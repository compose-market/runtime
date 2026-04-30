/**
 * Context Tests
 * 
 * Unit tests for context helpers and context window management.
 * Uses mocked API responses for deterministic, fast execution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    ContextWindowManager,
    getModelContextSpec,
    getModelContextSpecSync,
    getSlidingWindow,
    getDynamicThresholdPercent,
    fetchModelContextWindow,
    SLIDING_WINDOW_SIZE,
    type ModelContextSpec,
} from "../../src/manowar/workflow/context.js";
import {
    estimateCost,
} from "../../src/manowar/workflow/langsmith.js";

function mockModelFetch(contextWindow = 128000) {
    return vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({
            modelId: "gpt-4o",
            contextWindow: {
                inputTokens: contextWindow,
                outputTokens: 4096,
            },
            type: "chat-completions",
        }),
    } as Response);
}

beforeEach(() => {
    vi.restoreAllMocks();
    process.env.API_URL = "https://api.compose.market";
});

afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.API_URL;
});

// ============================================================================
// estimateCost Tests (from langsmith.ts)
// ============================================================================
describe("estimateCost", () => {
    it("should calculate cost with pricing object", () => {
        const pricing = { input: 2.5, output: 10 }; // USD per million tokens
        const cost = estimateCost(1000, 500, pricing);

        expect(cost).toBeGreaterThan(0);
        expect(cost).toBeLessThan(0.01);
    });

    it("should handle different pricing", () => {
        const pricing = { input: 0.15, output: 0.6 };
        const cost = estimateCost(1000, 500, pricing);

        expect(cost).toBeGreaterThan(0);
    });
});

// ============================================================================
// getDynamicThresholdPercent Tests (moved from memory.ts)
// ============================================================================
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
});

// ============================================================================
// Constants
// ============================================================================
describe("Constants", () => {
    it("should export SLIDING_WINDOW_SIZE", () => {
        expect(typeof SLIDING_WINDOW_SIZE).toBe("number");
        expect(SLIDING_WINDOW_SIZE).toBeGreaterThan(0);
    });
});

// ============================================================================
// getModelContextSpec Tests
// ============================================================================
describe("fetchModelContextWindow", () => {
    it("should fetch contextWindow from canonical /v1/models/:model endpoint", async () => {
        const fetchSpy = mockModelFetch(128000);
        const contextWindow = await fetchModelContextWindow("gpt-4o");

        expect(contextWindow).toBeGreaterThan(0);
        expect(contextWindow).toBe(128000);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy).toHaveBeenCalledWith(
            "https://api.compose.market/v1/models/gpt-4o",
        );
    });

    it("should cache repeated requests", async () => {
        const modelId = `gpt-4o-mini-${Date.now()}`;
        const fetchSpy = mockModelFetch(64000);

        const first = await fetchModelContextWindow(modelId);
        const second = await fetchModelContextWindow(modelId);

        expect(first).toBe(second);
        expect(first).toBe(64000);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
});

describe("getModelContextSpec", () => {
    it("should return spec from API", async () => {
        mockModelFetch(128000);
        const spec = await getModelContextSpec("gpt-4o-spec");

        expect(spec.modelId).toBe("gpt-4o-spec");
        expect(spec.contextLength).toBe(128000);
        expect(spec.effectiveWindow).toBe(Math.floor(128000 * 0.70));
        expect(spec.source).toBe("api");
    });
});

describe("getModelContextSpecSync", () => {
    it("should return unknown source for sync version", () => {
        const spec = getModelContextSpecSync("gpt-4o");

        expect(spec.modelId).toBe("gpt-4o");
        expect(spec.source).toBe("unknown"); // Sync cannot fetch from API
    });
});

// ============================================================================
// ContextWindowManager Tests
// ============================================================================
describe("ContextWindowManager", () => {
    it("should create with model", () => {
        const manager = new ContextWindowManager("gpt-4o");
        expect(manager).toBeDefined();
    });

    it("should initialize with real context from API", async () => {
        mockModelFetch(128000);
        const manager = new ContextWindowManager("gpt-4o");
        await manager.initialize();

        const state = manager.getState();
        expect(state.maxTokens).toBe(128000);
    });

    it("should record usage and update state", async () => {
        mockModelFetch(128000);
        const manager = new ContextWindowManager("gpt-4o");
        await manager.initialize();

        manager.recordUsage({
            agentId: "agent1",
            model: "gpt-4o",
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            timestamp: Date.now(),
        });

        const state = manager.getState();
        expect(state.currentTokens).toBe(150);
    });

    it("should record message and track actual token count", async () => {
        mockModelFetch(128000);
        const manager = new ContextWindowManager("gpt-4o");
        await manager.initialize();

        // Use actual token count (from LangSmith callback) instead of estimating
        const usage = manager.recordMessage("agent1", "gpt-4o", 100);

        expect(usage.agentId).toBe("agent1");
        expect(usage.totalTokens).toBe(100);
    });

    it("should accumulate usage for same agent", async () => {
        mockModelFetch(128000);
        const manager = new ContextWindowManager("gpt-4o");
        await manager.initialize();

        manager.recordUsage({
            agentId: "agent1",
            model: "gpt-4o",
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            timestamp: Date.now(),
        });

        manager.recordUsage({
            agentId: "agent1",
            model: "gpt-4o",
            inputTokens: 50,
            outputTokens: 25,
            totalTokens: 75,
            timestamp: Date.now(),
        });

        const state = manager.getState();
        expect(state.currentTokens).toBe(225);
    });

    it("should calculate remaining tokens", async () => {
        mockModelFetch(128000);
        const manager = new ContextWindowManager("gpt-4o");
        await manager.initialize();

        manager.recordUsage({
            agentId: "agent1",
            model: "gpt-4o",
            inputTokens: 300,
            outputTokens: 0,
            totalTokens: 300,
            timestamp: Date.now(),
        });

        expect(manager.getRemainingTokens()).toBe(128000 - 300);
    });
});

// ============================================================================
// getSlidingWindow Tests
// ============================================================================
describe("getSlidingWindow", () => {
    it("should keep all messages if under window size", () => {
        const messages = [
            { role: "system", content: "System" },
            { role: "user", content: "Hello" },
            { role: "assistant", content: "Hi" },
        ];

        const result = getSlidingWindow(messages, 6);
        expect(result.length).toBe(3);
    });

    it("should keep system message and last N messages", () => {
        const messages = [
            { role: "system", content: "System" },
            { role: "user", content: "1" },
            { role: "assistant", content: "2" },
            { role: "user", content: "3" },
            { role: "assistant", content: "4" },
            { role: "user", content: "5" },
            { role: "assistant", content: "6" },
            { role: "user", content: "7" },
            { role: "assistant", content: "8" },
        ];

        const result = getSlidingWindow(messages, 4);

        expect(result.length).toBe(5); // system + last 4
        expect(result[0].role).toBe("system");
        expect(result[1].content).toBe("5");
    });

    it("should handle messages without system message", () => {
        const messages = [
            { role: "user", content: "1" },
            { role: "assistant", content: "2" },
            { role: "user", content: "3" },
            { role: "assistant", content: "4" },
            { role: "user", content: "5" },
        ];

        const result = getSlidingWindow(messages, 2);

        expect(result.length).toBe(2);
        expect(result[0].content).toBe("4");
    });
});
