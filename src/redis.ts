import { createClient, type RedisClientType } from "redis";

let client: RedisClientType | null = null;
let connectionPromise: Promise<RedisClientType> | null = null;

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
    const endpoint = process.env.REDIS_MEMORY_DATABASE_PUBLIC_ENDPOINT;
    const password = process.env.REDIS_API_KEY || process.env.REDIS_MEMORY_DEFAULT_PASSWORD;
    const useTls = process.env.REDIS_TLS === "true";

    if (!endpoint) {
        throw new Error("REDIS_MEMORY_DATABASE_PUBLIC_ENDPOINT required");
    }

    const [host, portStr] = endpoint.split(":");
    const port = parseInt(portStr, 10) || 6379;

    console.log(`[redis] Connecting to ${host}:${port} (TLS: ${useTls})`);

    client = createClient({
        socket: useTls ? { host, port, tls: true as const } : { host, port },
        password,
    });

    client.on("error", (err) => console.error("[redis] Error:", err));
    client.on("reconnecting", () => console.log("[redis] Reconnecting..."));

    await client.connect();
    console.log("[redis] Connected");

    return client;
}

export async function closeRedis(): Promise<void> {
    if (client?.isOpen) {
        await client.quit();
        client = null;
        connectionPromise = null;
        console.log("[redis] Closed");
    }
}

export async function redisSet(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const redis = await getRedisClient();
    if (ttlSeconds) {
        await redis.setEx(key, ttlSeconds, value);
    } else {
        await redis.set(key, value);
    }
}

export async function redisGet(key: string): Promise<string | null> {
    const redis = await getRedisClient();
    return redis.get(key);
}

export async function redisDel(key: string): Promise<boolean> {
    const redis = await getRedisClient();
    return (await redis.del(key)) > 0;
}

export async function redisSetJSON(key: string, value: object, ttlSeconds?: number): Promise<void> {
    await redisSet(key, JSON.stringify(value), ttlSeconds);
}

export async function redisGetJSON<T>(key: string): Promise<T | null> {
    const raw = await redisGet(key);
    if (!raw) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

export function createContentHash(content: string): string {
    const crypto = require("crypto");
    return crypto.createHash("sha256").update(content).digest("hex").slice(0, 32);
}