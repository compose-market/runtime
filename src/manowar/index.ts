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

// Phase 1-3 Enhancements (Jan 2026)

// Task Planning (Plan → Act → Reflect pattern)
export {
    TaskPlanner,
    PLANNER_SYSTEM_PROMPT,
    REFLECTOR_SYSTEM_PROMPT,
    createInitialPlanningState,
    type ExecutionPlan,
    type PlanStep,
    type StepReflection,
    type PlanningState,
} from "./planner.js";

// File-Based Context Management (Manus-style)
export {
    FileContextManager,
    getContextManager,
    cleanupContextManagers,
    processForContext,
    formatReference,
    type ContextFile,
    type ContextReference,
    type TodoItem,
} from "./file-context.js";

// Tool Masking (KV-cache efficiency)
export {
    ToolRegistry,
    getToolRegistry,
    clearToolRegistry,
    createMaskingConfig,
    updateMaskingState,
    calculateMasking,
    type StaticToolDefinition,
    type MaskingConfig,
} from "./tool-masking.js";

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
