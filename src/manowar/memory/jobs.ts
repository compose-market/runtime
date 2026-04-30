import { createContentHash } from "./cache.js";
import { getMemoryJobsCollection } from "./mongo.js";
import type {
    MemoryJobRecord,
    MemoryMaintenanceJobInput,
} from "./types.js";
import {
    cleanupExpiredMemories,
    consolidateAgentMemories,
    createMemoryArchive,
    extractExecutionPatterns,
    updateMemoryDecayScores,
} from "./operations.js";

interface TimeRange {
    start: number;
    end: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function nowMs(): number {
    return Date.now();
}

function resolveWindow(
    explicitRange: TimeRange | undefined,
    windowDays: number | undefined,
    defaultDays: number,
): TimeRange {
    if (explicitRange) {
        return explicitRange;
    }
    const end = nowMs();
    const days = Number.isFinite(windowDays) && windowDays && windowDays > 0 ? windowDays : defaultDays;
    return {
        start: end - days * DAY_MS,
        end,
    };
}

export function createMemoryJobId(input: MemoryMaintenanceJobInput, timestamp = nowMs()): string {
    return `memjob_${createContentHash(`${input.type}|${JSON.stringify(input)}|${timestamp}`)}`;
}

async function executeInlineMemoryJob(input: MemoryMaintenanceJobInput): Promise<unknown> {
    if (input.type === "consolidate") {
        const wallets = input.agentWallets || (input.agentWallet ? [input.agentWallet] : []);
        return consolidateAgentMemories({
            agentWallets: wallets,
            batchSize: input.batchSize,
        });
    } else if (input.type === "patterns_extract") {
        if (!input.agentWallet) {
            throw new Error("agentWallet is required for patterns_extract");
        }
        return extractExecutionPatterns({
            agentWallet: input.agentWallet,
            timeRange: resolveWindow(input.timeRange, input.windowDays, 1),
            confidenceThreshold: input.confidenceThreshold ?? 0.7,
        });
    } else if (input.type === "archive_create") {
        if (!input.agentWallet) {
            throw new Error("agentWallet is required for archive_create");
        }
        return createMemoryArchive({
            agentWallet: input.agentWallet,
            dateRange: resolveWindow(input.dateRange, input.windowDays, 7),
            compress: input.compress,
        });
    } else if (input.type === "decay_update") {
        return updateMemoryDecayScores({ halfLifeDays: input.halfLifeDays ?? 30 });
    }

    return cleanupExpiredMemories({ olderThanDays: input.olderThanDays ?? 90 });
}

export async function runMemoryMaintenanceJob(input: MemoryMaintenanceJobInput): Promise<MemoryJobRecord> {
    const jobId = createMemoryJobId(input);
    const jobs = await getMemoryJobsCollection();
    const now = nowMs();
    const runningRecord: MemoryJobRecord = {
        jobId,
        type: input.type,
        execution: "inline",
        status: "running",
        agentWallet: input.agentWallet,
        createdAt: now,
    };
    await jobs.insertOne(runningRecord);

    try {
        const data = await executeInlineMemoryJob(input);
        const completedAt = nowMs();
        const completedRecord: MemoryJobRecord = {
            ...runningRecord,
            status: "completed",
            data,
            completedAt,
        };
        await jobs.updateOne(
            { jobId },
            { $set: { status: "completed", data, completedAt } },
        );
        return completedRecord;
    } catch (error) {
        const completedAt = nowMs();
        const message = error instanceof Error ? error.message : String(error);
        const failedRecord: MemoryJobRecord = {
            ...runningRecord,
            status: "failed",
            error: message,
            completedAt,
        };
        await jobs.updateOne(
            { jobId },
            { $set: { status: "failed", error: message, completedAt } },
        );
        return failedRecord;
    }
}

export async function getMemoryJob(jobId: string): Promise<MemoryJobRecord | null> {
    const jobs = await getMemoryJobsCollection();
    return jobs.findOne({ jobId });
}
