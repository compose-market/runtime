import { RedisSaver } from "@langchain/langgraph-checkpoint-redis";
import { createClient, type RedisClientType } from "redis";

let redisSaver: RedisSaver | null = null;
let client: RedisClientType | null = null;

export async function getRedisCheckpointSaver(): Promise<RedisSaver> {
    if (redisSaver) return redisSaver;

    const endpoint = process.env.REDIS_MEMORY_DATABASE_PUBLIC_ENDPOINT;
    const password = process.env.REDIS_API_KEY || process.env.REDIS_MEMORY_DEFAULT_PASSWORD;
    const useTls = process.env.REDIS_TLS === "true";

    if (!endpoint) {
        throw new Error("REDIS_MEMORY_DATABASE_PUBLIC_ENDPOINT required for checkpoint");
    }

    const [host, portStr] = endpoint.split(":");
    const port = parseInt(portStr, 10) || 6379;

    const url = useTls
        ? `rediss://${password ? `:${password}@` : ""}${host}:${port}`
        : `redis://${password ? `:${password}@` : ""}${host}:${port}`;

    redisSaver = await RedisSaver.fromUrl(url, {
        defaultTTL: 10080, // 7 days in minutes
        refreshOnRead: true,
    });

    console.log(`[checkpoint] Redis saver initialized: ${host}:${port}`);
    return redisSaver;
}

export async function getRedisClient(): Promise<RedisClientType> {
    if (client?.isOpen) return client;

    const endpoint = process.env.REDIS_MEMORY_DATABASE_PUBLIC_ENDPOINT;
    const password = process.env.REDIS_API_KEY || process.env.REDIS_MEMORY_DEFAULT_PASSWORD;
    const useTls = process.env.REDIS_TLS === "true";

    if (!endpoint) {
        throw new Error("REDIS_MEMORY_DATABASE_PUBLIC_ENDPOINT required");
    }

    const [host, portStr] = endpoint.split(":");
    const port = parseInt(portStr, 10) || 6379;

    client = createClient({
        socket: useTls ? { host, port, tls: true as const } : { host, port },
        password,
    });

    client.on("error", (err) => console.error("[redis-checkpoint] Error:", err));
    await client.connect();

    return client;
}

export async function closeRedisCheckpoint(): Promise<void> {
    if (client?.isOpen) {
        await client.quit();
        client = null;
        redisSaver = null;
    }
}