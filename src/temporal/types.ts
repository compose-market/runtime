import type {
    ExecutionRunStateProjection,
    ExecutorOptions,
    SSEProgressEvent,
    StepApprovalDecision,
    StepApprovalRequest,
    Workflow,
} from "../manowar/workflow/types.js";
import type { OrchestratorResult } from "../manowar/workflow/orchestrator.js";

export type SerializableExecutorOptions = Omit<
    Partial<ExecutorOptions>,
    | "onStepUpdate"
    | "onProgress"
    | "onTokenStateUpdate"
    | "shouldCancel"
    | "requestStepApproval"
    | "onRunStateUpdate"
>;

export interface ExecuteWorkflowWorkflowInput {
    composeRunId?: string;
    workflow?: Workflow;
    walletAddress?: string;
    userRequest: string;
    options: SerializableExecutorOptions;
    /** Internal: iteration count for Continue-As-New in continuous mode */
    _iterationCount?: number;
}

export interface ExecuteAgentWorkflowInput {
    composeRunId: string;
    agentWallet: string;
    message: string;
    options: {
        threadId?: string;
        userAddress?: string;
        workflowWallet?: string;
        attachment?: Record<string, unknown>;
        sessionContext?: {
            sessionActive: boolean;
            sessionBudgetRemaining: number;
            sessionGrants?: string[];
            cloudPermissions?: string[];
            backpackAccounts?: Array<{
                slug: string;
                name: string;
                connected: boolean;
                accountId?: string;
                status?: string;
            }>;
        };
    };
}

export interface TemporalExecutionState {
    runId: string;
    workflowId: string;
    walletAddress: string;
    status: ExecutionRunStateProjection["status"];
    startedAt: number;
    updatedAt: number;
    progress: number;
    message?: string;
    currentStep?: number;
    totalSteps?: number;
    error?: string;
    output?: string;
    lastEventIndex: number;
    events: SSEProgressEvent[];
    pendingApprovals: Record<string, StepApprovalRequest>;
    decisions: Record<string, StepApprovalDecision>;
}

export interface TemporalAgentExecutionState {
    runId: string;
    workflowId: string;
    agentWallet: string;
    threadId: string;
    status: "running" | "success" | "error" | "cancelled";
    startedAt: number;
    updatedAt: number;
    output?: string;
    error?: string;
}

export interface StepApprovalSignalPayload {
    stepKey: string;
    decision: StepApprovalDecision;
}

export interface ProgressSignalPayload {
    event?: SSEProgressEvent;
    runState?: Partial<ExecutionRunStateProjection>;
}

export interface WorkflowWorkflowResult extends OrchestratorResult {
    runId: string;
    workflowId: string;
    /** If true, indicates next continuous iteration was scheduled */
    continuousNextScheduled?: boolean;
}

export interface MemoryConsolidationInput {
    agentWallets: string[];
    options?: MemoryActivityOptions;
    _iterationCount?: number;
}

export interface PatternExtractionInput {
    agentWallet: string;
    timeRange?: { start: number; end: number };
    options?: MemoryActivityOptions;
}

export interface ArchiveCreationInput {
    agentWallet: string;
    dateRange?: { start: number; end: number };
    options?: MemoryActivityOptions;
}

export interface DecayUpdateInput {
    halfLifeDays?: number;
    options?: MemoryActivityOptions;
    _iterationCount?: number;
}

export interface SkillPromotionInput {
    patternId: string;
    skillName: string;
    options?: MemoryActivityOptions;
}

export interface MemoryCleanupInput {
    olderThanDays?: number;
    options?: MemoryActivityOptions;
    _iterationCount?: number;
}

export interface MemoryActivityOptions {
    batchSize?: number;
    confidenceThreshold?: number;
    compress?: boolean;
    syncToIpfs?: boolean;
    dryRun?: boolean;
    windowDays?: number;
}

export interface MemoryWorkflowResult {
    success: boolean;
    processed: number;
    errors?: string[];
}

export interface MemoryWorkflowState {
    workflowId: string;
    status: "running" | "completed" | "failed" | "paused";
    startedAt: number;
    updatedAt: number;
    processed: number;
    errors: string[];
    paused: boolean;
}

export interface ConsolidationActivityResult {
    success: boolean;
    processed: number;
    errors?: string[];
}

export interface PatternExtractionActivityResult {
    success: boolean;
    processed: number;
    errors?: string[];
}

export interface ArchiveCreationActivityResult {
    success: boolean;
    processed: number;
    archiveId?: string;
    ipfsHash?: string;
    errors?: string[];
}

export interface DecayUpdateActivityResult {
    success: boolean;
    processed: number;
    errors?: string[];
}

export interface PatternValidationResult {
    success: boolean;
    data?: {
        valid: boolean;
        confidence: number;
        occurrences: number;
        successRate: number;
        toolSequence: string[];
    };
    error?: string;
}

export interface SkillPromotionResult {
    success: boolean;
    skillId?: string;
    error?: string;
}

export interface MemoryCleanupActivityResult {
    success: boolean;
    processed: number;
    errors?: string[];
}

export interface SyncToPinataResult {
    success: boolean;
    ipfsHash?: string;
    error?: string;
}
