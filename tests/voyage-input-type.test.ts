/**
 * Tests for Voyage embedding `input_type` plumbing
 * (Phase 1.3 — `runtime/src/manowar/memory/embedding.ts`).
 *
 * Voyage's voyage-3+ family uses asymmetric query/document encoding.
 * We must:
 *   - Default to "document" so legacy indexing callers keep semantics.
 *   - Accept "query" for retrieval paths.
 *   - Cache queries and documents under DISTINCT keys so a query and a
 *     document with identical text don't collide on the same Redis slot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Redis client BEFORE importing embedding.ts.
const redisStore = new Map<string, string>();

vi.mock("../src/manowar/memory/cache.js", async () => {
    const actual = await vi.importActual<
        typeof import("../src/manowar/memory/cache.js")
    >("../src/manowar/memory/cache.js");
    return {
        ...actual,
        // Override only the redis client; keep createContentHash etc.
        getRedisClient: async () => ({
            get: async (key: string) => redisStore.get(key) ?? null,
            setEx: async (key: string, _ttl: number, value: string) => {
                redisStore.set(key, value);
                return "OK";
            },
        }),
    };
});

let lastVoyageBody: Record<string, unknown> | null = null;
const originalFetch = globalThis.fetch;

beforeEach(() => {
    process.env.MONGO_DB_API_KEY = "test-key";
    redisStore.clear();
    lastVoyageBody = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/embeddings")) {
            lastVoyageBody = JSON.parse(String(init?.body ?? "{}"));
            const inputArr = Array.isArray(lastVoyageBody!.input)
                ? (lastVoyageBody!.input as string[])
                : [String(lastVoyageBody!.input)];
            return new Response(
                JSON.stringify({
                    object: "list",
                    data: inputArr.map((_, i) => ({
                        object: "embedding",
                        embedding: Array(1024).fill(0.01 * (i + 1)),
                        index: i,
                    })),
                    model: "voyage-4-large",
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
            );
        }
        return originalFetch(input, init);
    }) as typeof fetch;
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe("getEmbedding — Voyage input_type plumbing", () => {
    it("defaults to input_type:'document' when no override is passed", async () => {
        const { getEmbedding } = await import("../src/manowar/memory/embedding.js");
        await getEmbedding("hello document");
        expect(lastVoyageBody).toBeTruthy();
        expect(lastVoyageBody!.input_type).toBe("document");
        expect(lastVoyageBody!.model).toBe("voyage-4-large");
    });

    it("sends input_type:'query' when explicitly requested", async () => {
        const { getEmbedding } = await import("../src/manowar/memory/embedding.js");
        // Use a unique text to bypass any leftover cache.
        await getEmbedding(`query-text-${Date.now()}-${Math.random()}`, "query");
        expect(lastVoyageBody!.input_type).toBe("query");
    });

    it("caches query and document with identical text under DISTINCT keys", async () => {
        const { getEmbedding } = await import("../src/manowar/memory/embedding.js");
        const text = `cache-isolation-${Date.now()}`;

        // First call: document indexing.
        const docFirst = await getEmbedding(text, "document");
        expect(docFirst.cached).toBe(false);
        // Second call same text + document -> cache hit.
        const docSecond = await getEmbedding(text, "document");
        expect(docSecond.cached).toBe(true);

        // First call: query (must NOT collide with document slot).
        const queryFirst = await getEmbedding(text, "query");
        expect(queryFirst.cached).toBe(false);
        // Second call query -> cache hit.
        const querySecond = await getEmbedding(text, "query");
        expect(querySecond.cached).toBe(true);

        // Cache stored under prefixes embedding: (document) and embedding:q: (query).
        const keys = Array.from(redisStore.keys()).sort();
        expect(keys.some((k) => k.startsWith("embedding:q:"))).toBe(true);
        expect(keys.some((k) => k.startsWith("embedding:") && !k.startsWith("embedding:q:"))).toBe(true);
    });
});

describe("getEmbeddingsBatch — Voyage input_type plumbing", () => {
    it("defaults to 'document' for batch indexing", async () => {
        const { getEmbeddingsBatch } = await import("../src/manowar/memory/embedding.js");
        await getEmbeddingsBatch([`a-${Date.now()}`, `b-${Date.now()}`]);
        expect(lastVoyageBody!.input_type).toBe("document");
        expect(Array.isArray(lastVoyageBody!.input)).toBe(true);
    });

    it("forwards 'query' when callers ask for batched query embeddings", async () => {
        const { getEmbeddingsBatch } = await import("../src/manowar/memory/embedding.js");
        await getEmbeddingsBatch(
            [`q1-${Date.now()}`, `q2-${Date.now()}`],
            "query",
        );
        expect(lastVoyageBody!.input_type).toBe("query");
    });
});
