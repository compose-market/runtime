/**
 * Nodes Tests
 * 
 * Unit tests for all Shadow Orchestra sub-agent nodes:
 * - NoteTaker: Token usage checkpointing
 * - WindowTracker: Context window health monitoring
 * - ToolBoxer: Registry-based tool recommendations
 * - Evaluator: End-of-loop performance assessment
 * - Reviewer: Start-of-loop improvement integration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    noteTakerNode,
    windowTrackerNode,
    toolBoxerNode,
    evaluatorNode,
    reviewerNode,
    getSubAgentNodes,
    type TokenLedgerState,
} from "../nodes.js";
import type { ManowarState, AgentTokenMetrics, WindowHealthStatus } from "../state.js";

// Mock fetch for external API calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock context functions
vi.mock("../context.js", () => ({
    getModelContextSpec: vi.fn().mockResolvedValue({
        modelId: "gpt-4o",
        contextLength: 128000,
        effectiveWindow: 89600,
        source: "mock",
    }),
    getModelContextSpecSync: vi.fn().mockReturnValue({
        modelId: "gpt-4o",
        contextLength: 128000,
        effectiveWindow: 89600,
        source: "mock",
    }),
    searchRegistryTools: vi.fn().mockResolvedValue([
        { id: "tool1", name: "search", description: "Web search tool", tags: ["search", "web"] },
        { id: "tool2", name: "calculator", description: "Math calculator", tags: ["math"] },
    ]),
    inspectToolCapability: vi.fn().mockResolvedValue({
        spawnParams: { transport: "http", remoteUrl: "https://example.com" },
    }),
}));

describe("NoteTaker Node", () => {
    const createMockState = (overrides: Partial<ManowarState> = {}): ManowarState => ({
        messages: [],
        workflowId: "test-workflow",
        runId: "test-run",
        activeGoal: "Complete test task",
        completedActions: [],
        tokenMetrics: {},
        windowHealth: {},
        ...overrides,
    } as ManowarState);

    it("should aggregate token metrics by agent", async () => {
        const state = createMockState();
        const ledgerState: TokenLedgerState = {
            checkpoints: [
                { agentId: "agent1", modelId: "gpt-4o", action: "analyze", inputTokens: 100, outputTokens: 50, reasoningTokens: 10, timestamp: Date.now() },
                { agentId: "agent1", modelId: "gpt-4o", action: "respond", inputTokens: 150, outputTokens: 75, reasoningTokens: 15, timestamp: Date.now() },
                { agentId: "coordinator", modelId: "gpt-4o", action: "delegate", inputTokens: 200, outputTokens: 100, reasoningTokens: 0, timestamp: Date.now() },
            ],
            cumulativeTotal: 700,
        };

        const result = await noteTakerNode(state, ledgerState);

        expect(result.tokenMetrics).toBeDefined();
        expect(result.tokenMetrics!["agent1"]).toBeDefined();
        expect(result.tokenMetrics!["agent1"].inputTokens).toBe(250); // 100 + 150
        expect(result.tokenMetrics!["agent1"].outputTokens).toBe(125); // 50 + 75
        expect(result.tokenMetrics!["coordinator"]).toBeDefined();
        expect(result.tokenMetrics!["coordinator"].inputTokens).toBe(200);
    });

    it("should handle empty checkpoints", async () => {
        const state = createMockState();
        const ledgerState: TokenLedgerState = {
            checkpoints: [],
            cumulativeTotal: 0,
        };

        const result = await noteTakerNode(state, ledgerState);
        expect(result.tokenMetrics).toEqual({});
    });

    it("should preserve existing metrics when merging", async () => {
        const existingMetrics: Record<string, AgentTokenMetrics> = {
            oldAgent: { inputTokens: 500, outputTokens: 200, reasoningTokens: 50, totalTokens: 750, lastUpdated: Date.now() - 1000 },
        };
        const state = createMockState({ tokenMetrics: existingMetrics });
        const ledgerState: TokenLedgerState = {
            checkpoints: [
                { agentId: "newAgent", modelId: "gpt-4o", action: "work", inputTokens: 100, outputTokens: 50, reasoningTokens: 0, timestamp: Date.now() },
            ],
            cumulativeTotal: 150,
        };

        const result = await noteTakerNode(state, ledgerState);

        expect(result.tokenMetrics!["oldAgent"]).toBeDefined();
        expect(result.tokenMetrics!["newAgent"]).toBeDefined();
    });
});

describe("WindowTracker Node", () => {
    const createMockState = (overrides: Partial<ManowarState> = {}): ManowarState => ({
        messages: [],
        workflowId: "test-workflow",
        runId: "test-run",
        activeGoal: "Complete test task",
        completedActions: [],
        tokenMetrics: {},
        windowHealth: {},
        agentModels: {
            coordinator: "gpt-4o",
            agent1: "gpt-4o-mini",
        },
        ...overrides,
    } as ManowarState);

    it("should calculate window health for all agents", async () => {
        const state = createMockState({
            tokenMetrics: {
                coordinator: { inputTokens: 10000, outputTokens: 5000, reasoningTokens: 0, totalTokens: 15000, lastUpdated: Date.now() },
                agent1: { inputTokens: 5000, outputTokens: 2000, reasoningTokens: 0, totalTokens: 7000, lastUpdated: Date.now() },
            },
        });

        const result = await windowTrackerNode(state);

        expect(result.windowHealth).toBeDefined();
        expect(result.windowHealth!["coordinator"]).toBeDefined();
        expect(result.windowHealth!["coordinator"].usage).toBe(15000);
        expect(result.windowHealth!["coordinator"].healthy).toBeDefined();
    });

    it("should set needsCleanup when any agent exceeds threshold", async () => {
        const state = createMockState({
            tokenMetrics: {
                // With mock effectiveWindow of 89600 (80% = 71680), 
                // 75000 tokens = ~84% usage, should trigger cleanup
                coordinator: { inputTokens: 50000, outputTokens: 25000, reasoningTokens: 0, totalTokens: 75000, lastUpdated: Date.now() },
            },
        });

        const result = await windowTrackerNode(state);

        // 75k tokens vs 89.6k effective window = ~84% usage, should trigger cleanup
        expect(result.needsCleanup).toBe(true);
    });

    it("should handle agents without metrics", async () => {
        const state = createMockState({
            tokenMetrics: {},
            agentModels: { coordinator: "gpt-4o" },
        });

        const result = await windowTrackerNode(state);

        expect(result.windowHealth!["coordinator"]).toBeDefined();
        expect(result.windowHealth!["coordinator"].usage).toBe(0);
        expect(result.windowHealth!["coordinator"].healthy).toBe(true);
    });
});

describe("ToolBoxer Node", () => {
    const createMockState = (overrides: Partial<ManowarState> = {}): ManowarState => ({
        messages: [],
        workflowId: "test-workflow",
        runId: "test-run",
        activeGoal: "Search the web for AI news",
        completedActions: [],
        tokenMetrics: {},
        windowHealth: {},
        boundPlugins: ["brave-search"],
        ...overrides,
    } as ManowarState);

    it("should recommend tools based on goal", async () => {
        const state = createMockState();

        const result = await toolBoxerNode(state);

        expect(result.suggestedTools).toBeDefined();
        expect(Array.isArray(result.suggestedTools)).toBe(true);
    });

    it("should not recommend tools that are already bound", async () => {
        const state = createMockState({
            boundPlugins: ["tool1", "tool2"], // Both mock tools
        });

        const result = await toolBoxerNode(state);

        // Should not recommend tools that are already bound
        const suggestedIds = (result.suggestedTools || []).map(t => t.registryId);
        expect(suggestedIds).not.toContain("tool1");
        expect(suggestedIds).not.toContain("tool2");
    });

    it("should handle empty goal gracefully", async () => {
        const state = createMockState({ activeGoal: "" });

        const result = await toolBoxerNode(state);

        // Should still return (possibly empty) array without error
        expect(result.suggestedTools).toBeDefined();
    });
});

describe("Evaluator Node", () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    const createMockState = (overrides: Partial<ManowarState> = {}): ManowarState => ({
        messages: [],
        workflowId: "test-workflow",
        runId: "test-run",
        activeGoal: "Complete a data analysis task",
        completedActions: ["Action 1", "Action 2"],
        tokenMetrics: {
            coordinator: { inputTokens: 5000, outputTokens: 2000, reasoningTokens: 0, totalTokens: 7000, lastUpdated: Date.now() },
        },
        windowHealth: {},
        loopCount: 1,
        loopQualityThreshold: 7,
        ...overrides,
    } as ManowarState);

    it("should return evaluation with scores and loop control", async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({
                choices: [{
                    message: {
                        content: JSON.stringify({ goalScore: 6, efficiencyScore: 7, improvements: ["Be more concise"] }),
                    },
                }],
            }),
        });

        const state = createMockState();
        const result = await evaluatorNode(state);

        expect(result.lastEvaluation).toBeDefined();
        expect(result.lastEvaluation!.goalScore).toBe(6);
        expect(result.lastEvaluation!.efficiencyScore).toBe(7);
        expect(result.suggestedImprovements).toContain("Be more concise");
        // With avg score 6.5 < threshold 7, should continue
        expect(result.shouldContinueLoop).toBe(true);
    });

    it("should stop loop when quality threshold is met", async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({
                choices: [{
                    message: {
                        content: JSON.stringify({ goalScore: 8, efficiencyScore: 9, improvements: [] }),
                    },
                }],
            }),
        });

        const state = createMockState();
        const result = await evaluatorNode(state);

        // With avg score 8.5 >= threshold 7, should NOT continue
        expect(result.shouldContinueLoop).toBe(false);
    });

    it("should increment loop count", async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({
                choices: [{
                    message: {
                        content: JSON.stringify({ goalScore: 5, efficiencyScore: 5, improvements: ["Improve"] }),
                    },
                }],
            }),
        });

        const state = createMockState({ loopCount: 3 });
        const result = await evaluatorNode(state);

        expect(result.loopCount).toBe(4);
    });

    it("should handle API failures gracefully", async () => {
        mockFetch.mockRejectedValueOnce(new Error("Network error"));

        const state = createMockState();
        const result = await evaluatorNode(state);

        // Should return empty result on failure, not throw
        expect(result).toEqual({});
    });
});

describe("Reviewer Node", () => {
    const createMockState = (overrides: Partial<ManowarState> = {}): ManowarState => ({
        messages: [],
        workflowId: "test-workflow",
        runId: "test-run",
        activeGoal: "Complete task",
        completedActions: [],
        tokenMetrics: {},
        windowHealth: {},
        loopCount: 2,
        suggestedImprovements: ["Be more concise", "Add error handling"],
        ...overrides,
    } as ManowarState);

    it("should process improvements on loop 2+", async () => {
        const state = createMockState();

        const result = await reviewerNode(state);

        expect(result.contextEnhancements).toBeDefined();
        expect(result.contextEnhancements!.length).toBe(2);
        expect(result.reviewApplied).toBe(true);
    });

    it("should skip on first loop", async () => {
        const state = createMockState({ loopCount: 1 });

        const result = await reviewerNode(state);

        expect(result.reviewApplied).toBe(false);
    });

    it("should handle empty improvements", async () => {
        const state = createMockState({ suggestedImprovements: [] });

        const result = await reviewerNode(state);

        expect(result.reviewApplied).toBe(false);
    });
});



describe("getSubAgentNodes", () => {
    it("should return all sub-agent node functions", () => {
        const nodes = getSubAgentNodes();

        expect(nodes.noteTaker).toBeDefined();
        expect(typeof nodes.noteTaker).toBe("function");

        expect(nodes.windowTracker).toBeDefined();
        expect(typeof nodes.windowTracker).toBe("function");

        expect(nodes.toolBoxer).toBeDefined();
        expect(typeof nodes.toolBoxer).toBe("function");

        expect(nodes.evaluator).toBeDefined();
        expect(typeof nodes.evaluator).toBe("function");

        expect(nodes.reviewer).toBeDefined();
        expect(typeof nodes.reviewer).toBe("function");
    });
});
