import { createContentHash, getRedisClient } from "./cache.js";
import type { EmbeddingResult } from "./types.js";

const EMBEDDING_CACHE_TTL_SECONDS = 86400;
const MONGODB_VOYAGE_EMBEDDING_URL = `${String(process.env.MONGO_DB_EMBEDDING_API_BASE_URL || "https://ai.mongodb.com/v1").replace(/\/+$/, "")}/embeddings`;

interface VoyageEmbeddingResponse {
    object: string;
    data: Array<{ object: string; embedding: number[]; index: number }>;
    model: string;
    usage: { total_tokens: number };
}

interface CloudflareEmbeddingResponse {
    result: { shape: number[]; data: number[][] };
    success: boolean;
}

export async function getEmbedding(text: string): Promise<EmbeddingResult> {
    const contentHash = createContentHash(text);
    const cacheKey = `embedding:${contentHash}`;
    const redis = await getRedisClient();
    const cached = await redis.get(cacheKey);

    if (cached) {
        try {
            const parsed = JSON.parse(cached) as { embedding: number[]; provider: "voyage" | "cloudflare" };
            return {
                embedding: parsed.embedding,
                provider: parsed.provider,
                cached: true,
                dimensions: parsed.embedding.length,
            };
        } catch {
            // Ignore malformed cache records.
        }
    }

    const voyageResult = await tryVoyageEmbedding(text);
    if (voyageResult) {
        await redis.setEx(cacheKey, EMBEDDING_CACHE_TTL_SECONDS, JSON.stringify({
            embedding: voyageResult.embedding,
            provider: "voyage",
        }));
        return { ...voyageResult, cached: false };
    }

    const cloudflareResult = await tryCloudflareEmbedding(text);
    if (cloudflareResult) {
        await redis.setEx(cacheKey, EMBEDDING_CACHE_TTL_SECONDS, JSON.stringify({
            embedding: cloudflareResult.embedding,
            provider: "cloudflare",
        }));
        return { ...cloudflareResult, cached: false };
    }

    throw new Error("All embedding providers failed");
}

export async function getEmbeddingsBatch(texts: string[]): Promise<EmbeddingResult[]> {
    const redis = await getRedisClient();
    const results: EmbeddingResult[] = new Array(texts.length);
    const uncached: Array<{ index: number; text: string }> = [];

    for (let i = 0; i < texts.length; i += 1) {
        const hash = createContentHash(texts[i]);
        const cached = await redis.get(`embedding:${hash}`);

        if (!cached) {
            uncached.push({ index: i, text: texts[i] });
            continue;
        }

        try {
            const parsed = JSON.parse(cached) as { embedding: number[]; provider: "voyage" | "cloudflare" };
            results[i] = {
                embedding: parsed.embedding,
                provider: parsed.provider,
                cached: true,
                dimensions: parsed.embedding.length,
            };
        } catch {
            uncached.push({ index: i, text: texts[i] });
        }
    }

    if (uncached.length === 0) {
        return results;
    }

    const uncachedTexts = uncached.map((item) => item.text);
    const uncachedEmbeddings = await getBatchEmbeddings(uncachedTexts);

    for (let i = 0; i < uncached.length; i += 1) {
        const { index, text } = uncached[i];
        const embedding = uncachedEmbeddings[i];
        const hash = createContentHash(text);

        results[index] = {
            embedding,
            provider: "voyage",
            cached: false,
            dimensions: embedding.length,
        };

        await redis.setEx(`embedding:${hash}`, EMBEDDING_CACHE_TTL_SECONDS, JSON.stringify({
            embedding,
            provider: "voyage",
        }));
    }

    return results;
}

async function getBatchEmbeddings(texts: string[]): Promise<number[][]> {
    const voyageEmbeddings = await tryVoyageBatchEmbedding(texts);
    if (voyageEmbeddings) {
        return voyageEmbeddings;
    }

    const fallback: number[][] = [];
    for (const text of texts) {
        const cloudflareEmbedding = await tryCloudflareEmbedding(text);
        if (!cloudflareEmbedding) {
            throw new Error(`Embedding failed for text: ${text.slice(0, 80)}...`);
        }
        fallback.push(cloudflareEmbedding.embedding);
    }

    return fallback;
}

async function tryVoyageEmbedding(text: string): Promise<EmbeddingResult | null> {
    const apiKey = process.env.MONGO_DB_API_KEY;
    if (!apiKey) {
        return null;
    }

    try {
        const response = await fetch(MONGODB_VOYAGE_EMBEDDING_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                input: text,
                model: "voyage-4-large",
                input_type: "document",
                output_dimension: 1024,
            }),
        });

        if (!response.ok) {
            return null;
        }

        const data = (await response.json()) as VoyageEmbeddingResponse;
        return {
            embedding: data.data[0].embedding,
            provider: "voyage",
            cached: false,
            dimensions: data.data[0].embedding.length,
        };
    } catch {
        return null;
    }
}

async function tryVoyageBatchEmbedding(texts: string[]): Promise<number[][] | null> {
    const apiKey = process.env.MONGO_DB_API_KEY;
    if (!apiKey) {
        return null;
    }

    try {
        const response = await fetch(MONGODB_VOYAGE_EMBEDDING_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                input: texts,
                model: "voyage-4-large",
                input_type: "document",
                output_dimension: 1024,
            }),
        });

        if (!response.ok) {
            return null;
        }

        const data = (await response.json()) as VoyageEmbeddingResponse;
        return data.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
    } catch {
        return null;
    }
}

async function tryCloudflareEmbedding(text: string): Promise<EmbeddingResult | null> {
    const apiKey = process.env.CLOUDFLARE_API_KEY;
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

    if (!apiKey || !accountId) {
        return null;
    }

    try {
        const response = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/baai/bge-large-en-v1.5`,
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ text }),
            },
        );

        if (!response.ok) {
            return null;
        }

        const data = (await response.json()) as CloudflareEmbeddingResponse;
        const embedding = data.result?.data?.[0];
        if (!data.success || !embedding) {
            return null;
        }

        return {
            embedding,
            provider: "cloudflare",
            cached: false,
            dimensions: embedding.length,
        };
    } catch {
        return null;
    }
}
