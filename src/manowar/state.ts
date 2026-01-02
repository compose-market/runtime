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

/**
 * Shadow Orchestra node models - assigned by Coordinator at planning phase.
 * These models are used for internal orchestration nodes, NOT component agents.
 * Component agents have their own models defined in workflow steps.
 */
export interface OrchestraModels {
    /** Model for TaskPlanner */
    planner: string;
    /** Model for Evaluator (thinking model preferred) */
    evaluator: string;
    /** Model for Summarizer */
    summarizer: string;
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
    manowarWallet: Annotation<string | undefined>(),
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

    // === Shadow Orchestra Models (assigned by Coordinator at planning) ===
    /**
     * Models assigned by coordinator for Shadow Orchestra internal nodes.
     * NOT for component agents - those have models defined in workflow steps.
     */
    orchestraModels: Annotation<OrchestraModels | undefined>({
        reducer: (_, next) => next,
        default: () => undefined,
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

    // === Phase 1-3 Enhancements (Jan 2026) ===

    // === Planning State ===
    /** Current execution plan (from planner.ts) */
    currentPlan: Annotation<{
        planId: string;
        goal: string;
        version: number;
        steps: Array<{
            stepNumber: number;
            agentName: string;
            task: string;
            expectedOutput: string;
            dependsOn: number[];
            estimatedTokens: number;
            priority: "critical" | "high" | "medium" | "low";
        }>;
        totalEstimatedTokens: number;
        createdAt: number;
        validated: boolean;
    } | null>({
        reducer: (_, next) => next,
        default: () => null,
    }),
    /** Completed step outputs (stepNumber -> truncated output summary) */
    stepOutputs: Annotation<Record<number, string>>({
        reducer: (old, next) => ({ ...old, ...next }),
        default: () => ({}),
    }),
    /** Step reflections from Plan→Act→Reflect loop */
    stepReflections: Annotation<Array<{
        stepNumber: number;
        success: boolean;
        qualityScore: number;
        learnings: string[];
        continueWithPlan: boolean;
        actualTokensUsed: number;
    }>>({
        reducer: (old, next) => [...old, ...next],
        default: () => [],
    }),
    /** Current step number being executed */
    currentStepNumber: Annotation<number>({
        reducer: (_, next) => next,
        default: () => 0,
    }),
    /** Planning phase completed flag */
    planningComplete: Annotation<boolean>({
        reducer: (_, next) => next,
        default: () => false,
    }),

    // === Memory Cache (Prevent Redundant Queries) ===
    /** Cached memory search results */
    cachedMemories: Annotation<{
        query: string;
        results: Array<{ memory: string; score?: number }>;
        timestamp: number;
    } | null>({
        reducer: (_, next) => next,
        default: () => null,
    }),
    /** Memory cache TTL in ms (default 60 seconds) */
    memoryCacheTTL: Annotation<number>({
        reducer: (_, next) => next,
        default: () => 60000,
    }),

    // === Tool Masking (Stable Tool List) ===
    /** Full static tool list (never changes during execution) */
    staticToolIds: Annotation<string[]>({
        reducer: (_, next) => next,
        default: () => [],
    }),
    /** Currently masked (disabled) tool IDs */
    maskedToolIds: Annotation<string[]>({
        reducer: (_, next) => next,
        default: () => [],
    }),

    // === File-Based Context References ===
    /** Context file references (from file-context.ts) */
    contextReferences: Annotation<Array<{
        fileId: string;
        type: "observation" | "tool_output" | "agent_response" | "attachment" | "plan" | "todo";
        summary: string;
        critical: boolean;
    }>>({
        reducer: (old, next) => {
            // Merge, keeping unique fileIds
            const map = new Map(old.map(r => [r.fileId, r]));
            for (const ref of next) {
                map.set(ref.fileId, ref);
            }
            return Array.from(map.values());
        },
        default: () => [],
    }),
    /** Todo items for attention steering */
    todoItems: Annotation<Array<{
        number: number;
        task: string;
        status: "pending" | "in_progress" | "completed" | "blocked";
        stepNumber?: number;
        notes?: string;
    }>>({
        reducer: (_, next) => next,
        default: () => [],
    }),

    // === Token Savings Metrics ===
    /** Tokens saved by externalization */
    tokensSavedByExternalization: Annotation<number>({
        reducer: (curr, next) => curr + next,
        default: () => 0,
    }),
    /** KV-cache hit estimate (0-100%) */
    kvCacheHitEstimate: Annotation<number>({
        reducer: (_, next) => next,
        default: () => 0,
    }),

    // === Continuous Loop Control (Production Multi-Loop Support) ===
    // Note: loopCount already defined in Evaluator/Reviewer section above
    /** Maximum loops allowed (0 = one-shot, >0 = enable continuous loop) */
    maxLoops: Annotation<number>({
        reducer: (_, next) => next,
        default: () => 0, // Default to one-shot
    }),
    /** Whether to continue to next loop iteration */
    shouldContinueLoop: Annotation<boolean>({
        reducer: (_, next) => next,
        default: () => false,
    }),
    /** Quality threshold for loop continuation (0-10, default 7) */
    loopQualityThreshold: Annotation<number>({
        reducer: (_, next) => next,
        default: () => 7,
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
    manowarWallet?: string
): Partial<ManowarState> {
    return {
        workflowId,
        manowarWallet,
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
