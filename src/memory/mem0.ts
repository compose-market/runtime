import * as mem0ai from "mem0ai";
import {
    CACHE_TTL_SECONDS,
    getCachedJson,
    getGraphQueryCacheKey,
    invalidateMemoryScope,
    setCachedJson,
} from "./cache.js";
import type {
    KnowledgeAddParams,
    MemoryAddParams,
    MemoryItem,
    MemorySearchParams,
} from "./types.js";

const MEM0_API_KEY = process.env.MEM0_API_KEY;

if (!MEM0_API_KEY) {
    console.warn("[memory:mem0] MEM0_API_KEY is not set; graph memory operations will be no-op.");
}

type Mem0Client = any;

let mem0Client: Mem0Client | null = null;

function getMem0Client(): Mem0Client | null {
    if (mem0Client) {
        return mem0Client;
    }

    if (!MEM0_API_KEY) {
        return null;
    }

    try {
        const MemoryClass = (mem0ai as any).MemoryClient || (mem0ai as any).default?.MemoryClient;
        if (typeof MemoryClass !== "function") {
            console.error("[memory:mem0] MemoryClient export not found", Object.keys(mem0ai));
            return null;
        }

        mem0Client = new MemoryClass({ apiKey: MEM0_API_KEY });
        return mem0Client;
    } catch (error) {
        console.error("[memory:mem0] failed to initialize client", error);
        return null;
    }
}

export async function addMemory(params: MemoryAddParams): Promise<MemoryItem[]> {
    const client = getMem0Client();
    if (!client) {
        return [];
    }

    try {
        const result = await client.add(params.messages, {
            user_id: params.user_id,
            agent_id: params.agent_id,
            run_id: params.run_id,
            metadata: params.metadata,
            enable_graph: params.enable_graph ?? false,
        });
        await invalidateMemoryScope({
            agentWallet: params.agent_id,
            userId: params.user_id,
            threadId: params.run_id,
        });
        return result as MemoryItem[];
    } catch (error) {
        console.error("[memory:mem0] add failed", error);
        return [];
    }
}

export async function addKnowledge(params: KnowledgeAddParams): Promise<MemoryItem[]> {
    const client = getMem0Client();
    if (!client) {
        return [];
    }

    try {
        const messages = [
            { role: "user", content: `Store this knowledge document (key: ${params.key || "unknown"}): ${params.content}` },
            { role: "assistant", content: "I have stored this knowledge document." },
        ];

        const result = await client.add(messages, {
            agent_id: params.agent_id,
            user_id: params.user_id,
            metadata: {
                type: "knowledge",
                key: params.key,
                source: params.source || "paste",
                ...params.metadata,
            },
            enable_graph: params.enable_graph ?? true,
        });
        await invalidateMemoryScope({
            agentWallet: params.agent_id,
            userId: params.user_id,
        });
        return result as MemoryItem[];
    } catch (error) {
        console.error("[memory:mem0] addKnowledge failed", error);
        return [];
    }
}

export async function searchMemory(params: MemorySearchParams): Promise<MemoryItem[]> {
    const client = getMem0Client();
    if (!client) {
        return [];
    }

    const cacheKey = getGraphQueryCacheKey({
        query: params.query,
        agentWallet: params.agent_id || "unknown",
        userId: params.user_id,
        threadId: params.run_id,
        limit: params.limit,
        rerank: params.rerank,
        enableGraph: params.enable_graph,
        filters: typeof params.filters === "object" && params.filters ? params.filters : undefined,
    });

    const cached = await getCachedJson<MemoryItem[]>(cacheKey);
    if (Array.isArray(cached)) {
        return cached;
    }

    try {
        const result = await client.search(params.query, {
            user_id: params.user_id,
            agent_id: params.agent_id,
            run_id: params.run_id,
            limit: params.limit,
            filters: params.filters,
            enable_graph: params.enable_graph ?? false,
            rerank: params.rerank,
            keyword_search: params.keyword_search,
            v2_filters: params.v2_filters,
            custom_categories: params.custom_categories,
        });
        const typedResult = result as MemoryItem[];
        await setCachedJson(cacheKey, typedResult, CACHE_TTL_SECONDS.graphQuery);
        return typedResult;
    } catch (error) {
        console.error("[memory:mem0] search failed", error);
        return [];
    }
}

export async function getAllMemories(options?: {
    user_id?: string;
    agent_id?: string;
    run_id?: string;
    limit?: number;
    enable_graph?: boolean;
}): Promise<MemoryItem[]> {
    const client = getMem0Client();
    if (!client) {
        return [];
    }

    try {
        const result = await client.getAll({
            user_id: options?.user_id,
            agent_id: options?.agent_id,
            run_id: options?.run_id,
            limit: options?.limit,
            enable_graph: options?.enable_graph ?? false,
        });
        return result as MemoryItem[];
    } catch (error) {
        console.error("[memory:mem0] getAll failed", error);
        return [];
    }
}
