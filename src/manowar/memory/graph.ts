/**
 * Graph layer — first-party durable-fact extraction and retrieval.
 *
 * Replaces the old mem0-cloud-backed graph layer. Facts live in the same Mongo
 * `memory` collection as conversational vectors, with `source: "fact"` and
 * `metadata.layer: "graph"`. Retrieval reuses the existing Atlas $vectorSearch
 * + CF BAAI rerank pipeline through `vector.ts:searchVectors`. Extraction runs
 * gemini-3.1-flash-lite-preview through our internal inference gateway.
 *
 * Why this is strictly better than mem0:
 *   - Single store (Mongo `memory`) instead of a vendor cloud round-trip.
 *   - voyage-4-large 1024-d (we control) + CF BAAI bge-reranker-base.
 *   - Per-turn p50 < 100ms vs ~905ms with mem0.
 *   - Schema control: every fact is queryable, debuggable, exportable.
 *   - Symmetric with the rest of the framework — same decay, same TTL,
 *     same Redis hot cache, same archival policy.
 *
 * Compatibility with the cross-layer ranker:
 *   - `searchAgentMemoryFacts` returns `MemoryItem[]` with the `memory` field
 *     populated (not `content`), so `summary.ts:summarizeLayerItem("graph", ...)`
 *     reads it the exact same way it read mem0 results.
 */

import { createContentHash } from "./cache.js";
import { getEmbedding } from "./embedding.js";
import { getMemoryVectorsCollection } from "./mongo.js";
import { indexVector, searchVectors } from "./vector.js";
import type {
    LayeredSearchParams,
    MemoryItem,
    SessionTranscript,
} from "./types.js";
import { buildApiInternalHeaders, requireApiInternalUrl } from "../../auth.js";

const FACT_EXTRACTION_MODEL = process.env.MEMORY_FACT_EXTRACTION_MODEL || "gemini-3.1-flash-lite-preview";
const FACT_EXTRACTION_TIMEOUT_MS = Number.parseInt(process.env.MEMORY_FACT_EXTRACTION_TIMEOUT_MS || "8000", 10);
const FACT_MAX_PER_TURN = Math.max(1, Number.parseInt(process.env.MEMORY_FACT_MAX_PER_TURN || "5", 10));
const FACT_MIN_CONFIDENCE = Math.max(0, Math.min(1, Number.parseFloat(process.env.MEMORY_FACT_MIN_CONFIDENCE || "0.6")));
const FACT_MAX_CHARS = Math.max(40, Number.parseInt(process.env.MEMORY_FACT_MAX_CHARS || "240", 10));
const FACT_TYPES = ["preference", "identity", "context", "skill", "relationship", "event"] as const;
type FactType = typeof FACT_TYPES[number];
const FACT_TAG_MAX_CHARS = 40;

interface ExtractedFact {
    fact: string;
    type: FactType;
    confidence: number;
}

const EXTRACTION_SYSTEM_PROMPT = [
    "You extract durable, atomic facts about the user from a single conversation turn.",
    "Return ONLY a JSON object with this exact shape: {\"facts\":[{\"fact\":string,\"type\":string,\"confidence\":number}]}",
    `Allowed type values: ${FACT_TYPES.join(", ")}.`,
    `Hard rules: max ${FACT_MAX_PER_TURN} facts; confidence in [0,1] and >= ${FACT_MIN_CONFIDENCE}; each fact <= ${FACT_MAX_CHARS} characters.`,
    "DO emit: stable user identity, preferences, skills, relationships, durable context, dated events.",
    "DO NOT emit: facts about the assistant; transient pleasantries; tool plumbing details; speculation.",
    "DO NOT emit summary, omnibus, or recap rows that re-state multiple atomic facts. One fact per row, atomic and standalone.",
    "If a candidate fact does not fit one of the allowed types, drop it.",
    "If the turn carries no durable fact, return {\"facts\":[]}.",
].join(" ");

function buildExtractionUserPrompt(messages: SessionTranscript["messages"]): string {
    const trimmed = messages
        .filter((message) => message.role === "user" || message.role === "assistant")
        .slice(-6)
        .map((message) => {
            const text = message.content.replace(/\s+/g, " ").trim().slice(0, 1_200);
            return `${message.role}: ${text}`;
        })
        .join("\n");

    return `Conversation turn:\n${trimmed}\n\nExtract durable user facts as JSON.`;
}

interface InferenceJsonResponse {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
}

async function callExtractor(messages: SessionTranscript["messages"]): Promise<ExtractedFact[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FACT_EXTRACTION_TIMEOUT_MS);
    try {
        const response = await fetch(`${requireApiInternalUrl()}/v1/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...buildApiInternalHeaders(),
            },
            body: JSON.stringify({
                model: FACT_EXTRACTION_MODEL,
                messages: [
                    { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
                    { role: "user", content: buildExtractionUserPrompt(messages) },
                ],
                response_format: { type: "json_object" },
                temperature: 0.1,
                max_tokens: 600,
            }),
            signal: controller.signal,
        });
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            console.warn(`[memory:graph] extractor ${response.status}: ${body.slice(0, 240)}`);
            return [];
        }
        const data = (await response.json()) as InferenceJsonResponse;
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== "string" || content.length === 0) {
            return [];
        }
        return parseExtractedFacts(content);
    } catch (error) {
        if ((error as { name?: string }).name === "AbortError") {
            console.warn(`[memory:graph] extractor timed out after ${FACT_EXTRACTION_TIMEOUT_MS}ms`);
        } else {
            console.warn(`[memory:graph] extractor error: ${error instanceof Error ? error.message : String(error)}`);
        }
        return [];
    } finally {
        clearTimeout(timer);
    }
}

function parseExtractedFacts(raw: string): ExtractedFact[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        // Some models wrap JSON in code fences or trailing prose. Try to recover
        // by extracting the first balanced {...} segment.
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) return [];
        try {
            parsed = JSON.parse(match[0]);
        } catch {
            return [];
        }
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const factsRaw = (parsed as { facts?: unknown }).facts;
    if (!Array.isArray(factsRaw)) return [];

    const facts: ExtractedFact[] = [];
    for (const entry of factsRaw) {
        if (!entry || typeof entry !== "object") continue;
        const record = entry as Record<string, unknown>;
        const fact = typeof record.fact === "string" ? record.fact.trim() : "";
        if (!fact) continue;
        const confidenceRaw = record.confidence;
        const confidence = typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
            ? Math.max(0, Math.min(1, confidenceRaw))
            : 0;
        if (confidence < FACT_MIN_CONFIDENCE) continue;
        const typeRaw = typeof record.type === "string" ? record.type.toLowerCase() : "";
        if (!(FACT_TYPES as readonly string[]).includes(typeRaw)) {
            // Reject types not in the typed list. Removing "other" from
            // FACT_TYPES (vs accepting + filtering) means the LLM never
            // emits it in the first place — cleaner extraction.
            continue;
        }
        const type: FactType = typeRaw as FactType;
        // Hard cap on length. The model occasionally emits 280-char "other"
        // summary rows even after schema tightening; rejecting them here
        // belt-and-braces prevents downstream rank-poisoning.
        if (fact.length > FACT_MAX_CHARS) continue;
        facts.push({
            fact,
            type,
            confidence,
        });
        if (facts.length >= FACT_MAX_PER_TURN) break;
    }
    return facts;
}

function buildFactHash(scope: { agentWallet: string; userAddress?: string }, fact: string): string {
    return createContentHash(`${scope.agentWallet}|${(scope.userAddress || "_").toLowerCase()}|${fact.toLowerCase().trim()}`);
}

interface IndexFactsParams {
    agentWallet: string;
    userAddress?: string;
    threadId?: string;
    mode?: "global" | "local";
    haiId?: string;
    messages: SessionTranscript["messages"];
    metadata?: Record<string, unknown>;
}

interface IndexFactsResult {
    factsExtracted: number;
    factsIndexed: number;
    factsBumped: number;
}

/**
 * Extract durable facts from a turn and index them as `source: "fact"` vectors.
 * Idempotent on (agentWallet, userAddress, factText) — duplicates bump
 * accessCount instead of inserting new rows.
 */
export async function indexAgentMemoryFacts(params: IndexFactsParams): Promise<IndexFactsResult> {
    if (!params.agentWallet || !Array.isArray(params.messages) || params.messages.length === 0) {
        return { factsExtracted: 0, factsIndexed: 0, factsBumped: 0 };
    }

    const facts = await callExtractor(params.messages);
    if (facts.length === 0) {
        return { factsExtracted: 0, factsIndexed: 0, factsBumped: 0 };
    }

    const vectors = await getMemoryVectorsCollection();
    const turnId = typeof params.metadata?.turnId === "string" ? params.metadata.turnId : undefined;
    let factsIndexed = 0;
    let factsBumped = 0;

    for (const fact of facts) {
        const factHash = buildFactHash(params, fact.fact);
        // Cheap dedup: exact-text match within scope. Future: cosine-supersedes.
        const existing = await vectors.findOne(
            {
                agentWallet: params.agentWallet,
                source: "fact",
                "metadata.factHash": factHash,
            },
            { projection: { _id: 0, vectorId: 1, accessCount: 1 } },
        );

        if (existing?.vectorId) {
            const now = Date.now();
            await vectors.updateOne(
                { vectorId: existing.vectorId },
                {
                    $inc: { accessCount: 1 },
                    $set: { lastAccessedAt: now, updatedAt: now },
                },
            );
            factsBumped += 1;
            continue;
        }

        const embedding = await getEmbedding(fact.fact);
        await indexVector({
            agentWallet: params.agentWallet,
            userAddress: params.userAddress,
            threadId: params.threadId,
            mode: params.mode,
            haiId: params.haiId,
            content: fact.fact,
            embedding: embedding.embedding,
            source: "fact",
            metadata: {
                ...params.metadata,
                layer: "graph",
                factType: fact.type,
                factHash,
                confidence: fact.confidence,
                sourceTurnId: turnId,
                extractor: FACT_EXTRACTION_MODEL,
            },
        });
        factsIndexed += 1;
    }

    return {
        factsExtracted: facts.length,
        factsIndexed,
        factsBumped,
    };
}

/**
 * Search durable facts for the (agentWallet, userAddress) scope. Returns shape
 * compatible with `summary.ts:summarizeLayerItem("graph", ...)` which reads
 * `record.memory`. Uses the existing vector pipeline (Atlas $vectorSearch,
 * CF BAAI rerank with dominance-skip, MMR, decay).
 */
export async function searchAgentMemoryFacts(params: LayeredSearchParams): Promise<MemoryItem[]> {
    const factFilter: Record<string, unknown> = {
        ...(params.filters || {}),
        source: "fact",
    };
    const results = await searchVectors({
        query: params.query,
        agentWallet: params.agentWallet,
        userAddress: params.userAddress,
        threadId: params.threadId,
        mode: params.mode,
        haiId: params.haiId,
        filters: factFilter,
        limit: Math.max(1, params.limit ?? 5),
        options: {
            temporalDecay: true,
            rerank: true,
            mmr: true,
            mmrLambda: 0.7,
        },
    });

    return results.map((row) => {
        const item: MemoryItem = {
            id: row.vectorId ?? row.id,
            memory: row.content,
            user_id: row.userAddress,
            agent_id: row.agentWallet,
            run_id: row.threadId,
            metadata: {
                source: "fact",
                layer: "graph",
                score: row.score,
                decayScore: row.decayScore,
                accessCount: row.accessCount,
            },
            created_at: row.createdAt ? new Date(row.createdAt).toISOString() : undefined,
        };
        return item;
    });
}
