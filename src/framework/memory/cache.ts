import { createHash } from "node:crypto";
import { createClient, type RedisClientType } from "redis";

const DEFAULT_VECTOR_QUERY_TTL_SECONDS = Number(process.env.MEMORY_VECTOR_QUERY_CACHE_TTL_SECONDS || 120);
const DEFAULT_LAYER_QUERY_TTL_SECONDS = Number(process.env.MEMORY_LAYER_QUERY_CACHE_TTL_SECONDS || 120);
const DEFAULT_GRAPH_QUERY_TTL_SECONDS = Number(process.env.MEMORY_GRAPH_QUERY_CACHE_TTL_SECONDS || 120);

export const CACHE_TTL_SECONDS = {
    vectorQuery: Number.isFinite(DEFAULT_VECTOR_QUERY_TTL_SECONDS) ? Math.max(1, DEFAULT_VECTOR_QUERY_TTL_SECONDS) : 120,
    layerQuery: Number.isFinite(DEFAULT_LAYER_QUERY_TTL_SECONDS) ? Math.max(1, DEFAULT_LAYER_QUERY_TTL_SECONDS) : 120,
    graphQuery: Number.isFinite(DEFAULT_GRAPH_QUERY_TTL_SECONDS) ? Math.max(1, DEFAULT_GRAPH_QUERY_TTL_SECONDS) : 120,
};

let client: RedisClientType | null = null;
let connectionPromise: Promise<RedisClientType> | null = null;

export function resolveMemoryRedisConnectionConfig(env: NodeJS.ProcessEnv = process.env): {
    endpoint: string;
    password: string;
    useTls: boolean;
} {
    const endpoint = env.REDIS_MEMORY_DATABASE_PUBLIC_ENDPOINT;
    const password = env.REDIS_MEMORY_DEFAULT_PASSWORD;
    const useTls = env.REDIS_TLS === "true";

    if (!endpoint) {
        throw new Error("REDIS_MEMORY_DATABASE_PUBLIC_ENDPOINT required");
    }
    if (!password) {
        throw new Error("REDIS_MEMORY_DEFAULT_PASSWORD required");
    }

    return {
        endpoint,
        password,
        useTls,
    };
}

export interface MemoryScope {
    agentWallet?: string;
    userAddress?: string;
    threadId?: string;
}

function normalizeScopePart(value: string | undefined): string {
    if (!value || value.trim().length === 0) return "_";
    return encodeURIComponent(value.trim().toLowerCase());
}

function buildScopeKey(scope: { agentWallet: string; userAddress?: string; threadId?: string }): string {
    return `a:${normalizeScopePart(scope.agentWallet)}:u:${normalizeScopePart(scope.userAddress)}:t:${normalizeScopePart(scope.threadId)}`;
}

function buildScopePattern(scope: MemoryScope): string {
    const agentPart = scope.agentWallet ? normalizeScopePart(scope.agentWallet) : "*";
    const userPart = scope.userAddress ? normalizeScopePart(scope.userAddress) : "*";
    const threadPart = scope.threadId ? normalizeScopePart(scope.threadId) : "*";
    return `a:${agentPart}:u:${userPart}:t:${threadPart}`;
}

export function createContentHash(content: string): string {
    return createHash("sha256").update(content).digest("hex").slice(0, 32);
}

export function getVectorQueryCacheKey(input: {
    query: string;
    agentWallet: string;
    userAddress?: string;
    threadId?: string;
    limit?: number;
    threshold?: number;
    options?: Record<string, unknown>;
}): string {
    const scopeKey = buildScopeKey(input);
    const payload = JSON.stringify({
        query: input.query,
        limit: input.limit ?? 10,
        threshold: input.threshold ?? null,
        options: input.options || {},
    });
    return `memory:query:vector:${scopeKey}:${createContentHash(payload)}`;
}

export function getLayerQueryCacheKey(input: {
    query: string;
    agentWallet: string;
    userAddress?: string;
    threadId?: string;
    layers: string[];
    limit?: number;
}): string {
    const scopeKey = buildScopeKey(input);
    const payload = JSON.stringify({
        query: input.query,
        layers: [...input.layers].sort(),
        limit: input.limit ?? 5,
    });
    return `memory:query:layers:${scopeKey}:${createContentHash(payload)}`;
}

export function getGraphQueryCacheKey(input: {
    query: string;
    agentWallet: string;
    userAddress?: string;
    threadId?: string;
    limit?: number;
    rerank?: boolean;
    enableGraph?: boolean;
    filters?: Record<string, unknown>;
}): string {
    const scopeKey = buildScopeKey(input);
    const payload = JSON.stringify({
        query: input.query,
        limit: input.limit ?? 10,
        rerank: input.rerank ?? false,
        enableGraph: input.enableGraph ?? false,
        filters: input.filters || {},
    });
    return `memory:query:graph:${scopeKey}:${createContentHash(payload)}`;
}

export async function getRedisClient(): Promise<RedisClientType> {
    if (client?.isOpen) {
        return client;
    }

    if (connectionPromise) {
        return connectionPromise;
    }

    connectionPromise = connect();
    return connectionPromise;
}

async function connect(): Promise<RedisClientType> {
    const { endpoint, password, useTls } = resolveMemoryRedisConnectionConfig();

    const [host, portStr] = endpoint.split(":");
    const port = parseInt(portStr, 10) || 6379;

    console.log(`[memory:cache] Connecting to ${host}:${port} (TLS: ${useTls})`);

    client = createClient({
        socket: useTls ? { host, port, tls: true as const } : { host, port },
        password,
    });

    client.on("error", (err) => console.error("[memory:cache] Redis error:", err));
    client.on("reconnecting", () => console.log("[memory:cache] Redis reconnecting..."));

    await client.connect();
    console.log("[memory:cache] Redis connected");

    return client;
}

export async function closeRedis(): Promise<void> {
    if (client?.isOpen) {
        await client.quit();
        client = null;
        connectionPromise = null;
        console.log("[memory:cache] Redis closed");
    }
}

async function scanKeysByPattern(redis: RedisClientType, pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = "0";
    do {
        const result = await redis.scan(cursor, {
            MATCH: pattern,
            COUNT: 250,
        });
        cursor = result.cursor;
        if (result.keys.length > 0) {
            keys.push(...result.keys);
        }
    } while (cursor !== "0");

    return keys;
}

export async function getCachedJson<T>(key: string): Promise<T | null> {
    try {
        const redis = await getRedisClient();
        const raw = await redis.get(key);
        if (!raw) return null;
        return JSON.parse(raw) as T;
    } catch (error) {
        console.warn(`[memory:cache] getCachedJson failed for key ${key}`, error);
        return null;
    }
}

export async function setCachedJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
        const redis = await getRedisClient();
        await redis.setEx(key, Math.max(1, ttlSeconds), JSON.stringify(value));
    } catch (error) {
        console.warn(`[memory:cache] setCachedJson failed for key ${key}`, error);
    }
}

export async function invalidateMemoryScope(scope: MemoryScope): Promise<number> {
    try {
        const redis = await getRedisClient();
        const scopePattern = buildScopePattern(scope);
        const patterns = [
            `memory:query:vector:${scopePattern}:*`,
            `memory:query:layers:${scopePattern}:*`,
            `memory:query:graph:${scopePattern}:*`,
        ];

        let deleted = 0;
        for (const pattern of patterns) {
            const keys = await scanKeysByPattern(redis, pattern);
            if (keys.length === 0) continue;
            deleted += await redis.del(keys);
        }
        return deleted;
    } catch (error) {
        console.warn("[memory:cache] invalidateMemoryScope failed", error);
        return 0;
    }
}
