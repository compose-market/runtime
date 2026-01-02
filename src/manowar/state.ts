/**
 * Manowar Orchestration State
 * 
 * Defines the core state for workflow execution.
 */

import { Annotation } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";

// =============================================================================
// Types
// =============================================================================

export interface PlanStepOutput {
    stepNumber: number;
    agentName: string;
    success: boolean;
    output: string;
    tokensUsed?: number;
}

// =============================================================================
// Main Orchestration State
// =============================================================================

export const ManowarOrchestrationState = Annotation.Root({
    // === Core Messages ===
    messages: Annotation<BaseMessage[]>({
        reducer: (old, next) => [...old, ...next],
        default: () => [],
    }),

    // === Workflow Identity ===
    workflowId: Annotation<string>({
        reducer: (_, next) => next,
        default: () => "",
    }),
    manowarWallet: Annotation<string | undefined>(),
    runId: Annotation<string>({
        reducer: (_, next) => next,
        default: () => `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    }),

    // === Goal & Progress ===
    activeGoal: Annotation<string>({
        reducer: (old, next) => next || old,
        default: () => "",
    }),
    completedActions: Annotation<string[]>({
        reducer: (old, next) => [...old, ...next],
        default: () => [],
    }),

    // === Current Plan ===
    currentPlan: Annotation<{
        planId: string;
        goal: string;
        steps: Array<{
            stepNumber: number;
            agentName: string;
            task: string;
            expectedOutput: string;
            priority: "critical" | "high" | "medium" | "low";
        }>;
        createdAt: number;
    } | null>({
        reducer: (_, next) => next,
        default: () => null,
    }),

    // === Step Outputs ===
    stepOutputs: Annotation<PlanStepOutput[]>({
        reducer: (old, next) => [...old, ...next],
        default: () => [],
    }),

    // === Current Step ===
    currentStepNumber: Annotation<number>({
        reducer: (_, next) => next,
        default: () => 0,
    }),

    // === Execution Control ===
    status: Annotation<"idle" | "running" | "complete" | "error">({
        reducer: (_, next) => next,
        default: () => "idle",
    }),
    error: Annotation<string | undefined>({
        reducer: (_, next) => next,
    }),

    // === Cost Tracking ===
    totalCostWei: Annotation<string>({
        reducer: (curr, next) => (BigInt(curr) + BigInt(next)).toString(),
        default: () => "0",
    }),
    totalTokensUsed: Annotation<number>({
        reducer: (curr, next) => curr + next,
        default: () => 0,
    }),
});

// Export the state type
export type ManowarState = typeof ManowarOrchestrationState.State;

// =============================================================================
// State Helpers
// =============================================================================

/**
 * Create initial state for a new workflow execution
 */
export function createInitialState(
    workflowId: string,
    goal: string,
    manowarWallet?: string
): Partial<ManowarState> {
    return {
        workflowId,
        manowarWallet,
        activeGoal: goal,
        runId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        status: "idle",
    };
}

/**
 * Calculate total token usage across all steps
 */
export function getTotalTokenUsage(state: ManowarState): number {
    return state.stepOutputs?.reduce(
        (sum, s) => sum + (s.tokensUsed || 0),
        0
    ) || 0;
}
