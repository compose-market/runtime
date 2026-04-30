import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import type { WorkflowHandle } from "@temporalio/client";
import {
    createMemoryJobId,
    getMemoryJob as getStoredMemoryJob,
    getMemoryJobsCollection,
    runMemoryMaintenanceJob as runInlineMemoryMaintenanceJob,
} from "../../manowar/memory/index.js";
import type {
    MemoryJobRecord,
    MemoryMaintenanceJobInput,
} from "../../manowar/memory/index.js";
import {
    getTemporalClient,
    getTemporalPinnedVersioningOverride,
    isTemporalConfigured,
} from "../client.js";
import {
    MEMORY_ACTIVITY_TASK_QUEUE,
    MEMORY_WORKFLOW_ID_PREFIX,
    QUERY_GET_MEMORY_WORKFLOW_STATE,
} from "../constants.js";
import type {
    ArchiveCreationInput,
    DecayUpdateInput,
    MemoryCleanupInput,
    MemoryConsolidationInput,
    MemoryWorkflowState,
    PatternExtractionInput,
} from "../types.js";

const DEFAULT_MEMORY_JOB_TIMEOUT = "6h";

function nowMs(): number {
    return Date.now();
}

function buildMemoryJobWorkflowId(jobId: string): string {
    return `${MEMORY_WORKFLOW_ID_PREFIX}job:${jobId}`;
}

function buildWorkflowStart(input: MemoryMaintenanceJobInput): {
    workflowType: string;
    args: unknown[];
} {
    if (input.type === "consolidate") {
        const agentWallets = input.agentWallets || (input.agentWallet ? [input.agentWallet] : []);
        const payload: MemoryConsolidationInput = {
            agentWallets,
            options: {
                batchSize: input.batchSize,
            },
        };
        return { workflowType: "memoryConsolidationWorkflow", args: [payload] };
    }

    if (input.type === "patterns_extract") {
        if (!input.agentWallet) {
            throw new Error("agentWallet is required for patterns_extract");
        }
        const payload: PatternExtractionInput = {
            agentWallet: input.agentWallet,
            timeRange: input.timeRange,
            options: {
                confidenceThreshold: input.confidenceThreshold,
                windowDays: input.windowDays,
            },
        };
        return { workflowType: "patternExtractionWorkflow", args: [payload] };
    }

    if (input.type === "archive_create") {
        if (!input.agentWallet) {
            throw new Error("agentWallet is required for archive_create");
        }
        const payload: ArchiveCreationInput = {
            agentWallet: input.agentWallet,
            dateRange: input.dateRange,
            options: {
                compress: input.compress,
                syncToIpfs: input.syncToIpfs,
                windowDays: input.windowDays,
            },
        };
        return { workflowType: "archiveCreationWorkflow", args: [payload] };
    }

    if (input.type === "decay_update") {
        const payload: DecayUpdateInput = {
            halfLifeDays: input.halfLifeDays,
        };
        return { workflowType: "decayUpdateWorkflow", args: [payload] };
    }

    const payload: MemoryCleanupInput = {
        olderThanDays: input.olderThanDays,
    };
    return { workflowType: "memoryCleanupWorkflow", args: [payload] };
}

async function queryTemporalMemoryState(handle: WorkflowHandle): Promise<MemoryWorkflowState | null> {
    try {
        return await handle.query(QUERY_GET_MEMORY_WORKFLOW_STATE) as MemoryWorkflowState;
    } catch {
        return null;
    }
}

async function startTemporalMemoryJob(input: MemoryMaintenanceJobInput): Promise<MemoryJobRecord> {
    if (!isTemporalConfigured()) {
        throw new Error("Temporal memory jobs require TEMPORAL_NAMESPACE, TEMPORAL_ADDRESS, and TEMPORAL_API_KEY");
    }

    const jobId = createMemoryJobId(input);
    const workflowId = buildMemoryJobWorkflowId(jobId);
    const jobs = await getMemoryJobsCollection();
    const now = nowMs();
    const runningRecord: MemoryJobRecord = {
        jobId,
        type: input.type,
        execution: "temporal",
        status: "running",
        agentWallet: input.agentWallet,
        temporalWorkflowId: workflowId,
        data: {
            input: {
                type: input.type,
                agentWallet: input.agentWallet,
                agentWallets: input.agentWallets,
            },
        },
        createdAt: now,
    };

    await jobs.insertOne(runningRecord);

    try {
        const client = await getTemporalClient();
        const workflowStart = buildWorkflowStart(input);
        const handle = await client.workflow.start(workflowStart.workflowType, {
            taskQueue: MEMORY_ACTIVITY_TASK_QUEUE,
            workflowId,
            versioningOverride: getTemporalPinnedVersioningOverride(),
            workflowRunTimeout: DEFAULT_MEMORY_JOB_TIMEOUT,
            args: workflowStart.args,
            memo: {
                memoryJobId: jobId,
                memoryJobType: input.type,
                agentWallet: input.agentWallet,
            },
        });
        const temporalRunId = "firstExecutionRunId" in handle && typeof handle.firstExecutionRunId === "string"
            ? handle.firstExecutionRunId
            : undefined;
        await jobs.updateOne(
            { jobId },
            { $set: { temporalRunId } },
        );
        return {
            ...runningRecord,
            temporalRunId,
        };
    } catch (error) {
        if (error instanceof WorkflowExecutionAlreadyStartedError) {
            return runningRecord;
        }
        const completedAt = nowMs();
        const message = error instanceof Error ? error.message : String(error);
        await jobs.updateOne(
            { jobId },
            { $set: { status: "failed", error: message, completedAt } },
        );
        return {
            ...runningRecord,
            status: "failed",
            error: message,
            completedAt,
        };
    }
}

async function refreshTemporalJob(record: MemoryJobRecord): Promise<MemoryJobRecord> {
    if (record.execution !== "temporal" || record.status !== "running" || !record.temporalWorkflowId || !isTemporalConfigured()) {
        return record;
    }

    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(record.temporalWorkflowId);
    const temporalState = await queryTemporalMemoryState(handle);
    if (!temporalState) {
        return record;
    }

    const status = temporalState.status === "completed"
        ? "completed"
        : temporalState.status === "failed"
            ? "failed"
            : "running";
    const completedAt = status === "running" ? undefined : nowMs();
    const data = {
        ...(record.data && typeof record.data === "object" ? record.data as Record<string, unknown> : {}),
        temporalState,
    };

    const refreshed: MemoryJobRecord = {
        ...record,
        status,
        data,
        error: status === "failed" ? temporalState.errors[0] ?? record.error : record.error,
        completedAt: completedAt ?? record.completedAt,
    };

    await getMemoryJobsCollection().then((jobs) => jobs.updateOne(
        { jobId: record.jobId },
        {
            $set: {
                status,
                data,
                ...(status === "failed" ? { error: temporalState.errors[0] ?? record.error } : {}),
                ...(completedAt ? { completedAt } : {}),
            },
        },
    ));

    return refreshed;
}

export async function runMemoryMaintenanceJob(input: MemoryMaintenanceJobInput): Promise<MemoryJobRecord> {
    if (input.execution === "temporal") {
        return startTemporalMemoryJob(input);
    }
    return runInlineMemoryMaintenanceJob(input);
}

export async function getMemoryJob(jobId: string): Promise<MemoryJobRecord | null> {
    const record = await getStoredMemoryJob(jobId);
    return record ? refreshTemporalJob(record) : null;
}
