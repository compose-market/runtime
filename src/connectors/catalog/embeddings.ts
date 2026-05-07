/**
 * Voyage embeddings via the MongoDB AI Gateway.
 *
 * Same pattern used by runtime/src/manowar/memory/embedding.ts:23-115 — we
 * route Voyage through Mongo's gateway because that's already the auth
 * boundary the codebase pays for. Cache key prefix is `connectors:embedding:`
 * so the connectors index is fully separated from the memory index.
 */

import type { Env } from "../worker/env.js";

interface VoyageResponse {
    object: string;
    data: Array<{ object: string; embedding: number[]; index: number }>;
    model: string;
}

interface VoyageRerankResponse {
    data?: Array<{ index: number; relevance_score?: number; score?: number; document?: string }>;
    results?: Array<{ index: number; relevance_score?: number; score?: number; document?: string }>;
}

function endpoint(env: Env, path: "embeddings" | "rerank"): string {
    const base = (env.EMBEDDING_API_BASE || "https://ai.mongodb.com/v1").replace(/\/+$/, "");
    return `${base}/${path}`;
}

export async function embedTexts(env: Env, texts: string[], inputType: "document" | "query" = "document"): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (!env.MONGO_DB_API_KEY) {
        throw new Error("MONGO_DB_API_KEY is required for connectors embeddings");
    }
    const body = {
        model: env.EMBEDDING_MODEL || "voyage-4-large",
        input: texts,
        input_type: inputType,
        output_dimension: 1024,
    };
    const response = await fetch(endpoint(env, "embeddings"), {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": `Bearer ${env.MONGO_DB_API_KEY}`,
        },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Voyage embeddings ${response.status}: ${text.slice(0, 300)}`);
    }
    const parsed = await response.json() as VoyageResponse;
    if (!parsed.data || parsed.data.length === 0) {
        throw new Error("Voyage embeddings returned no data");
    }
    return parsed.data
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
}

export async function embedOne(env: Env, text: string): Promise<number[]> {
    const [vec] = await embedTexts(env, [text], "document");
    if (!vec) throw new Error("Voyage embeddings returned empty vector");
    return vec;
}

export async function rerankDocuments(
    env: Env,
    query: string,
    documents: Array<{ id: string; text: string }>,
    topK: number,
): Promise<Array<{ id: string; score: number }>> {
    if (documents.length === 0) return [];
    if (!env.MONGO_DB_API_KEY) {
        throw new Error("MONGO_DB_API_KEY is required for connectors reranking");
    }
    const response = await fetch(endpoint(env, "rerank"), {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": `Bearer ${env.MONGO_DB_API_KEY}`,
        },
        body: JSON.stringify({
            model: "rerank-2.5",
            query,
            documents: documents.map((doc) => doc.text),
            top_k: topK,
        }),
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Voyage rerank ${response.status}: ${text.slice(0, 300)}`);
    }
    const parsed = await response.json() as VoyageRerankResponse;
    const rows = parsed.data || parsed.results || [];
    return rows
        .map((row) => ({
            id: documents[row.index]?.id,
            score: row.relevance_score ?? row.score ?? 0,
        }))
        .filter((row): row is { id: string; score: number } => Boolean(row.id))
        .sort((a, b) => b.score - a.score);
}

export function buildCardEmbeddingText(card: {
    name: string;
    description: string;
    tags: string[];
    tools: Array<{ name: string; description?: string | null }>;
}): string {
    const toolText = (card.tools || [])
        .slice(0, 10)
        .map((t) => `${t.name}${t.description ? `: ${t.description}` : ""}`)
        .join("\n");
    return [
        `name: ${card.name}`,
        `description: ${card.description}`,
        `tags: ${(card.tags || []).join(", ")}`,
        `tools:\n${toolText}`,
    ].join("\n");
}

function hashText(input: string): string {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

export function buildVectorId(slug: string, cardVersion: string): string {
    const id = `${slug}:${cardVersion}`;
    if (new TextEncoder().encode(id).length <= 64) return id;
    return `${slug.slice(0, 40)}:${hashText(id)}:${cardVersion.slice(0, 8)}`;
}
