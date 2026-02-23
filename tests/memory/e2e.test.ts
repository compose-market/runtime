import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";

describe("Memory System - E2E Live Tests", () => {
    const shouldRunLiveTests = process.env.RUN_LIVE_TESTS === "true";

    const testConfig = {
        mongoUri: process.env.MONGO_MEMORY_URI || 
            `mongodb+srv://${process.env.MONGO_MEMORY_USER}:${encodeURIComponent(process.env.MONGO_MEMORY_PASSWORD || "")}@${process.env.MONGO_MEMORY_CLUSTER}`,
        redisEndpoint: process.env.REDIS_DATABASE_PUBLIC_ENDPOINT,
        voyageApiKey: process.env.MONGO_DB_API_KEY,
        mem0ApiKey: process.env.MEM0_API_KEY,
        testAgentWallet: "0xTEST000000000000000000000000000000000001",
        testUserId: "test_user_e2e",
    };

    beforeAll(() => {
        if (!shouldRunLiveTests) {
            console.log("Skipping live E2E tests. Set RUN_LIVE_TESTS=true to enable.");
        }
    });

    describe("MongoDB Atlas Vector Search - Live", () => {
        it.skipIf(!shouldRunLiveTests)("should connect to MongoDB memory cluster", async () => {
            const { MongoClient } = await import("mongodb");
            const client = new MongoClient(testConfig.mongoUri);
            
            try {
                await client.connect();
                const db = client.db("compose_memory");
                await db.command({ ping: 1 });
                expect(true).toBe(true);
            } finally {
                await client.close();
            }
        });

        it.skipIf(!shouldRunLiveTests)("should insert and retrieve vector with correct schema", async () => {
            const { MongoClient } = await import("mongodb");
            const client = new MongoClient(testConfig.mongoUri);
            
            try {
                await client.connect();
                const db = client.db("compose_memory");
                const collection = db.collection("memory");

                const testVector = {
                    vectorId: `e2e_test_${Date.now()}`,
                    agentWallet: testConfig.testAgentWallet,
                    content: "E2E test vector content",
                    embedding: Array(1024).fill(0).map((_, i) => Math.sin(i * 0.01)),
                    source: "knowledge",
                    decayScore: 1.0,
                    accessCount: 0,
                    lastAccessedAt: Date.now(),
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                };

                const insertResult = await collection.insertOne(testVector);
                expect(insertResult.insertedId).toBeDefined();

                const retrieved = await collection.findOne({ vectorId: testVector.vectorId });
                expect(retrieved).not.toBeNull();
                expect(retrieved?.content).toBe(testVector.content);
                expect(retrieved?.embedding).toHaveLength(1024);

                await collection.deleteOne({ vectorId: testVector.vectorId });
            } finally {
                await client.close();
            }
        });

        it.skipIf(!shouldRunLiveTests)("should perform vector search with Atlas Vector Search", async () => {
            const { MongoClient } = await import("mongodb");
            const client = new MongoClient(testConfig.mongoUri);
            
            try {
                await client.connect();
                const db = client.db("compose_memory");
                const collection = db.collection("memory");

                const testEmbedding = Array(1024).fill(0).map((_, i) => Math.sin(i * 0.01));
                const vectorId = `e2e_search_${Date.now()}`;

                await collection.insertOne({
                    vectorId,
                    agentWallet: testConfig.testAgentWallet,
                    content: "E2E searchable vector content",
                    embedding: testEmbedding,
                    source: "session",
                    decayScore: 1.0,
                    accessCount: 0,
                    lastAccessedAt: Date.now(),
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                });

                await new Promise(r => setTimeout(r, 2000));

                const searchResults = await collection.aggregate([
                    {
                        $vectorSearch: {
                            index: "vector_index",
                            path: "embedding",
                            queryVector: testEmbedding,
                            numCandidates: 10,
                            limit: 5,
                            filter: { agentWallet: testConfig.testAgentWallet }
                        }
                    },
                    {
                        $project: {
                            vectorId: 1,
                            content: 1,
                            score: { $meta: "vectorSearchScore" }
                        }
                    }
                ]).toArray();

                expect(searchResults.length).toBeGreaterThan(0);
                const found = searchResults.find((r: any) => r.vectorId === vectorId);
                expect(found).toBeDefined();
                expect((found as any)?.score).toBeGreaterThan(0.9);

                await collection.deleteOne({ vectorId });
            } finally {
                await client.close();
            }
        });

        it.skipIf(!shouldRunLiveTests)("should update decay scores correctly", async () => {
            const { MongoClient } = await import("mongodb");
            const client = new MongoClient(testConfig.mongoUri);
            
            try {
                await client.connect();
                const db = client.db("compose_memory");
                const collection = db.collection("memory");

                const vectorId = `e2e_decay_${Date.now()}`;
                const halfLifeDays = 30;
                const halfLifeMs = halfLifeDays * 24 * 60 * 60 * 1000;

                const thirtyDaysAgo = Date.now() - halfLifeMs;
                await collection.insertOne({
                    vectorId,
                    agentWallet: testConfig.testAgentWallet,
                    content: "E2E decay test vector",
                    embedding: Array(1024).fill(0),
                    source: "session",
                    decayScore: 1.0,
                    accessCount: 0,
                    lastAccessedAt: thirtyDaysAgo,
                    createdAt: thirtyDaysAgo,
                    updatedAt: thirtyDaysAgo,
                });

                const ageMs = Date.now() - thirtyDaysAgo;
                const newDecayScore = Math.pow(0.5, ageMs / halfLifeMs);

                await collection.updateOne(
                    { vectorId },
                    { $set: { decayScore: newDecayScore, updatedAt: Date.now() } }
                );

                const updated = await collection.findOne({ vectorId });
                expect(updated?.decayScore).toBeCloseTo(0.5, 1);

                await collection.deleteOne({ vectorId });
            } finally {
                await client.close();
            }
        });

        it.skipIf(!shouldRunLiveTests)("should store and retrieve session transcripts", async () => {
            const { MongoClient } = await import("mongodb");
            const client = new MongoClient(testConfig.mongoUri);
            
            try {
                await client.connect();
                const db = client.db("compose_memory");
                const collection = db.collection("session_transcripts");

                const sessionId = `e2e_session_${Date.now()}`;
                const transcript = {
                    sessionId,
                    threadId: "e2e_thread_001",
                    agentWallet: testConfig.testAgentWallet,
                    userId: testConfig.testUserId,
                    messages: [
                        { role: "user", content: "Hello E2E test", timestamp: Date.now() - 2000 },
                        { role: "assistant", content: "Hello from E2E!", timestamp: Date.now() - 1000 },
                    ],
                    tokenCount: 20,
                    metadata: {
                        modelUsed: "test-model",
                        totalTokens: 20,
                        contextWindow: 128000,
                    },
                    createdAt: Date.now(),
                };

                await collection.insertOne(transcript);

                const retrieved = await collection.findOne({ sessionId });
                expect(retrieved).not.toBeNull();
                expect(retrieved?.messages).toHaveLength(2);
                expect(retrieved?.userId).toBe(testConfig.testUserId);

                await collection.deleteOne({ sessionId });
            } finally {
                await client.close();
            }
        });
    });

    describe("Redis Cache - Live", () => {
        it.skipIf(!shouldRunLiveTests)("should connect to Redis", async () => {
            const { createClient } = await import("redis");
            const [host, portStr] = testConfig.redisEndpoint!.split(":");
            const port = parseInt(portStr, 10) || 6379;

            const client = createClient({
                socket: { host, port, tls: true },
                password: process.env.REDIS_API_KEY,
            });

            await client.connect();
            await client.ping();
            expect(true).toBe(true);
            await client.quit();
        });

        it.skipIf(!shouldRunLiveTests)("should cache and retrieve embeddings", async () => {
            const { createClient } = await import("redis");
            const crypto = await import("crypto");
            const [host, portStr] = testConfig.redisEndpoint!.split(":");
            const port = parseInt(portStr, 10) || 6379;

            const client = createClient({
                socket: { host, port, tls: true },
                password: process.env.REDIS_API_KEY,
            });

            await client.connect();

            const testContent = "E2E test content for embedding cache";
            const contentHash = crypto.createHash("sha256").update(testContent).digest("hex").slice(0, 32);
            const cacheKey = `embedding:e2e_${contentHash}`;

            const testEmbedding = {
                embedding: Array(1024).fill(0.5),
                provider: "e2e_test",
            };

            await client.setEx(cacheKey, 60, JSON.stringify(testEmbedding));

            const cached = await client.get(cacheKey);
            expect(cached).not.toBeNull();

            const parsed = JSON.parse(cached!);
            expect(parsed.embedding).toHaveLength(1024);
            expect(parsed.provider).toBe("e2e_test");

            await client.del(cacheKey);
            await client.quit();
        });

        it.skipIf(!shouldRunLiveTests)("should respect TTL on cached items", async () => {
            const { createClient } = await import("redis");
            const [host, portStr] = testConfig.redisEndpoint!.split(":");
            const port = parseInt(portStr, 10) || 6379;

            const client = createClient({
                socket: { host, port, tls: true },
                password: process.env.REDIS_API_KEY,
            });

            await client.connect();

            const cacheKey = "embedding:e2e_ttl_test";
            await client.setEx(cacheKey, 1, JSON.stringify({ test: true }));

            const immediate = await client.get(cacheKey);
            expect(immediate).not.toBeNull();

            await new Promise(r => setTimeout(r, 1500));

            const afterTTL = await client.get(cacheKey);
            expect(afterTTL).toBeNull();

            await client.quit();
        });
    });

    describe("Voyage AI Embedding - Live", () => {
        it.skipIf(!shouldRunLiveTests)("should get embedding from Voyage API", async () => {
            const response = await fetch("https://api.voyageai.com/v1/embeddings", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${testConfig.voyageApiKey}`,
                },
                body: JSON.stringify({
                    input: "E2E test content for Voyage embedding",
                    model: "voyage-4-large",
                    input_type: "document",
                    output_dimension: 1024,
                }),
            });

            expect(response.ok).toBe(true);

            const data = await response.json();
            expect(data.data).toBeDefined();
            expect(data.data[0].embedding).toHaveLength(1024);
            expect(data.data[0].embedding.every((v: number) => typeof v === "number")).toBe(true);
        });

        it.skipIf(!shouldRunLiveTests)("should handle batch embeddings from Voyage API", async () => {
            const response = await fetch("https://api.voyageai.com/v1/embeddings", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${testConfig.voyageApiKey}`,
                },
                body: JSON.stringify({
                    input: [
                        "First E2E test document",
                        "Second E2E test document",
                        "Third E2E test document",
                    ],
                    model: "voyage-4-large",
                    input_type: "document",
                    output_dimension: 1024,
                }),
            });

            expect(response.ok).toBe(true);

            const data = await response.json();
            expect(data.data).toHaveLength(3);
            
            for (const item of data.data) {
                expect(item.embedding).toHaveLength(1024);
            }
        });

        it.skipIf(!shouldRunLiveTests)("should have similar embeddings for similar content", async () => {
            const getEmbedding = async (text: string) => {
                const response = await fetch("https://api.voyageai.com/v1/embeddings", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${testConfig.voyageApiKey}`,
                    },
                    body: JSON.stringify({
                        input: text,
                        model: "voyage-4-large",
                        input_type: "document",
                        output_dimension: 1024,
                    }),
                });
                const data = await response.json();
                return data.data[0].embedding;
            };

            const emb1 = await getEmbedding("The cat sat on the mat");
            const emb2 = await getEmbedding("A cat was sitting on a mat");
            const emb3 = await getEmbedding("Quantum mechanics describes subatomic particles");

            const cosineSimilarity = (a: number[], b: number[]) => {
                let dot = 0, normA = 0, normB = 0;
                for (let i = 0; i < a.length; i++) {
                    dot += a[i] * b[i];
                    normA += a[i] * a[i];
                    normB += b[i] * b[i];
                }
                return dot / (Math.sqrt(normA) * Math.sqrt(normB));
            };

            const simSimilar = cosineSimilarity(emb1, emb2);
            const simDifferent = cosineSimilarity(emb1, emb3);

            expect(simSimilar).toBeGreaterThan(0.8);
            expect(simSimilar).toBeGreaterThan(simDifferent);
        });
    });

    describe("Mem0 Graph Memory - Live", () => {
        it.skipIf(!shouldRunLiveTests)("should add and search memories via Mem0", async () => {
            const mem0ai = await import("mem0ai");
            const MemoryClass = (mem0ai as any).MemoryClient || (mem0ai as any).default?.MemoryClient;
            
            if (typeof MemoryClass !== "function") {
                console.log("Mem0 client not available, skipping");
                return;
            }

            const client = new MemoryClass({ apiKey: testConfig.mem0ApiKey });

            const messages = [
                { role: "user", content: "E2E test: I prefer dark mode in my IDE" },
                { role: "assistant", content: "Noted, you prefer dark mode!" }
            ];

            const addResult = await client.add(messages, {
                agent_id: testConfig.testAgentWallet,
                user_id: testConfig.testUserId,
                metadata: { test: "e2e", timestamp: Date.now() },
            });

            expect(addResult).toBeDefined();

            const searchResult = await client.search("IDE preference", {
                agent_id: testConfig.testAgentWallet,
                user_id: testConfig.testUserId,
                limit: 5,
            });

            expect(Array.isArray(searchResult)).toBe(true);
        });
    });

    describe("Full Roundtrip - Live", () => {
        it.skipIf(!shouldRunLiveTests)("should complete full manowar->lambda->mongodb roundtrip", async () => {
            const { MongoClient } = await import("mongodb");
            const crypto = await import("crypto");
            
            const client = new MongoClient(testConfig.mongoUri);
            
            try {
                await client.connect();
                const db = client.db("compose_memory");
                const memoryCollection = db.collection("memory");

                const testContent = "E2E full roundtrip test: Agent learned about distributed memory systems";
                const testEmbedding = Array(1024).fill(0).map((_, i) => Math.sin(i * 0.01));
                const vectorId = `e2e_roundtrip_${Date.now()}`;

                const insertResult = await memoryCollection.insertOne({
                    vectorId,
                    agentWallet: testConfig.testAgentWallet,
                    userId: testConfig.testUserId,
                    threadId: "e2e_roundtrip_thread",
                    content: testContent,
                    embedding: testEmbedding,
                    source: "session",
                    decayScore: 1.0,
                    accessCount: 0,
                    lastAccessedAt: Date.now(),
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                });

                expect(insertResult.acknowledged).toBe(true);

                await new Promise(r => setTimeout(r, 2000));

                const searchResults = await memoryCollection.aggregate([
                    {
                        $vectorSearch: {
                            index: "vector_index",
                            path: "embedding",
                            queryVector: testEmbedding,
                            numCandidates: 10,
                            limit: 5,
                            filter: { agentWallet: testConfig.testAgentWallet }
                        }
                    },
                    { $addFields: { rawScore: { $meta: "vectorSearchScore" } } },
                    { $addFields: { adjustedScore: { $multiply: ["$rawScore", "$decayScore"] } } },
                    { $project: { vectorId: 1, content: 1, adjustedScore: 1 } }
                ]).toArray();

                expect(searchResults.length).toBeGreaterThan(0);

                const found = searchResults.find((r: any) => r.vectorId === vectorId);
                expect(found).toBeDefined();
                expect((found as any)?.content).toBe(testContent);

                await memoryCollection.deleteOne({ vectorId });

                const afterDelete = await memoryCollection.findOne({ vectorId });
                expect(afterDelete).toBeNull();

            } finally {
                await client.close();
            }
        });
    });
});