/**
 * Model-backed metadata review utilities.
 *
 * The three metadata agents are concrete model routes:
 *   0 - Gemini Flash via GOOGLE_GENERATIVE_AI_API_KEY
 *   1 - Fireworks MiniMax via FIREWORKS_API_KEY
 *   2 - Fireworks DeepSeek via FIREWORKS_API_KEY
 *
 * They produce metadata only from observed spawn output (or explicit
 * credential-required evidence). Publishing and embeddings live elsewhere.
 */

import type { Env } from "../../worker/env.js";

const SYSTEM_PROMPT = `Spawn the MCP Server, and use the correct name and slug returned by the spawned-server's metadata. Output ONLY a single JSON object, no markdown.

Examples:
Good server name: "Server Name"
Bad server names: "io-github-server-name"; "jimmy-chow-server-name"; "Server Name by Jimmy Chow"; "MCP Server Server Name"; "Server Name MCP"
Good slug: "server-name"
Bad slugs: "io-github-server-name"; "jimmy-chow-server-name"; "server-name-by-jimmy-chow"; "mcp-server-server-name"; "server-name-mcp"

Schema:
{
  "name": string,
  "slug": string,
  "description": string,
  "tags": string[]
}`;

export interface ReviewedCard {
    name: string;
    slug: string;
    description: string;
    tags: string[];
}

export interface MetadataReviewInput {
    repoUrl: string | null;
    name: string;
    description: string;
    tools: Array<{ name: string; description: string | null; inputSchema?: Record<string, unknown> }>;
    credentialVars?: string[];
    serverInfo?: Record<string, unknown> | null;
}

export class MetadataReviewProviderError extends Error {
    provider: string;

    constructor(provider: string, message: string) {
        super(`${provider}: ${message}`);
        this.name = "MetadataReviewProviderError";
        this.provider = provider;
    }
}

export function reviewerForAgent(agentId: number): string {
    if (agentId === 0) return "metadata-agent-0:gemini-2.5-flash:spawn-metadata-v2";
    if (agentId === 1) return "metadata-agent-1:fireworks-minimax-m2p7:spawn-metadata-v2";
    if (agentId === 2) return "metadata-agent-2:fireworks-deepseek-v3p2:spawn-metadata-v2";
    throw new Error("agentId must be 0, 1, or 2");
}

function validate(card: ReviewedCard | null): card is ReviewedCard {
    if (!card || typeof card !== "object") return false;
    if (typeof card.name !== "string" || card.name.trim().length === 0) return false;
    if (typeof card.slug !== "string" || card.slug.trim().length === 0) return false;
    if (typeof card.description !== "string" || card.description.trim().length === 0) return false;
    if (!Array.isArray(card.tags) || card.tags.length === 0) return false;
    for (const tag of card.tags) {
        if (typeof tag !== "string") return false;
        if (tag.trim().length === 0) return false;
    }
    return true;
}

function buildUserPrompt(input: MetadataReviewInput): string {
    const lines = [`Raw server name: ${input.name}`];
    if (input.repoUrl) lines.push(`Repository: ${input.repoUrl}`);
    if (input.description) lines.push(`Registry description for disambiguation only: ${input.description}`);
    if (input.serverInfo) lines.push(`Spawned-server metadata: ${JSON.stringify(input.serverInfo)}`);
    if (input.credentialVars && input.credentialVars.length > 0) {
        lines.push(`Credential-required evidence: ${input.credentialVars.join(", ")}`);
        lines.push("No tools were guessed. Describe only the server identity and credential-gated access.");
    }
    if (input.tools.length > 0) {
        lines.push("Observed tools from a successful MCP tools/list:");
        for (const tool of input.tools.slice(0, 20)) {
            const schemaKeys = tool.inputSchema ? Object.keys(tool.inputSchema).slice(0, 8).join(", ") : "";
            lines.push(`- ${tool.name}${tool.description ? `: ${tool.description}` : ""}${schemaKeys ? ` (schema keys: ${schemaKeys})` : ""}`);
        }
    }
    lines.push("\nOutput a single JSON object matching the schema. No prose.");
    return lines.join("\n");
}

function providerCard(provider: string, text: string): ReviewedCard {
    const card = parseStrict(text);
    if (!card) {
        throw new MetadataReviewProviderError(provider, "model returned invalid metadata JSON");
    }
    return card;
}

function parseJsonResponse<T>(provider: string, text: string): T {
    try {
        return JSON.parse(text) as T;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new MetadataReviewProviderError(provider, `response was not valid JSON: ${message}`);
    }
}

async function callGeminiFlash(env: Env, prompt: string): Promise<ReviewedCard> {
    const provider = "Gemini";
    const apiKey = (env as unknown as Record<string, string | undefined>).GOOGLE_GENERATIVE_AI_API_KEY;
    if (!apiKey) throw new MetadataReviewProviderError(provider, "GOOGLE_GENERATIVE_AI_API_KEY is not configured");
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.COMPILER_MODEL_PRIMARY}:generateContent?key=${apiKey}`;
    const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: `${SYSTEM_PROMPT}\n\n${prompt}` }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
        }),
    });
    const responseText = await r.text();
    if (!r.ok) throw new MetadataReviewProviderError(provider, `HTTP ${r.status}: ${responseText.slice(0, 300)}`);
    const body = parseJsonResponse<{ candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }>(provider, responseText);
    const text = body.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (!text.trim()) throw new MetadataReviewProviderError(provider, "response did not include candidate text");
    return providerCard(provider, text);
}

function fireworksModelId(model: string): string {
    return model.startsWith("accounts/") ? model : `accounts/fireworks/models/${model}`;
}

async function callFireworks(env: Env, prompt: string, model: string, provider: string): Promise<ReviewedCard> {
    const key = (env as unknown as Record<string, string | undefined>).FIREWORKS_API_KEY;
    if (!key) throw new MetadataReviewProviderError(provider, "FIREWORKS_API_KEY is not configured");
    const r = await fetch("https://api.fireworks.ai/inference/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
        body: JSON.stringify({
            model: fireworksModelId(model),
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: prompt },
            ],
            temperature: 0.2,
        }),
    });
    const responseText = await r.text();
    if (!r.ok) throw new MetadataReviewProviderError(provider, `HTTP ${r.status}: ${responseText.slice(0, 300)}`);
    const body = parseJsonResponse<{ choices?: Array<{ message?: { content?: string } }> }>(provider, responseText);
    const text = body.choices?.[0]?.message?.content || "";
    if (!text.trim()) throw new MetadataReviewProviderError(provider, "response did not include message content");
    return providerCard(provider, text);
}

function parseStrict(text: string): ReviewedCard | null {
    if (!text) return null;
    try {
        const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
        const json = extractJsonObject(trimmed);
        if (!json) return null;
        const card = JSON.parse(json) as ReviewedCard;
        return validate(card) ? card : null;
    } catch {
        return null;
    }
}

function extractJsonObject(text: string): string | null {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    return text.slice(start, end + 1);
}

export async function reviewMetadataWithAgent(
    env: Env,
    agentId: number,
    input: MetadataReviewInput,
): Promise<ReviewedCard> {
    const prompt = buildUserPrompt(input);
    let card: ReviewedCard;
    if (agentId === 0) card = await callGeminiFlash(env, prompt);
    else if (agentId === 1) card = await callFireworks(env, prompt, env.COMPILER_MODEL_SECONDARY, "Fireworks MiniMax");
    else if (agentId === 2) card = await callFireworks(env, prompt, env.COMPILER_MODEL_TERTIARY, "Fireworks DeepSeek");
    else throw new Error("agentId must be 0, 1, or 2");
    return card;
}

export async function hashReviewedArtifact(input: unknown): Promise<string> {
    const raw = new TextEncoder().encode(JSON.stringify(input));
    const digest = await crypto.subtle.digest("SHA-256", raw);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

export const __test = {
    validate,
    parseStrict,
    buildUserPrompt,
    fireworksModelId,
    MetadataReviewProviderError,
};
