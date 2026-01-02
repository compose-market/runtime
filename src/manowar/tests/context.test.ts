/**
 * Context Tests
 * 
 * Unit tests for context window management components:
 * - TokenLedger: Token usage checkpointing
 * - ContextWindowManager: Window state tracking
 * - Model context spec retrieval (sync and async)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    TokenLedger,
    ContextWindowManager,
    getModelContextSpec,
    getModelContextSpecSync,
    type TokenCheckpoint,
    type ModelContextSpec,
} from "../context.js";

// Mock fetch for Lambda API calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Helper to create valid TokenUsage objects
function createTokenUsage(agentId: string, model: string, inputTokens: number, outputTokens: number) {
    return {
        agentId,
        model,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        timestamp: Date.now(),
    };
}

describe("TokenLedger", () => {
    let ledger: TokenLedger;

    beforeEach(() => {
        ledger = new TokenLedger();
    });

    describe("recordFromResponse", () => {
        it("should record checkpoint from API response with usage data", () => {
            const response = {
                usage: {
                    prompt_tokens: 100,
                    completion_tokens: 50,
                    total_tokens: 150,
                },
            };

            const checkpoint = ledger.recordFromResponse(
                "agent1",
                "gpt-4o",
                "analyze",
                response,
                "openai"
            );

            expect(checkpoint.agentId).toBe("agent1");
            expect(checkpoint.modelId).toBe("gpt-4o");
            expect(checkpoint.action).toBe("analyze");
            expect(checkpoint.inputTokens).toBe(100);
            expect(checkpoint.outputTokens).toBe(50);
            expect(checkpoint.estimated).toBe(false);
        });

        it("should handle Anthropic-style usage format", () => {
            const response = {
                usage: {
                    input_tokens: 200,
                    output_tokens: 100,
                },
            };

            const checkpoint = ledger.recordFromResponse(
                "claude",
                "claude-3-opus",
                "generate",
                response,
                "anthropic"
            );

            expect(checkpoint.inputTokens).toBe(200);
            expect(checkpoint.outputTokens).toBe(100);
        });

        it("should update cumulative total", () => {
            const response1 = { usage: { prompt_tokens: 100, completion_tokens: 50 } };
            const response2 = { usage: { prompt_tokens: 200, completion_tokens: 100 } };

            ledger.recordFromResponse("a1", "m1", "act1", response1);
            ledger.recordFromResponse("a2", "m2", "act2", response2);

            expect(ledger.getCumulativeTotal()).toBe(450); // 150 + 300
        });
    });

    describe("getAgentCheckpoints", () => {
        it("should return only checkpoints for specified agent", () => {
            ledger.recordFromResponse("agent1", "m1", "a1", { usage: { prompt_tokens: 100, completion_tokens: 50 } });
            ledger.recordFromResponse("agent2", "m2", "a2", { usage: { prompt_tokens: 200, completion_tokens: 100 } });
            ledger.recordFromResponse("agent1", "m3", "a3", { usage: { prompt_tokens: 150, completion_tokens: 75 } });

            const agent1Checkpoints = ledger.getAgentCheckpoints("agent1");

            expect(agent1Checkpoints).toHaveLength(2);
            expect(agent1Checkpoints.every(c => c.agentId === "agent1")).toBe(true);
        });

        it("should return empty array for unknown agent", () => {
            ledger.recordFromResponse("agent1", "m1", "a1", { usage: { prompt_tokens: 100, completion_tokens: 50 } });

            const unknown = ledger.getAgentCheckpoints("unknown");

            expect(unknown).toHaveLength(0);
        });
    });

    describe("getAgentTotals", () => {
        it("should return total tokens per agent", () => {
            ledger.recordFromResponse("agent1", "m1", "a1", { usage: { prompt_tokens: 100, completion_tokens: 50 } });
            ledger.recordFromResponse("agent2", "m2", "a2", { usage: { prompt_tokens: 200, completion_tokens: 100 } });
            ledger.recordFromResponse("agent1", "m3", "a3", { usage: { prompt_tokens: 150, completion_tokens: 75 } });

            const totals = ledger.getAgentTotals();

            expect(totals.get("agent1")).toBe(375); // 150 + 225
            expect(totals.get("agent2")).toBe(300);
        });
    });

    describe("clear", () => {
        it("should clear all checkpoints and reset total", () => {
            ledger.recordFromResponse("agent1", "m1", "a1", { usage: { prompt_tokens: 100, completion_tokens: 50 } });
            ledger.recordFromResponse("agent2", "m2", "a2", { usage: { prompt_tokens: 200, completion_tokens: 100 } });

            ledger.clear();

            expect(ledger.getCumulativeTotal()).toBe(0);
            expect(ledger.export()).toHaveLength(0);
        });
    });

    describe("recordCheckpoint", () => {
        it("should record pre-built checkpoint directly", () => {
            const checkpoint: TokenCheckpoint = {
                agentId: "external",
                modelId: "gpt-4",
                action: "external-action",
                inputTokens: 500,
                outputTokens: 200,
                timestamp: Date.now(),
                cumulativeTotal: 700,
                estimated: false,
                provider: "openai",
            };

            ledger.recordCheckpoint(checkpoint);

            const exported = ledger.export();
            expect(exported).toHaveLength(1);
            expect(exported[0].agentId).toBe("external");
        });
    });

    describe("export", () => {
        it("should return copy of all checkpoints", () => {
            ledger.recordFromResponse("agent1", "m1", "a1", { usage: { prompt_tokens: 100, completion_tokens: 50 } });

            const exported1 = ledger.export();
            const exported2 = ledger.export();

            expect(exported1).not.toBe(exported2); // Different array instances
            expect(exported1).toEqual(exported2); // Same content
        });
    });
});

describe("ContextWindowManager", () => {
    let manager: ContextWindowManager;

    beforeEach(() => {
        manager = new ContextWindowManager("gpt-4o", {
            maxTokens: 128000,
            cleanupThreshold: 70,
        });
    });

    describe("constructor", () => {
        it("should initialize with correct settings", () => {
            const state = manager.getState();

            expect(state.maxTokens).toBe(128000);
            expect(state.currentTokens).toBe(0);
            expect(state.usagePercent).toBe(0);
        });

        it("should use default values when options not provided", () => {
            const defaultManager = new ContextWindowManager("gpt-4o-mini");
            const state = defaultManager.getState();

            // Should have a reasonable default maxTokens
            expect(state.maxTokens).toBeGreaterThanOrEqual(16000);
        });
    });

    describe("recordUsage", () => {
        it("should track token usage", () => {
            manager.recordUsage(createTokenUsage("agent1", "gpt-4o", 1000, 500));

            const state = manager.getState();
            expect(state.currentTokens).toBe(1500);
        });

        it("should accumulate usage from multiple calls", () => {
            manager.recordUsage(createTokenUsage("a1", "m1", 1000, 500));
            manager.recordUsage(createTokenUsage("a2", "m2", 2000, 1000));

            const state = manager.getState();
            expect(state.currentTokens).toBe(4500);
        });
    });

    describe("recordMessage", () => {
        it("should estimate and record tokens from message content", () => {
            const usage = manager.recordMessage("agent1", "gpt-4o", "Hello, this is a test message with some content.");

            expect(usage.inputTokens).toBeGreaterThan(0);
            expect(manager.getState().currentTokens).toBeGreaterThan(0);
        });

        it("should add output tokens when isOutput is true", () => {
            const usage = manager.recordMessage("agent1", "gpt-4o", "Response content", true);

            expect(usage.outputTokens).toBeGreaterThan(0);
        });
    });

    describe("getState", () => {
        it("should calculate usage percentage correctly", () => {
            manager.recordUsage(createTokenUsage("a1", "m1", 64000, 0));

            const state = manager.getState();
            expect(state.usagePercent).toBeCloseTo(50, 0);
        });

        it("should indicate when cleanup is needed", () => {
            // Record tokens that exceed 70% threshold
            manager.recordUsage(createTokenUsage("a1", "m1", 100000, 0));

            const state = manager.getState();
            expect(state.needsCleanup).toBe(true);
        });
    });

    describe("getRemainingTokens", () => {
        it("should return correct remaining capacity", () => {
            manager.recordUsage(createTokenUsage("a1", "m1", 28000, 0));

            expect(manager.getRemainingTokens()).toBe(100000); // 128000 - 28000
        });
    });

    describe("getSafeTokenLimit", () => {
        it("should return threshold-adjusted limit", () => {
            const safeLimit = manager.getSafeTokenLimit();

            expect(safeLimit).toBe(89600); // 128000 * 0.7
        });
    });

    describe("willExceedThreshold", () => {
        it("should return true when content will exceed threshold", () => {
            // Set current usage close to threshold
            manager.recordUsage(createTokenUsage("a1", "m1", 85000, 0));

            // A long message should exceed threshold
            const longContent = "word ".repeat(10000);
            expect(manager.willExceedThreshold(longContent)).toBe(true);
        });

        it("should return false when content fits within threshold", () => {
            const shortContent = "Hello world";
            expect(manager.willExceedThreshold(shortContent)).toBe(false);
        });
    });
});

describe("getModelContextSpec", () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    it("should return spec for model", async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({
                contextLength: 128000,
                source: "openai",
            }),
        });

        const spec = await getModelContextSpec("gpt-4o");

        expect(spec.modelId).toBe("gpt-4o");
        expect(spec.contextLength).toBeGreaterThan(0);
        expect(spec.effectiveWindow).toBeGreaterThan(0);
    });
});

describe("getModelContextSpecSync", () => {
    it("should return spec for any model", () => {
        const spec = getModelContextSpecSync("gpt-4o");

        expect(spec.modelId).toBe("gpt-4o");
        expect(typeof spec.contextLength).toBe("number");
    });
});
