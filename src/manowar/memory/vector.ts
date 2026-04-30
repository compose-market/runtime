import {
    CACHE_TTL_SECONDS,
    createContentHash,
    getCachedJson,
    getVectorQueryCacheKey,
    invalidateMemoryScope,
    resolveScopedCacheKey,
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
import {
    matchesMemoryFilters,
} from "./filters.js";
import { buildScopedMemoryFilter } from "./utils.js";

export interface VectorSearchRequest {
    agentWallet: string;
    userAddress?: string;
    threadId?: string;
    mode?: "global" | "local";
    haiId?: string;
    filters?: Record<string, unknown>;
    query: string;
    queryEmbedding: number[];
    limit?: number;
    threshold?: number;
    applyDecay?: boolean;
}

export interface VectorIndexParams {
    agentWallet: string;
    userAddress?: string;
    threadId?: string;
    mode?: "global" | "local";
    haiId?: string;
    content: string;
    embedding: number[];
    source: MemoryVector["source"];
    metadata?: Record<string, unknown>;
    decayScore?: number;
}

function buildVectorFilter(params: {
    agentWallet: string;
    userAddress?: string;
    threadId?: string;
    mode?: "global" | "local";
    haiId?: string;
    filters?: Record<string, unknown>;
}): Record<string, unknown> {
    return buildScopedMemoryFilter(params, { activeOnly: true });
}

function buildAtlasVectorPrefilter(filter: Record<string, unknown>): Record<string, unknown> | undefined {
    const configuredFields = String(process.env.MEMORY_VECTOR_PREFILTER_FIELDS || "")
        .split(",")
        .map((field) => field.trim())
        .filter(Boolean);
    if (configuredFields.length === 0) {
        return undefined;
    }

    const prefilter: Record<string, unknown> = {};
    for (const field of configuredFields) {
        if (filter[field] !== undefined) {
            prefilter[field] = filter[field];
        }
    }
    return Object.keys(prefilter).length > 0 ? prefilter : undefined;
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
        userAddress: params.userAddress,
        threadId: params.threadId,
        mode: params.mode,
        haiId: params.haiId,
        filters: params.filters,
    });

    const terms = params.query.toLowerCase().split(/\s+/).filter(Boolean);
    const docs = await vectors
        .find(filter)
        .sort({ createdAt: -1 })
        .limit(Math.max(100, (params.limit || 10) * 10))
        .toArray();

    const scored = docs
        .filter((doc) => matchesMemoryFilters(doc, params.filters))
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
                userAddress: doc.userAddress,
                threadId: doc.threadId,
                mode: doc.mode,
                haiId: doc.haiId,
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
        userAddress: params.userAddress,
        threadId: params.threadId,
        mode: params.mode,
        haiId: params.haiId,
        filters: params.filters,
    });
    const searchLimit = limit * (params.filters ? 8 : 4);
    const vectorLimit = Math.max(searchLimit, Math.min(500, searchLimit * 10));
    const vectorSearch: Record<string, unknown> = {
        index: "vector_index",
        path: "embedding",
        queryVector: params.queryEmbedding,
        numCandidates: vectorLimit * 20,
        limit: vectorLimit,
    };
    const prefilter = buildAtlasVectorPrefilter(filter);
    if (prefilter) {
        vectorSearch.filter = prefilter;
    }

    try {
        const pipeline: object[] = [
            {
                $vectorSearch: vectorSearch,
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
                    ...filter,
                    adjustedScore: { $gte: threshold },
                },
            },
            {
                $sort: { adjustedScore: -1 },
            },
            {
                    $limit: searchLimit,
            },
        ];

        const rawResults = await vectors.aggregate<{
            vectorId: string;
            content: string;
            source: MemoryVector["source"];
            agentWallet: string;
            userAddress?: string;
            threadId?: string;
            mode?: "global" | "local";
            haiId?: string;
            decayScore: number;
            accessCount: number;
            createdAt: number;
            metadata?: Record<string, unknown>;
            adjustedScore: number;
        }>(pipeline).toArray();

        const results = rawResults.filter((item) => matchesMemoryFilters(item, params.filters)).slice(0, limit).map((item) => ({
            id: item.vectorId,
            vectorId: item.vectorId,
            content: item.content,
            score: item.adjustedScore,
            source: item.source,
            agentWallet: item.agentWallet,
            userAddress: item.userAddress,
            threadId: item.threadId,
            mode: item.mode,
            haiId: item.haiId,
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
        userAddress: params.userAddress,
        threadId: params.threadId,
        mode: params.mode,
        haiId: params.haiId,
        content: params.content,
        embedding: params.embedding,
        source: params.source,
        decayScore: params.decayScore ?? 1,
        accessCount: 0,
        lastAccessedAt: now,
        createdAt: now,
        updatedAt: now,
        scopeKind: params.mode,
        scopeId: params.haiId ?? params.agentWallet,
        metadata: params.metadata,
    });

    await invalidateMemoryScope({
        agentWallet: params.agentWallet,
        userAddress: params.userAddress,
        threadId: params.threadId,
        mode: params.mode,
        haiId: params.haiId,
    });

    return { vectorId };
}

export async function indexMemoryContent(params: {
    content: string;
    agentWallet: string;
    userAddress?: string;
    threadId?: string;
    mode?: "global" | "local";
    haiId?: string;
    source: MemoryVector["source"];
    metadata?: Record<string, unknown>;
}): Promise<{ success: boolean; vectorId?: string }> {
    const embedding = await getEmbedding(params.content);
    const indexed = await indexVector({
        agentWallet: params.agentWallet,
        userAddress: params.userAddress,
        threadId: params.threadId,
        mode: params.mode,
        haiId: params.haiId,
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
        userAddress,
        threadId,
        limit = 10,
        threshold,
        options,
    } = params;

    const cacheKey = await resolveScopedCacheKey(getVectorQueryCacheKey({
        query,
        agentWallet,
        userAddress,
        threadId,
        mode: params.mode,
        haiId: params.haiId,
        filters: params.filters,
        limit,
        threshold,
        options,
    }), {
        agentWallet,
        userAddress,
        threadId,
        mode: params.mode,
        haiId: params.haiId,
    });

    const cached = await getCachedJson<SearchResult[]>(cacheKey);
    if (Array.isArray(cached)) {
        await bumpVectorAccessCounts(extractVectorIds(cached));
        return cached;
    }

    const queryEmbedding = await getEmbedding(query);

    const rawResults = await hybridVectorSearch({
        query,
        queryEmbedding: queryEmbedding.embedding,
        agentWallet,
        userAddress,
        threadId,
        mode: params.mode,
        haiId: params.haiId,
        filters: params.filters,
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
