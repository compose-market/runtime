import type { HybridSearchParams, SearchResult, TemporalDecayConfig, MMRConfig } from "./types.js";
import { getEmbedding } from "./embedding.js";
import { applyDecayToResults } from "./decay.js";
import { mmrRerank } from "./mmr.js";
import { DEFAULT_TEMPORAL_DECAY_CONFIG, DEFAULT_MMR_CONFIG } from "./types.js";

const LAMBDA_API_URL = process.env.LAMBDA_API_URL || "https://api.compose.market";

export async function hybridSearch(params: HybridSearchParams): Promise<SearchResult[]> {
    const {
        query,
        agentWallet,
        userId,
        threadId,
        limit = 10,
        options = {},
    } = params;

    const {
        temporalDecay = true,
        rerank = true,
        mmr = false,
        mmrLambda = 0.7,
    } = options;

    const queryEmbedding = await getEmbedding(query);

    const response = await fetch(`${LAMBDA_API_URL}/api/memory/vector-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            query,
            queryEmbedding: queryEmbedding.embedding,
            agentWallet,
            userId,
            threadId,
            limit: limit * 2,
            embeddingProvider: queryEmbedding.provider,
        }),
    });

    if (!response.ok) {
        console.error(`[search] Vector search failed: ${response.status}`);
        return [];
    }

    const data = await response.json() as { results: SearchResult[] };
    let results = data.results || [];

    if (temporalDecay) {
        results = applyDecayToResults(results, {
            enabled: true,
            halfLifeDays: DEFAULT_TEMPORAL_DECAY_CONFIG.halfLifeDays,
        });
    }

    if (rerank && results.length > 0) {
        results = await applyReranking(query, results);
    }

    if (mmr) {
        results = mmrRerank(results, { enabled: true, lambda: mmrLambda });
    }

    return results
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
}

async function applyReranking(query: string, results: SearchResult[]): Promise<SearchResult[]> {
    if (results.length <= 1) return results;

    try {
        const response = await fetch(`${LAMBDA_API_URL}/api/memory/rerank`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                query,
                documents: results.map(r => ({ content: r.content, score: r.score })),
            }),
        });

        if (!response.ok) return results;

        const data = await response.json() as { results: Array<{ content: string; score: number }> };
        
        return results.map((r, i) => ({
            ...r,
            score: data.results[i]?.score ?? r.score,
        }));
    } catch {
        return results;
    }
}

export async function indexMemoryContent(params: {
    content: string;
    agentWallet: string;
    userId?: string;
    threadId?: string;
    source: "session" | "knowledge" | "pattern" | "archive" | "fact";
    metadata?: Record<string, unknown>;
}): Promise<{ success: boolean; vectorId?: string }> {
    const { content, agentWallet, userId, threadId, source } = params;

    const embedding = await getEmbedding(content);

    const response = await fetch(`${LAMBDA_API_URL}/api/memory/vector-index`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            content,
            embedding: embedding.embedding,
            agentWallet,
            userId,
            threadId,
            source,
        }),
    });

    if (!response.ok) {
        console.error(`[search] Index failed: ${response.status}`);
        return { success: false };
    }

    const data = await response.json() as { success: boolean; vectorId?: string };
    return data;
}