/**
 * Memory Tests
 * 
 * Unit tests for Mem0 Platform API integration.
 * Tests utility functions and type exports.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    isMem0Available,
    getDynamicThresholdPercent,
    SLIDING_WINDOW_SIZE,
    type MemoryItem,
    type GraphMemoryResult,
} from "../memory.js";

describe("isMem0Available", () => {
    it("should return boolean", () => {
        const result = isMem0Available();
        expect(typeof result).toBe("boolean");
    });
});

describe("getDynamicThresholdPercent", () => {
    it("should return higher threshold for larger windows", () => {
        const smallWindowThreshold = getDynamicThresholdPercent(16000);
        const largeWindowThreshold = getDynamicThresholdPercent(128000);

        expect(largeWindowThreshold).toBeGreaterThan(smallWindowThreshold);
    });

    it("should return approximately 55% for small windows", () => {
        const threshold = getDynamicThresholdPercent(1024);

        expect(threshold).toBeCloseTo(55, 0);
    });

    it("should cap at reasonable maximum", () => {
        const threshold = getDynamicThresholdPercent(1000000);

        expect(threshold).toBeLessThanOrEqual(75);
    });

    it("should handle edge cases", () => {
        expect(() => getDynamicThresholdPercent(0)).not.toThrow();
        expect(() => getDynamicThresholdPercent(-1)).not.toThrow();
    });
});

describe("Constants", () => {
    it("should export SLIDING_WINDOW_SIZE", () => {
        expect(typeof SLIDING_WINDOW_SIZE).toBe("number");
        expect(SLIDING_WINDOW_SIZE).toBeGreaterThan(0);
    });
});

describe("Type Exports", () => {
    it("should export MemoryItem type correctly", () => {
        const item: MemoryItem = {
            id: "m1",
            memory: "Test memory",
            agent_id: "wf-1",
            user_id: "u1",
            run_id: "r1",
            metadata: { key: "value" },
            created_at: new Date().toISOString(),
        };

        expect(item.id).toBe("m1");
    });

    it("should export GraphMemoryResult type correctly", () => {
        const result: GraphMemoryResult = {
            memories: [{ id: "m1", memory: "Test" }],
            entities: [{ name: "Entity", type: "test" }],
            relations: [{ source: "A", target: "B", relation: "related" }],
        };

        expect(result.memories).toHaveLength(1);
        expect(result.entities).toHaveLength(1);
    });
});
