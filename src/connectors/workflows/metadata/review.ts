/**
 * Model-backed metadata review utilities.
 *
 * The three metadata agents are concrete model routes:
 *   0 - Gemini Flash via GOOGLE_GENERATIVE_AI_API_KEY
 *   1 - Workers AI via the AI binding
 *   2 - Fireworks DeepSeek via FIREWORKS_API_KEY
 *
 * They produce metadata only from observed spawn output (or explicit
 * credential-required evidence). Publishing and embeddings live elsewhere.
 */

import type { Env } from "../../worker/env.js";

const SYSTEM_PROMPT = `You normalize MCP server metadata from observed MCP spawn evidence. Output JSON with cleaned fields. Output ONLY a single JSON object, no markdown.

Schema:
{
  "name": string,
  "description": string,
  "tags": string[]
}`;

export interface ReviewedCard {
    name: string;
    description: string;
    tags: string[];
}

export interface MetadataReviewInput {
    repoUrl: string | null;
    name: string;
    description: string;
    tools: Array<{ name: string; description: string | null; inputSchema?: Record<string, unknown> }>;
    credentialVars?: string[];
}

export function reviewerForAgent(agentId: number): string {
    if (agentId === 0) return "metadata-agent-0:gemini-2.5-flash";
    if (agentId === 1) return "metadata-agent-1:workers-ai";
    if (agentId === 2) return "metadata-agent-2:fireworks-deepseek";
    throw new Error("agentId must be 0, 1, or 2");
}

function validate(card: ReviewedCard | null): card is ReviewedCard {
    if (!card || typeof card !== "object") return false;
    if (typeof card.name !== "string" || card.name.trim().length === 0) return false;
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

async function callGeminiFlash(env: Env, prompt: string): Promise<ReviewedCard | null> {
    const apiKey = (env as unknown as Record<string, string | undefined>).GOOGLE_GENERATIVE_AI_API_KEY;
    if (!apiKey) return null;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.COMPILER_MODEL_PRIMARY}:generateContent?key=${apiKey}`;
    const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: `${SYSTEM_PROMPT}\n\n${prompt}` }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
        }),
    });
    if (!r.ok) return null;
    const body = await r.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = body.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return parseStrict(text);
}

async function callWorkersAi(env: Env, prompt: string): Promise<ReviewedCard | null> {
    try {
        const result = await env.AI.run<AiChatResult>(env.COMPILER_MODEL_SECONDARY, {
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: prompt },
            ],
            temperature: 0.2,
        });
        const text = extractAiText(result);
        return parseStrict(text);
    } catch {
        return null;
    }
}

interface AiChatResult {
    response?: string;
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
    result?: {
        response?: string;
        choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
    };
}

function extractAiText(result: AiChatResult): string {
    const candidates = [
        result.response,
        result.choices?.[0]?.message?.content,
        result.result?.response,
        result.result?.choices?.[0]?.message?.content,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
        if (Array.isArray(candidate)) {
            const text = candidate.map((part) => part.text || "").join("").trim();
            if (text) return text;
        }
    }
    return JSON.stringify(result);
}

async function callFireworks(env: Env, prompt: string): Promise<ReviewedCard | null> {
    const key = (env as unknown as Record<string, string | undefined>).FIREWORKS_API_KEY;
    if (!key) return null;
    const r = await fetch("https://api.fireworks.ai/inference/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
        body: JSON.stringify({
            model: `accounts/fireworks/models/${env.COMPILER_MODEL_TERTIARY}`,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: prompt },
            ],
            temperature: 0.2,
        }),
    });
    if (!r.ok) return null;
    const body = await r.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = body.choices?.[0]?.message?.content || "";
    return parseStrict(text);
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
): Promise<ReviewedCard | null> {
    const prompt = buildUserPrompt(input);
    let card: ReviewedCard | null = null;
    if (agentId === 0) card = await callGeminiFlash(env, prompt);
    else if (agentId === 1) card = await callWorkersAi(env, prompt);
    else if (agentId === 2) card = await callFireworks(env, prompt);
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
    extractAiText,
};
