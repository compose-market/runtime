import { applyDecayToResults } from "./decay.js";
import { mmrRerank } from "./mmr.js";
import {
    DEFAULT_TEMPORAL_DECAY_CONFIG,
    type HybridSearchParams,
    type SearchResult,
} from "./types.js";

export async function rerankDocuments(params: {
    query: string;
    documents: Array<{ content: string; score?: number }>;
    topK?: number;
}): Promise<Array<{ content: string; score: number }>> {
    const queryTerms = params.query.toLowerCase().split(/\s+/).filter(Boolean);

    const scored = params.documents.map((doc) => {
        const originalScore = doc.score ?? 0;
        const contentLower = doc.content.toLowerCase();

        const keywordBoost = queryTerms.reduce((boost, term) => {
            return boost + (contentLower.includes(term) ? 0.1 : 0);
        }, 0);

        const score = originalScore * 0.7 + keywordBoost * 0.3;
        return { content: doc.content, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, params.topK || scored.length);
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
        const reranked = await rerankDocuments({
            query: params.query,
            documents: ranked.map((item) => ({ content: item.content, score: item.score })),
            topK: ranked.length,
        });

        const byContent = new Map(reranked.map((item) => [item.content, item.score]));
        ranked = ranked.map((item) => ({ ...item, score: byContent.get(item.content) ?? item.score }));
    }

    if (params.options?.mmr) {
        ranked = mmrRerank(ranked, { enabled: true, lambda: params.options.mmrLambda ?? 0.7 });
    }

    return ranked.sort((a, b) => b.score - a.score);
}
