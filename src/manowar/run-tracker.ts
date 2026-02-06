/**
 * Run Tracker - Execution History & Observability
 * 
 * Tracks all workflow runs with LangSmith integration:
 * - Run creation, status updates, and completion
 * - Trigger-based execution tracking
 * - Cron job execution history
 * 
 * Uses langsmith.ts for all LangSmith SDK operations (centralized).
 */

import {
    isLangSmithEnabled,
    fetchLangSmithRuns as fetchRuns,
    getLangSmithRun as getRemoteRun,
    type Run,
} from "./langsmith.js";

// =============================================================================
// Types
// =============================================================================

export interface TrackedRun {
    runId: string;
    workflowId: string;
    manowarWallet?: string; // Wallet address as primary identifier
    status: "pending" | "running" | "success" | "error" | "cancelled";
    triggeredBy?: {
        type: "manual" | "cron" | "webhook" | "api";
        triggerId?: string;
        cronExpression?: string;
    };
    input: Record<string, unknown>;
    output?: Record<string, unknown>;
    error?: string;
    tokenMetrics?: {
        inputTokens: number;
        outputTokens: number;
        reasoningTokens: number;
        totalTokens: number;
    };
    timing: {
        createdAt: number;
        startedAt?: number;
        completedAt?: number;
        durationMs?: number;
    };
    langsmithRunId?: string;
}

export interface RunFilter {
    workflowId?: string;
    manowarWallet?: string;
    status?: TrackedRun["status"];
    triggeredBy?: "manual" | "cron" | "webhook" | "api";
    since?: number;
    until?: number;
    limit?: number;
}

// =============================================================================
// In-Memory Run Store
// =============================================================================

const runStore = new Map<string, TrackedRun>();
const runsByWorkflow = new Map<string, Set<string>>();
const MAX_RUNS_PER_WORKFLOW = 100;

// =============================================================================
// LangSmith Integration (via langsmith.ts)
// =============================================================================

/**
 * Check if LangSmith is available
 */
export function isLangSmithAvailable(): boolean {
    return isLangSmithEnabled();
}

// =============================================================================
// Run Lifecycle
// =============================================================================

/**
 * Create a new tracked run
 */
export function createRun(params: {
    workflowId: string;
    manowarWallet?: string;
    input: Record<string, unknown>;
    triggeredBy?: TrackedRun["triggeredBy"];
}): TrackedRun {
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const run: TrackedRun = {
        runId,
        workflowId: params.workflowId,
        manowarWallet: params.manowarWallet,
        status: "pending",
        triggeredBy: params.triggeredBy,
        input: params.input,
        timing: {
            createdAt: Date.now(),
        },
    };

    runStore.set(runId, run);

    // Track by workflow
    if (!runsByWorkflow.has(params.workflowId)) {
        runsByWorkflow.set(params.workflowId, new Set());
    }
    const workflowRuns = runsByWorkflow.get(params.workflowId)!;
    workflowRuns.add(runId);

    // Prune old runs
    if (workflowRuns.size > MAX_RUNS_PER_WORKFLOW) {
        const toRemove = Array.from(workflowRuns).slice(0, workflowRuns.size - MAX_RUNS_PER_WORKFLOW);
        toRemove.forEach(id => {
            workflowRuns.delete(id);
            runStore.delete(id);
        });
    }

    console.log(`[RunTracker] Created run ${runId} for workflow ${params.workflowId}`);
    return run;
}

/**
 * Mark run as started
 */
export function startRun(runId: string, langsmithRunId?: string): TrackedRun | null {
    const run = runStore.get(runId);
    if (!run) return null;

    run.status = "running";
    run.timing.startedAt = Date.now();
    run.langsmithRunId = langsmithRunId;

    console.log(`[RunTracker] Started run ${runId}`);
    return run;
}

/**
 * Complete a run successfully
 */
export function completeRun(
    runId: string,
    output: Record<string, unknown>,
    tokenMetrics?: TrackedRun["tokenMetrics"]
): TrackedRun | null {
    const run = runStore.get(runId);
    if (!run) return null;

    const now = Date.now();
    run.status = "success";
    run.output = output;
    run.tokenMetrics = tokenMetrics;
    run.timing.completedAt = now;
    run.timing.durationMs = run.timing.startedAt
        ? now - run.timing.startedAt
        : now - run.timing.createdAt;

    console.log(`[RunTracker] Completed run ${runId} in ${run.timing.durationMs}ms`);
    return run;
}

/**
 * Fail a run with error
 */
export function failRun(runId: string, error: string): TrackedRun | null {
    const run = runStore.get(runId);
    if (!run) return null;

    const now = Date.now();
    run.status = "error";
    run.error = error;
    run.timing.completedAt = now;
    run.timing.durationMs = run.timing.startedAt
        ? now - run.timing.startedAt
        : now - run.timing.createdAt;

    console.log(`[RunTracker] Failed run ${runId}: ${error}`);
    return run;
}

/**
 * Cancel a run
 */
export function cancelRun(runId: string): TrackedRun | null {
    const run = runStore.get(runId);
    if (!run || run.status !== "running") return null;

    run.status = "cancelled";
    run.timing.completedAt = Date.now();

    console.log(`[RunTracker] Cancelled run ${runId}`);
    return run;
}

// =============================================================================
// Run Queries
// =============================================================================

/**
 * Get a specific run
 */
export function getRun(runId: string): TrackedRun | null {
    return runStore.get(runId) || null;
}

/**
 * List runs with filters
 */
export function listRuns(filter: RunFilter = {}): TrackedRun[] {
    let runs = Array.from(runStore.values());

    if (filter.workflowId) {
        runs = runs.filter(r => r.workflowId === filter.workflowId);
    }
    if (filter.manowarWallet) {
        runs = runs.filter(r => r.manowarWallet === filter.manowarWallet);
    }
    if (filter.status) {
        runs = runs.filter(r => r.status === filter.status);
    }
    if (filter.triggeredBy) {
        runs = runs.filter(r => r.triggeredBy?.type === filter.triggeredBy);
    }
    if (filter.since) {
        runs = runs.filter(r => r.timing.createdAt >= filter.since!);
    }
    if (filter.until) {
        runs = runs.filter(r => r.timing.createdAt <= filter.until!);
    }

    // Sort by creation time descending
    runs.sort((a, b) => b.timing.createdAt - a.timing.createdAt);

    if (filter.limit) {
        runs = runs.slice(0, filter.limit);
    }

    return runs;
}

/**
 * Get run statistics for a workflow
 */
export function getRunStats(workflowId: string): {
    total: number;
    pending: number;
    running: number;
    success: number;
    error: number;
    cancelled: number;
    avgDurationMs: number;
    totalTokens: number;
} {
    const runs = listRuns({ workflowId });

    const stats = {
        total: runs.length,
        pending: 0,
        running: 0,
        success: 0,
        error: 0,
        cancelled: 0,
        avgDurationMs: 0,
        totalTokens: 0,
    };

    let completedCount = 0;
    let totalDuration = 0;

    for (const run of runs) {
        stats[run.status]++;

        if (run.timing.durationMs) {
            totalDuration += run.timing.durationMs;
            completedCount++;
        }

        if (run.tokenMetrics) {
            stats.totalTokens += run.tokenMetrics.totalTokens;
        }
    }

    stats.avgDurationMs = completedCount > 0 ? Math.round(totalDuration / completedCount) : 0;

    return stats;
}

// =============================================================================
// LangSmith Integration (delegated to langsmith.ts)
// =============================================================================

/**
 * Fetch runs from LangSmith for a project
 * @deprecated Use fetchLangSmithRuns from langsmith.ts directly
 */
export async function fetchLangSmithRuns(params: {
    limit?: number;
    projectName?: string;
}): Promise<Run[]> {
    return fetchRuns(params);
}

/**
 * Get LangSmith run details
 * @deprecated Use getLangSmithRun from langsmith.ts directly
 */
export async function getLangSmithRun(runId: string): Promise<Run | null> {
    return getRemoteRun(runId);
}

// =============================================================================
// Cron Execution Tracking
// =============================================================================

// Track cron executions for observability
const cronExecutions = new Map<string, {
    triggerId: string;
    cronExpression: string;
    lastExecution: number;
    executionCount: number;
    lastRunId?: string;
    lastStatus?: "success" | "error";
}>();

/**
 * Record a cron trigger execution
 */
export function recordCronExecution(
    triggerId: string,
    cronExpression: string,
    runId: string,
    status: "success" | "error"
): void {
    const existing = cronExecutions.get(triggerId) || {
        triggerId,
        cronExpression,
        lastExecution: 0,
        executionCount: 0,
    };

    existing.lastExecution = Date.now();
    existing.executionCount++;
    existing.lastRunId = runId;
    existing.lastStatus = status;

    cronExecutions.set(triggerId, existing);
    console.log(`[RunTracker] Recorded cron execution for ${triggerId}: ${status}`);
}

/**
 * Get cron execution stats
 */
export function getCronStats(triggerId: string): {
    lastExecution: number;
    executionCount: number;
    lastStatus?: "success" | "error";
} | null {
    return cronExecutions.get(triggerId) || null;
}

/**
 * List all active cron triggers with stats
 */
export function listCronStats(): Array<{
    triggerId: string;
    cronExpression: string;
    lastExecution: number;
    executionCount: number;
    lastStatus?: "success" | "error";
}> {
    return Array.from(cronExecutions.values());
}
