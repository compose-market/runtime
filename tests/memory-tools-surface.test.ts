/**
 * Tests for the simplified memory tool surface (Phase 1.5).
 *
 * `memory_recall` was removed: the `memory.arazzo.yaml` contract states
 * "ranker picks for you" — server-side pre-injection (~6 items / 900
 * chars per turn) is the contract. Letting the model second-guess
 * the ranker mid-turn doubles the work and contradicts the spec.
 *
 * `memory_remember` stays: orthogonal use case for explicit user-stated
 * facts that the auto-extractor sometimes misses.
 */
import { describe, expect, it } from "vitest";

import { createMemoryTools } from "../src/manowar/agent/tools.js";

describe("createMemoryTools (Phase 1.5)", () => {
    it("exposes only memory_remember; no memory_recall", () => {
        const tools = createMemoryTools(
            "0x1111111111111111111111111111111111111111",
        );
        const names = tools.map((tool) => tool.name).sort();
        expect(names).toEqual(["memory_remember"]);
    });

    it("memory_remember description matches the explicit-user-fact use case", () => {
        const tools = createMemoryTools(
            "0x1111111111111111111111111111111111111111",
        );
        const remember = tools.find((tool) => tool.name === "memory_remember");
        expect(remember).toBeDefined();
        expect(remember?.description).toMatch(/Save a durable fact/i);
        // Description must NOT advertise stale layer/recall semantics.
        expect(remember?.description).not.toMatch(/recall|search.*layers/i);
    });

    it("works with all three caller positional shapes (no breaking change to signature)", () => {
        // Common production shapes — three-arg form (with userAddress + workflowWallet)
        // and one-arg form (sub-agent / harness).
        const onlyAgent = createMemoryTools(
            "0x1111111111111111111111111111111111111111",
        );
        const withUser = createMemoryTools(
            "0x1111111111111111111111111111111111111111",
            "0x2222222222222222222222222222222222222222",
        );
        const withWorkflow = createMemoryTools(
            "0x1111111111111111111111111111111111111111",
            "0x2222222222222222222222222222222222222222",
            "0x3333333333333333333333333333333333333333",
        );
        for (const tools of [onlyAgent, withUser, withWorkflow]) {
            expect(tools.map((t) => t.name)).toEqual(["memory_remember"]);
        }
    });
});
