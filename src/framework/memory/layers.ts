import {
    CACHE_TTL_SECONDS,
    getCachedJson,
    getLayerQueryCacheKey,
    setCachedJson,
} from "./cache.js";
import {
    getArchivesCollection,
    getPatternsCollection,
    getSessionsCollection,
    getSessionTranscriptsCollection,
} from "./mongo.js";
import { searchMemory } from "./mem0.js";
import { searchVectors } from "./vector.js";
import type {
    LayeredSearchParams,
    LayeredSearchResult,
    MemoryArchive,
    ProceduralPattern,
    SessionMemory,
    SessionTranscript,
} from "./types.js";

function ensureLayers(input: LayeredSearchParams["layers"]): LayeredSearchParams["layers"] {
    if (!input || input.length === 0) {
        return ["working", "scene", "graph", "patterns", "archives", "vectors"];
    }
    return input;
}

function matchesQuery(text: string | undefined, query: string): boolean {
    if (!text) {
        return false;
    }
    return text.toLowerCase().includes(query.toLowerCase());
}

function summarizeSessionMemory(record: SessionMemory): Record<string, unknown> {
    return {
        sessionId: record.sessionId,
        context: record.workingMemory.context.slice(0, 5),
        entities: record.workingMemory.entities,
        state: record.workingMemory.state,
        lastAccessedAt: record.lastAccessedAt,
    };
}

function summarizeTranscript(record: SessionTranscript): Record<string, unknown> {
    return {
        sessionId: record.sessionId,
        threadId: record.threadId,
        messageCount: record.messages.length,
        summary: record.summary,
        latestMessages: record.messages.slice(-5),
        tokenCount: record.tokenCount,
        createdAt: record.createdAt,
    };
}

function summarizePattern(record: ProceduralPattern): Record<string, unknown> {
    return {
        patternId: record.patternId,
        summary: record.summary,
        trigger: record.trigger,
        steps: record.steps,
        successRate: record.successRate,
        executionCount: record.executionCount,
        lastExecuted: record.lastExecuted,
    };
}

function summarizeArchive(record: MemoryArchive): Record<string, unknown> {
    return {
        archiveId: record.archiveId,
        summary: record.summary,
        dateRange: record.dateRange,
        metadata: record.metadata,
        ipfsCid: record.ipfsCid,
        createdAt: record.createdAt,
    };
}

export function buildWorkingLayerFilter(params: Pick<LayeredSearchParams, "agentWallet" | "userId" | "threadId">): Record<string, unknown> {
    const filter: Record<string, unknown> = { agentWallet: params.agentWallet };
    if (params.userId) {
        filter.userId = params.userId;
    }
    if (params.threadId) {
        filter.threadId = params.threadId;
    }
    return filter;
}

export function buildSceneLayerFilter(params: Pick<LayeredSearchParams, "agentWallet" | "userId" | "threadId">): Record<string, unknown> {
    const filter: Record<string, unknown> = { agentWallet: params.agentWallet };
    if (params.userId) {
        filter.userId = params.userId;
    }
    if (params.threadId) {
        filter.threadId = params.threadId;
    }
    return filter;
}

export async function searchMemoryLayers(params: LayeredSearchParams): Promise<LayeredSearchResult> {
    const limit = params.limit || 5;
    const layers = ensureLayers(params.layers);
    const cacheKey = getLayerQueryCacheKey({
        query: params.query,
        agentWallet: params.agentWallet,
        userId: params.userId,
        threadId: params.threadId,
        layers,
        limit,
    });

    const cached = await getCachedJson<LayeredSearchResult>(cacheKey);
    if (cached) {
        return cached;
    }

    const result: LayeredSearchResult = {
        query: params.query,
        layers: {},
        totals: {},
    };
    const disableVectorLocalRanking = layers.includes("graph") && layers.includes("vectors");

    if (layers.includes("working")) {
        const sessions = await getSessionsCollection();
        const docs = await sessions.find(buildWorkingLayerFilter(params)).sort({ lastAccessedAt: -1 }).limit(limit * 3).toArray();
        const filtered = docs
            .filter((doc) => matchesQuery(doc.workingMemory.context.join("\n"), params.query))
            .slice(0, limit)
            .map(summarizeSessionMemory);

        result.layers.working = filtered;
        result.totals.working = filtered.length;
    }

    if (layers.includes("scene")) {
        const transcripts = await getSessionTranscriptsCollection();
        const docs = await transcripts.find(buildSceneLayerFilter(params)).sort({ createdAt: -1 }).limit(limit * 3).toArray();
        const filtered = docs
            .filter((doc) => {
                const transcriptText = doc.messages.map((msg) => msg.content).join("\n");
                return matchesQuery(transcriptText, params.query) || matchesQuery(doc.summary, params.query);
            })
            .slice(0, limit)
            .map(summarizeTranscript);

        result.layers.scene = filtered;
        result.totals.scene = filtered.length;
    }

    if (layers.includes("graph")) {
        const memories = await searchMemory({
            query: params.query,
            agent_id: params.agentWallet,
            user_id: params.userId,
            run_id: params.threadId,
            limit,
            enable_graph: true,
            rerank: true,
        });

        result.layers.graph = memories;
        result.totals.graph = memories.length;
    }

    if (layers.includes("patterns")) {
        const patterns = await getPatternsCollection();
        const docs = await patterns.find({ agentWallet: params.agentWallet }).sort({ successRate: -1 }).limit(limit * 4).toArray();
        const filtered = docs
            .filter((doc) => matchesQuery(doc.summary, params.query) || matchesQuery(doc.trigger.value, params.query))
            .slice(0, limit)
            .map(summarizePattern);

        result.layers.patterns = filtered;
        result.totals.patterns = filtered.length;
    }

    if (layers.includes("archives")) {
        const archives = await getArchivesCollection();
        const docs = await archives.find({ agentWallet: params.agentWallet }).sort({ createdAt: -1 }).limit(limit * 4).toArray();
        const filtered = docs
            .filter((doc) => matchesQuery(doc.summary, params.query) || matchesQuery(doc.content, params.query))
            .slice(0, limit)
            .map(summarizeArchive);

        result.layers.archives = filtered;
        result.totals.archives = filtered.length;
    }

    if (layers.includes("vectors")) {
        const vectors = await searchVectors({
            query: params.query,
            agentWallet: params.agentWallet,
            userId: params.userId,
            threadId: params.threadId,
            limit,
            options: {
                temporalDecay: disableVectorLocalRanking ? false : true,
                rerank: disableVectorLocalRanking ? false : true,
                mmr: disableVectorLocalRanking ? false : true,
                mmrLambda: 0.7,
            },
        });

        result.layers.vectors = vectors;
        result.totals.vectors = vectors.length;
    }

    await setCachedJson(cacheKey, result, CACHE_TTL_SECONDS.layerQuery);
    return result;
}
