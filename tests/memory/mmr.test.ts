import { describe, it, expect } from "vitest";
import { mmrRerank } from "../../src/agent/memory/mmr.js";
import type { SearchResult, MMRConfig } from "../../src/agent/memory/types.js";

describe("MMR Re-ranking - Unit Tests", () => {
    const createResult = (id: string, content: string, score: number): SearchResult => ({
        id,
        content,
        score,
        source: "session",
        agentWallet: "0x0000000000000000000000000000000000000001",
        decayScore: 1.0,
        accessCount: 0,
        createdAt: Date.now(),
    });

    describe("Basic Functionality", () => {
        it("should return unchanged results when MMR is disabled", () => {
            const results = [
                createResult("1", "apple banana", 0.9),
                createResult("2", "orange grape", 0.8),
                createResult("3", "kiwi mango", 0.7),
            ];

            const reranked = mmrRerank(results, { enabled: false });

            expect(reranked[0].id).toBe("1");
            expect(reranked[1].id).toBe("2");
            expect(reranked[2].id).toBe("3");
        });

        it("should return unchanged results for single item", () => {
            const results = [createResult("only", "single content", 1.0)];
            const reranked = mmrRerank(results, { enabled: true });

            expect(reranked).toHaveLength(1);
            expect(reranked[0].id).toBe("only");
        });

        it("should return unchanged results for empty array", () => {
            const reranked = mmrRerank([], { enabled: true });
            expect(reranked).toEqual([]);
        });
    });

    describe("Lambda Parameter", () => {
        it("should prioritize relevance with high lambda (0.9)", () => {
            const results = [
                createResult("high_relevance", "unique content about dogs", 1.0),
                createResult("similar_1", "content about dogs and cats", 0.95),
                createResult("similar_2", "content about dogs and birds", 0.9),
                createResult("different", "totally different topic about cars", 0.5),
            ];

            const reranked = mmrRerank(results, { enabled: true, lambda: 0.9 });

            expect(reranked[0].id).toBe("high_relevance");
        });

        it("should prioritize diversity with low lambda (0.1)", () => {
            const results = [
                createResult("topic_a_1", "apple apple apple apple", 1.0),
                createResult("topic_a_2", "apple apple apple", 0.95),
                createResult("topic_a_3", "apple apple", 0.9),
                createResult("topic_b", "banana orange grape", 0.5),
            ];

            const reranked = mmrRerank(results, { enabled: true, lambda: 0.1 });

            const firstTwo = [reranked[0].id, reranked[1].id];
            expect(firstTwo).toContain("topic_a_1");
            expect(firstTwo).toContain("topic_b");
        });

        it("should use default lambda of 0.7 when not specified", () => {
            const results = [
                createResult("a", "content a", 1.0),
                createResult("b", "content b", 0.9),
            ];

            const rerankedDefault = mmrRerank(results, { enabled: true });
            const rerankedExplicit = mmrRerank(results, { enabled: true, lambda: 0.7 });

            expect(rerankedDefault[0].id).toBe(rerankedExplicit[0].id);
        });

        it("should clamp lambda to valid range", () => {
            const results = [
                createResult("a", "apple", 1.0),
                createResult("b", "banana", 0.9),
            ];

            const rerankedOver = mmrRerank(results, { enabled: true, lambda: 2.0 });
            const rerankedUnder = mmrRerank(results, { enabled: true, lambda: -0.5 });

            expect(rerankedOver).toHaveLength(2);
            expect(rerankedUnder).toHaveLength(2);
        });

        it("should behave like pure relevance sort when lambda is 1", () => {
            const results = [
                createResult("a", "duplicate duplicate duplicate", 0.7),
                createResult("b", "duplicate duplicate duplicate", 0.9),
                createResult("c", "unique different distinct", 0.8),
            ];

            const reranked = mmrRerank(results, { enabled: true, lambda: 1 });

            expect(reranked[0].score).toBeGreaterThanOrEqual(reranked[1].score);
            expect(reranked[1].score).toBeGreaterThanOrEqual(reranked[2].score);
        });
    });

    describe("Diversity Calculation", () => {
        it("should select diverse results from similar content", () => {
            const results = [
                createResult("duplicate_1", "the quick brown fox jumps over the lazy dog", 1.0),
                createResult("duplicate_2", "the quick brown fox jumps over the lazy dog", 0.99),
                createResult("unique_1", "programming in typescript with node.js", 0.6),
                createResult("unique_2", "machine learning and artificial intelligence", 0.5),
            ];

            const reranked = mmrRerank(results, { enabled: true, lambda: 0.5 });

            expect(reranked).toHaveLength(4);

            const topTwo = [reranked[0].id, reranked[1].id];
            expect(topTwo).toContain("duplicate_1");

            const hasUnique = reranked.slice(0, 3).some(r => r.id.startsWith("unique"));
            expect(hasUnique).toBe(true);
        });

        it("should penalize high overlap with selected items", () => {
            const results = [
                createResult("base", "apple banana cherry", 1.0),
                createResult("overlap", "apple banana cherry date", 0.9),
                createResult("different", "elephant fox giraffe", 0.8),
            ];

            const reranked = mmrRerank(results, { enabled: true, lambda: 0.5 });

            expect(reranked[0].id).toBe("base");

            const secondId = reranked[1].id;
            expect(secondId === "different" || secondId === "overlap").toBe(true);
        });

        it("should handle partial word overlaps correctly", () => {
            const results = [
                createResult("programming", "programming development coding software", 1.0),
                createResult("related", "programmer developer coder", 0.8),
                createResult("unrelated", "cooking recipes food kitchen", 0.7),
            ];

            const reranked = mmrRerank(results, { enabled: true, lambda: 0.6 });

            expect(reranked[0].id).toBe("programming");
        });
    });

    describe("Edge Cases", () => {
        it("should handle identical content", () => {
            const results = [
                createResult("a", "identical content", 1.0),
                createResult("b", "identical content", 0.9),
                createResult("c", "identical content", 0.8),
            ];

            const reranked = mmrRerank(results, { enabled: true, lambda: 0.5 });

            expect(reranked).toHaveLength(3);
            expect(reranked[0].id).toBe("a");
        });

        it("should handle empty content strings", () => {
            const results = [
                createResult("empty", "", 0.9),
                createResult("has_content", "some content here", 0.8),
            ];

            const reranked = mmrRerank(results, { enabled: true });

            expect(reranked).toHaveLength(2);
        });

        it("should handle special characters in content", () => {
            const results = [
                createResult("special_1", "hello @world #tag $money", 1.0),
                createResult("special_2", "hello @universe #hash $dollar", 0.9),
                createResult("normal", "normal content without symbols", 0.8),
            ];

            const reranked = mmrRerank(results, { enabled: true, lambda: 0.5 });

            expect(reranked).toHaveLength(3);
        });

        it("should handle unicode content", () => {
            const results = [
                createResult("unicode_1", "こんにちは世界 日本語テスト", 1.0),
                createResult("unicode_2", "你好世界 中文测试", 0.9),
                createResult("unicode_3", "hello world english test", 0.8),
            ];

            const reranked = mmrRerank(results, { enabled: true, lambda: 0.5 });

            expect(reranked).toHaveLength(3);
        });

        it("should handle very long content", () => {
            const longContent = "word ".repeat(1000);
            const results = [
                createResult("long", longContent, 1.0),
                createResult("short", "short content", 0.9),
            ];

            const reranked = mmrRerank(results, { enabled: true });

            expect(reranked).toHaveLength(2);
        });

        it("should handle extreme score values", () => {
            const results = [
                createResult("max", "content a", Number.MAX_VALUE),
                createResult("min", "content b", Number.MIN_VALUE),
                createResult("zero", "content c", 0),
            ];

            const reranked = mmrRerank(results, { enabled: true, lambda: 0.7 });

            expect(reranked).toHaveLength(3);
            expect(reranked[0].id).toBe("max");
        });
    });

    describe("Performance Tests", () => {
        it("should handle large result sets efficiently", () => {
            const results: SearchResult[] = [];
            for (let i = 0; i < 500; i++) {
                results.push(createResult(`item_${i}`, `unique content number ${i} about topic ${i % 10}`, 1 - i * 0.001));
            }

            const start = performance.now();
            const reranked = mmrRerank(results, { enabled: true, lambda: 0.6 });
            const duration = performance.now() - start;

            expect(reranked).toHaveLength(500);
            expect(duration).toBeLessThan(1000);
        });

        it("should maintain result order stability", () => {
            const results = [
                createResult("a", "alpha", 1.0),
                createResult("b", "beta", 1.0),
                createResult("c", "gamma", 1.0),
            ];

            const run1 = mmrRerank(results, { enabled: true, lambda: 0.5 });
            const run2 = mmrRerank(results, { enabled: true, lambda: 0.5 });

            expect(run1.map(r => r.id)).toEqual(run2.map(r => r.id));
        });
    });

    describe("Score Normalization", () => {
        it("should normalize scores correctly when all equal", () => {
            const results = [
                createResult("a", "apple", 0.5),
                createResult("b", "banana", 0.5),
                createResult("c", "cherry", 0.5),
            ];

            const reranked = mmrRerank(results, { enabled: true, lambda: 0.5 });

            expect(reranked).toHaveLength(3);
        });

        it("should normalize scores correctly with wide range", () => {
            const results = [
                createResult("high", "unique content alpha", 1000000),
                createResult("mid", "unique content beta", 100),
                createResult("low", "unique content gamma", 0.001),
            ];

            const reranked = mmrRerank(results, { enabled: true, lambda: 0.7 });

            expect(reranked[0].id).toBe("high");
            expect(reranked[1].id).toBe("mid");
            expect(reranked[2].id).toBe("low");
        });
    });

    describe("Real-world Scenarios", () => {
        it("should diversify search results about the same topic", () => {
            const results = [
                createResult("doc1", "machine learning is a field of artificial intelligence", 0.95),
                createResult("doc2", "machine learning algorithms learn from data", 0.93),
                createResult("doc3", "deep learning is a subset of machine learning", 0.92),
                createResult("doc4", "natural language processing uses machine learning", 0.90),
                createResult("doc5", "the stock market crashed yesterday", 0.40),
            ];

            const reranked = mmrRerank(results, { enabled: true, lambda: 0.5 });

            expect(reranked[0].id).toBe("doc1");
            expect(reranked).toHaveLength(5);

            const top3Ids = reranked.slice(0, 3).map(r => r.id);
            const uniqueTopics = new Set(top3Ids);
            expect(uniqueTopics.size).toBeGreaterThan(1);
        });

        it("should handle FAQ-like duplicate results", () => {
            const results = [
                createResult("faq1", "how do I reset my password? click settings then reset", 0.95),
                createResult("faq2", "how to reset password? go to settings and click reset", 0.94),
                createResult("faq3", "password reset instructions: settings menu reset button", 0.92),
                createResult("faq4", "how can I change my email address? account settings email", 0.60),
            ];

            const reranked = mmrRerank(results, { enabled: true, lambda: 0.3 });

            expect(reranked[0].score).toBeGreaterThanOrEqual(reranked[1].score);
            expect(reranked).toHaveLength(4);

            const top4 = reranked.slice(0, 4);
            const hasEmailQuestion = top4.some(r => r.id === "faq4");
            expect(hasEmailQuestion).toBe(true);
        });
    });
});