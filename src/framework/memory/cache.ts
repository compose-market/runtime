import { createHash } from "node:crypto";
import { createClient, type RedisClientType } from "redis";

const DEFAULT_VECTOR_QUERY_TTL_SECONDS = Number(process.env.MEMORY_VECTOR_QUERY_CACHE_TTL_SECONDS || 120);
const DEFAULT_LAYER_QUERY_TTL_SECONDS = Number(process.env.MEMORY_LAYER_QUERY_CACHE_TTL_SECONDS || 120);
const DEFAULT_GRAPH_QUERY_TTL_SECONDS = Number(process.env.MEMORY_GRAPH_QUERY_CACHE_TTL_SECONDS || 120);
const DEFAULT_REDIS_CONNECT_TIMEOUT_MS = Number(process.env.MEMORY_REDIS_CONNECT_TIMEOUT_MS || 2000);
const GLOBAL_MEMORY_NAMESPACE_KEY = "memory:ns:global";

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

export function createContentHash(content: string): string {
    return createHash("sha256").update(content).digest("hex").slice(0, 32);
}

function buildNamespaceKey(scope: MemoryScope): string {
    return `memory:ns:${buildScopeKey({
        agentWallet: scope.agentWallet || "_",
        userAddress: scope.userAddress,
        threadId: scope.threadId,
    })}`;
}

function buildNamespaceChain(scope: { agentWallet: string; userAddress?: string; threadId?: string }): string[] {
    const keys = [
        GLOBAL_MEMORY_NAMESPACE_KEY,
        buildNamespaceKey({ agentWallet: scope.agentWallet }),
    ];

    if (scope.userAddress) {
        keys.push(buildNamespaceKey({
            agentWallet: scope.agentWallet,
            userAddress: scope.userAddress,
        }));
    }

    if (scope.threadId) {
        keys.push(buildNamespaceKey({
            agentWallet: scope.agentWallet,
            userAddress: scope.userAddress,
            threadId: scope.threadId,
        }));
    }

    return [...new Set(keys)];
}

async function getNamespaceToken(scope: { agentWallet: string; userAddress?: string; threadId?: string }): Promise<string> {
    try {
        const redis = await getRedisClient();
        const keys = buildNamespaceChain(scope);
        const values = await redis.mGet(keys);
        return createContentHash(values.map((value) => value || "0").join("|"));
    } catch {
        return "0";
    }
}

export async function resolveScopedCacheKey(
    key: string,
    scope: { agentWallet: string; userAddress?: string; threadId?: string },
): Promise<string> {
    const namespaceToken = await getNamespaceToken(scope);
    return `${key}:ns:${namespaceToken}`;
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

    connectionPromise = connect().catch((error) => {
        connectionPromise = null;
        throw error;
    });
    return connectionPromise;
}

async function connect(): Promise<RedisClientType> {
    const { endpoint, password, useTls } = resolveMemoryRedisConnectionConfig();

    const [host, portStr] = endpoint.split(":");
    const port = parseInt(portStr, 10) || 6379;

    console.log(`[memory:cache] Connecting to ${host}:${port} (TLS: ${useTls})`);

    client = createClient({
        socket: useTls
            ? {
                host,
                port,
                tls: true as const,
                connectTimeout: DEFAULT_REDIS_CONNECT_TIMEOUT_MS,
                reconnectStrategy: (retries) => Math.min(retries * 50, 500),
            }
            : {
                host,
                port,
                connectTimeout: DEFAULT_REDIS_CONNECT_TIMEOUT_MS,
                reconnectStrategy: (retries) => Math.min(retries * 50, 500),
            },
        password,
    });

    client.on("error", (err) => console.error("[memory:cache] Redis error:", err));
    client.on("reconnecting", () => console.log("[memory:cache] Redis reconnecting..."));
    client.on("end", () => {
        if (client && !client.isOpen) {
            client = null;
        }
    });

    await client.connect();
    connectionPromise = null;
    console.log("[memory:cache] Redis connected");

    return client;
}

export async function warmMemoryCache(): Promise<boolean> {
    try {
        await getRedisClient();
        return true;
    } catch (error) {
        console.warn("[memory:cache] warmMemoryCache failed", error);
        return false;
    }
}

export async function closeRedis(): Promise<void> {
    if (client?.isOpen) {
        await client.quit();
        client = null;
        connectionPromise = null;
        console.log("[memory:cache] Redis closed");
    }
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
        const key = scope.agentWallet
            ? buildNamespaceKey(scope)
            : GLOBAL_MEMORY_NAMESPACE_KEY;
        const nextValue = await redis.incr(key);
        if (nextValue === 1) {
            await redis.expire(key, Math.max(
                CACHE_TTL_SECONDS.vectorQuery,
                CACHE_TTL_SECONDS.layerQuery,
                CACHE_TTL_SECONDS.graphQuery,
            ) * 4);
        }
        return 1;
    } catch (error) {
        console.warn("[memory:cache] invalidateMemoryScope failed", error);
        return 0;
    }
}
