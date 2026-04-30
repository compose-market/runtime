import { describe, it, expect } from "vitest";
import {
    type MemoryVector,
    type SessionTranscript,
    type SearchResult,
    type EmbeddingResult,
    type HybridSearchParams,
    DEFAULT_MMR_CONFIG,
    DEFAULT_TEMPORAL_DECAY_CONFIG,
    EMBEDDING_DIMENSIONS,
} from "../../../src/manowar/memory/types.js";

describe("Memory Types - Type Validation", () => {
    describe("MemoryVector", () => {
        it("should define complete MemoryVector structure", () => {
            const vector: MemoryVector = {
                vectorId: "vec_0xABC123_1234567890",
                agentWallet: "0xABC1234567890123456789012345678901234567",
                userId: "user_001",
                threadId: "thread_001",
                content: "Test content for vector storage",
                embedding: Array(1024).fill(0.1),
                source: "session",
                decayScore: 1.0,
                accessCount: 5,
                lastAccessedAt: Date.now(),
                createdAt: Date.now() - 86400000,
                updatedAt: Date.now(),
            };

            expect(vector.vectorId).toMatch(/^vec_/);
            expect(vector.agentWallet).toMatch(/^0x[a-fA-F0-9]{40}$/);
            expect(vector.embedding).toHaveLength(1024);
            expect(vector.source).toBe("session");
            expect(vector.decayScore).toBeGreaterThanOrEqual(0);
            expect(vector.decayScore).toBeLessThanOrEqual(1);
        });

        it("should support all source types", () => {
            const sources: MemoryVector["source"][] = ["session", "knowledge", "pattern", "archive", "fact"];

            for (const source of sources) {
                const vector: MemoryVector = {
                    vectorId: `vec_${source}`,
                    agentWallet: "0x0000000000000000000000000000000000000001",
                    content: `Content from ${source}`,
                    embedding: [],
                    source,
                    decayScore: 1.0,
                    accessCount: 0,
                    lastAccessedAt: Date.now(),
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                };
                expect(vector.source).toBe(source);
            }
        });

        it("should handle optional fields correctly", () => {
            const minimalVector: MemoryVector = {
                vectorId: "vec_minimal",
                agentWallet: "0x0000000000000000000000000000000000000001",
                content: "Minimal vector",
                embedding: [],
                source: "session",
                decayScore: 1.0,
                accessCount: 0,
                lastAccessedAt: Date.now(),
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };

            expect(minimalVector.userId).toBeUndefined();
            expect(minimalVector.threadId).toBeUndefined();
        });

        it("should validate embedding dimensions", () => {
            const vector: MemoryVector = {
                vectorId: "vec_test",
                agentWallet: "0x0000000000000000000000000000000000000001",
                content: "Test",
                embedding: Array(EMBEDDING_DIMENSIONS).fill(0),
                source: "knowledge",
                decayScore: 1.0,
                accessCount: 0,
                lastAccessedAt: Date.now(),
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };

            expect(vector.embedding.length).toBe(EMBEDDING_DIMENSIONS);
            expect(EMBEDDING_DIMENSIONS).toBe(1024);
        });
    });

    describe("SessionTranscript", () => {
        it("should define complete SessionTranscript structure", () => {
            const transcript: SessionTranscript = {
                sessionId: "sess_001",
                agentWallet: "0xABC1234567890123456789012345678901234567",
                userId: "user_001",
                threadId: "thread_001",
                messages: [
                    { role: "user", content: "Hello", timestamp: Date.now() - 60000 },
                    { role: "assistant", content: "Hi there!", timestamp: Date.now() - 30000 },
                ],
                metadata: {
                    modelUsed: "gpt-4",
                    totalTokens: 150,
                    contextWindow: 128000,
                },
                createdAt: Date.now(),
            };

            expect(transcript.sessionId).toBeDefined();
            expect(transcript.threadId).toBeDefined();
            expect(transcript.messages).toHaveLength(2);
            expect(transcript.metadata.modelUsed).toBe("gpt-4");
        });

        it("should support all message roles", () => {
            const roles: SessionTranscript["messages"][0]["role"][] = ["user", "assistant", "system", "tool"];

            const messages: SessionTranscript["messages"] = roles.map((role, i) => ({
                role,
                content: `${role} message ${i}`,
                timestamp: Date.now() + i * 1000,
            }));

            const transcript: SessionTranscript = {
                sessionId: "sess_roles",
                agentWallet: "0x0000000000000000000000000000000000000001",
                threadId: "thread_roles",
                messages,
                metadata: {
                    modelUsed: "test-model",
                    totalTokens: 100,
                    contextWindow: 128000,
                },
                createdAt: Date.now(),
            };

            expect(transcript.messages).toHaveLength(4);
        });

        it("should handle tool calls in messages", () => {
            const transcript: SessionTranscript = {
                sessionId: "sess_tools",
                agentWallet: "0x0000000000000000000000000000000000000001",
                threadId: "thread_tools",
                messages: [
                    {
                        role: "assistant",
                        content: "I'll help you with that",
                        timestamp: Date.now(),
                        toolCalls: [
                            { name: "search_memory", args: { query: "test" } },
                            { name: "get_weather", args: { location: "NYC" } },
                        ],
                    },
                ],
                metadata: {
                    modelUsed: "gpt-4",
                    totalTokens: 200,
                    contextWindow: 128000,
                },
                createdAt: Date.now(),
            };

            expect(transcript.messages[0].toolCalls).toBeDefined();
            expect(transcript.messages[0].toolCalls).toHaveLength(2);
            expect(transcript.messages[0].toolCalls?.[0].name).toBe("search_memory");
        });

        it("should handle optional expiry", () => {
            const permanentTranscript: SessionTranscript = {
                sessionId: "sess_permanent",
                agentWallet: "0x0000000000000000000000000000000000000001",
                threadId: "thread_perm",
                messages: [],
                metadata: { modelUsed: "test", totalTokens: 0, contextWindow: 128000 },
                createdAt: Date.now(),
            };

            const expiringTranscript: SessionTranscript = {
                ...permanentTranscript,
                sessionId: "sess_expiring",
                expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
            };

            expect(permanentTranscript.expiresAt).toBeUndefined();
            expect(expiringTranscript.expiresAt).toBeDefined();
            expect(expiringTranscript.expiresAt).toBeGreaterThan(Date.now());
        });
    });

    describe("SearchResult", () => {
        it("should define complete SearchResult structure", () => {
            const result: SearchResult = {
                id: "vec_test_001",
                content: "Search result content",
                score: 0.95,
                source: "knowledge",
                agentWallet: "0x0000000000000000000000000000000000000001",
                userId: "user_001",
                threadId: "thread_001",
                decayScore: 0.85,
                accessCount: 10,
                createdAt: Date.now() - 86400000,
            };

            expect(result.score).toBeGreaterThanOrEqual(0);
            expect(result.score).toBeLessThanOrEqual(1);
            expect(result.decayScore).toBeGreaterThanOrEqual(0);
            expect(result.decayScore).toBeLessThanOrEqual(1);
            expect(result.accessCount).toBeGreaterThanOrEqual(0);
        });
    });

    describe("EmbeddingResult", () => {
        it("should define complete EmbeddingResult structure", () => {
            const voyageResult: EmbeddingResult = {
                embedding: Array(1024).fill(0.1),
                provider: "voyage",
                cached: false,
                dimensions: 1024,
            };

            const cloudflareResult: EmbeddingResult = {
                embedding: Array(1024).fill(0.2),
                provider: "cloudflare",
                cached: true,
                dimensions: 1024,
            };

            expect(voyageResult.provider).toBe("voyage");
            expect(voyageResult.cached).toBe(false);
            expect(cloudflareResult.provider).toBe("cloudflare");
            expect(cloudflareResult.cached).toBe(true);
        });

        it("should only support valid providers", () => {
            const providers: EmbeddingResult["provider"][] = ["voyage", "cloudflare"];

            for (const provider of providers) {
                const result: EmbeddingResult = {
                    embedding: [],
                    provider,
                    cached: false,
                    dimensions: 1024,
                };
                expect(result.provider).toBe(provider);
            }
        });
    });

    describe("HybridSearchParams", () => {
        it("should define complete search parameters", () => {
            const params: HybridSearchParams = {
                query: "test query",
                agentWallet: "0x0000000000000000000000000000000000000001",
                userId: "user_001",
                threadId: "thread_001",
                limit: 20,
                options: {
                    vectorWeight: 0.7,
                    textWeight: 0.3,
                    rerank: true,
                    temporalDecay: true,
                    mmr: true,
                    mmrLambda: 0.8,
                },
            };

            expect(params.query).toBeDefined();
            expect(params.agentWallet).toBeDefined();
            expect(params.limit).toBe(20);
            expect(params.options?.mmrLambda).toBe(0.8);
        });

        it("should work with minimal parameters", () => {
            const minimalParams: HybridSearchParams = {
                query: "test",
                agentWallet: "0x0000000000000000000000000000000000000001",
            };

            expect(minimalParams.userId).toBeUndefined();
            expect(minimalParams.limit).toBeUndefined();
            expect(minimalParams.options).toBeUndefined();
        });
    });

    describe("Default Configurations", () => {
        it("should provide correct default MMR config", () => {
            expect(DEFAULT_MMR_CONFIG.enabled).toBe(false);
            expect(DEFAULT_MMR_CONFIG.lambda).toBe(0.7);
        });

        it("should provide correct default temporal decay config", () => {
            expect(DEFAULT_TEMPORAL_DECAY_CONFIG.enabled).toBe(true);
            expect(DEFAULT_TEMPORAL_DECAY_CONFIG.halfLifeDays).toBe(30);
        });

        it("should define correct embedding dimensions", () => {
            expect(EMBEDDING_DIMENSIONS).toBe(1024);
        });
    });

    describe("Edge Cases", () => {
        it("should handle empty embeddings", () => {
            const vector: MemoryVector = {
                vectorId: "vec_empty",
                agentWallet: "0x0000000000000000000000000000000000000001",
                content: "Empty embedding",
                embedding: [],
                source: "session",
                decayScore: 1.0,
                accessCount: 0,
                lastAccessedAt: Date.now(),
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };

            expect(vector.embedding).toHaveLength(0);
        });

        it("should handle zero decay score", () => {
            const vector: MemoryVector = {
                vectorId: "vec_zero_decay",
                agentWallet: "0x0000000000000000000000000000000000000001",
                content: "Expired content",
                embedding: [],
                source: "session",
                decayScore: 0,
                accessCount: 100,
                lastAccessedAt: Date.now() - 365 * 24 * 60 * 60 * 1000,
                createdAt: Date.now() - 365 * 24 * 60 * 60 * 1000,
                updatedAt: Date.now(),
            };

            expect(vector.decayScore).toBe(0);
        });

        it("should handle very long content", () => {
            const longContent = "x".repeat(100000);
            const vector: MemoryVector = {
                vectorId: "vec_long",
                agentWallet: "0x0000000000000000000000000000000000000001",
                content: longContent,
                embedding: Array(1024).fill(0),
                source: "archive",
                decayScore: 1.0,
                accessCount: 0,
                lastAccessedAt: Date.now(),
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };

            expect(vector.content.length).toBe(100000);
        });

        it("should handle high access counts", () => {
            const vector: MemoryVector = {
                vectorId: "vec_popular",
                agentWallet: "0x0000000000000000000000000000000000000001",
                content: "Popular content",
                embedding: [],
                source: "knowledge",
                decayScore: 1.0,
                accessCount: Number.MAX_SAFE_INTEGER,
                lastAccessedAt: Date.now(),
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };

            expect(vector.accessCount).toBe(Number.MAX_SAFE_INTEGER);
        });
    });
});
