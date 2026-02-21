import type { EmbeddingResult } from "./types.js";
import { getRedisClient, createContentHash } from "../../redis.js";
const LAMBDA_API_URL = process.env.LAMBDA_API_URL || "https://api.compose.market";
const EMBEDDING_CACHE_TTL_SECONDS = 86400;
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
            const parsed = JSON.parse(cached);
            return {
                embedding: parsed.embedding,
                provider: parsed.provider,
                cached: true,
                dimensions: parsed.embedding.length,
            };
        } catch {
            // Cache corrupted, continue to fresh fetch
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
    console.warn("[embedding] Voyage failed, using Cloudflare fallback");
    const cfResult = await tryCloudflareEmbedding(text);
    if (cfResult) {
        await redis.setEx(cacheKey, EMBEDDING_CACHE_TTL_SECONDS, JSON.stringify({
            embedding: cfResult.embedding,
            provider: "cloudflare",
        }));
        return { ...cfResult, cached: false };
    }
    throw new Error("All embedding providers failed");
}
export async function getEmbeddingsBatch(texts: string[]): Promise<EmbeddingResult[]> {
    const results: EmbeddingResult[] = [];
    const uncached: { index: number; text: string }[] = [];
    const hashes: string[] = [];
    const redis = await getRedisClient();
    for (let i = 0; i < texts.length; i++) {
        const hash = createContentHash(texts[i]);
        hashes.push(hash);
        const cached = await redis.get(`embedding:${hash}`);
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                results[i] = {
                    embedding: parsed.embedding,
                    provider: parsed.provider,
                    cached: true,
                    dimensions: parsed.embedding.length,
                };
            } catch {
                uncached.push({ index: i, text: texts[i] });
            }
        } else {
            uncached.push({ index: i, text: texts[i] });
        }
    }
    if (uncached.length === 0) {
        return results;
    }
    const uncachedTexts = uncached.map(u => u.text);
    const batchResult = await getBatchEmbeddings(uncachedTexts);
    for (let i = 0; i < uncached.length; i++) {
        const { index } = uncached[i];
        const hash = createContentHash(uncached[i].text);
        const embedding = batchResult[i];
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
    const voyageResult = await tryVoyageBatchEmbedding(texts);
    if (voyageResult) {
        return voyageResult;
    }
    console.warn("[embedding] Voyage batch failed, falling back to individual Cloudflare calls");
    const results: number[][] = [];
    for (const text of texts) {
        const cf = await tryCloudflareEmbedding(text);
        if (cf) {
            results.push(cf.embedding);
        } else {
            throw new Error(`Embedding failed for text: ${text.slice(0, 50)}...`);
        }
    }
    return results;
}
async function tryVoyageEmbedding(text: string): Promise<EmbeddingResult | null> {
    const apiKey = process.env.MONGO_DB_API_KEY;
    if (!apiKey) return null;
    try {
        const response = await fetch("https://api.voyageai.com/v1/embeddings", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                input: text,
                model: "voyage-4-large",
                input_type: "document",
                output_dimension: 1024,
            }),
        });
        if (!response.ok) {
            console.error(`[embedding] Voyage error: ${response.status}`);
            return null;
        }
        const data = (await response.json()) as VoyageEmbeddingResponse;
        return {
            embedding: data.data[0].embedding,
            provider: "voyage",
            cached: false,
            dimensions: data.data[0].embedding.length,
        };
    } catch (error) {
        console.error("[embedding] Voyage fetch error:", error);
        return null;
    }
}
async function tryVoyageBatchEmbedding(texts: string[]): Promise<number[][] | null> {
    const apiKey = process.env.MONGO_DB_API_KEY;
    if (!apiKey) return null;
    try {
        const response = await fetch("https://api.voyageai.com/v1/embeddings", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                input: texts,
                model: "voyage-4-large",
                input_type: "document",
                output_dimension: 1024,
            }),
        });
        if (!response.ok) return null;
        const data = (await response.json()) as VoyageEmbeddingResponse;
        return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
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
                    "Authorization": `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ text }),
            }
        );
        if (!response.ok) {
            console.error(`[embedding] Cloudflare error: ${response.status}`);
            return null;
        }
        const data = (await response.json()) as CloudflareEmbeddingResponse;
        if (!data.success || !data.result?.data?.[0]) {
            return null;
        }
        return {
            embedding: data.result.data[0],
            provider: "cloudflare",
            cached: false,
            dimensions: data.result.data[0].length,
        };
    } catch (error) {
        console.error("[embedding] Cloudflare fetch error:", error);
        return null;
    }
}