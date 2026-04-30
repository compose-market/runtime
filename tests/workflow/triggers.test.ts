/**
 * Triggers Tests
 *
 * Unit tests for the workflow trigger system:
 * - NL-to-cron parsing (pattern matching + LLM fallback)
 * - Trigger persistence via Temporal schedule metadata
 * - Temporal schedule registration lifecycle
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TriggerDefinition } from "../../src/manowar/workflow/types.js";

const temporalState = vi.hoisted(() => ({
    schedules: new Map<string, { scheduleId: string; paused: boolean; memo?: Record<string, unknown> }>(),
}));

const temporalMock = vi.hoisted(() => {
    const upsertTriggerSchedule = vi.fn(async (trigger: TriggerDefinition) => {
        const wallet = trigger.workflowWallet;
        const scheduleId = `workflow-trigger-${wallet}-${trigger.id}`;
        temporalState.schedules.set(scheduleId, {
            scheduleId,
            paused: !trigger.enabled,
            memo: {
                trigger: {
                    ...trigger,
                    workflowWallet: wallet,
                },
                triggerId: trigger.id,
                workflowWallet: wallet,
            },
        });
    });

    const deleteTriggerSchedule = vi.fn(async (walletAddress: string, triggerId: string) => {
        const scheduleId = `workflow-trigger-${walletAddress}-${triggerId}`;
        temporalState.schedules.delete(scheduleId);
    });

    const listTriggerSchedules = vi.fn(async (walletAddress: string) => {
        const prefix = `workflow-trigger-${walletAddress}-`;
        return Array.from(temporalState.schedules.values()).filter((entry) =>
            entry.scheduleId.startsWith(prefix),
        );
    });

    const getTriggerSchedule = vi.fn(async (walletAddress: string, triggerId: string) => {
        const scheduleId = `workflow-trigger-${walletAddress}-${triggerId}`;
        return temporalState.schedules.get(scheduleId) || null;
    });

    return {
        upsertTriggerSchedule,
        deleteTriggerSchedule,
        listTriggerSchedules,
        getTriggerSchedule,
    };
});

vi.mock("../../src/temporal/client.js", () => ({
    getTemporalClient: vi.fn(async () => ({
        schedule: {
            list: async function* () {
                for (const entry of temporalState.schedules.values()) {
                    yield {
                        scheduleId: entry.scheduleId,
                        state: { paused: entry.paused },
                        memo: entry.memo,
                    };
                }
            },
        },
    })),
}));

vi.mock("../../src/temporal/service.js", () => ({
    upsertTriggerSchedule: temporalMock.upsertTriggerSchedule,
    deleteTriggerSchedule: temporalMock.deleteTriggerSchedule,
    listTriggerSchedules: temporalMock.listTriggerSchedules,
    getTriggerSchedule: temporalMock.getTriggerSchedule,
}));

import {
    parseTriggerFromNL,
    storeTrigger,
    retrieveTriggers,
    deleteTriggerFromMemory,
    registerTrigger,
    unregisterTrigger,
    unregisterAllTriggers,
    getActiveTriggerCount,
    getNextRunTime,
} from "../../src/manowar/workflow/triggers.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function createTestTrigger(overrides: Partial<TriggerDefinition> = {}): TriggerDefinition {
    const now = Date.now();
    return {
        id: `trig-${now}`,
        workflowWallet: "0xTestWallet",
        name: "Test Trigger",
        type: "cron",
        nlDescription: "every hour",
        cronExpression: "0 * * * *",
        cronReadable: "Every hour",
        timezone: "UTC",
        enabled: true,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    };
}

function resetRedisState(): void {
    temporalState.schedules.clear();
}

describe("parseTriggerFromNL", () => {
    beforeEach(() => {
        mockFetch.mockReset();
        process.env.API_URL = "https://api.compose.market";
        process.env.RUNTIME_INTERNAL_SECRET = "runtime-test-token";
    });

    afterEach(() => {
        delete process.env.API_URL;
        delete process.env.RUNTIME_INTERNAL_SECRET;
    });

    it("should parse 'every hour' pattern", async () => {
        const result = await parseTriggerFromNL("every hour");

        expect(result.success).toBe(true);
        expect(result.cronExpression).toBe("0 * * * *");
    });

    it("should parse 'every day at midnight' pattern", async () => {
        const result = await parseTriggerFromNL("every day at midnight");

        expect(result.success).toBe(true);
        expect(result.cronExpression).toBe("0 0 * * *");
    });

    it("should parse 'every 5 minutes' pattern", async () => {
        const result = await parseTriggerFromNL("every 5 minutes");

        expect(result.success).toBe(true);
        expect(result.cronExpression).toBe("*/5 * * * *");
    });

    it("should parse 'every monday' pattern", async () => {
        const result = await parseTriggerFromNL("every monday");

        expect(result.success).toBe(true);
        expect(result.cronExpression).toContain("1");
    });

    it("should use LLM for complex patterns", async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            cronExpression: "30 14 * * 1-5",
                            cronReadable: "Every weekday at 2:30 PM",
                        }),
                    },
                }],
            }),
        });

        const result = await parseTriggerFromNL("on business days at 2:30pm");

        expect(result.success).toBe(true);
        expect(result.cronExpression).toBe("30 14 * * 1-5");
    });

    it("should handle unparseable input", async () => {
        mockFetch.mockRejectedValueOnce(new Error("API error"));

        const result = await parseTriggerFromNL("gibberish xyz 123");

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
    });
});

describe("storeTrigger / retrieveTriggers", () => {
    beforeEach(() => {
        resetRedisState();
    });

    it("should store trigger in temporal schedule and retrieve it", async () => {
        const trigger = createTestTrigger({ id: "trig-123" });

        const result = await storeTrigger(trigger, "user-123");
        const triggers = await retrieveTriggers(trigger.workflowWallet);

        expect(result).toBe("trig-123");
        expect(triggers).toHaveLength(1);
        expect(triggers[0].id).toBe("trig-123");
        expect(triggers[0].workflowWallet).toBe(trigger.workflowWallet);
    });

    it("should handle storage failure", async () => {
        temporalMock.upsertTriggerSchedule.mockRejectedValueOnce(new Error("Storage error"));

        const trigger = createTestTrigger({ id: "trig-fail" });
        const result = await storeTrigger(trigger);

        expect(result).toBeNull();
    });

    it("should return empty array on retrieval error", async () => {
        temporalMock.listTriggerSchedules.mockRejectedValueOnce(new Error("Fetch error"));

        const triggers = await retrieveTriggers("0xABC123");

        expect(triggers).toEqual([]);
    });
});

describe("deleteTriggerFromMemory", () => {
    beforeEach(() => {
        resetRedisState();
    });

    it("should delete trigger schedule from temporal", async () => {
        const trigger = createTestTrigger({
            id: "trig-123",
            workflowWallet: "0xABC",
        });
        await storeTrigger(trigger);

        const result = await deleteTriggerFromMemory("trig-123", "0xABC");
        const remaining = await retrieveTriggers("0xABC");

        expect(result).toBe(true);
        expect(remaining).toEqual([]);
        expect(temporalMock.deleteTriggerSchedule).toHaveBeenCalledWith("0xABC", "trig-123");
    });
});

describe("Cron Scheduling", () => {
    afterEach(async () => {
        await unregisterAllTriggers();
    });

    it("should register a trigger", async () => {
        const trigger = createTestTrigger({
            id: `trig-${Date.now()}`,
            cronExpression: "* * * * *",
            cronReadable: "Every minute",
        });

        await expect(registerTrigger(trigger, vi.fn())).resolves.toBeUndefined();
        expect(temporalMock.upsertTriggerSchedule).toHaveBeenCalled();
    });

    it("should unregister a trigger", async () => {
        const triggerId = `trig-unregister-${Date.now()}`;
        const trigger = createTestTrigger({
            id: triggerId,
            workflowWallet: "0xwallet",
        });

        await registerTrigger(trigger, vi.fn());
        await expect(unregisterTrigger(triggerId, "0xwallet")).resolves.toBeUndefined();
        await expect(unregisterTrigger(triggerId, "0xwallet")).resolves.toBeUndefined();
    });

    it("should throw when unregistering without wallet context", async () => {
        await expect(unregisterTrigger("missing-wallet-trigger")).rejects.toThrow(
            "Missing workflow wallet for trigger missing-wallet-trigger",
        );
    });

    it("should track active trigger count", async () => {
        expect(getActiveTriggerCount()).toBe(0);

        const trigger = createTestTrigger({
            id: `trig-count-${Date.now()}`,
            workflowWallet: "0xwallet",
            cronExpression: "0 0 * * *",
            cronReadable: "Every day",
        });

        await registerTrigger(trigger, vi.fn());

        expect(getActiveTriggerCount()).toBe(1);
    });

    it("should unregister all triggers", async () => {
        await registerTrigger(
            createTestTrigger({ id: "t1", workflowWallet: "0xwallet1" }),
            vi.fn(),
        );
        await registerTrigger(
            createTestTrigger({ id: "t2", workflowWallet: "0xwallet2", cronExpression: "0 0 * * *" }),
            vi.fn(),
        );

        await unregisterAllTriggers();

        expect(getActiveTriggerCount()).toBe(0);
    });
});

describe("getNextRunTime", () => {
    it("should calculate next run time for cron expression", () => {
        const nextRun = getNextRunTime("0 * * * *");

        expect(nextRun).toBeGreaterThan(Date.now());
    });

    it("should return future timestamp", () => {
        const nextRun = getNextRunTime("0 0 * * *");

        expect(nextRun).toBeGreaterThan(Date.now());
    });
});
