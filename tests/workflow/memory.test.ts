/**
 * Workflow memory tests — first-party graph layer (no mem0).
 *
 * Verifies the core type contract that workflow consumers depend on:
 *   MemoryItem and GraphMemoryResult.
 */

import { describe, it, expect } from "vitest";
import type {
    GraphMemoryResult,
} from "../../src/manowar/workflow/memory.js";
import type { MemoryItem } from "../../src/manowar/memory/index.js";

describe("Type Exports", () => {
    it("should export MemoryItem type correctly", () => {
        const item: MemoryItem = {
            id: "m1",
            memory: "User's favorite color is azure.",
            agent_id: "0xagent",
            user_id: "0xuser",
            run_id: "thread-1",
            metadata: { layer: "graph", factType: "preference" },
            created_at: new Date().toISOString(),
        };

        expect(item.id).toBe("m1");
        expect(item.memory).toContain("azure");
    });

    it("should export GraphMemoryResult shape correctly", () => {
        const result: GraphMemoryResult = {
            memories: [{ id: "m1", memory: "User likes jazz." }],
            relations: [{ source: "user", target: "jazz", relation: "likes" }],
        };

        expect(result.memories).toHaveLength(1);
        expect(result.memories[0].memory).toBe("User likes jazz.");
    });
});
