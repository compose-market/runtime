import { ScheduleOverlapPolicy } from "@temporalio/client";
import type { Client } from "@temporalio/client";
import { getTemporalClient } from "../client.js";
import {
    MEMORY_ACTIVITY_TASK_QUEUE,
    MEMORY_DAILY_CONSOLIDATION_CRON,
    MEMORY_WEEKLY_ARCHIVE_CRON,
    MEMORY_HOURLY_DECAY_CRON,
    MEMORY_SCHEDULE_CATCHUP_WINDOW_MS,
    MEMORY_WORKFLOW_ID_PREFIX,
} from "../constants.js";
import type {
    MemoryConsolidationInput,
    ArchiveCreationInput,
    DecayUpdateInput,
    PatternExtractionInput,
    MemoryCleanupInput,
} from "../types.js";

export const MEMORY_SCHEDULE_OVERLAP_POLICY = ScheduleOverlapPolicy.SKIP;

export const MEMORY_DAILY_CONSOLIDATION_SCHEDULE_ID = `${MEMORY_WORKFLOW_ID_PREFIX}daily-consolidation`;
export const MEMORY_WEEKLY_ARCHIVE_SCHEDULE_ID = `${MEMORY_WORKFLOW_ID_PREFIX}weekly-archive`;
export const MEMORY_HOURLY_DECAY_SCHEDULE_ID = `${MEMORY_WORKFLOW_ID_PREFIX}hourly-decay`;
export const MEMORY_DAILY_PATTERN_SCHEDULE_ID_PREFIX = `${MEMORY_WORKFLOW_ID_PREFIX}daily-patterns`;
export const MEMORY_WEEKLY_ARCHIVE_SCHEDULE_ID_PREFIX = `${MEMORY_WORKFLOW_ID_PREFIX}weekly-archive`;
export const MEMORY_DAILY_CLEANUP_SCHEDULE_ID = `${MEMORY_WORKFLOW_ID_PREFIX}daily-cleanup`;

interface MemoryScheduleConfig {
    scheduleId: string;
    spec: {
        cronExpressions: string[];
        timezone: string;
    };
    action: {
        type: "startWorkflow";
        workflowType: string;
        taskQueue: string;
        args: unknown[];
    };
    memo?: Record<string, unknown>;
    policies: {
        overlap: ScheduleOverlapPolicy;
        catchupWindow: number;
    };
    state: {
        paused: boolean;
        note: string;
    };
}

function buildMemoryConsolidationSchedule(agentWallets: string[]): MemoryScheduleConfig {
    const input: MemoryConsolidationInput = {
        agentWallets,
        options: {
            batchSize: 25,
        },
    };

    return {
        scheduleId: MEMORY_DAILY_CONSOLIDATION_SCHEDULE_ID,
        spec: {
            cronExpressions: [MEMORY_DAILY_CONSOLIDATION_CRON],
            timezone: "UTC",
        },
        action: {
            type: "startWorkflow",
            workflowType: "memoryConsolidationWorkflow",
            taskQueue: MEMORY_ACTIVITY_TASK_QUEUE,
            args: [input],
        },
        memo: {
            type: "memory-consolidation",
            agentCount: agentWallets.length,
        },
        policies: {
            overlap: MEMORY_SCHEDULE_OVERLAP_POLICY,
            catchupWindow: MEMORY_SCHEDULE_CATCHUP_WINDOW_MS,
        },
        state: {
            paused: false,
            note: "Daily memory consolidation at 2 AM UTC",
        },
    };
}

function buildAgentPatternSchedule(agentWallet: string): MemoryScheduleConfig {
    const input: PatternExtractionInput = {
        agentWallet,
        options: {
            windowDays: 1,
        },
    };

    return {
        scheduleId: `${MEMORY_DAILY_PATTERN_SCHEDULE_ID_PREFIX}:${agentWallet.toLowerCase()}`,
        spec: {
            cronExpressions: [MEMORY_DAILY_CONSOLIDATION_CRON],
            timezone: "UTC",
        },
        action: {
            type: "startWorkflow",
            workflowType: "patternExtractionWorkflow",
            taskQueue: MEMORY_ACTIVITY_TASK_QUEUE,
            args: [input],
        },
        memo: {
            type: "memory-patterns",
            agentWallet,
        },
        policies: {
            overlap: ScheduleOverlapPolicy.SKIP,
            catchupWindow: MEMORY_SCHEDULE_CATCHUP_WINDOW_MS,
        },
        state: {
            paused: false,
            note: `Daily memory pattern extraction for ${agentWallet}`,
        },
    };
}

function buildAgentArchiveSchedule(agentWallet: string): MemoryScheduleConfig {
    const input: ArchiveCreationInput = {
        agentWallet,
        options: {
            windowDays: 7,
            compress: true,
            syncToIpfs: true,
        },
    };

    return {
        scheduleId: `${MEMORY_WEEKLY_ARCHIVE_SCHEDULE_ID_PREFIX}:${agentWallet.toLowerCase()}`,
        spec: {
            cronExpressions: [MEMORY_WEEKLY_ARCHIVE_CRON],
            timezone: "UTC",
        },
        action: {
            type: "startWorkflow",
            workflowType: "archiveCreationWorkflow",
            taskQueue: MEMORY_ACTIVITY_TASK_QUEUE,
            args: [input],
        },
        memo: {
            type: "memory-archive",
            agentWallet,
        },
        policies: {
            overlap: ScheduleOverlapPolicy.BUFFER_ONE,
            catchupWindow: MEMORY_SCHEDULE_CATCHUP_WINDOW_MS,
        },
        state: {
            paused: false,
            note: `Weekly memory archive creation for ${agentWallet}`,
        },
    };
}

function buildHourlyDecaySchedule(): MemoryScheduleConfig {
    const input: DecayUpdateInput = {
        halfLifeDays: 30,
    };

    return {
        scheduleId: MEMORY_HOURLY_DECAY_SCHEDULE_ID,
        spec: {
            cronExpressions: [MEMORY_HOURLY_DECAY_CRON],
            timezone: "UTC",
        },
        action: {
            type: "startWorkflow",
            workflowType: "decayUpdateWorkflow",
            taskQueue: MEMORY_ACTIVITY_TASK_QUEUE,
            args: [input],
        },
        memo: {
            type: "memory-decay",
        },
        policies: {
            overlap: ScheduleOverlapPolicy.SKIP,
            catchupWindow: MEMORY_SCHEDULE_CATCHUP_WINDOW_MS,
        },
        state: {
            paused: false,
            note: "Hourly decay score updates",
        },
    };
}

function buildDailyCleanupSchedule(): MemoryScheduleConfig {
    const input: MemoryCleanupInput = {
        olderThanDays: 90,
    };

    return {
        scheduleId: MEMORY_DAILY_CLEANUP_SCHEDULE_ID,
        spec: {
            cronExpressions: [MEMORY_DAILY_CONSOLIDATION_CRON],
            timezone: "UTC",
        },
        action: {
            type: "startWorkflow",
            workflowType: "memoryCleanupWorkflow",
            taskQueue: MEMORY_ACTIVITY_TASK_QUEUE,
            args: [input],
        },
        memo: {
            type: "memory-cleanup",
        },
        policies: {
            overlap: ScheduleOverlapPolicy.SKIP,
            catchupWindow: MEMORY_SCHEDULE_CATCHUP_WINDOW_MS,
        },
        state: {
            paused: false,
            note: "Daily memory cleanup",
        },
    };
}

async function upsertSchedule(client: Client, scheduleConfig: MemoryScheduleConfig): Promise<void> {
    try {
        await client.schedule.getHandle(scheduleConfig.scheduleId).delete();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.toLowerCase().includes("not found")) {
            console.warn(`[memory-schedules] Failed to delete existing schedule ${scheduleConfig.scheduleId}:`, error);
        }
    }

    await client.schedule.create(scheduleConfig);
    console.log(`[memory-schedules] Created schedule: ${scheduleConfig.scheduleId}`);
}

export async function createMemorySchedules(agentWallets: string[]): Promise<void> {
    const client = await getTemporalClient();
    const normalizedWallets = normalizeAgentWallets(agentWallets);

    const schedules = [
        buildMemoryConsolidationSchedule(normalizedWallets),
        buildHourlyDecaySchedule(),
        buildDailyCleanupSchedule(),
        ...normalizedWallets.flatMap((wallet) => [
            buildAgentPatternSchedule(wallet),
            buildAgentArchiveSchedule(wallet),
        ]),
    ];

    for (const scheduleConfig of schedules) {
        await upsertSchedule(client, scheduleConfig);
    }
}

function normalizeAgentWallets(agentWallets: string[]): string[] {
    return [...new Set(agentWallets.map((wallet) => wallet.trim().toLowerCase()).filter(Boolean))];
}

function memoryScheduleIds(agentWallets: string[] = []): string[] {
    const normalizedWallets = normalizeAgentWallets(agentWallets);
    return [
        MEMORY_DAILY_CONSOLIDATION_SCHEDULE_ID,
        MEMORY_WEEKLY_ARCHIVE_SCHEDULE_ID,
        MEMORY_HOURLY_DECAY_SCHEDULE_ID,
        MEMORY_DAILY_CLEANUP_SCHEDULE_ID,
        ...normalizedWallets.flatMap((agentWallet) => [
            `${MEMORY_DAILY_PATTERN_SCHEDULE_ID_PREFIX}:${agentWallet}`,
            `${MEMORY_WEEKLY_ARCHIVE_SCHEDULE_ID_PREFIX}:${agentWallet}`,
        ]),
    ];
}

export async function deleteMemorySchedules(agentWallets: string[] = []): Promise<void> {
    const client = await getTemporalClient();
    const scheduleIds = memoryScheduleIds(agentWallets);

    for (const scheduleId of scheduleIds) {
        try {
            const handle = client.schedule.getHandle(scheduleId);
            await handle.delete();
            console.log(`[memory-schedules] Deleted schedule: ${scheduleId}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!message.toLowerCase().includes("not found")) {
                console.warn(`[memory-schedules] Failed to delete schedule ${scheduleId}:`, error);
            }
        }
    }
}

export interface MemoryScheduleStatus {
    scheduleId: string;
    paused: boolean;
    lastRunAt?: number;
    nextRunAt?: number;
    note?: string;
}

export async function getMemoryScheduleStatus(agentWallets: string[] = []): Promise<MemoryScheduleStatus[]> {
    const client = await getTemporalClient();
    const scheduleIds = memoryScheduleIds(agentWallets);

    const statuses: MemoryScheduleStatus[] = [];

    for (const scheduleId of scheduleIds) {
        try {
            const handle = client.schedule.getHandle(scheduleId);
            const description = await handle.describe();

            statuses.push({
                scheduleId: description.scheduleId,
                paused: description.state.paused,
                note: description.state.note as string | undefined,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!message.toLowerCase().includes("not found")) {
                console.warn(`[memory-schedules] Failed to get status for ${scheduleId}:`, error);
            }
        }
    }

    return statuses;
}

export async function pauseMemorySchedule(scheduleId: string): Promise<void> {
    const client = await getTemporalClient();
    const handle = client.schedule.getHandle(scheduleId);
    await handle.pause();
}

export async function resumeMemorySchedule(scheduleId: string): Promise<void> {
    const client = await getTemporalClient();
    const handle = client.schedule.getHandle(scheduleId);
    await handle.unpause();
}

export async function triggerMemorySchedule(scheduleId: string): Promise<void> {
    const client = await getTemporalClient();
    const handle = client.schedule.getHandle(scheduleId);
    await handle.trigger();
}
