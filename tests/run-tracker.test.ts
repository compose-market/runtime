/**
 * Run Tracker Tests
 * 
 * Unit tests for the workflow run tracking system:
 * - Run creation and state management  
 * - LangSmith integration
 * - Run lifecycle (start, complete, fail, cancel)
 * - Run queries and statistics
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
    createRun,
    getRun,
    startRun,
    completeRun,
    failRun,
    cancelRun,
    listRuns,
    getRunStats,
    isLangSmithAvailable,
    recordCronExecution,
    getCronStats,
    listCronStats,
    type TrackedRun,
    type RunFilter,
} from "../src/manowar/run-tracker.js";

describe("createRun", () => {
    it("should create a new tracked run", () => {
        const run = createRun({
            workflowId: "wf-123",
            input: { task: "Analyze the data" },
            triggeredBy: { type: "manual" },
        });

        expect(run).toBeDefined();
        expect(run.runId).toBeDefined();
        expect(run.workflowId).toBe("wf-123");
        expect(run.status).toBe("pending");
    });

    it("should generate unique run IDs", () => {
        const run1 = createRun({ workflowId: "wf-1", input: { test: 1 }, triggeredBy: { type: "manual" } });
        const run2 = createRun({ workflowId: "wf-1", input: { test: 2 }, triggeredBy: { type: "manual" } });

        expect(run1.runId).not.toBe(run2.runId);
    });

    it("should include manowar wallet when provided", () => {
        const run = createRun({
            workflowId: "wf-123",
            manowarWallet: "0xABC123",
            input: { test: true },
            triggeredBy: { type: "manual" },
        });

        expect(run.manowarWallet).toBe("0xABC123");
    });

    it("should set trigger info correctly", () => {
        const cronRun = createRun({
            workflowId: "wf-1",
            input: { scheduled: true },
            triggeredBy: { type: "cron", triggerId: "cron-daily" },
        });

        expect(cronRun.triggeredBy?.type).toBe("cron");
        expect(cronRun.triggeredBy?.triggerId).toBe("cron-daily");
    });

    it("should set timing.createdAt", () => {
        const before = Date.now();
        const run = createRun({ workflowId: "wf-1", input: {}, triggeredBy: { type: "manual" } });
        const after = Date.now();

        expect(run.timing.createdAt).toBeGreaterThanOrEqual(before);
        expect(run.timing.createdAt).toBeLessThanOrEqual(after);
    });
});

describe("getRun", () => {
    it("should retrieve run by ID", () => {
        const created = createRun({ workflowId: "wf-1", input: {}, triggeredBy: { type: "manual" } });
        const retrieved = getRun(created.runId);

        expect(retrieved).toBeDefined();
        expect(retrieved?.runId).toBe(created.runId);
        expect(retrieved?.workflowId).toBe("wf-1");
    });

    it("should return null for unknown run ID", () => {
        const run = getRun("nonexistent-run-id");

        expect(run).toBeNull();
    });
});

describe("startRun", () => {
    it("should update run status to running", () => {
        const run = createRun({ workflowId: "wf-1", input: {}, triggeredBy: { type: "manual" } });

        const started = startRun(run.runId);

        expect(started?.status).toBe("running");
        expect(started?.timing.startedAt).toBeDefined();
    });

    it("should return null for unknown run ID", () => {
        const result = startRun("unknown-id");
        expect(result).toBeNull();
    });
});

describe("completeRun", () => {
    it("should complete run with output", () => {
        const run = createRun({ workflowId: "wf-1", input: {}, triggeredBy: { type: "manual" } });
        startRun(run.runId);

        const completed = completeRun(run.runId, { result: "Analysis complete" });

        expect(completed?.status).toBe("success");
        expect(completed?.output).toEqual({ result: "Analysis complete" });
        expect(completed?.timing.completedAt).toBeDefined();
    });

    it("should include token metrics when provided", () => {
        const run = createRun({ workflowId: "wf-1", input: {}, triggeredBy: { type: "manual" } });
        startRun(run.runId);

        const completed = completeRun(run.runId, { result: "done" }, {
            inputTokens: 1000,
            outputTokens: 500,
            reasoningTokens: 0,
            totalTokens: 1500,
        });

        expect(completed?.tokenMetrics?.totalTokens).toBe(1500);
    });
});

describe("failRun", () => {
    it("should fail run with error", () => {
        const run = createRun({ workflowId: "wf-1", input: {}, triggeredBy: { type: "manual" } });
        startRun(run.runId);

        const failed = failRun(run.runId, "Something went wrong");

        expect(failed?.status).toBe("error");
        expect(failed?.error).toBe("Something went wrong");
        expect(failed?.timing.completedAt).toBeDefined();
    });
});

describe("cancelRun", () => {
    it("should cancel a running run", () => {
        const run = createRun({ workflowId: "wf-1", input: {}, triggeredBy: { type: "manual" } });
        startRun(run.runId);

        const cancelled = cancelRun(run.runId);

        expect(cancelled?.status).toBe("cancelled");
    });
});

describe("listRuns", () => {
    beforeEach(() => {
        // Create some test runs
        const wfA1 = createRun({ workflowId: "wf-A", input: { n: 1 }, triggeredBy: { type: "manual" } });
        const wfA2 = createRun({ workflowId: "wf-A", input: { n: 2 }, triggeredBy: { type: "cron" } });
        const wfB1 = createRun({ workflowId: "wf-B", input: { n: 1 }, triggeredBy: { type: "manual" } });

        startRun(wfA1.runId);
        completeRun(wfA1.runId, { done: true });
    });

    it("should filter by workflowId", () => {
        const runsA = listRuns({ workflowId: "wf-A" });

        expect(runsA.every((r: TrackedRun) => r.workflowId === "wf-A")).toBe(true);
    });

    it("should filter by status", () => {
        const completedRuns = listRuns({ status: "success" });

        expect(completedRuns.every((r: TrackedRun) => r.status === "success")).toBe(true);
    });

    it("should filter by trigger type", () => {
        const cronRuns = listRuns({ triggeredBy: "cron" });

        expect(cronRuns.every((r: TrackedRun) => r.triggeredBy?.type === "cron")).toBe(true);
    });

    it("should limit results", () => {
        const limited = listRuns({ limit: 2 });

        expect(limited.length).toBeLessThanOrEqual(2);
    });
});

describe("getRunStats", () => {
    it("should return statistics for workflow", () => {
        const workflowId = `wf-stats-${Date.now()}`;

        const run1 = createRun({ workflowId, input: {}, triggeredBy: { type: "manual" } });
        startRun(run1.runId);
        completeRun(run1.runId, {}, { inputTokens: 100, outputTokens: 50, reasoningTokens: 0, totalTokens: 150 });

        const run2 = createRun({ workflowId, input: {}, triggeredBy: { type: "manual" } });
        startRun(run2.runId);
        failRun(run2.runId, "Error");

        const stats = getRunStats(workflowId);

        expect(stats.total).toBe(2);
        expect(stats.success).toBe(1);
        expect(stats.error).toBe(1);
        expect(stats.totalTokens).toBe(150);
    });
});

describe("isLangSmithAvailable", () => {
    it("should return boolean", () => {
        const available = isLangSmithAvailable();
        expect(typeof available).toBe("boolean");
    });
});

describe("Cron Execution Tracking", () => {
    it("should record cron execution", () => {
        const triggerId = `trigger-${Date.now()}`;
        const run = createRun({ workflowId: "wf-cron", input: {}, triggeredBy: { type: "cron", triggerId } });

        recordCronExecution(triggerId, "0 * * * *", run.runId, "success");

        const stats = getCronStats(triggerId);
        expect(stats).toBeDefined();
        expect(stats?.executionCount).toBe(1);
    });

    it("should increment execution count on multiple runs", () => {
        const triggerId = `trigger-multi-${Date.now()}`;
        const run1 = createRun({ workflowId: "wf-cron", input: {}, triggeredBy: { type: "cron", triggerId } });
        const run2 = createRun({ workflowId: "wf-cron", input: {}, triggeredBy: { type: "cron", triggerId } });

        recordCronExecution(triggerId, "*/5 * * * *", run1.runId, "success");
        recordCronExecution(triggerId, "*/5 * * * *", run2.runId, "success");

        const stats = getCronStats(triggerId);
        expect(stats?.executionCount).toBe(2);
    });

    it("should list all cron stats", () => {
        const allStats = listCronStats();
        expect(Array.isArray(allStats)).toBe(true);
    });
});

describe("Type Exports", () => {
    it("should export TrackedRun type correctly", () => {
        const run: TrackedRun = {
            runId: "run-123",
            workflowId: "wf-456",
            status: "running",
            input: { test: true },
            triggeredBy: { type: "manual" },
            timing: { createdAt: Date.now() },
        };

        expect(run.runId).toBe("run-123");
    });

    it("should export RunFilter type correctly", () => {
        const filter: RunFilter = {
            workflowId: "wf-123",
            status: "success",
            limit: 10,
        };

        expect(filter.limit).toBe(10);
    });
});
