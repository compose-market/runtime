import { ScheduleOverlapPolicy } from "@temporalio/client";
import type { Client } from "@temporalio/client";
import { getTemporalClient } from "./client.js";
import {
    MEMORY_ACTIVITY_TASK_QUEUE,
    MEMORY_DAILY_CONSOLIDATION_CRON,
    MEMORY_WEEKLY_ARCHIVE_CRON,
    MEMORY_HOURLY_DECAY_CRON,
    MEMORY_SCHEDULE_CATCHUP_WINDOW_MS,
    MEMORY_WORKFLOW_ID_PREFIX,
} from "./constants.js";
import type {
    MemoryConsolidationInput,
    ArchiveCreationInput,
    DecayUpdateInput,
} from "./types.js";

export const MEMORY_SCHEDULE_OVERLAP_POLICY = ScheduleOverlapPolicy.SKIP;

export const MEMORY_DAILY_CONSOLIDATION_SCHEDULE_ID = `${MEMORY_WORKFLOW_ID_PREFIX}daily-consolidation`;
export const MEMORY_WEEKLY_ARCHIVE_SCHEDULE_ID = `${MEMORY_WORKFLOW_ID_PREFIX}weekly-archive`;
export const MEMORY_HOURLY_DECAY_SCHEDULE_ID = `${MEMORY_WORKFLOW_ID_PREFIX}hourly-decay`;

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

function buildWeeklyArchiveSchedule(agentWallets: string[]): MemoryScheduleConfig {
    const now = Date.now();
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

    const input: ArchiveCreationInput = {
        agentWallet: agentWallets[0],
        dateRange: {
            start: weekAgo,
            end: now,
        },
        options: {
            compress: true,
            syncToIpfs: true,
        },
    };

    return {
        scheduleId: MEMORY_WEEKLY_ARCHIVE_SCHEDULE_ID,
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
        },
        policies: {
            overlap: ScheduleOverlapPolicy.BUFFER_ONE,
            catchupWindow: MEMORY_SCHEDULE_CATCHUP_WINDOW_MS,
        },
        state: {
            paused: false,
            note: "Weekly archive creation on Sundays at 3 AM UTC",
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

export async function createMemorySchedules(agentWallets: string[]): Promise<void> {
    const client = await getTemporalClient();

    const schedules = [
        buildMemoryConsolidationSchedule(agentWallets),
        buildWeeklyArchiveSchedule(agentWallets),
        buildHourlyDecaySchedule(),
    ];

    for (const scheduleConfig of schedules) {
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
}

export async function deleteMemorySchedules(): Promise<void> {
    const client = await getTemporalClient();

    const scheduleIds = [
        MEMORY_DAILY_CONSOLIDATION_SCHEDULE_ID,
        MEMORY_WEEKLY_ARCHIVE_SCHEDULE_ID,
        MEMORY_HOURLY_DECAY_SCHEDULE_ID,
    ];

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

export async function getMemoryScheduleStatus(): Promise<MemoryScheduleStatus[]> {
    const client = await getTemporalClient();

    const scheduleIds = [
        MEMORY_DAILY_CONSOLIDATION_SCHEDULE_ID,
        MEMORY_WEEKLY_ARCHIVE_SCHEDULE_ID,
        MEMORY_HOURLY_DECAY_SCHEDULE_ID,
    ];

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