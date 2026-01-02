/**
 * Manowar Module Index - Simplified
 * 
 * Exports all Manowar workflow execution functionality.
 * Per suggestions.md, removed Shadow Orchestra sub-agent exports.
 */

// Core types
export * from "./types.js";

// State management
export * from "./state.js";

// Token tracking (LangSmith integration)
export * from "./langsmith.js";

// Memory (Mem0 Graph integration)
export * from "./memory.js";

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
export { ManowarOrchestrator, executeWithOrchestrator } from "./orchestrator.js";

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
    registerTrigger,
    unregisterTrigger,
    unregisterAllTriggers,
    getActiveTriggerCount,
    getNextRunTime,
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

// Structured Task Contracts
export {
    TaskContractBuilder,
    generateStructuredPrompt,
    parseAgentOutput,
    summarizeOutput,
    createContractFromStep,
    createResearchContract,
    createImplementationContract,
    createDesignContract,
    BaseTaskContractSchema,
    ContextualTaskContractSchema,
    AgentOutputSchema,
    type BaseTaskContract,
    type ContextualTaskContract,
    type AgentOutput,
} from "./task-contracts.js";

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
    isAgentAvailable,
    type DelegationResult,
    type DelegationOptions,
} from "./delegation.js";

// Registry
export {
    fetchManowarCard,
    buildSystemPromptFromCard,
    clearCardCache,
    getAgentCard,
    type AgentCard,
    type ManowarCard,
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
