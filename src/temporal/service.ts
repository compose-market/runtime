import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import type { WorkflowHandle } from "@temporalio/client";
import type { Client } from "@temporalio/client";
import type { ExecutionResult } from "../frameworks/langchain.js";
import type { TriggerDefinition } from "../manowar/types.js";
import type { OrchestratorResult } from "../manowar/orchestrator.js";
import type { ExecutorOptions, Workflow as ManowarWorkflow, StepApprovalDecision, StepApprovalStatus } from "../manowar/types.js";
import {
    AGENT_TASK_QUEUE,
    AGENT_WORKFLOW_TYPE,
    MANOWAR_TASK_QUEUE,
    MANOWAR_WORKFLOW_TYPE,
    QUERY_GET_AGENT_RUN_STATE,
    QUERY_GET_RUN_STATE,
    SIGNAL_CANCEL_EXECUTION,
    SIGNAL_SET_STEP_APPROVAL,
} from "./constants.js";
import { getTemporalClient } from "./client.js";
import {
    buildTriggerScheduleId as buildTriggerScheduleIdInternal,
    TRIGGER_SCHEDULE_CATCHUP_WINDOW_MS,
    TRIGGER_SCHEDULE_OVERLAP_POLICY,
} from "./schedules.js";
import {
    manowarCircuitBreaker,
    agentCircuitBreaker,
} from "./circuit-breaker.js";
import { executeWithOrchestrator } from "../manowar/orchestrator.js";
import { executeAgent } from "../frameworks/langchain.js";
import type {
    ExecuteAgentWorkflowInput,
    ExecuteManowarWorkflowInput,
    ManowarWorkflowResult,
    SerializableExecutorOptions,
    StepApprovalSignalPayload,
    TemporalExecutionState,
    TemporalAgentExecutionState,
} from "./types.js";

const DEFAULT_RUN_TIMEOUT = "6h";
const DEFAULT_AGENT_TIMEOUT = "30m";
const ENABLE_CUSTOM_SEARCH_ATTRIBUTES = process.env.TEMPORAL_ENABLE_CUSTOM_SEARCH_ATTRIBUTES === "true";
const ENABLE_DIRECT_EXECUTION_FALLBACK = process.env.TEMPORAL_ALLOW_DIRECT_FALLBACK === "true";

export class TemporalRunNotFoundError extends Error {
    readonly code = "TEMPORAL_RUN_NOT_FOUND";
    readonly statusCode = 404;

    constructor(message: string) {
        super(message);
        this.name = "TemporalRunNotFoundError";
    }
}

function generateUUID(): string {
    // Generate a valid v4 UUID
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

export function createComposeRunId(): string {
    // Return a valid UUID format for LangSmith compatibility
    return generateUUID();
}

function assertNonEmpty(value: string, field: string): void {
    if (!value || !value.trim()) {
        throw new Error(`${field} is required`);
    }
}

function isWorkflowNotFoundError(error: unknown): boolean {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return (
        message.includes("not found") ||
        message.includes("no rows in result set") ||
        message.includes("unknown execution") ||
        message.includes("workflow execution not found")
    );
}

export function buildManowarRunWorkflowId(walletAddress: string, runId: string): string {
    assertNonEmpty(walletAddress, "walletAddress");
    assertNonEmpty(runId, "runId");
    return `manowar-${walletAddress}:run:${runId}`;
}

function buildManowarHandle(
    client: Client,
    walletAddress: string,
    runId: string,
): WorkflowHandle<any> {
    const workflowId = buildManowarRunWorkflowId(walletAddress, runId);
    return client.workflow.getHandle(workflowId);
}

async function queryManowarRunStateOrThrow(
    client: Client,
    walletAddress: string,
    runId: string,
): Promise<TemporalExecutionState> {
    const handle = buildManowarHandle(client, walletAddress, runId);
    try {
        return await handle.query(QUERY_GET_RUN_STATE) as TemporalExecutionState;
    } catch (error) {
        if (isWorkflowNotFoundError(error)) {
            throw new TemporalRunNotFoundError(
                `Run not found for wallet=${walletAddress} runId=${runId}`,
            );
        }
        throw error;
    }
}

export function buildAgentRunWorkflowId(agentWallet: string, threadId: string, runId: string): string {
    return `agent-${agentWallet}:thread:${threadId}:run:${runId}`;
}

export function sanitizeExecutorOptions(options: Partial<ExecutorOptions> & Record<string, unknown>): SerializableExecutorOptions {
    const {
        onProgress,
        onStepUpdate,
        onTokenStateUpdate,
        shouldCancel,
        requestStepApproval,
        onRunStateUpdate,
        ...rest
    } = options as Record<string, unknown>;

    return rest as SerializableExecutorOptions;
}

export async function startManowarRun(
    walletAddress: string,
    workflow: ManowarWorkflow | undefined,
    userRequest: string,
    options: SerializableExecutorOptions,
    runId: string,
): Promise<WorkflowHandle<any>> {
    const client = await getTemporalClient();
    assertNonEmpty(runId, "runId");
    if (workflow?.id && !workflow.id.startsWith(`manowar-${walletAddress}`)) {
        throw new Error(`workflow.id mismatch: expected prefix manowar-${walletAddress}, got ${workflow.id}`);
    }
    const workflowId = buildManowarRunWorkflowId(walletAddress, runId);

    const input: ExecuteManowarWorkflowInput = {
        composeRunId: runId,
        walletAddress,
        workflow,
        userRequest,
        options,
    };

    try {
        return await client.workflow.start(MANOWAR_WORKFLOW_TYPE, {
            taskQueue: MANOWAR_TASK_QUEUE,
            workflowId,
            workflowRunTimeout: DEFAULT_RUN_TIMEOUT,
            args: [input],
            memo: {
                composeRunId: runId,
                walletAddress,
                workflowId,
            },
            ...(ENABLE_CUSTOM_SEARCH_ATTRIBUTES
                ? {
                    searchAttributes: {
                        manowarWallet: [walletAddress],
                        runType: [options.triggerId ? "scheduled" : "interactive"],
                    },
                }
                : {}),
        });
    } catch (error) {
        if (!(error instanceof WorkflowExecutionAlreadyStartedError)) {
            throw error;
        }

        // If workflow already exists with same ID, return existing handle
        // This handles the case of duplicate start requests
        const existing = client.workflow.getHandle(workflowId);
        return existing;
    }
}

export async function executeManowarRun(
    walletAddress: string,
    workflow: ManowarWorkflow | undefined,
    userRequest: string,
    options: SerializableExecutorOptions,
    runId: string,
): Promise<OrchestratorResult> {
    const handle = await startManowarRun(walletAddress, workflow, userRequest, options, runId);
    const result = await handle.result() as ManowarWorkflowResult;
    return result;
}

export async function getManowarRunState(
    walletAddress: string,
    runId: string,
): Promise<TemporalExecutionState | null> {
    const client = await getTemporalClient();
    try {
        const state = await queryManowarRunStateOrThrow(client, walletAddress, runId);
        if (state.runId !== runId) {
            return null;
        }
        return state;
    } catch (error) {
        if (error instanceof TemporalRunNotFoundError) {
            return null;
        }
        console.error("[temporal/service] Error getting run state:", error);
        return null;
    }
}

export async function cancelManowarRun(walletAddress: string, runId: string): Promise<void> {
    const client = await getTemporalClient();
    try {
        const handle = buildManowarHandle(client, walletAddress, runId);
        await handle.signal(SIGNAL_CANCEL_EXECUTION);
    } catch (error) {
        if (isWorkflowNotFoundError(error)) {
            throw new TemporalRunNotFoundError(
                `Run not found for wallet=${walletAddress} runId=${runId}`,
            );
        }
        console.error("[temporal/service] Error cancelling run:", error);
        throw error;
    }
}

export async function signalStepApproval(
    walletAddress: string,
    runId: string,
    stepKey: string,
    status: StepApprovalStatus,
    approver?: string,
    reason?: string,
): Promise<void> {
    const client = await getTemporalClient();
    try {
        const handle = buildManowarHandle(client, walletAddress, runId);
        const decision: StepApprovalDecision = {
            status,
            approver,
            reason,
            decidedAt: Date.now(),
        };
        const payload: StepApprovalSignalPayload = { stepKey, decision };
        await handle.signal(SIGNAL_SET_STEP_APPROVAL, payload);
    } catch (error) {
        if (isWorkflowNotFoundError(error)) {
            throw new TemporalRunNotFoundError(
                `Run not found for wallet=${walletAddress} runId=${runId}`,
            );
        }
        console.error("[temporal/service] Error signaling step approval:", error);
        throw error;
    }
}

export async function startAgentRun(
    input: ExecuteAgentWorkflowInput,
): Promise<WorkflowHandle<any>> {
    const client = await getTemporalClient();
    const threadId = input.options.threadId || `thread-${input.agentWallet}`;
    const workflowId = buildAgentRunWorkflowId(input.agentWallet, threadId, input.composeRunId);
    try {
        return await client.workflow.start(AGENT_WORKFLOW_TYPE, {
            taskQueue: AGENT_TASK_QUEUE,
            workflowId,
            workflowRunTimeout: DEFAULT_AGENT_TIMEOUT,
            args: [input],
            memo: {
                composeRunId: input.composeRunId,
                agentWallet: input.agentWallet,
                threadId,
            },
            ...(ENABLE_CUSTOM_SEARCH_ATTRIBUTES
                ? {
                    searchAttributes: {
                        agentWallet: [input.agentWallet],
                        runType: ["interactive"],
                    },
                }
                : {}),
        });
    } catch (error) {
        if (!(error instanceof WorkflowExecutionAlreadyStartedError)) {
            throw error;
        }
        return client.workflow.getHandle(workflowId);
    }
}

export async function executeAgentRun(input: ExecuteAgentWorkflowInput): Promise<ExecutionResult> {
    const handle = await startAgentRun(input);
    return await handle.result() as ExecutionResult;
}

export async function getAgentRunState(
    agentWallet: string,
    threadId: string,
    runId: string,
): Promise<TemporalAgentExecutionState | null> {
    const client = await getTemporalClient();
    const workflowId = buildAgentRunWorkflowId(agentWallet, threadId, runId);
    try {
        const handle = client.workflow.getHandle(workflowId);
        return await handle.query(QUERY_GET_AGENT_RUN_STATE) as TemporalAgentExecutionState;
    } catch {
        return null;
    }
}

export function buildTriggerScheduleId(walletAddress: string, triggerId: string): string {
    return buildTriggerScheduleIdInternal(walletAddress, triggerId);
}

export interface TriggerScheduleSnapshot {
    scheduleId: string;
    paused: boolean;
    memo?: Record<string, unknown>;
}

export async function upsertTriggerSchedule(
    trigger: TriggerDefinition,
): Promise<void> {
    if (!trigger.cronExpression) {
        throw new Error("cronExpression is required for schedule");
    }
    const client = await getTemporalClient();
    const manowarWallet = trigger.manowarWallet;
    const normalizedTrigger: TriggerDefinition = {
        ...trigger,
        manowarWallet: manowarWallet,
        timezone: trigger.timezone || "UTC",
        createdAt: trigger.createdAt || Date.now(),
        updatedAt: trigger.updatedAt || Date.now(),
    };
    const scheduleId = buildTriggerScheduleId(manowarWallet, trigger.id);

    const actionArgs: ExecuteManowarWorkflowInput = {
        walletAddress: trigger.manowarWallet,
        userRequest: (normalizedTrigger.inputTemplate?.message as string) || normalizedTrigger.nlDescription || "Scheduled run",
        options: {
            triggerId: normalizedTrigger.id,
            synthesizeFinal: true,
            continuous: false,
        },
    };
    
    const scheduleOptions = {
        scheduleId,
        spec: {
            cronExpressions: [normalizedTrigger.cronExpression!],
            timezone: normalizedTrigger.timezone || "UTC",
        },
        action: {
            type: "startWorkflow" as const,
            workflowType: MANOWAR_WORKFLOW_TYPE,
            taskQueue: MANOWAR_TASK_QUEUE,
            args: [actionArgs],
        },
        memo: {
            trigger: normalizedTrigger,
            triggerId: normalizedTrigger.id,
            manowarWallet: manowarWallet,
        },
        policies: {
            overlap: TRIGGER_SCHEDULE_OVERLAP_POLICY,
            catchupWindow: TRIGGER_SCHEDULE_CATCHUP_WINDOW_MS,
        },
        state: {
            paused: !normalizedTrigger.enabled,
            note: normalizedTrigger.enabled ? "Active" : "Paused",
        },
    };

    try {
        await client.schedule.getHandle(scheduleId).delete();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.toLowerCase().includes("not found")) {
            throw error;
        }
    }

    await client.schedule.create(scheduleOptions);
}

export async function deleteTriggerSchedule(walletAddress: string, triggerId: string): Promise<void> {
    const client = await getTemporalClient();
    const scheduleId = buildTriggerScheduleId(walletAddress, triggerId);
    const handle = client.schedule.getHandle(scheduleId);
    try {
        await handle.delete();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.toLowerCase().includes("not found")) {
            return;
        }
        throw error;
    }
}

export async function getTriggerSchedule(
    walletAddress: string,
    triggerId: string,
): Promise<TriggerScheduleSnapshot | null> {
    const client = await getTemporalClient();
    const scheduleId = buildTriggerScheduleId(walletAddress, triggerId);
    const handle = client.schedule.getHandle(scheduleId);
    try {
        const description = await handle.describe();
        return {
            scheduleId: description.scheduleId,
            paused: description.state.paused,
            memo: description.memo,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.toLowerCase().includes("not found")) {
            return null;
        }
        throw error;
    }
}

export async function listTriggerSchedules(walletAddress: string): Promise<TriggerScheduleSnapshot[]> {
    const client = await getTemporalClient();
    const prefix = buildTriggerScheduleId(walletAddress, "");
    const schedules: TriggerScheduleSnapshot[] = [];

    for await (const schedule of client.schedule.list()) {
        if (!schedule.scheduleId.startsWith(prefix)) {
            continue;
        }
        schedules.push({
            scheduleId: schedule.scheduleId,
            paused: schedule.state.paused,
            memo: schedule.memo,
        });
    }

    return schedules;
}

// =============================================================================
// Circuit Breaker Enhanced Execution (Phase 4: C+A Pattern)
// These functions automatically fallback to direct execution after N failures
// =============================================================================

/**
 * Execute Manowar workflow with circuit breaker protection
 * Falls back to direct execution after 3 Temporal failures (30s recovery window)
 */
export async function executeManowarRunWithFallback(
    walletAddress: string,
    workflow: ManowarWorkflow | undefined,
    userRequest: string,
    options: SerializableExecutorOptions,
    runId: string,
): Promise<OrchestratorResult> {
    return manowarCircuitBreaker.execute(
        async () => {
            const handle = await startManowarRun(walletAddress, workflow, userRequest, options, runId);
            return await handle.result() as ManowarWorkflowResult;
        },
        async () => {
            if (!ENABLE_DIRECT_EXECUTION_FALLBACK) {
                throw new Error("Temporal execution failed and direct fallback is disabled");
            }
            console.log(`[manowar] Circuit breaker: Using direct execution for ${walletAddress}`);
            return await executeWithOrchestrator(workflow!, userRequest, {
                ...options,
                runId,
            });
        },
        `manowar-${walletAddress}`,
    );
}

/**
 * Execute agent workflow with circuit breaker protection
 * Falls back to direct execution after 5 Temporal failures (30s recovery window)
 */
export async function executeAgentRunWithFallback(
    input: ExecuteAgentWorkflowInput,
): Promise<ExecutionResult> {
    return agentCircuitBreaker.execute(
        async () => {
            const handle = await startAgentRun(input);
            return await handle.result() as ExecutionResult;
        },
        async () => {
            if (!ENABLE_DIRECT_EXECUTION_FALLBACK) {
                throw new Error("Temporal execution failed and direct fallback is disabled");
            }
            console.log(`[agent] Circuit breaker: Using direct execution for ${input.agentWallet}`);
            return await executeAgent(
                input.agentWallet,
                input.message,
                {
                    ...input.options,
                    composeRunId: input.composeRunId,
                },
            );
        },
        `agent-${input.agentWallet}`,
    );
}

/**
 * Get circuit breaker health status for monitoring
 */
export function getTemporalHealth(): {
    manowar: ReturnType<typeof manowarCircuitBreaker.getState>;
    agent: ReturnType<typeof agentCircuitBreaker.getState>;
} {
    return {
        manowar: manowarCircuitBreaker.getState(),
        agent: agentCircuitBreaker.getState(),
    };
}
