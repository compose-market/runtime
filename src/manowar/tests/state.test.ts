/**
 * State Tests - Simplified
 * 
 * Tests for the simplified state management.
 */

import { describe, it, expect } from "vitest";
import {
    ManowarOrchestrationState,
    createInitialState,
    getTotalTokenUsage,
    type ManowarState,
    type PlanStepOutput,
} from "../state.js";

// ============================================================================
// State Annotation Tests
// ============================================================================
describe("ManowarOrchestrationState", () => {
    it("should have required core fields", () => {
        const spec = ManowarOrchestrationState.spec;

        // Core fields
        expect(spec.messages).toBeDefined();
        expect(spec.workflowId).toBeDefined();
        expect(spec.runId).toBeDefined();
        expect(spec.activeGoal).toBeDefined();
        expect(spec.status).toBeDefined();
    });

    it("should have planning fields", () => {
        const spec = ManowarOrchestrationState.spec;

        expect(spec.currentPlan).toBeDefined();
        expect(spec.stepOutputs).toBeDefined();
        expect(spec.currentStepNumber).toBeDefined();
    });

    it("should have tracking fields", () => {
        const spec = ManowarOrchestrationState.spec;

        expect(spec.totalCostWei).toBeDefined();
        expect(spec.totalTokensUsed).toBeDefined();
        expect(spec.completedActions).toBeDefined();
    });
});

// ============================================================================
// Helper Function Tests
// ============================================================================
describe("createInitialState", () => {
    it("should create state with required fields", () => {
        const state = createInitialState("workflow-1", "My goal", "0x123");

        expect(state.workflowId).toBe("workflow-1");
        expect(state.activeGoal).toBe("My goal");
        expect(state.manowarWallet).toBe("0x123");
        expect(state.status).toBe("idle");
        expect(state.runId).toMatch(/^run-\d+-[a-z0-9]+$/);
    });

    it("should work without wallet address", () => {
        const state = createInitialState("workflow-2", "Another goal");

        expect(state.workflowId).toBe("workflow-2");
        expect(state.manowarWallet).toBeUndefined();
    });
});

describe("getTotalTokenUsage", () => {
    it("should sum tokens from step outputs", () => {
        const state: Partial<ManowarState> = {
            stepOutputs: [
                { stepNumber: 1, agentName: "A1", success: true, output: "test", tokensUsed: 100 },
                { stepNumber: 2, agentName: "A2", success: true, output: "test", tokensUsed: 200 },
                { stepNumber: 3, agentName: "A3", success: false, output: "err", tokensUsed: 50 },
            ],
        };

        const total = getTotalTokenUsage(state as ManowarState);
        expect(total).toBe(350);
    });

    it("should return 0 for empty step outputs", () => {
        const state: Partial<ManowarState> = {
            stepOutputs: [],
        };

        const total = getTotalTokenUsage(state as ManowarState);
        expect(total).toBe(0);
    });

    it("should handle missing tokensUsed", () => {
        const state: Partial<ManowarState> = {
            stepOutputs: [
                { stepNumber: 1, agentName: "A1", success: true, output: "test" },
            ],
        };

        const total = getTotalTokenUsage(state as ManowarState);
        expect(total).toBe(0);
    });
});
