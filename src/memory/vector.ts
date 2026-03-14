import {
    CACHE_TTL_SECONDS,
    createContentHash,
    getCachedJson,
    getVectorQueryCacheKey,
    invalidateMemoryScope,
    setCachedJson,
} from "./cache.js";
import { getEmbedding } from "./embedding.js";
import { getMemoryVectorsCollection } from "./mongo.js";
import { applyVectorRanking } from "./ranking.js";
import {
    type HybridSearchParams,
    type MemoryVector,
    type SearchResult,
} from "./types.js";

export interface VectorSearchRequest {
    agentWallet: string;
    userId?: string;
    threadId?: string;
    query: string;
    queryEmbedding: number[];
    limit?: number;
    threshold?: number;
    applyDecay?: boolean;
}

export interface VectorIndexParams {
    agentWallet: string;
    userId?: string;
    threadId?: string;
    content: string;
    embedding: number[];
    source: MemoryVector["source"];
    metadata?: Record<string, unknown>;
    decayScore?: number;
}

function buildVectorFilter(params: {
    agentWallet: string;
    userId?: string;
    threadId?: string;
}): Record<string, unknown> {
    const filter: Record<string, unknown> = { agentWallet: params.agentWallet };
    if (params.userId) {
        filter.userId = params.userId;
    }
    if (params.threadId) {
        filter.threadId = params.threadId;
    }
    return filter;
}

function extractVectorIds(results: SearchResult[]): string[] {
    return results
        .map((item) => item.vectorId)
        .filter((value): value is string => typeof value === "string" && value.length > 0);
}

async function fallbackKeywordVectorSearch(params: VectorSearchRequest): Promise<SearchResult[]> {
    const vectors = await getMemoryVectorsCollection();
    const filter = buildVectorFilter({
        agentWallet: params.agentWallet,
        userId: params.userId,
        threadId: params.threadId,
    });

    const terms = params.query.toLowerCase().split(/\s+/).filter(Boolean);
    const docs = await vectors
        .find(filter)
        .sort({ createdAt: -1 })
        .limit(Math.max(100, (params.limit || 10) * 10))
        .toArray();

    const scored = docs
        .map((doc) => {
            const contentLower = doc.content.toLowerCase();
            const keywordHits = terms.reduce((acc, term) => acc + (contentLower.includes(term) ? 1 : 0), 0);
            const keywordScore = terms.length > 0 ? keywordHits / terms.length : 0;
            const score = keywordScore * 0.7 + (doc.decayScore || 1) * 0.3;

            return {
                id: doc.vectorId,
                vectorId: doc.vectorId,
                content: doc.content,
                score,
                source: doc.source,
                agentWallet: doc.agentWallet,
                userId: doc.userId,
                threadId: doc.threadId,
                decayScore: doc.decayScore,
                accessCount: doc.accessCount,
                createdAt: doc.createdAt,
            } satisfies SearchResult;
        })
        .filter((item) => item.score >= (params.threshold ?? 0));

    return scored.sort((a, b) => b.score - a.score).slice(0, params.limit || 10);
}

async function bumpVectorAccessCounts(vectorIds: string[]): Promise<void> {
    if (vectorIds.length === 0) {
        return;
    }

    const vectors = await getMemoryVectorsCollection();
    const now = Date.now();

    await vectors.updateMany(
        { vectorId: { $in: vectorIds } },
        { $inc: { accessCount: 1 }, $set: { lastAccessedAt: now, updatedAt: now } },
    );
}

export async function hybridVectorSearch(params: VectorSearchRequest): Promise<SearchResult[]> {
    const vectors = await getMemoryVectorsCollection();
    const limit = params.limit || 10;
    const threshold = params.threshold ?? 0.2;
    const filter = buildVectorFilter({
        agentWallet: params.agentWallet,
        userId: params.userId,
        threadId: params.threadId,
    });

    try {
        const pipeline: object[] = [
            {
                $vectorSearch: {
                    index: "vector_index",
                    path: "embedding",
                    queryVector: params.queryEmbedding,
                    numCandidates: limit * 20,
                    limit: limit * 4,
                    filter,
                },
            },
            {
                $addFields: {
                    rawScore: { $meta: "vectorSearchScore" },
                },
            },
            {
                $addFields: {
                    adjustedScore: params.applyDecay === false
                        ? "$rawScore"
                        : { $multiply: ["$rawScore", "$decayScore"] },
                },
            },
            {
                $match: {
                    adjustedScore: { $gte: threshold },
                },
            },
            {
                $sort: { adjustedScore: -1 },
            },
            {
                $limit: limit,
            },
        ];

        const rawResults = await vectors.aggregate<{
            vectorId: string;
            content: string;
            source: MemoryVector["source"];
            agentWallet: string;
            userId?: string;
            threadId?: string;
            decayScore: number;
            accessCount: number;
            createdAt: number;
            adjustedScore: number;
        }>(pipeline).toArray();

        const results = rawResults.map((item) => ({
            id: item.vectorId,
            vectorId: item.vectorId,
            content: item.content,
            score: item.adjustedScore,
            source: item.source,
            agentWallet: item.agentWallet,
            userId: item.userId,
            threadId: item.threadId,
            decayScore: item.decayScore,
            accessCount: item.accessCount,
            createdAt: item.createdAt,
        } satisfies SearchResult));

        await bumpVectorAccessCounts(extractVectorIds(results));
        return results;
    } catch (error) {
        console.warn("[memory:vector] vectorSearch unavailable, falling back to keyword search", error);
        const fallback = await fallbackKeywordVectorSearch(params);
        await bumpVectorAccessCounts(extractVectorIds(fallback));
        return fallback;
    }
}

export async function indexVector(params: VectorIndexParams): Promise<{ vectorId: string }> {
    const vectors = await getMemoryVectorsCollection();
    const now = Date.now();
    const contentHash = createContentHash(params.content);
    const vectorId = `vec_${params.agentWallet.slice(0, 8)}_${contentHash}_${now}`;

    await vectors.insertOne({
        vectorId,
        agentWallet: params.agentWallet,
        userId: params.userId,
        threadId: params.threadId,
        content: params.content,
        embedding: params.embedding,
        source: params.source,
        decayScore: params.decayScore ?? 1,
        accessCount: 0,
        lastAccessedAt: now,
        createdAt: now,
        updatedAt: now,
        metadata: params.metadata,
    });

    await invalidateMemoryScope({
        agentWallet: params.agentWallet,
        userId: params.userId,
        threadId: params.threadId,
    });

    return { vectorId };
}

export async function indexMemoryContent(params: {
    content: string;
    agentWallet: string;
    userId?: string;
    threadId?: string;
    source: MemoryVector["source"];
    metadata?: Record<string, unknown>;
}): Promise<{ success: boolean; vectorId?: string }> {
    const embedding = await getEmbedding(params.content);
    const indexed = await indexVector({
        agentWallet: params.agentWallet,
        userId: params.userId,
        threadId: params.threadId,
        content: params.content,
        embedding: embedding.embedding,
        source: params.source,
        metadata: params.metadata,
    });

    return {
        success: true,
        vectorId: indexed.vectorId,
    };
}

export async function searchVectors(params: HybridSearchParams): Promise<SearchResult[]> {
    const {
        query,
        agentWallet,
        userId,
        threadId,
        limit = 10,
        threshold,
        options,
    } = params;

    const cacheKey = getVectorQueryCacheKey({
        query,
        agentWallet,
        userId,
        threadId,
        limit,
        threshold,
        options,
    });

    const cached = await getCachedJson<SearchResult[]>(cacheKey);
    if (Array.isArray(cached) && cached.length > 0) {
        await bumpVectorAccessCounts(extractVectorIds(cached));
        return cached;
    }

    const queryEmbedding = await getEmbedding(query);

    const rawResults = await hybridVectorSearch({
        query,
        queryEmbedding: queryEmbedding.embedding,
        agentWallet,
        userId,
        threadId,
        limit: limit * 2,
        threshold,
        applyDecay: false,
    });

    const ranked = await applyVectorRanking({
        query,
        results: rawResults,
        options,
    });

    const finalResults = ranked.slice(0, limit);
    await setCachedJson(cacheKey, finalResults, CACHE_TTL_SECONDS.vectorQuery);

    return finalResults;
}
