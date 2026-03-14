import { randomUUID } from "crypto";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import type { WorkflowHandle } from "@temporalio/client";
import type { Client } from "@temporalio/client";
import type { ExecutionResult } from "../frameworks/langchain.js";
import type { TriggerDefinition } from "../workflow/types.js";
import type { OrchestratorResult } from "../workflow/orchestrator.js";
import type { ExecutorOptions, Workflow as WorkflowWorkflow, StepApprovalDecision, StepApprovalStatus } from "../workflow/types.js";
import {
    AGENT_TASK_QUEUE,
    AGENT_WORKFLOW_TYPE,
    WORKFLOW_TASK_QUEUE,
    WORKFLOW_WORKFLOW_TYPE,
    QUERY_GET_AGENT_RUN_STATE,
    QUERY_GET_RUN_STATE,
    SIGNAL_CANCEL_EXECUTION,
    SIGNAL_SET_STEP_APPROVAL,
} from "./constants.js";
import { getTemporalClient, getTemporalPinnedVersioningOverride } from "./client.js";
import {
    buildTriggerScheduleId as buildTriggerScheduleIdInternal,
    TRIGGER_SCHEDULE_CATCHUP_WINDOW_MS,
    TRIGGER_SCHEDULE_OVERLAP_POLICY,
} from "./schedules.js";
import type {
    ExecuteAgentWorkflowInput,
    ExecuteWorkflowWorkflowInput,
    WorkflowWorkflowResult,
    SerializableExecutorOptions,
    StepApprovalSignalPayload,
    TemporalExecutionState,
    TemporalAgentExecutionState,
} from "./types.js";

const DEFAULT_RUN_TIMEOUT = "6h";
const DEFAULT_AGENT_TIMEOUT = "30m";
const ENABLE_CUSTOM_SEARCH_ATTRIBUTES = process.env.TEMPORAL_ENABLE_CUSTOM_SEARCH_ATTRIBUTES === "true";

export class TemporalRunNotFoundError extends Error {
    readonly code = "TEMPORAL_RUN_NOT_FOUND";
    readonly statusCode = 404;

    constructor(message: string) {
        super(message);
        this.name = "TemporalRunNotFoundError";
    }
}

export function createComposeRunId(): string {
    return randomUUID();
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

export function buildWorkflowRunWorkflowId(walletAddress: string, runId: string): string {
    assertNonEmpty(walletAddress, "walletAddress");
    assertNonEmpty(runId, "runId");
    return `workflow-${walletAddress}:run:${runId}`;
}

function buildWorkflowHandle(
    client: Client,
    walletAddress: string,
    runId: string,
): WorkflowHandle<any> {
    const workflowId = buildWorkflowRunWorkflowId(walletAddress, runId);
    return client.workflow.getHandle(workflowId);
}

async function queryWorkflowRunStateOrThrow(
    client: Client,
    walletAddress: string,
    runId: string,
): Promise<TemporalExecutionState> {
    const handle = buildWorkflowHandle(client, walletAddress, runId);
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

export async function startWorkflowRun(
    walletAddress: string,
    workflow: WorkflowWorkflow | undefined,
    userRequest: string,
    options: SerializableExecutorOptions,
    runId: string,
): Promise<WorkflowHandle<any>> {
    const client = await getTemporalClient();
    assertNonEmpty(runId, "runId");
    if (workflow?.id && !workflow.id.startsWith(`workflow-${walletAddress}`)) {
        throw new Error(`workflow.id mismatch: expected prefix workflow-${walletAddress}, got ${workflow.id}`);
    }
    const workflowId = buildWorkflowRunWorkflowId(walletAddress, runId);

    const input: ExecuteWorkflowWorkflowInput = {
        composeRunId: runId,
        walletAddress,
        workflow,
        userRequest,
        options,
    };

    try {
        return await client.workflow.start(WORKFLOW_WORKFLOW_TYPE, {
            taskQueue: WORKFLOW_TASK_QUEUE,
            workflowId,
            versioningOverride: getTemporalPinnedVersioningOverride(),
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
                        workflowWallet: [walletAddress],
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

export async function executeWorkflowRun(
    walletAddress: string,
    workflow: WorkflowWorkflow | undefined,
    userRequest: string,
    options: SerializableExecutorOptions,
    runId: string,
): Promise<OrchestratorResult> {
    const handle = await startWorkflowRun(walletAddress, workflow, userRequest, options, runId);
    const result = await handle.result() as WorkflowWorkflowResult;
    return result;
}

export async function getWorkflowRunState(
    walletAddress: string,
    runId: string,
): Promise<TemporalExecutionState | null> {
    const client = await getTemporalClient();
    try {
        const state = await queryWorkflowRunStateOrThrow(client, walletAddress, runId);
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

export async function cancelWorkflowRun(walletAddress: string, runId: string): Promise<void> {
    const client = await getTemporalClient();
    try {
        const handle = buildWorkflowHandle(client, walletAddress, runId);
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
        const handle = buildWorkflowHandle(client, walletAddress, runId);
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
            versioningOverride: getTemporalPinnedVersioningOverride(),
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
    const workflowWallet = trigger.workflowWallet;
    const normalizedTrigger: TriggerDefinition = {
        ...trigger,
        workflowWallet: workflowWallet,
        timezone: trigger.timezone || "UTC",
        createdAt: trigger.createdAt || Date.now(),
        updatedAt: trigger.updatedAt || Date.now(),
    };
    const scheduleId = buildTriggerScheduleId(workflowWallet, trigger.id);

    const actionArgs: ExecuteWorkflowWorkflowInput = {
        walletAddress: trigger.workflowWallet,
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
            workflowType: WORKFLOW_WORKFLOW_TYPE,
            taskQueue: WORKFLOW_TASK_QUEUE,
            args: [actionArgs],
        },
        memo: {
            trigger: normalizedTrigger,
            triggerId: normalizedTrigger.id,
            workflowWallet: workflowWallet,
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
