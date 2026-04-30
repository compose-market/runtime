/**
 * Workflow Module Index - Simplified
 * 
 * Exports all Workflow workflow execution functionality.
 * Per suggestions.md, removed Shadow Orchestra sub-agent exports.
 */

// Core types
export * from "./types.js";

// Token tracking & LangSmith Observability Hub
export {
    // Token extraction
    extractTokens,
    extractTokensFromResult,
    extractTokenUsage,
    estimateCost,
    LangSmithTokenTracker,
    type ExtractedTokens,
    type ExtractedUsage,
    type TokenLedgerInterface,
    // Configuration
    createLangSmithConfig,
    isLangSmithEnabled,
    // SDK Client
    getLangSmithClient,
    type Run,
    type LangSmithFeedback,
    // Run Tracking
    fetchLangSmithRuns as fetchRemoteLangSmithRuns,
    getLangSmithRun as getRemoteLangSmithRun,
    // Feedback/Annotations
    recordFeedback,
    getRunFeedback,
    recordInsightFeedback,
    recordDecisionFeedback,
    recordQualityScore,
    recordErrorFeedback,
    type FeedbackOptions,
    // Dataset Integration
    recordLearning,
    getRelevantLearnings,
} from "./langsmith.js";

// Memory (Mem0 Graph integration)
export * from "./memory.js";

/**
 * Validate required environment variables for Workflow.
 * Call during app initialization for early warning of missing config.
 */
export function validateEnv(): { valid: boolean; missing: string[] } {
    const required = ["MEM0_API_KEY", "LANGSMITH_API_KEY"];
    const missing = required.filter(k => !process.env[k]);
    if (missing.length > 0) {
        console.warn(`[manowar] Missing required env vars: ${missing.join(", ")}`);
    }
    return { valid: missing.length === 0, missing };
}


// Context management
export {
    ContextWindowManager,
    getModelContextSpec,
    getModelContextSpecSync,
    getSlidingWindow,
    getDynamicThresholdPercent,
    SLIDING_WINDOW_SIZE,
    type TokenCheckpoint,
    type ModelContextSpec,
    type AgentContextState,
} from "./context.js";

// Orchestrator
export { WorkflowOrchestrator, executeWithOrchestrator } from "./orchestrator.js";

// Run tracking & observability
export {
    createRun,
    startRun,
    completeRun,
    failRun,
    cancelRun,
    getRun,
    listRuns,
    getRunStats,
    fetchLangSmithRuns,
    getLangSmithRun,
    recordCronExecution,
    getCronStats,
    listCronStats,
    isLangSmithAvailable,
    type TrackedRun,
    type RunFilter,
} from "./run-tracker.js";

// Trigger management
export {
    parseTriggerFromNL,
    storeTrigger,
    retrieveTriggers,
    deleteTriggerFromMemory,
    getTriggerById,
    updateTriggerEnabled,
    registerTrigger,
    unregisterTrigger,
    unregisterAllTriggers,
    getActiveTriggerCount,
    getNextRunTime,
    initTriggersFromRedis,
    initTriggersForWorkflow,
} from "./triggers.js";

// Agentic models
export {
    coordinatorModels,
    getAgenticModel,
    getAgenticModelIds,
    isAgenticCoordinatorModel,
    getDefaultCoordinatorModel,
    type AgenticModel,
} from "./agentic.js";

// Task Planning
export {
    TaskPlanner,
    plannerSystemPrompt,
    reflectorSystemPrompt,
    reviewerSystemPrompt,
    createInitialPlanningState,
    type ExecutionPlan,
    type PlanStep,
    type StepReflection,
    type PlanningState,
    type ReviewerSuggestions,
} from "./planner.js";

// Embeddings
export {
    computeEmbedding,
    storeEmbedding,
    searchByEmbedding,
    getRelevantContext,
    recordConversationTurn,
    type EmbeddingResult,
    type StoredEmbedding,
} from "./embeddings.js";

// Delegation
export {
    callAgent,
    delegatePlanStep,
    type DelegationResult,
    type DelegationOptions,
} from "./delegation.js";

// Registry
export {
    fetchWorkflowCard,
    buildSystemPromptFromCard,
    clearCardCache,
    getAgentCard,
    type AgentCard,
    type WorkflowCard,
} from "./registry.js";

// Checkpoints
export {
    createCheckpoint,
    getCheckpoints,
    getAgentCheckpoints,
    getCheckpointsByType,
    getInsights,
    getDecisionTrail,
    summarizeCheckpoints,
    persistCheckpoints,
    retrievePastInsights,
    recordObservation,
    recordDecision,
    recordInsight,
    recordError,
    type Checkpoint,
    type CheckpointSummary,
} from "./checkpoint.js";
