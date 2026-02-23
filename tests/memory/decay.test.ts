import { describe, it, expect } from "vitest";
import {
    toDecayLambda,
    calculateDecayMultiplier,
    applyTemporalDecay,
    applyDecayToResults,
} from "../../src/agent/memory/decay.js";
import type { TemporalDecayConfig, SearchResult } from "../../src/agent/memory/types.js";

describe("Temporal Decay - Unit Tests", () => {
    describe("toDecayLambda", () => {
        it("should calculate correct decay lambda for standard half-life", () => {
            const halfLifeDays = 30;
            const lambda = toDecayLambda(halfLifeDays);

            expect(lambda).toBeCloseTo(Math.LN2 / 30, 10);
        });

        it("should return same lambda for any positive half-life", () => {
            expect(toDecayLambda(1)).toBeCloseTo(Math.LN2, 10);
            expect(toDecayLambda(7)).toBeCloseTo(Math.LN2 / 7, 10);
            expect(toDecayLambda(30)).toBeCloseTo(Math.LN2 / 30, 10);
            expect(toDecayLambda(365)).toBeCloseTo(Math.LN2 / 365, 10);
        });

        it("should return 0 for invalid half-life values", () => {
            expect(toDecayLambda(0)).toBe(0);
            expect(toDecayLambda(-1)).toBe(0);
            expect(toDecayLambda(-30)).toBe(0);
            expect(toDecayLambda(NaN)).toBe(0);
            expect(toDecayLambda(Infinity)).toBe(0);
            expect(toDecayLambda(-Infinity)).toBe(0);
        });

        it("should handle very small half-life values", () => {
            const lambda = toDecayLambda(0.001);
            expect(lambda).toBeCloseTo(Math.LN2 / 0.001, 10);
            expect(lambda).toBeGreaterThan(0);
        });

        it("should handle very large half-life values", () => {
            const lambda = toDecayLambda(10000);
            expect(lambda).toBeCloseTo(Math.LN2 / 10000, 10);
            expect(lambda).toBeGreaterThan(0);
            expect(lambda).toBeLessThan(0.001);
        });
    });

    describe("calculateDecayMultiplier", () => {
        it("should return 1.0 for fresh content (age=0)", () => {
            expect(calculateDecayMultiplier(0, 30)).toBe(1);
            expect(calculateDecayMultiplier(0, 7)).toBe(1);
            expect(calculateDecayMultiplier(0, 365)).toBe(1);
        });

        it("should return 0.5 at half-life boundary", () => {
            expect(calculateDecayMultiplier(30, 30)).toBeCloseTo(0.5, 5);
            expect(calculateDecayMultiplier(7, 7)).toBeCloseTo(0.5, 5);
            expect(calculateDecayMultiplier(365, 365)).toBeCloseTo(0.5, 5);
        });

        it("should return ~0.25 at 2x half-life", () => {
            expect(calculateDecayMultiplier(60, 30)).toBeCloseTo(0.25, 5);
            expect(calculateDecayMultiplier(14, 7)).toBeCloseTo(0.25, 5);
        });

        it("should return ~0.125 at 3x half-life", () => {
            expect(calculateDecayMultiplier(90, 30)).toBeCloseTo(0.125, 5);
            expect(calculateDecayMultiplier(21, 7)).toBeCloseTo(0.125, 5);
        });

        it("should approach 0 for very old content", () => {
            expect(calculateDecayMultiplier(365, 30)).toBeLessThan(0.001);
            expect(calculateDecayMultiplier(1000, 30)).toBeLessThan(0.0001);
        });

        it("should handle negative age as 0", () => {
            expect(calculateDecayMultiplier(-10, 30)).toBe(1);
            expect(calculateDecayMultiplier(-100, 30)).toBe(1);
        });

        it("should handle invalid half-life gracefully", () => {
            expect(calculateDecayMultiplier(10, 0)).toBe(1);
            expect(calculateDecayMultiplier(10, -1)).toBe(1);
            expect(calculateDecayMultiplier(10, NaN)).toBe(1);
        });

        it("should produce consistent decay curve", () => {
            const halfLife = 30;
            const results: number[] = [];

            for (let day = 0; day <= 120; day += 10) {
                results.push(calculateDecayMultiplier(day, halfLife));
            }

            for (let i = 1; i < results.length; i++) {
                expect(results[i]).toBeLessThan(results[i - 1]);
            }

            expect(results[0]).toBe(1);
            expect(results[3]).toBeCloseTo(0.5, 2);
        });
    });

    describe("applyTemporalDecay", () => {
        const config: TemporalDecayConfig = { enabled: true, halfLifeDays: 30 };

        it("should not modify score when decay is disabled", () => {
            const disabledConfig: TemporalDecayConfig = { enabled: false, halfLifeDays: 30 };
            const now = Date.now();

            expect(applyTemporalDecay(0.9, now, disabledConfig)).toBe(0.9);
            expect(applyTemporalDecay(1.0, now - 86400000 * 60, disabledConfig)).toBe(1.0);
        });

        it("should apply decay to fresh content with full score", () => {
            const now = Date.now();
            const result = applyTemporalDecay(1.0, now, config);

            expect(result).toBeCloseTo(1.0, 5);
        });

        it("should apply decay to content at half-life", () => {
            const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
            const result = applyTemporalDecay(1.0, thirtyDaysAgo, config);

            expect(result).toBeCloseTo(0.5, 2);
        });

        it("should preserve relative score ordering", () => {
            const now = Date.now();
            const result1 = applyTemporalDecay(0.9, now, config);
            const result2 = applyTemporalDecay(0.8, now, config);

            expect(result1).toBeGreaterThan(result2);
        });

        it("should combine decay with original score", () => {
            const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

            const result1 = applyTemporalDecay(1.0, thirtyDaysAgo, config);
            const result2 = applyTemporalDecay(0.8, thirtyDaysAgo, config);

            expect(result1).toBeCloseTo(0.5, 2);
            expect(result2).toBeCloseTo(0.4, 2);
        });
    });

    describe("applyDecayToResults", () => {
        const config: TemporalDecayConfig = { enabled: true, halfLifeDays: 30 };

        const createResult = (id: string, score: number, ageInDays: number): SearchResult => ({
            id,
            content: `Content ${id}`,
            score,
            source: "session",
            agentWallet: "0x0000000000000000000000000000000000000001",
            decayScore: 1.0,
            accessCount: 0,
            createdAt: Date.now() - ageInDays * 24 * 60 * 60 * 1000,
        });

        it("should not modify results when decay is disabled", () => {
            const disabledConfig: TemporalDecayConfig = { enabled: false, halfLifeDays: 30 };
            const results = [
                createResult("1", 0.9, 0),
                createResult("2", 0.8, 30),
                createResult("3", 0.7, 60),
            ];

            const processed = applyDecayToResults(results, disabledConfig);

            expect(processed[0].score).toBe(0.9);
            expect(processed[1].score).toBe(0.8);
            expect(processed[2].score).toBe(0.7);
        });

        it("should apply decay to all results", () => {
            const results = [
                createResult("1", 1.0, 0),
                createResult("2", 1.0, 30),
                createResult("3", 1.0, 60),
            ];

            const processed = applyDecayToResults(results, config);

            expect(processed[0].score).toBeCloseTo(1.0, 2);
            expect(processed[1].score).toBeCloseTo(0.5, 2);
            expect(processed[2].score).toBeCloseTo(0.25, 2);
        });

        it("should update decayScore field in results", () => {
            const results = [
                createResult("1", 1.0, 30),
            ];

            const processed = applyDecayToResults(results, config);

            expect(processed[0].decayScore).toBeCloseTo(0.5, 2);
        });

        it("should preserve all other result fields", () => {
            const results = [
                createResult("test", 0.9, 10),
            ];

            const processed = applyDecayToResults(results, config);

            expect(processed[0].id).toBe("test");
            expect(processed[0].content).toBe("Content test");
            expect(processed[0].source).toBe("session");
            expect(processed[0].agentWallet).toBe("0x0000000000000000000000000000000000000001");
            expect(processed[0].accessCount).toBe(0);
        });

        it("should handle empty results array", () => {
            const processed = applyDecayToResults([], config);
            expect(processed).toEqual([]);
        });

        it("should handle single result", () => {
            const results = [createResult("only", 1.0, 15)];
            const processed = applyDecayToResults(results, config);

            expect(processed).toHaveLength(1);
            expect(processed[0].score).toBeGreaterThan(0.5);
            expect(processed[0].score).toBeLessThan(1);
        });

        it("should handle mixed age results correctly", () => {
            const results = [
                createResult("fresh", 0.5, 0),
                createResult("old", 1.0, 60),
            ];

            const processed = applyDecayToResults(results, config);

            expect(processed[0].score).toBeCloseTo(0.5, 2);
            expect(processed[1].score).toBeCloseTo(0.25, 2);
            expect(processed[0].score).toBeGreaterThan(processed[1].score);
        });

        it("should re-order results after decay", () => {
            const results = [
                createResult("old_high", 1.0, 90),
                createResult("fresh_low", 0.3, 0),
                createResult("mid", 0.6, 30),
            ];

            const processed = applyDecayToResults(results, config);

            const scores = processed.map((r: SearchResult) => r.score);
            for (let i = 1; i < scores.length; i++) {
                expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
            }
        });

        it("should handle very large result sets efficiently", () => {
            const results: SearchResult[] = [];
            for (let i = 0; i < 1000; i++) {
                results.push(createResult(`item_${i}`, Math.random(), Math.random() * 365));
            }

            const start = performance.now();
            const processed = applyDecayToResults(results, config);
            const duration = performance.now() - start;

            expect(processed).toHaveLength(1000);
            expect(duration).toBeLessThan(100);
        });
    });

    describe("Edge Cases and Stress Tests", () => {
        it("should handle zero half-life gracefully", () => {
            const zeroConfig: TemporalDecayConfig = { enabled: true, halfLifeDays: 0 };
            const now = Date.now();

            const result = applyTemporalDecay(1.0, now, zeroConfig);
            expect(result).toBe(1.0);
        });

        it("should handle extremely large half-life", () => {
            const hugeConfig: TemporalDecayConfig = { enabled: true, halfLifeDays: 1000000 };
            const yearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;

            const result = applyTemporalDecay(1.0, yearAgo, hugeConfig);
            expect(result).toBeGreaterThan(0.999);
        });

        it("should handle future createdAt timestamps", () => {
            const future = Date.now() + 86400000;
            const config: TemporalDecayConfig = { enabled: true, halfLifeDays: 30 };

            const result = applyTemporalDecay(1.0, future, config);
            expect(result).toBe(1.0);
        });

        it("should handle very small scores", () => {
            const now = Date.now();
            const config: TemporalDecayConfig = { enabled: true, halfLifeDays: 30 };

            const result = applyTemporalDecay(0.0001, now, config);
            expect(result).toBeCloseTo(0.0001, 6);
        });

        it("should handle score of 0", () => {
            const config: TemporalDecayConfig = { enabled: true, halfLifeDays: 30 };

            expect(applyTemporalDecay(0, Date.now(), config)).toBe(0);
            expect(applyTemporalDecay(0, Date.now() - 86400000 * 60, config)).toBe(0);
        });

        it("should handle score greater than 1", () => {
            const config: TemporalDecayConfig = { enabled: true, halfLifeDays: 30 };
            const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

            const result = applyTemporalDecay(2.0, thirtyDaysAgo, config);
            expect(result).toBeCloseTo(1.0, 2);
        });
    });
});