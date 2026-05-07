/**
 * Tests for fire-and-forget fact extraction in the post_turn loop
 * (Phase 1.4 — `runtime/src/manowar/memory/agent-loop.ts`).
 *
 * Contract:
 *   - `recordAgentMemoryTurn` must NOT block on `indexAgentMemoryFacts`
 *     (which calls Gemini and can take 1-8s).
 *   - The route should return as soon as transcript+working+session-vector
 *     land. `stored.graph` is documented as always `false` at response time;
 *     facts surface in the next pre_turn recall.
 *   - Errors in fact extraction must NOT propagate to the caller.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hold a deferred for the indexAgentMemoryFacts call so we can keep it
// pending while the route completes.
let factExtractionPromise: Promise<unknown> | null = null;
let factExtractionResolve: ((v: unknown) => void) | null = null;
let factExtractionFn = vi.fn();

vi.mock("../src/manowar/memory/graph.js", () => ({
    indexAgentMemoryFacts: (input: unknown) => {
        factExtractionFn(input);
        factExtractionPromise = new Promise((resolve) => {
            factExtractionResolve = resolve;
        });
        return factExtractionPromise;
    },
}));

vi.mock("../src/manowar/memory/transcript.js", () => ({
    storeTranscript: vi.fn().mockResolvedValue({ success: true }),
    rememberSessionMessages: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("../src/manowar/memory/vector.js", () => ({
    indexMemoryContent: vi.fn().mockResolvedValue({ vectorId: "vec_test_123" }),
}));

beforeEach(() => {
    factExtractionPromise = null;
    factExtractionResolve = null;
    factExtractionFn = vi.fn();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("recordAgentMemoryTurn — fire-and-forget fact extraction (Phase 1.4)", () => {
    it("returns BEFORE indexAgentMemoryFacts resolves", async () => {
        const { recordAgentMemoryTurn } = await import("../src/manowar/memory/agent-loop.js");

        const start = Date.now();
        const result = await recordAgentMemoryTurn({
            agentWallet: "0x1111111111111111111111111111111111111111",
            userAddress: "0x2222222222222222222222222222222222222222",
            threadId: "thread-test",
            turnId: "turn_test_123",
            userMessage: "Hello assistant",
            assistantMessage: "Hi user",
        });
        const elapsed = Date.now() - start;

        // The route must NOT have waited for the (never-resolved) extractor.
        expect(elapsed).toBeLessThan(500);
        expect(result.success).toBe(true);
        expect(result.turnId).toBe("turn_test_123");
        // graph is always false at response time per Phase 1.4 contract.
        expect(result.stored.graph).toBe(false);
        // The other three layers landed synchronously.
        expect(result.stored.transcript).toBe(true);
        expect(result.stored.working).toBe(true);
        expect(result.stored.vector).toBe(true);

        // Confirm extraction was actually invoked (even though we never resolved it).
        expect(factExtractionFn).toHaveBeenCalledTimes(1);

        // Resolve the dangling promise so the test doesn't leak.
        factExtractionResolve?.(undefined);
    });

    it("does not propagate errors from fact extraction to the caller", async () => {
        const { recordAgentMemoryTurn } = await import("../src/manowar/memory/agent-loop.js");

        // Override mock to reject.
        const mod = await import("../src/manowar/memory/graph.js") as { indexAgentMemoryFacts: unknown };
        (mod as { indexAgentMemoryFacts: unknown }).indexAgentMemoryFacts = () =>
            Promise.reject(new Error("Gemini timeout"));

        // Spy on console.warn to verify the error is logged structured.
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        const result = await recordAgentMemoryTurn({
            agentWallet: "0x1111111111111111111111111111111111111111",
            userAddress: "0x2222222222222222222222222222222222222222",
            threadId: "thread-fail",
            turnId: "turn_fail_123",
            userMessage: "Hello assistant",
            assistantMessage: "Hi user",
        });

        expect(result.success).toBe(true);
        expect(result.stored.graph).toBe(false);

        // Wait a tick so the rejected promise's .catch handler runs.
        await new Promise((resolve) => setTimeout(resolve, 20));
        const calls = warnSpy.mock.calls.map((c) => c.join(" "));
        expect(calls.some((m) => m.includes("fact extraction failed"))).toBe(true);

        warnSpy.mockRestore();
    });
});
