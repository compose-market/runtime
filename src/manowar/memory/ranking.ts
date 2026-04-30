import { applyDecayToResults } from "./decay.js";
import { mmrRerank } from "./mmr.js";
import {
    DEFAULT_TEMPORAL_DECAY_CONFIG,
    type HybridSearchParams,
    type SearchResult,
} from "./types.js";

const CLOUDFLARE_RERANK_MODEL_ID = process.env.MEMORY_RERANK_MODEL_ID || "@cf/baai/bge-reranker-base";
const RERANK_TIMEOUT_MS = Number(process.env.MEMORY_RERANK_TIMEOUT_MS || 3000);

interface CloudflareRerankResponse {
    success?: boolean;
    result?: {
        response?: Array<{ id?: number; score?: number }>;
    };
    errors?: Array<{ message?: string }>;
}

function cloudflareCredentials(): { apiKey: string; accountId: string } | null {
    const apiKey = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_KEY;
    const accountId = process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
    return apiKey && accountId ? { apiKey, accountId } : null;
}

async function callCloudflareReranker(params: {
    query: string;
    contexts: Array<{ text: string }>;
    topK: number;
}): Promise<Map<number, number>> {
    const credentials = cloudflareCredentials();
    if (!credentials) {
        throw new Error("Cloudflare rerank credentials are not configured");
    }

    const controller = new AbortController();
    const timeout = setTimeout(
        () => controller.abort(),
        Number.isFinite(RERANK_TIMEOUT_MS) ? Math.max(250, RERANK_TIMEOUT_MS) : 3000,
    );

    const startedAt = Date.now();
    try {
        const response = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/ai/run/${CLOUDFLARE_RERANK_MODEL_ID}`,
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${credentials.apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    query: params.query,
                    contexts: params.contexts,
                    top_k: params.topK,
                }),
                signal: controller.signal,
            },
        );

        const text = await response.text();
        if (!response.ok) {
            throw new Error(`Cloudflare reranker ${CLOUDFLARE_RERANK_MODEL_ID} failed: ${response.status} ${text}`);
        }

        const data = JSON.parse(text) as CloudflareRerankResponse;
        if (data.success === false) {
            const message = data.errors?.map((error) => error.message).filter(Boolean).join("; ") || "unknown error";
            throw new Error(`Cloudflare reranker ${CLOUDFLARE_RERANK_MODEL_ID} failed: ${message}`);
        }

        const scores = new Map<number, number>();
        for (const item of data.result?.response || []) {
            const id = item.id;
            if (Number.isInteger(id) && typeof item.score === "number" && Number.isFinite(item.score)) {
                scores.set(id as number, item.score);
            }
        }
        const elapsedMs = Date.now() - startedAt;
        console.log(`[memory:rerank] cf=${CLOUDFLARE_RERANK_MODEL_ID} q=${JSON.stringify(params.query.slice(0, 60))} contexts=${params.contexts.length} topK=${params.topK} scored=${scores.size} ms=${elapsedMs}`);
        return scores;
    } finally {
        clearTimeout(timeout);
    }
}

async function cloudflareRerank(params: {
    query: string;
    documents: Array<{ content: string; score?: number }>;
    topK?: number;
}): Promise<Array<{ content: string; score: number }>> {
    if (params.documents.length < 2) {
        return params.documents
            .map((doc) => ({ content: doc.content, score: doc.score ?? 0 }))
            .slice(0, params.topK || params.documents.length);
    }
    const limit = Math.max(1, params.topK || params.documents.length);
    const candidates = [...params.documents]
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, Math.max(limit, Math.min(params.documents.length, 24)));
    const scores = await callCloudflareReranker({
        query: params.query,
        contexts: candidates.map((doc) => ({ text: doc.content })),
        topK: limit,
    });
    if (scores.size === 0) {
        throw new Error(`Cloudflare reranker ${CLOUDFLARE_RERANK_MODEL_ID} returned no usable scores`);
    }

    return candidates
        .map((doc, index) => {
            const providerScore = scores.get(index);
            const baseScore = doc.score ?? 0;
            return {
                content: doc.content,
                score: typeof providerScore === "number"
                    ? providerScore + baseScore * 0.000001
                    : baseScore,
            };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
}

export async function rerankDocuments(params: {
    query: string;
    documents: Array<{ content: string; score?: number }>;
    topK?: number;
}): Promise<Array<{ content: string; score: number }>> {
    return cloudflareRerank(params);
}

export async function applyVectorRanking(params: {
    query: string;
    results: SearchResult[];
    options?: HybridSearchParams["options"];
}): Promise<SearchResult[]> {
    let ranked = [...params.results];

    if (params.options?.temporalDecay ?? true) {
        ranked = applyDecayToResults(ranked, DEFAULT_TEMPORAL_DECAY_CONFIG);
    }

    if (params.options?.rerank ?? true) {
        // Fail-soft: a rerank outage MUST NOT break agent memory retrieval.
        // If Cloudflare is down, missing creds, or returns empty scores, we
        // log + fall through to the decayed ordering.
        try {
            const reranked = await rerankDocuments({
                query: params.query,
                documents: ranked.map((item) => ({ content: item.content, score: item.score })),
                topK: ranked.length,
            });

            const byContent = new Map(reranked.map((item) => [item.content, item.score]));
            ranked = ranked.map((item) => ({ ...item, score: byContent.get(item.content) ?? item.score }));
        } catch (error) {
            console.warn(`[memory:rerank] rerank failed, falling back to decayed ordering: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    if (params.options?.mmr) {
        ranked = mmrRerank(ranked, { enabled: true, lambda: params.options.mmrLambda ?? 0.7 });
    }

    return ranked.sort((a, b) => b.score - a.score);
}
