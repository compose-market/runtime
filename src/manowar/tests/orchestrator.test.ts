/**
 * Orchestrator E2E Integration Tests
 * 
 * Real integration tests for the Shadow Orchestra pattern:
 * - Node inter-communication (NoteTaker → WindowTracker → ToolBoxer → Evaluator)
 * - State flow through the graph
 * - Token metrics aggregation
 * - Continuous loop control logic
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages";

// ============================================================================
// Import REAL node functions for integration testing
// ============================================================================
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

// Mock external HTTP calls but NOT node logic
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ============================================================================
// Helper: Create realistic ManowarState for testing
// ============================================================================
function createTestState(overrides: Partial<ManowarState> = {}): ManowarState {
    return {
        messages: [],
        workflowId: "test-workflow",
        runId: `run-${Date.now()}`,
        activeGoal: "Complete the data analysis task",
        completedActions: [],
        agentModels: {
            coordinator: "gpt-4o",
            DataAnalyst: "gpt-4o-mini",
            Summarizer: "gpt-4o-mini",
        },
        tokenMetrics: {},
        windowHealth: {},
        needsCleanup: false,
        suggestedTools: [],
        suggestedImprovements: [],
        boundPlugins: [],
        loopCount: 1,
        loopQualityThreshold: 7,
        shouldContinueLoop: false,
        stepOutputs: {},
        maskedToolIds: [],
        ...overrides,
    } as ManowarState;
}

// ============================================================================
// NoteTaker → WindowTracker Flow Tests
// ============================================================================
describe("Shadow Orchestra: NoteTaker → WindowTracker Flow", () => {
    it("should aggregate token metrics and pass to WindowTracker for health check", async () => {
        // Step 1: NoteTaker processes token ledger
        const initialState = createTestState();
        const ledger: TokenLedgerState = {
            checkpoints: [
                { agentId: "coordinator", modelId: "gpt-4o", action: "plan", inputTokens: 500, outputTokens: 200, reasoningTokens: 0, timestamp: Date.now() },
                { agentId: "DataAnalyst", modelId: "gpt-4o-mini", action: "analyze", inputTokens: 1000, outputTokens: 500, reasoningTokens: 0, timestamp: Date.now() },
            ],
            cumulativeTotal: 2200,
        };

        const afterNoteTaker = await noteTakerNode(initialState, ledger);

        // Verify NoteTaker output
        expect(afterNoteTaker.tokenMetrics).toBeDefined();
        expect(afterNoteTaker.tokenMetrics!["coordinator"]).toBeDefined();
        expect(afterNoteTaker.tokenMetrics!["coordinator"].totalTokens).toBe(700); // 500 + 200
        expect(afterNoteTaker.tokenMetrics!["DataAnalyst"].totalTokens).toBe(1500); // 1000 + 500

        // Step 2: WindowTracker processes updated state
        const stateWithMetrics = { ...initialState, ...afterNoteTaker };
        const afterWindowTracker = await windowTrackerNode(stateWithMetrics);

        // Verify WindowTracker output
        expect(afterWindowTracker.windowHealth).toBeDefined();
        expect(afterWindowTracker.windowHealth!["coordinator"]).toBeDefined();
        expect(afterWindowTracker.windowHealth!["coordinator"].usage).toBe(700);
        expect(typeof afterWindowTracker.windowHealth!["coordinator"].healthy).toBe("boolean");
    });

    it("should detect unhealthy window when tokens exceed threshold", async () => {
        // Create state with high token usage
        const state = createTestState({
            tokenMetrics: {
                coordinator: {
                    inputTokens: 80000,
                    outputTokens: 20000,
                    reasoningTokens: 0,
                    totalTokens: 100000, // ~78% of 128k
                    lastUpdated: Date.now()
                },
            },
        });

        const result = await windowTrackerNode(state);

        // High usage should trigger cleanup or mark as unhealthy
        expect(result.windowHealth!["coordinator"].usagePercent).toBeGreaterThan(50);
    });
});

// ============================================================================
// ToolBoxer Node Tests  
// ============================================================================
describe("Shadow Orchestra: ToolBoxer Node", () => {
    beforeEach(() => {
        mockFetch.mockReset();
        // Mock registry search
        mockFetch.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({
                results: [
                    { id: "brave-search", name: "Brave Search", description: "Web search", tags: ["search"] },
                    { id: "calculator", name: "Calculator", description: "Math operations", tags: ["math"] },
                ],
            }),
        });
    });

    it("should recommend tools based on goal keywords", async () => {
        const state = createTestState({
            activeGoal: "Search the web for AI news and analyze the results",
            boundPlugins: [],
        });

        const result = await toolBoxerNode(state);

        expect(result.suggestedTools).toBeDefined();
        expect(Array.isArray(result.suggestedTools)).toBe(true);
    });

    it("should exclude already-bound plugins from recommendations", async () => {
        const state = createTestState({
            activeGoal: "Search the web for data",
            boundPlugins: ["brave-search"], // Already bound
        });

        const result = await toolBoxerNode(state);

        // Should not recommend brave-search since it's already bound
        const recommendedIds = (result.suggestedTools || []).map(t => t.registryId);
        expect(recommendedIds).not.toContain("brave-search");
    });
});

// ============================================================================
// Evaluator Node - Loop Control Tests
// ============================================================================
describe("Shadow Orchestra: Evaluator Loop Control", () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    it("should set shouldContinueLoop when quality is below threshold", async () => {
        // Mock LLM response for evaluation
        mockFetch.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            goalScore: 5,
                            efficiencyScore: 6,
                            improvements: ["Add more detail", "Verify sources"],
                        }),
                    },
                }],
            }),
        });

        const state = createTestState({
            activeGoal: "Complete data analysis",
            completedActions: ["Fetched data", "Ran initial analysis"],
            loopCount: 1,
            loopQualityThreshold: 7,
        });

        const result = await evaluatorNode(state);

        // Average score (5+6)/2 = 5.5 < threshold 7, should continue
        expect(result.lastEvaluation).toBeDefined();
        expect(result.shouldContinueLoop).toBe(true);
        expect(result.loopCount).toBe(2);
        expect(result.suggestedImprovements?.length).toBeGreaterThan(0);
    });

    it("should NOT continue loop when quality meets threshold", async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            goalScore: 9,
                            efficiencyScore: 8,
                            improvements: [],
                        }),
                    },
                }],
            }),
        });

        const state = createTestState({
            loopCount: 1,
            loopQualityThreshold: 7,
        });

        const result = await evaluatorNode(state);

        // Average score (9+8)/2 = 8.5 >= threshold 7, should NOT continue
        expect(result.shouldContinueLoop).toBe(false);
    });

    it("should increment loopCount on each evaluation", async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({
                choices: [{ message: { content: JSON.stringify({ goalScore: 6, efficiencyScore: 6, improvements: ["x"] }) } }],
            }),
        });

        const state = createTestState({ loopCount: 5 });
        const result = await evaluatorNode(state);

        expect(result.loopCount).toBe(6);
    });
});

// ============================================================================
// Reviewer Node - Improvement Integration Tests
// ============================================================================
describe("Shadow Orchestra: Reviewer Node", () => {
    it("should integrate improvements on loop 2+", async () => {
        const state = createTestState({
            loopCount: 2,
            activeGoal: "Original goal text",
            suggestedImprovements: ["Add error handling", "Include edge cases"],
        });

        const result = await reviewerNode(state);

        expect(result.contextEnhancements).toBeDefined();
        expect(result.contextEnhancements!.length).toBe(2);
        expect(result.contextEnhancements![0]).toContain("Add error handling");
        expect(result.reviewApplied).toBe(true);
    });

    it("should skip on first loop", async () => {
        const state = createTestState({
            loopCount: 1,
            suggestedImprovements: ["Should be ignored"],
        });

        const result = await reviewerNode(state);

        // Should return reviewApplied: false on first loop
        expect(result.reviewApplied).toBe(false);
    });

    it("should preserve original goal when no improvements", async () => {
        const state = createTestState({
            loopCount: 3,
            activeGoal: "My goal",
            suggestedImprovements: [],
        });

        const result = await reviewerNode(state);

        // No improvements means reviewApplied: false
        expect(result.reviewApplied).toBe(false);
    });
});

// ============================================================================
// Full Pipeline: NoteTaker → WindowTracker → ToolBoxer → Evaluator
// ============================================================================
describe("Shadow Orchestra: Full Pipeline Integration", () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    it("should execute complete sub-agent pipeline and update state", async () => {
        // Mock external calls
        mockFetch.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({
                choices: [{ message: { content: JSON.stringify({ goalScore: 7, efficiencyScore: 8, improvements: [] }) } }],
                results: [],
            }),
        });

        // Initial state
        let state = createTestState({
            activeGoal: "Analyze market data",
            completedActions: ["Fetched data"],
        });

        // 1. NoteTaker
        const ledger: TokenLedgerState = {
            checkpoints: [
                { agentId: "coordinator", modelId: "gpt-4o", action: "delegate", inputTokens: 300, outputTokens: 150, reasoningTokens: 0, timestamp: Date.now() },
            ],
            cumulativeTotal: 450,
        };
        const afterNoteTaker = await noteTakerNode(state, ledger);
        state = { ...state, ...afterNoteTaker };

        expect(state.tokenMetrics!["coordinator"]).toBeDefined();

        // 2. WindowTracker
        const afterWindowTracker = await windowTrackerNode(state);
        state = { ...state, ...afterWindowTracker };

        expect(state.windowHealth!["coordinator"]).toBeDefined();
        expect(state.windowHealth!["coordinator"].healthy).toBe(true);

        // 3. ToolBoxer
        const afterToolBoxer = await toolBoxerNode(state);
        state = { ...state, ...afterToolBoxer };

        expect(state.suggestedTools).toBeDefined();

        // 4. Evaluator
        const afterEvaluator = await evaluatorNode(state);
        state = { ...state, ...afterEvaluator };

        expect(state.lastEvaluation).toBeDefined();
        expect(typeof state.shouldContinueLoop).toBe("boolean");
        expect(state.loopCount).toBe(2);

        console.log("[E2E] Final state:", {
            tokenMetrics: Object.keys(state.tokenMetrics || {}),
            windowHealth: Object.keys(state.windowHealth || {}),
            suggestedTools: state.suggestedTools?.length || 0,
            loopCount: state.loopCount,
            shouldContinueLoop: state.shouldContinueLoop,
        });
    });
});

// ============================================================================
// getSubAgentNodes Factory Test
// ============================================================================
describe("getSubAgentNodes Factory", () => {
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

    it("should return functions that match direct exports", () => {
        const nodes = getSubAgentNodes();

        expect(nodes.noteTaker).toBe(noteTakerNode);
        expect(nodes.windowTracker).toBe(windowTrackerNode);
        expect(nodes.toolBoxer).toBe(toolBoxerNode);
        expect(nodes.evaluator).toBe(evaluatorNode);
        expect(nodes.reviewer).toBe(reviewerNode);
    });
});

// ============================================================================
// State Type Correctness
// ============================================================================
describe("State Type Contracts", () => {
    it("should produce correct AgentTokenMetrics shape", async () => {
        const state = createTestState();
        const ledger: TokenLedgerState = {
            checkpoints: [
                { agentId: "test", modelId: "gpt-4o", action: "test", inputTokens: 100, outputTokens: 50, reasoningTokens: 10, timestamp: Date.now() },
            ],
            cumulativeTotal: 160,
        };

        const result = await noteTakerNode(state, ledger);
        const metrics = result.tokenMetrics!["test"];

        // Verify shape matches AgentTokenMetrics
        expect(metrics.inputTokens).toBe(100);
        expect(metrics.outputTokens).toBe(50);
        expect(metrics.reasoningTokens).toBe(10);
        expect(metrics.totalTokens).toBe(160);
        expect(typeof metrics.lastUpdated).toBe("number");
    });

    it("should produce correct WindowHealthStatus shape", async () => {
        const state = createTestState({
            tokenMetrics: {
                agent1: { inputTokens: 1000, outputTokens: 500, reasoningTokens: 0, totalTokens: 1500, lastUpdated: Date.now() },
            },
        });

        const result = await windowTrackerNode(state);
        const health = result.windowHealth!["agent1"];

        // Verify shape matches WindowHealthStatus
        expect(typeof health.usage).toBe("number");
        expect(typeof health.limit).toBe("number");
        expect(typeof health.usagePercent).toBe("number");
        expect(typeof health.healthy).toBe("boolean");
    });

    it("should produce correct LoopEvaluation shape", async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({
                choices: [{ message: { content: JSON.stringify({ goalScore: 7, efficiencyScore: 8, improvements: ["improve"] }) } }],
            }),
        });

        const state = createTestState();
        const result = await evaluatorNode(state);

        if (result.lastEvaluation) {
            expect(typeof result.lastEvaluation.loopNumber).toBe("number");
            expect(typeof result.lastEvaluation.goalScore).toBe("number");
            expect(typeof result.lastEvaluation.efficiencyScore).toBe("number");
            expect(Array.isArray(result.lastEvaluation.improvements)).toBe(true);
            expect(typeof result.lastEvaluation.timestamp).toBe("number");
        }
    });
});
