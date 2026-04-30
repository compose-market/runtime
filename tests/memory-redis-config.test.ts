import { describe, expect, it } from "vitest";

import { resolveMemoryRedisConnectionConfig } from "../src/manowar/memory/cache.js";

describe("memory redis connection config", () => {
    it("uses the database password instead of the Redis Cloud API key", () => {
        const config = resolveMemoryRedisConnectionConfig({
            REDIS_MEMORY_DATABASE_PUBLIC_ENDPOINT: "redis.example.com:6380",
            REDIS_MEMORY_DEFAULT_PASSWORD: "database-password",
            REDIS_MEMORY_API_KEY: "management-api-key",
            REDIS_TLS: "true",
        });

        expect(config).toEqual({
            endpoint: "redis.example.com:6380",
            password: "database-password",
            useTls: true,
        });
    });

    it("fails fast when the database password is missing", () => {
        expect(() =>
            resolveMemoryRedisConnectionConfig({
                REDIS_MEMORY_DATABASE_PUBLIC_ENDPOINT: "redis.example.com:6380",
                REDIS_MEMORY_API_KEY: "management-api-key",
            }),
        ).toThrow(/REDIS_MEMORY_DEFAULT_PASSWORD required/i);
    });
});
