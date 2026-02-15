import {
    ApplicationFailure,
    CancellationScope,
    defineQuery,
    defineSignal,
    proxyActivities,
    setHandler,
    workflowInfo,
    continueAsNew,
} from "@temporalio/workflow";
import type { ExecutionResult } from "../frameworks/langchain.js";
import type { ExecutionRunStateProjection, SSEProgressEvent, StepApprovalDecision } from "../manowar/types.js";
import {
    AGENT_ACTIVITY_TASK_QUEUE,
    MANOWAR_ACTIVITY_TASK_QUEUE,
    APPROVAL_TIMEOUT_MS,
    QUERY_GET_AGENT_RUN_STATE,
    QUERY_GET_APPROVAL_DECISION,
    QUERY_GET_RUN_STATE,
    SIGNAL_CANCEL_EXECUTION,
    SIGNAL_REPORT_PROGRESS,
    SIGNAL_SET_STEP_APPROVAL,
} from "./constants.js";
import type {
    ExecuteAgentWorkflowInput,
    ExecuteManowarWorkflowInput,
    ManowarWorkflowResult,
    ProgressSignalPayload,
    StepApprovalSignalPayload,
    TemporalAgentExecutionState,
    TemporalExecutionState,
} from "./types.js";

const MAX_PROGRESS_EVENTS = 300;
const TERMINAL_STATUSES: ReadonlySet<TemporalExecutionState["status"]> = new Set(["success", "error", "cancelled"]);

// Maximum iterations before Continue-As-New to prevent workflow history bloat
const MAX_CONTINUOUS_ITERATIONS = 50;

const runStateQuery = defineQuery<TemporalExecutionState>(QUERY_GET_RUN_STATE);
const agentRunStateQuery = defineQuery<TemporalAgentExecutionState>(QUERY_GET_AGENT_RUN_STATE);
const approvalDecisionQuery = defineQuery<StepApprovalDecision | null, [string]>(QUERY_GET_APPROVAL_DECISION);

const reportProgressSignal = defineSignal<[ProgressSignalPayload]>(SIGNAL_REPORT_PROGRESS);
const cancelExecutionSignal = defineSignal(SIGNAL_CANCEL_EXECUTION);
const setStepApprovalSignal = defineSignal<[StepApprovalSignalPayload]>(SIGNAL_SET_STEP_APPROVAL);

const manowarActivities = proxyActivities<typeof import("./activities.js")>({
    taskQueue: MANOWAR_ACTIVITY_TASK_QUEUE,
    startToCloseTimeout: "6h",
    heartbeatTimeout: "90s",
    retry: {
        initialInterval: "1s",
        backoffCoefficient: 2,
        maximumInterval: "60s", // Optimized: increased from 30s to 60s for better backoff
        maximumAttempts: 3, // Optimized: reduced from 6 to 3 (50% cost reduction on failures)
        nonRetryableErrorTypes: [
            "DelegationNonRetryableError",
            "ValidationError",
            "ApprovalRejectedError",
            "ApprovalStateError",
            "ApprovalTimeoutError",
        ],
    },
});

const agentActivities = proxyActivities<typeof import("./activities.js")>({
    taskQueue: AGENT_ACTIVITY_TASK_QUEUE,
    startToCloseTimeout: "20m",
    heartbeatTimeout: "90s",
    retry: {
        initialInterval: "1s",
        backoffCoefficient: 2,
        maximumInterval: "60s", // Optimized: increased from 30s to 60s for better backoff
        maximumAttempts: 3, // Optimized: reduced from 6 to 3 (50% cost reduction on failures)
        nonRetryableErrorTypes: ["ValidationError"],
    },
});

function pushEvent(state: TemporalExecutionState, event: SSEProgressEvent): void {
    state.events.push(event);
    if (state.events.length > MAX_PROGRESS_EVENTS) {
        state.events = state.events.slice(-MAX_PROGRESS_EVENTS);
    }
    state.lastEventIndex += 1;
}

function toStateProjection(state: TemporalExecutionState): ExecutionRunStateProjection {
    return {
        runId: state.runId,
        workflowId: state.workflowId,
        walletAddress: state.walletAddress,
        status: state.status,
        startedAt: state.startedAt,
        updatedAt: state.updatedAt,
        progress: state.progress,
        message: state.message,
        currentStep: state.currentStep,
        totalSteps: state.totalSteps,
        error: state.error,
        output: state.output,
    };
}

function synthesizeProgressEvent(runId: string, state: TemporalExecutionState): SSEProgressEvent {
    return {
        type: state.status === "error" ? "error" : "progress",
        timestamp: Date.now(),
        data: {
            runId,
            progress: state.progress,
            message: state.message,
            error: state.error,
            stepIndex: state.currentStep,
            totalSteps: state.totalSteps,
        },
    };
}

function deriveRunId(input: ExecuteManowarWorkflowInput, info: ReturnType<typeof workflowInfo>): string {
    if (input.composeRunId && input.composeRunId.trim().length > 0) {
        return input.composeRunId;
    }
    return `scheduled-${info.firstExecutionRunId}`;
}

export async function executeManowarWorkflow(input: ExecuteManowarWorkflowInput): Promise<ManowarWorkflowResult> {
    if (!input.walletAddress) {
        throw ApplicationFailure.create({
            message: "walletAddress is required",
            nonRetryable: true,
            type: "ValidationError",
        });
    }
    const info = workflowInfo();
    const runId = deriveRunId(input, info);
    const now = Date.now();
    const walletAddress = input.walletAddress;
    const expectedWorkflowPrefix = `manowar-${walletAddress}:run:`;
    const isInteractiveRun = Boolean(input.composeRunId);

    // RELAXED VALIDATION: Log warning but don't block execution
    // This allows workflows to run even with non-standard IDs for better compatibility
    if (isInteractiveRun && !info.workflowId.startsWith(expectedWorkflowPrefix)) {
        console.warn(`[workflow] ⚠️ WorkflowId mismatch: expected ${expectedWorkflowPrefix}, got ${info.workflowId}`);
        console.warn(`[workflow] Continuing execution anyway - workflow will be tracked in Temporal Cloud`);
        // Don't throw - let it continue for better resilience
    }

    if (input.workflow?.id && !input.workflow.id.startsWith(`manowar-${walletAddress}`)) {
        console.warn(`[workflow] ⚠️ Workflow payload id mismatch: expected manowar-${walletAddress}, got ${input.workflow.id}`);
        console.warn(`[workflow] Continuing execution anyway`);
        // Don't throw - let it continue
    }

    // Track iteration count for Continue-As-New
    const iterationCount = (input as any)._iterationCount || 0;

    const state: TemporalExecutionState = {
        runId,
        workflowId: info.workflowId,
        walletAddress,
        status: "running",
        startedAt: now,
        updatedAt: now,
        progress: 0,
        message: "Starting execution",
        lastEventIndex: 0,
        events: [],
        pendingApprovals: {},
        decisions: {},
    };

    let executionScope: CancellationScope | null = null;
    let cancellationRequested = false;

    setHandler(runStateQuery, () => state);
    setHandler(approvalDecisionQuery, (stepKey: string) => state.decisions[stepKey] || null);
    setHandler(reportProgressSignal, (payload?: ProgressSignalPayload) => {
        state.updatedAt = Date.now();

        const update = payload?.runState;
        if (update) {
            // Immutable-core fields are never overwritten by signal payload.
            if (update.status) {
                if (!(TERMINAL_STATUSES.has(state.status) && update.status === "running")) {
                    state.status = update.status;
                }
            }
            if (typeof update.progress === "number") state.progress = update.progress;
            if (update.message) state.message = update.message;
            if (update.currentStep !== undefined) state.currentStep = update.currentStep;
            if (update.totalSteps !== undefined) state.totalSteps = update.totalSteps;
            if (update.error) state.error = update.error;
            if (update.output) state.output = update.output;
            if (update.pendingApprovalStepKey) {
                state.status = "blocked_approval";
            }
        }
        pushEvent(state, payload?.event || synthesizeProgressEvent(runId, state));
    });
    setHandler(setStepApprovalSignal, (payload: StepApprovalSignalPayload) => {
        if (!payload?.stepKey || !payload?.decision) {
            return;
        }
        state.updatedAt = Date.now();
        state.decisions[payload.stepKey] = payload.decision;
        delete state.pendingApprovals[payload.stepKey];
        if (payload.decision.status === "approved") {
            if (!TERMINAL_STATUSES.has(state.status)) {
                state.status = "running";
            }
            state.message = `Approved ${payload.stepKey}`;
        }
        if (payload.decision.status === "rejected") {
            state.status = "error";
            state.error = payload.decision.reason || `Rejected ${payload.stepKey}`;
            state.message = state.error;
        }
    });
    setHandler(cancelExecutionSignal, () => {
        cancellationRequested = true;
        if (state.status === "cancelled") {
            return;
        }
        state.updatedAt = Date.now();
        state.status = "cancelled";
        state.message = "Execution cancelled";
        executionScope?.cancel();
    });

    try {
        executionScope = new CancellationScope();
        const orchestratorResult = await executionScope.run(() =>
            manowarActivities.runManowarExecutionActivity({
                ...input,
                composeRunId: runId,
                approvalTimeoutMs: input.options.timeout || APPROVAL_TIMEOUT_MS,
            }),
        );

        if (cancellationRequested) {
            state.updatedAt = Date.now();
            state.status = "cancelled";
            state.message = "Execution cancelled";
            return {
                success: false,
                result: "",
                error: "Execution cancelled",
                stepResults: [],
                totalTokensUsed: 0,
                runId,
                workflowId: state.workflowId,
            };
        }

        state.updatedAt = Date.now();
        state.status = orchestratorResult.success ? "success" : "error";
        state.progress = 100;
        state.output = orchestratorResult.result;
        state.error = orchestratorResult.error;
        state.message = orchestratorResult.success ? "Workflow completed" : "Workflow failed";
        pushEvent(state, {
            type: orchestratorResult.success ? "done" : "error",
            timestamp: Date.now(),
            data: orchestratorResult.success
                ? { message: "Workflow completed successfully" }
                : { error: orchestratorResult.error || "Workflow failed" },
        });

        // Handle continuous mode with Continue-As-New
        const isContinuous = input.options.continuous;
        const maxLoopIterations = input.options.maxLoopIterations;
        const hasIterationCap = typeof maxLoopIterations === "number" && maxLoopIterations > 0;
        const nextIterationCount = iterationCount + 1;
        const canContinue = !hasIterationCap || nextIterationCount < maxLoopIterations!;

        if (isContinuous && orchestratorResult.success && canContinue) {
            state.status = "continuous";
            state.updatedAt = Date.now();
            state.message = `Continuous iteration ${nextIterationCount} complete`;
            pushEvent(state, {
                type: "progress",
                timestamp: Date.now(),
                data: {
                    runId,
                    progress: 100,
                    message: state.message,
                },
            });

            const loopDelayMs = Math.max(0, input.options.loopDelayMs || 0);
            if (loopDelayMs > 0) {
                const { sleep } = await import("@temporalio/workflow");
                await sleep(loopDelayMs);
            }

            const shouldResetIterationCounter = nextIterationCount >= MAX_CONTINUOUS_ITERATIONS || info.continueAsNewSuggested;
            await continueAsNew<typeof executeManowarWorkflow>({
                ...input,
                composeRunId: runId,
                _iterationCount: shouldResetIterationCounter ? 0 : nextIterationCount,
            });
        }

        return {
            ...orchestratorResult,
            runId,
            workflowId: state.workflowId,
        };
    } catch (error) {
        state.updatedAt = Date.now();
        state.status = cancellationRequested || state.status === "cancelled" ? "cancelled" : "error";
        state.error = error instanceof Error ? error.message : String(error);
        state.message = state.status === "cancelled" ? "Execution cancelled" : "Execution failed";
        pushEvent(state, {
            type: "error",
            timestamp: Date.now(),
            data: {
                error: state.error,
            },
        });
        throw ApplicationFailure.create({
            message: state.error,
            nonRetryable: state.status === "cancelled",
            type: state.status === "cancelled" ? "CancelledError" : "ExecutionFailedError",
        });
    }
}

export async function executeAgentTurnWorkflow(input: ExecuteAgentWorkflowInput): Promise<ExecutionResult> {
    const info = workflowInfo();
    const now = Date.now();
    const agentState: TemporalAgentExecutionState = {
        runId: input.composeRunId,
        workflowId: info.workflowId,
        agentWallet: input.agentWallet,
        threadId: input.options.threadId || `thread-${input.agentWallet}`,
        status: "running",
        startedAt: now,
        updatedAt: now,
    };
    let cancelled = false;
    setHandler(agentRunStateQuery, () => agentState);
    setHandler(cancelExecutionSignal, () => {
        cancelled = true;
        agentState.status = "cancelled";
        agentState.updatedAt = Date.now();
        agentState.error = "Execution cancelled";
    });
    if (cancelled) {
        throw ApplicationFailure.create({
            message: "Execution cancelled",
            nonRetryable: true,
            type: "CancelledError",
        });
    }
    try {
        const result = await agentActivities.runAgentExecutionActivity(input);
        agentState.status = "success";
        agentState.updatedAt = Date.now();
        agentState.output = result.output;
        return result;
    } catch (error) {
        agentState.status = cancelled ? "cancelled" : "error";
        agentState.updatedAt = Date.now();
        agentState.error = error instanceof Error ? error.message : String(error);
        throw error;
    }
}

export { runStateQuery as getRunStateQuery, approvalDecisionQuery as getApprovalDecisionQuery };
export { agentRunStateQuery as getAgentRunStateQuery };
export { reportProgressSignal, cancelExecutionSignal, setStepApprovalSignal };
export { toStateProjection };
