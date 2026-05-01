/**
 * Voyage embeddings — single embedder for the entire memory framework.
 *
 * Voyage `voyage-4-large` (1024-d), reached through MongoDB's AI gateway
 * (`ai.mongodb.com/v1/embeddings`). One vendor, one model, no fallback.
 * If the gateway fails, the operation fails — surfacing a real outage early
 * is far better than silently degrading recall quality.
 *
 * Auth and quota are handled by `MONGO_DB_API_KEY`; no separate Voyage key
 * is required (the gateway proxies Voyage transparently).
 *
 * Configurable via:
 *   - MONGO_DB_API_KEY                 (required)
 *   - MONGO_DB_EMBEDDING_API_BASE_URL  (optional, defaults to https://ai.mongodb.com/v1)
 *   - MEMORY_EMBEDDING_MODEL           (optional, defaults to voyage-4-large)
 *   - MEMORY_EMBEDDING_DIMENSIONS      (optional, defaults to 1024)
 *   - MEMORY_EMBEDDING_TIMEOUT_MS      (optional, defaults to 8000)
 */
import { createContentHash, getRedisClient } from "./cache.js";
import type { EmbeddingResult } from "./types.js";

const EMBEDDING_CACHE_TTL_SECONDS = 86_400; // 24h
const EMBEDDING_MODEL = process.env.MEMORY_EMBEDDING_MODEL || "voyage-4-large";
const EMBEDDING_DIMENSIONS = Number.parseInt(process.env.MEMORY_EMBEDDING_DIMENSIONS || "1024", 10);
const EMBEDDING_TIMEOUT_MS = Number.parseInt(process.env.MEMORY_EMBEDDING_TIMEOUT_MS || "8000", 10);
const VOYAGE_URL = `${String(process.env.MONGO_DB_EMBEDDING_API_BASE_URL || "https://ai.mongodb.com/v1").replace(/\/+$/u, "")}/embeddings`;

interface VoyageEmbeddingResponse {
    object: string;
    data: Array<{ object: string; embedding: number[]; index: number }>;
    model: string;
    usage?: { total_tokens?: number };
}

function requireVoyageApiKey(): string {
    const key = process.env.MONGO_DB_API_KEY;
    if (!key) {
        throw new Error("MONGO_DB_API_KEY is required for Voyage embeddings");
    }
    return key;
}

async function callVoyage(input: string | string[]): Promise<number[][]> {
    const apiKey = requireVoyageApiKey();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);
    try {
        const response = await fetch(VOYAGE_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                input,
                model: EMBEDDING_MODEL,
                input_type: "document",
                output_dimension: EMBEDDING_DIMENSIONS,
            }),
            signal: controller.signal,
        });
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new Error(`Voyage embeddings ${response.status}: ${body.slice(0, 300)}`);
        }
        const data = (await response.json()) as VoyageEmbeddingResponse;
        if (!Array.isArray(data?.data) || data.data.length === 0) {
            throw new Error("Voyage embeddings returned no data");
        }
        return data.data
            .slice()
            .sort((a, b) => a.index - b.index)
            .map((item) => item.embedding);
    } finally {
        clearTimeout(timer);
    }
}

async function readCachedEmbedding(text: string): Promise<EmbeddingResult | null> {
    try {
        const redis = await getRedisClient();
        const cached = await redis.get(`embedding:${createContentHash(text)}`);
        if (!cached) return null;
        const parsed = JSON.parse(cached) as { embedding: number[] };
        return {
            embedding: parsed.embedding,
            provider: "voyage",
            cached: true,
            dimensions: parsed.embedding.length,
        };
    } catch {
        return null;
    }
}

async function writeCachedEmbedding(text: string, embedding: number[]): Promise<void> {
    try {
        const redis = await getRedisClient();
        await redis.setEx(
            `embedding:${createContentHash(text)}`,
            EMBEDDING_CACHE_TTL_SECONDS,
            JSON.stringify({ embedding }),
        );
    } catch {
        // Cache failures must not break embedding writes.
    }
}

export async function getEmbedding(text: string): Promise<EmbeddingResult> {
    const cached = await readCachedEmbedding(text);
    if (cached) return cached;
    const [embedding] = await callVoyage(text);
    await writeCachedEmbedding(text, embedding);
    return {
        embedding,
        provider: "voyage",
        cached: false,
        dimensions: embedding.length,
    };
}

export async function getEmbeddingsBatch(texts: string[]): Promise<EmbeddingResult[]> {
    if (texts.length === 0) return [];

    const results: EmbeddingResult[] = new Array(texts.length);
    const uncachedIndexes: number[] = [];
    const uncachedTexts: string[] = [];

    for (let i = 0; i < texts.length; i += 1) {
        const cached = await readCachedEmbedding(texts[i]);
        if (cached) {
            results[i] = cached;
        } else {
            uncachedIndexes.push(i);
            uncachedTexts.push(texts[i]);
        }
    }

    if (uncachedTexts.length === 0) return results;

    const embeddings = await callVoyage(uncachedTexts);
    for (let j = 0; j < uncachedIndexes.length; j += 1) {
        const i = uncachedIndexes[j];
        const embedding = embeddings[j];
        results[i] = {
            embedding,
            provider: "voyage",
            cached: false,
            dimensions: embedding.length,
        };
        await writeCachedEmbedding(texts[i], embedding);
    }

    return results;
}
