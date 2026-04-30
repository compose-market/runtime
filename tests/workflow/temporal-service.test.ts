/**
 * Temporal service tests.
 *
 * Covers deterministic IDs, pinned deployment routing, and schedule defaults.
 */

import { ScheduleOverlapPolicy } from "@temporalio/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TriggerDefinition, Workflow } from "../../src/manowar/workflow/types.js";

const pinnedVersioningOverride = {
    pinnedTo: {
        deploymentName: "runtime-compose-test-desjy",
        buildId: "runtime@0.1.0+1234567890abcdef12345678",
    },
};

const workflowHandle = {
    result: vi.fn(),
    query: vi.fn(),
    signal: vi.fn(),
};

const scheduleHandle = {
    delete: vi.fn(),
};

const mockWorkflowStart = vi.fn();
const mockWorkflowGetHandle = vi.fn(() => workflowHandle);
const mockScheduleCreate = vi.fn();
const mockScheduleGetHandle = vi.fn(() => scheduleHandle);

vi.mock("../../src/temporal/client.js", () => ({
    getTemporalClient: vi.fn(async () => ({
        workflow: {
            start: mockWorkflowStart,
            getHandle: mockWorkflowGetHandle,
        },
        schedule: {
            create: mockScheduleCreate,
            getHandle: mockScheduleGetHandle,
        },
    })),
    getTemporalPinnedVersioningOverride: vi.fn(() => pinnedVersioningOverride),
}));

import {
    buildAgentRunWorkflowId,
    buildTriggerScheduleId,
    buildWorkflowRunWorkflowId,
    cancelWorkflowRun,
    getWorkflowRunState,
    signalStepApproval,
    startAgentRun,
    startWorkflowRun,
    upsertTriggerSchedule,
} from "../../src/temporal/service.js";

function createWorkflow(walletAddress: string): Workflow {
    return {
        id: `workflow-${walletAddress}`,
        name: "Test Workflow",
        description: "Temporal test workflow",
        steps: [],
        chainId: 43113,
    };
}

function createTrigger(overrides: Partial<TriggerDefinition> = {}): TriggerDefinition {
    const now = Date.now();
    return {
        id: "trigger-1",
        workflowWallet: "0xABC",
        name: "Cron Trigger",
        type: "cron",
        nlDescription: "every 5 minutes",
        cronExpression: "*/5 * * * *",
        cronReadable: "Every 5 minutes",
        timezone: "UTC",
        enabled: true,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    };
}

describe("temporal/service", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        workflowHandle.result.mockResolvedValue({ success: true });
        workflowHandle.query.mockResolvedValue({ runId: "run-1" });
        workflowHandle.signal.mockResolvedValue(undefined);
        scheduleHandle.delete.mockResolvedValue(undefined);
        mockWorkflowStart.mockResolvedValue(workflowHandle);
        mockScheduleCreate.mockResolvedValue(undefined);
    });

    it("builds workflow ids with wallet and run id", () => {
        expect(buildWorkflowRunWorkflowId("0xabc", "run-1")).toBe("workflow-0xabc:run:run-1");
    });

    it("builds agent workflow ids with wallet, thread, and run id", () => {
        expect(buildAgentRunWorkflowId("0xabc", "thread-1", "run-1")).toBe("agent-0xabc:thread:thread-1:run:run-1");
    });

    it("rejects workflow start when workflow payload id mismatches wallet", async () => {
        await expect(startWorkflowRun(
            "0xabc",
            { ...createWorkflow("0xabc"), id: "workflow-0xdef" },
            "run request",
            {},
            "run-1",
        )).rejects.toThrow("workflow.id mismatch");
    });

    it("starts workflow runs with stable ids and pinned deployment routing", async () => {
        await startWorkflowRun(
            "0xabc",
            createWorkflow("0xabc"),
            "run request",
            {},
            "run-1",
        );

        expect(mockWorkflowStart).toHaveBeenCalledTimes(1);
        const [, startArgs] = mockWorkflowStart.mock.calls[0];
        expect(startArgs.workflowId).toBe("workflow-0xabc:run:run-1");
        expect(startArgs.memo.walletAddress).toBe("0xabc");
        expect(startArgs.versioningOverride).toEqual(pinnedVersioningOverride);
    });

    it("starts agent runs with stable ids and pinned deployment routing", async () => {
        await startAgentRun({
            composeRunId: "run-1",
            agentWallet: "0xagent",
            message: "hello",
            options: {
                threadId: "thread-1",
            },
        });

        expect(mockWorkflowStart).toHaveBeenCalledTimes(1);
        const [, startArgs] = mockWorkflowStart.mock.calls[0];
        expect(startArgs.workflowId).toBe("agent-0xagent:thread:thread-1:run:run-1");
        expect(startArgs.memo.agentWallet).toBe("0xagent");
        expect(startArgs.memo.threadId).toBe("thread-1");
        expect(startArgs.versioningOverride).toEqual(pinnedVersioningOverride);
    });

    it("returns workflow state only for matching run id", async () => {
        workflowHandle.query.mockResolvedValue({ runId: "run-1", status: "running" });

        const found = await getWorkflowRunState("0xabc", "run-1");
        const notFound = await getWorkflowRunState("0xabc", "run-2");

        expect(found).not.toBeNull();
        expect(notFound).toBeNull();
    });

    it("signals workflow cancellation for deterministic handles", async () => {
        await cancelWorkflowRun("0xabc", "run-1");
        expect(workflowHandle.signal).toHaveBeenCalledWith("cancelExecution");
    });

    it("sends step approval signal with decision payload", async () => {
        await signalStepApproval(
            "0xabc",
            "run-1",
            "step-1",
            "approved",
            "ops",
            "approved by ops",
        );

        expect(workflowHandle.signal).toHaveBeenCalledTimes(1);
        const [signalName, payload] = workflowHandle.signal.mock.calls[0];
        expect(signalName).toBe("setStepApproval");
        expect(payload.stepKey).toBe("step-1");
        expect(payload.decision.status).toBe("approved");
        expect(payload.decision.approver).toBe("ops");
    });

    it("builds trigger schedule ids with workflow prefix", () => {
        expect(buildTriggerScheduleId("0xABCDEF", "trigger-9")).toBe("workflow-trigger-0xABCDEF-trigger-9");
    });

    it("upserts schedules with workflow queue defaults", async () => {
        const trigger = createTrigger({
            id: "trigger-10",
            workflowWallet: "0xABC",
            cronExpression: "*/5 * * * *",
            enabled: true,
        });

        await upsertTriggerSchedule(trigger);

        expect(scheduleHandle.delete).toHaveBeenCalledTimes(1);
        expect(mockScheduleCreate).toHaveBeenCalledTimes(1);
        const [args] = mockScheduleCreate.mock.calls[0];
        expect(args.scheduleId).toBe("workflow-trigger-0xABC-trigger-10");
        expect(args.action.workflowId).toBeUndefined();
        expect(args.action.args[0].composeRunId).toBeUndefined();
        expect(args.policies.overlap).toBe(ScheduleOverlapPolicy.BUFFER_ONE);
        expect(args.policies.catchupWindow).toBe(10 * 60 * 1000);
        expect(args.state.paused).toBe(false);
    });

    it("creates schedules when delete path reports not found", async () => {
        scheduleHandle.delete.mockRejectedValueOnce(new Error("not found"));

        await upsertTriggerSchedule(createTrigger({ id: "trigger-create" }));

        expect(mockScheduleCreate).toHaveBeenCalledTimes(1);
        const [args] = mockScheduleCreate.mock.calls[0];
        expect(args.scheduleId).toBe("workflow-trigger-0xABC-trigger-create");
        expect(args.action.workflowId).toBeUndefined();
    });
});
