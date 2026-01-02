/**
 * State Tests
 * 
 * Unit tests for the ManowarOrchestrationState annotations and types.
 */

import { describe, it, expect } from "vitest";
import {
    ManowarOrchestrationState,
    type AgentTokenMetrics,
    type WindowHealthStatus,
    type ToolRecommendation,
    type LoopEvaluation,
    type OrchestraModels,
} from "../state.js";

describe("ManowarOrchestrationState", () => {
    it("should have all required annotations defined", () => {
        const spec = ManowarOrchestrationState.spec;

        // Core messages
        expect(spec.messages).toBeDefined();

        // Workflow identity
        expect(spec.workflowId).toBeDefined();
        expect(spec.runId).toBeDefined();

        // Goal & Progress
        expect(spec.activeGoal).toBeDefined();
        expect(spec.completedActions).toBeDefined();

        // Agent mapping
        expect(spec.agentModels).toBeDefined();
        expect(spec.boundPlugins).toBeDefined();

        // Shadow Orchestra Models (coordinator-assigned)
        expect(spec.orchestraModels).toBeDefined();

        // NoteTaker
        expect(spec.tokenMetrics).toBeDefined();

        // WindowTracker
        expect(spec.windowHealth).toBeDefined();
        expect(spec.needsCleanup).toBeDefined();

        // ToolBoxer
        expect(spec.suggestedTools).toBeDefined();

        // Evaluator
        expect(spec.lastEvaluation).toBeDefined();
        expect(spec.suggestedImprovements).toBeDefined();

        // Continuous Loop
        expect(spec.loopCount).toBeDefined();
        expect(spec.shouldContinueLoop).toBeDefined();
    });

    it("should have orchestraModels annotation", () => {
        const spec = ManowarOrchestrationState.spec;
        expect(spec.orchestraModels).toBeDefined();
    });
});

describe("Type Exports", () => {
    it("should export AgentTokenMetrics type correctly", () => {
        const metrics: AgentTokenMetrics = {
            inputTokens: 100,
            outputTokens: 50,
            reasoningTokens: 10,
            totalTokens: 160,
            lastUpdated: Date.now(),
        };

        expect(metrics.inputTokens).toBe(100);
        expect(metrics.reasoningTokens).toBe(10);
    });

    it("should export WindowHealthStatus type correctly", () => {
        const health: WindowHealthStatus = {
            usage: 50000,
            limit: 128000,
            usagePercent: 39.0625,
            healthy: true,
        };

        expect(health.healthy).toBe(true);
    });

    it("should export ToolRecommendation type correctly", () => {
        const rec: ToolRecommendation = {
            registryId: "brave-search",
            name: "Brave Search",
            description: "Web search using Brave",
            spawnParams: { transport: "http", remoteUrl: "https://api.brave.com" },
            confidence: 0.85,
        };

        expect(rec.confidence).toBe(0.85);
    });

    it("should export LoopEvaluation type correctly", () => {
        const evaluation: LoopEvaluation = {
            loopNumber: 3,
            goalScore: 7,
            efficiencyScore: 8,
            improvements: ["Reduce context size"],
            timestamp: Date.now(),
        };

        expect(evaluation.loopNumber).toBe(3);
    });

    it("should export OrchestraModels type correctly", () => {
        const models: OrchestraModels = {
            planner: "gpt-4o",
            evaluator: "moonshotai/kimi-k2-thinking",
            summarizer: "gpt-4o-mini",
        };

        expect(models.planner).toBe("gpt-4o");
        expect(models.evaluator).toContain("kimi");
    });
});
