/**
 * Manowar Orchestration State
 * 
 * Defines the LangGraph state annotations with proper reducers.
 * Key design decisions:
 * - Messages use conditional reducer (allows wipe vs append)
 * - tokenMetrics/activeGoal use merge reducer (persist through wipes)
 * - Sub-agent outputs use replace reducer (latest wins)
 * 
 * Based on Dec 2025 LangGraph Functional API best practices.
 */

import { Annotation } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";

// =============================================================================
// Token Metrics Types
// =============================================================================

export interface AgentTokenMetrics {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;  // For thinking models (Kimi K2, DeepSeek)
    totalTokens: number;
    lastUpdated: number;
}

export interface WindowHealthStatus {
    usage: number;
    limit: number;
    usagePercent: number;
    healthy: boolean;
}

// =============================================================================
// Tool Recommendation Types
// =============================================================================

export interface ToolRecommendation {
    registryId: string;
    name: string;
    description: string;
    spawnParams?: {
        transport: "stdio" | "http" | "docker";
        image?: string;
        remoteUrl?: string;
    };
    confidence: number;
}

// =============================================================================
// Evaluation Types (Continuous Loop)
// =============================================================================

export interface LoopEvaluation {
    loopNumber: number;
    goalScore: number;         // 0-10
    efficiencyScore: number;   // 0-10
    improvements: string[];
    timestamp: number;
}

// =============================================================================
// Main Orchestration State Annotation
// =============================================================================

export const ManowarOrchestrationState = Annotation.Root({
    // === Core Messages ===
    // Conditional reducer: only wipe if message contains WIPE_TOKEN
    messages: Annotation<BaseMessage[]>({
        reducer: (old, next) => {
            // Wipe signal: single SystemMessage containing the WIPE_TOKEN
            // This prevents accidental wipes from single-message coordinator responses
            const isWipeSignal = next.length === 1 &&
                next[0]._getType?.() === "system" &&
                String(next[0].content).includes("[CONTEXT REFRESHED]");

            if (isWipeSignal) {
                return next; // Replace history with the summary
            }
            // Normal append
            return [...old, ...next];
        },
        default: () => [],
    }),

    // === Workflow Identity ===
    workflowId: Annotation<string>({
        reducer: (_, next) => next,
        default: () => "",
    }),
    manowarId: Annotation<number | undefined>(),
    runId: Annotation<string>({
        reducer: (_, next) => next,
        default: () => `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    }),

    // === Goal & Progress ===
    activeGoal: Annotation<string>({
        reducer: (old, next) => next || old, // Preserve if not explicitly changed
        default: () => "",
    }),
    completedActions: Annotation<string[]>({
        reducer: (old, next) => [...old, ...next],
        default: () => [],
    }),

    // === Agent Model Mapping ===
    agentModels: Annotation<Record<string, string>>({
        reducer: (old, next) => ({ ...old, ...next }),
        default: () => ({}),
    }),
    boundPlugins: Annotation<string[]>({
        reducer: (_, next) => next,
        default: () => [],
    }),

    // === NoteTaker: Token Metrics (persists through wipes) ===
    tokenMetrics: Annotation<Record<string, AgentTokenMetrics>>({
        reducer: (old, next) => ({ ...old, ...next }),
        default: () => ({}),
    }),

    // === WindowTracker: Health Status ===
    windowHealth: Annotation<Record<string, WindowHealthStatus>>({
        reducer: (old, next) => ({ ...old, ...next }),
        default: () => ({}),
    }),
    needsCleanup: Annotation<boolean>({
        reducer: (_, next) => next,
        default: () => false,
    }),

    // === ToolBoxer: Recommendations ===
    suggestedTools: Annotation<ToolRecommendation[]>({
        reducer: (_, next) => next, // Replace with latest recommendations
        default: () => [],
    }),
    toolBoxerReasoning: Annotation<string>({
        reducer: (_, next) => next,
        default: () => "",
    }),

    // === Summarizer: Context Compression ===
    lastSummary: Annotation<string>({
        reducer: (_, next) => next,
        default: () => "",
    }),
    preservedFacts: Annotation<string[]>({
        reducer: (_, next) => next,
        default: () => [],
    }),

    // === Evaluator/Reviewer: Continuous Loop ===
    loopCount: Annotation<number>({
        reducer: (old, next) => (next !== undefined ? next : old + 1),
        default: () => 0,
    }),
    lastEvaluation: Annotation<LoopEvaluation | null>({
        reducer: (_, next) => next,
        default: () => null,
    }),
    suggestedImprovements: Annotation<string[]>({
        reducer: (_, next) => next,
        default: () => [],
    }),
    contextEnhancements: Annotation<string[]>({
        reducer: (old, next) => [...old, ...next],
        default: () => [],
    }),
    reviewApplied: Annotation<boolean>({
        reducer: (_, next) => next,
        default: () => false,
    }),

    // === Execution Control ===
    status: Annotation<"idle" | "running" | "cleanup" | "evaluating" | "complete" | "error">({
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
});

// Export the state type for use in other modules
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
    manowarId?: number
): Partial<ManowarState> {
    return {
        workflowId,
        manowarId,
        activeGoal: goal,
        runId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        status: "idle",
        loopCount: 0,
    };
}

/**
 * Check if state indicates a wipe is needed
 */
export function shouldTriggerWipe(state: ManowarState): boolean {
    return state.needsCleanup === true;
}

/**
 * Calculate total token usage across all agents
 */
export function getTotalTokenUsage(state: ManowarState): number {
    return Object.values(state.tokenMetrics || {}).reduce(
        (sum, m) => sum + m.totalTokens,
        0
    );
}
