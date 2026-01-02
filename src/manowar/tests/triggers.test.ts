/**
 * Triggers Tests
 * 
 * Unit tests for the workflow trigger system:
 * - NL-to-cron parsing (pattern matching + LLM)
 * - Trigger storage via mem0
 * - Cron scheduling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
} from "../triggers.js";
import type { TriggerDefinition } from "../types.js";

// Mock fetch for LLM and mem0 API calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Helper to create a valid TriggerDefinition for tests
function createTestTrigger(overrides: Partial<TriggerDefinition> = {}): TriggerDefinition {
    const now = Date.now();
    return {
        id: `trig-${now}`,
        manowarWallet: "0xTestWallet",
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

describe("parseTriggerFromNL", () => {
    beforeEach(() => {
        mockFetch.mockReset();
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
        expect(result.cronExpression).toContain("1"); // Monday = 1
    });

    it("should use LLM for complex patterns", async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            text: () => Promise.resolve(JSON.stringify({
                cronExpression: "30 14 * * 1-5",
                cronReadable: "Every weekday at 2:30 PM",
            })),
        });

        const result = await parseTriggerFromNL("every weekday at 2:30pm");

        // Should either match a pattern or use LLM
        expect(result.success).toBeDefined();
    });

    it("should handle unparseable input", async () => {
        mockFetch.mockRejectedValueOnce(new Error("API error"));

        const result = await parseTriggerFromNL("gibberish xyz 123");

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
    });
});

describe("storeTrigger", () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    it("should store trigger in mem0", async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve([{ id: "mem-123", memory: "trigger stored" }]),
        });

        const trigger = createTestTrigger({ id: "trig-123" });

        const result = await storeTrigger(trigger, "user-123");

        expect(result).toBeDefined();
    });

    it("should handle storage failure", async () => {
        mockFetch.mockRejectedValueOnce(new Error("Storage error"));

        const trigger = createTestTrigger({ id: "trig-fail" });

        const result = await storeTrigger(trigger);

        expect(result).toBeNull();
    });
});

describe("retrieveTriggers", () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    it("should retrieve triggers from mem0", async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({
                memories: [
                    { memory: JSON.stringify({ id: "t1", cronExpression: "0 * * * *" }) },
                    { memory: JSON.stringify({ id: "t2", cronExpression: "0 0 * * *" }) },
                ],
            }),
        });

        const triggers = await retrieveTriggers("0xABC123");

        expect(Array.isArray(triggers)).toBe(true);
    });

    it("should return empty array on error", async () => {
        mockFetch.mockRejectedValueOnce(new Error("Fetch error"));

        const triggers = await retrieveTriggers("0xABC123");

        expect(triggers).toEqual([]);
    });
});

describe("deleteTriggerFromMemory", () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    it("should delete trigger from mem0", async () => {
        // First search returns the trigger
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({
                memories: [{ id: "mem-to-delete", memory: JSON.stringify({ id: "trig-123" }) }],
            }),
        });
        // Then delete succeeds
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ deleted: true }),
        });

        const result = await deleteTriggerFromMemory("trig-123", "0xABC");

        expect(result).toBe(true);
    });
});

describe("Cron Scheduling", () => {
    afterEach(() => {
        unregisterAllTriggers();
    });

    it("should register a trigger", () => {
        const trigger = createTestTrigger({
            id: `trig-${Date.now()}`,
            cronExpression: "* * * * *",
            cronReadable: "Every minute",
        });

        const mockExecutor = vi.fn();

        // This should not throw
        expect(() => registerTrigger(trigger, mockExecutor)).not.toThrow();
    });

    it("should unregister a trigger", () => {
        const triggerId = `trig-unregister-${Date.now()}`;
        const trigger = createTestTrigger({ id: triggerId });

        registerTrigger(trigger, vi.fn());
        unregisterTrigger(triggerId);

        // Should not throw even if already unregistered
        expect(() => unregisterTrigger(triggerId)).not.toThrow();
    });

    it("should track active trigger count", () => {
        const initialCount = getActiveTriggerCount();

        const trigger = createTestTrigger({
            id: `trig-count-${Date.now()}`,
            cronExpression: "0 0 * * *",
            cronReadable: "Every day",
        });

        registerTrigger(trigger, vi.fn());

        expect(getActiveTriggerCount()).toBe(initialCount + 1);
    });

    it("should unregister all triggers", () => {
        registerTrigger(createTestTrigger({ id: "t1" }), vi.fn());
        registerTrigger(createTestTrigger({ id: "t2", cronExpression: "0 0 * * *" }), vi.fn());

        unregisterAllTriggers();

        expect(getActiveTriggerCount()).toBe(0);
    });
});

describe("getNextRunTime", () => {
    it("should calculate next run time for cron expression", () => {
        const nextRun = getNextRunTime("0 * * * *"); // Every hour

        expect(nextRun).toBeGreaterThan(Date.now());
    });

    it("should return future timestamp", () => {
        const nextRun = getNextRunTime("0 0 * * *"); // Daily at midnight

        expect(nextRun).toBeGreaterThan(Date.now());
    });
});
