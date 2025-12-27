/**
 * Manowar Module Index
 * 
 * Exports all Manowar workflow execution functionality.
 * The Shadow Orchestra pattern is exposed via executeWithOrchestrator.
 */

// Core types
export * from "./types.js";

// State management (Dec 2025 Annotation pattern)
export * from "./state.js";

// Token tracking (LangSmith integration)
export * from "./langsmith.js";

// Memory (Mem0 Graph integration)
export * from "./memory.js";

// Sub-agent nodes
export * from "./nodes.js";

// Context management
export {
    ContextWindowManager,
    TokenLedger,
    extractTokenUsage,
    getModelContextSpec,
    getModelContextSpecSync,
    searchRegistryTools,
    inspectToolCapability,
    type TokenCheckpoint,
    type ModelContextSpec,
    type ExtractedUsage,
} from "./context.js";

// Orchestrator (Shadow Orchestra pattern)
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
    AGENTIC_COORDINATOR_MODELS,
    getAgenticModel,
    getAgenticModelIds,
    isAgenticCoordinatorModel,
    getDefaultCoordinatorModel,
    CONTEXT_SUB_AGENTS,
    getActiveSubAgents,
    type AgenticModel,
    type ContextSubAgent,
    type ContextAgentRole,
} from "./agentic.js";
