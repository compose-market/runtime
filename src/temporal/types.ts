import type {
    ExecutionRunStateProjection,
    ExecutorOptions,
    SSEProgressEvent,
    StepApprovalDecision,
    StepApprovalRequest,
    Workflow,
} from "../manowar/types.js";
import type { OrchestratorResult } from "../manowar/orchestrator.js";

export type SerializableExecutorOptions = Omit<
    Partial<ExecutorOptions>,
    | "onStepUpdate"
    | "onProgress"
    | "onTokenStateUpdate"
    | "shouldCancel"
    | "requestStepApproval"
    | "onRunStateUpdate"
>;

export interface ExecuteManowarWorkflowInput {
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
        userId?: string;
        manowarWallet?: string;
        attachment?: { type: "image" | "audio" | "video"; url: string };
        sessionContext?: {
            sessionActive: boolean;
            sessionBudgetRemaining: number;
            grantedPermissions?: string[];
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

export interface ManowarWorkflowResult extends OrchestratorResult {
    runId: string;
    workflowId: string;
    /** If true, indicates next continuous iteration was scheduled */
    continuousNextScheduled?: boolean;
}
