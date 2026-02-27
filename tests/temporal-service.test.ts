/**
 * Temporal Service Tests
 *
 * Covers ID invariants, signal/query routing, and schedule policy defaults.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ScheduleOverlapPolicy } from "@temporalio/client";
import type { TriggerDefinition, Workflow } from "../src/manowar/types.js";

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

vi.mock("../src/temporal/client.js", () => ({
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
}));

import {
    buildManowarRunWorkflowId,
    buildTriggerScheduleId,
    cancelManowarRun,
    getManowarRunState,
    signalStepApproval,
    startManowarRun,
    upsertTriggerSchedule,
} from "../src/temporal/service.js";

function createWorkflow(walletAddress: string): Workflow {
    return {
        id: `manowar-${walletAddress}`,
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
        manowarWallet: "0xABC",
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

    it("builds workflowId as manowar-wallet", () => {
        expect(buildManowarRunWorkflowId("0xabc", "run-1")).toBe("manowar-0xabc:run:run-1");
    });

    it("rejects start when workflow payload ID mismatches wallet", async () => {
        await expect(startManowarRun(
            "0xabc",
            { ...createWorkflow("0xabc"), id: "manowar-0xdef" },
            "run request",
            {},
            "run-1",
        )).rejects.toThrow("workflow.id mismatch");
    });

    it("starts run with stable workflowId", async () => {
        await startManowarRun(
            "0xabc",
            createWorkflow("0xabc"),
            "run request",
            {},
            "run-1",
        );

        expect(mockWorkflowStart).toHaveBeenCalledTimes(1);
        const [, startArgs] = mockWorkflowStart.mock.calls[0];
        expect(startArgs.workflowId).toBe("manowar-0xabc:run:run-1");
        expect(startArgs.memo.walletAddress).toBe("0xabc");
    });

    it("returns run state only for matching runId", async () => {
        workflowHandle.query.mockResolvedValue({ runId: "run-1", status: "running" });

        const found = await getManowarRunState("0xabc", "run-1");
        const notFound = await getManowarRunState("0xabc", "run-2");

        expect(found).not.toBeNull();
        expect(notFound).toBeNull();
    });

    it("signals cancellation for deterministic run handle", async () => {
        await cancelManowarRun("0xabc", "run-1");
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

    it("builds trigger schedule ID with exact wallet", () => {
        expect(buildTriggerScheduleId("0xABCDEF", "trigger-9")).toBe("manowar-trigger-0xABCDEF-trigger-9");
    });

    it("upserts schedule with BUFFER_ONE overlap and schedule-managed workflow IDs", async () => {
        const trigger = createTrigger({
            id: "trigger-10",
            manowarWallet: "0xABC",
            cronExpression: "*/5 * * * *",
            enabled: true,
        });

        await upsertTriggerSchedule(trigger);

        expect(scheduleHandle.delete).toHaveBeenCalledTimes(1);
        expect(scheduleHandle.delete).toHaveBeenCalledWith();
        expect(mockScheduleCreate).toHaveBeenCalledTimes(1);
        const [args] = mockScheduleCreate.mock.calls[0];
        expect(args.scheduleId).toBe("manowar-trigger-0xABC-trigger-10");
        expect(args.action.workflowId).toBeUndefined();
        expect(args.action.args[0].composeRunId).toBeUndefined();
        expect(args.policies.overlap).toBe(ScheduleOverlapPolicy.BUFFER_ONE);
        expect(args.policies.catchupWindow).toBe(10 * 60 * 1000);
        expect(args.state.paused).toBe(false);
    });

    it("creates schedule even when delete path reports not found", async () => {
        scheduleHandle.delete.mockRejectedValueOnce(new Error("not found"));

        const trigger = createTrigger({ id: "trigger-create" });
        await upsertTriggerSchedule(trigger);

        expect(mockScheduleCreate).toHaveBeenCalledTimes(1);
        const [args] = mockScheduleCreate.mock.calls[0];
        expect(args.scheduleId).toBe("manowar-trigger-0xABC-trigger-create");
        expect(args.action.workflowId).toBeUndefined();
    });
});
