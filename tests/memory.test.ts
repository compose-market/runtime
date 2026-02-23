/**
 * Memory Tests
 * 
 * Unit tests for Mem0 Platform API integration.
 * Tests utility functions and type exports.
 * 
 * NOTE: SLIDING_WINDOW_SIZE and getDynamicThresholdPercent moved to context.ts
 */

import { describe, it, expect, vi } from "vitest";
import {
    isMem0Available,
    type MemoryItem,
    type GraphMemoryResult,
} from "../src/manowar/memory.js";

describe("isMem0Available", () => {
    it("should return boolean", () => {
        const result = isMem0Available();
        expect(typeof result).toBe("boolean");
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
