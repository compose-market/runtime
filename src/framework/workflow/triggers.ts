/**
 * Trigger Management Service
 * 
 * Handles NL-to-cron parsing, trigger persistence via Temporal Schedules,
 * and schedule lifecycle for autonomous workflow execution.
 */

import {
    TriggerDefinition,
    TriggerType,
} from "./types.js";
import {
    deleteTriggerSchedule,
    getTriggerSchedule,
    listTriggerSchedules,
    upsertTriggerSchedule,
    type TriggerScheduleSnapshot,
} from "../../temporal/service.js";
import { getTemporalClient } from "../../temporal/client.js";
import { buildApiInternalHeaders, requireApiInternalUrl } from "../../auth.js";
let activeTriggerCount = 0;

// =============================================================================
// Trigger Helpers
// =============================================================================

function normalizeTrigger(trigger: TriggerDefinition): TriggerDefinition {
    const now = Date.now();
    return {
        ...trigger,
        workflowWallet: trigger.workflowWallet,
        timezone: trigger.timezone || "UTC",
        createdAt: trigger.createdAt || now,
        updatedAt: trigger.updatedAt || now,
    };
}

function parseTriggerFromSchedule(
    snapshot: TriggerScheduleSnapshot,
    wallet: string,
): TriggerDefinition {
    const prefix = `workflow-trigger-${wallet}-`;
    const fallbackId = snapshot.scheduleId.startsWith(prefix)
        ? snapshot.scheduleId.slice(prefix.length)
        : snapshot.scheduleId;
    const memoTrigger = snapshot.memo?.trigger;

    if (!memoTrigger || typeof memoTrigger !== "object") {
        return {
            id: fallbackId,
            workflowWallet: wallet,
            name: fallbackId || "Trigger",
            type: "cron",
            nlDescription: "",
            timezone: "UTC",
            enabled: !snapshot.paused,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
    }

    const fromMemo = memoTrigger as Partial<TriggerDefinition>;
    return {
        id: fromMemo.id || fallbackId,
        workflowWallet: fromMemo.workflowWallet || wallet,
        name: fromMemo.name || "Trigger",
        type: (fromMemo.type as TriggerType) || "cron",
        nlDescription: fromMemo.nlDescription || "",
        cronExpression: fromMemo.cronExpression,
        cronReadable: fromMemo.cronReadable,
        timezone: fromMemo.timezone || "UTC",
        enabled: typeof fromMemo.enabled === "boolean" ? fromMemo.enabled : !snapshot.paused,
        recurrence: fromMemo.recurrence,
        webhookUrl: fromMemo.webhookUrl,
        eventPattern: fromMemo.eventPattern,
        inputTemplate: fromMemo.inputTemplate,
        lastRun: fromMemo.lastRun,
        nextRun: fromMemo.nextRun,
        createdAt: typeof fromMemo.createdAt === "number" ? fromMemo.createdAt : Date.now(),
        updatedAt: typeof fromMemo.updatedAt === "number" ? fromMemo.updatedAt : Date.now(),
        memoryId: fromMemo.memoryId,
    };
}

async function resolveWalletForTriggerId(triggerId: string): Promise<string | null> {
    const client = await getTemporalClient();
    const suffix = `-${triggerId}`;
    for await (const schedule of client.schedule.list()) {
        const scheduleId = schedule.scheduleId;
        if (!scheduleId.startsWith("workflow-trigger-") || !scheduleId.endsWith(suffix)) {
            continue;
        }
        const withoutPrefix = scheduleId.slice("workflow-trigger-".length);
        const wallet = withoutPrefix.slice(0, withoutPrefix.length - suffix.length);
        if (wallet) {
            return wallet;
        }
    }
    return null;
}

async function refreshActiveTriggerCount(): Promise<void> {
    const client = await getTemporalClient();
    let count = 0;
    for await (const schedule of client.schedule.list()) {
        if (schedule.scheduleId.startsWith("workflow-trigger-") && !schedule.state.paused) {
            count += 1;
        }
    }
    activeTriggerCount = count;
}

// =============================================================================
// NL to Cron Parser
// =============================================================================

/**
 * Common NL patterns with their cron expressions
 * Used as fallback before LLM parsing for common patterns
 */
const NL_PATTERNS: Array<{
    pattern: RegExp;
    cronExpression: string;
    cronReadable: string;
}> = [
        { pattern: /every\s*minute/i, cronExpression: "* * * * *", cronReadable: "Every minute" },
        { pattern: /every\s*5\s*minutes?/i, cronExpression: "*/5 * * * *", cronReadable: "Every 5 minutes" },
        { pattern: /every\s*10\s*minutes?/i, cronExpression: "*/10 * * * *", cronReadable: "Every 10 minutes" },
        { pattern: /every\s*15\s*minutes?/i, cronExpression: "*/15 * * * *", cronReadable: "Every 15 minutes" },
        { pattern: /every\s*30\s*minutes?/i, cronExpression: "*/30 * * * *", cronReadable: "Every 30 minutes" },
        { pattern: /every\s*hour/i, cronExpression: "0 * * * *", cronReadable: "Every hour, on the hour" },
        { pattern: /every\s*2\s*hours?/i, cronExpression: "0 */2 * * *", cronReadable: "Every 2 hours" },
        { pattern: /every\s*4\s*hours?/i, cronExpression: "0 */4 * * *", cronReadable: "Every 4 hours" },
        { pattern: /every\s*6\s*hours?/i, cronExpression: "0 */6 * * *", cronReadable: "Every 6 hours" },
        { pattern: /every\s*12\s*hours?/i, cronExpression: "0 */12 * * *", cronReadable: "Every 12 hours" },
        { pattern: /every\s*day\s*at\s*midnight/i, cronExpression: "0 0 * * *", cronReadable: "Every day at midnight" },
        { pattern: /every\s*day\s*at\s*noon/i, cronExpression: "0 12 * * *", cronReadable: "Every day at noon" },
        { pattern: /daily\s*at\s*9\s*(am)?/i, cronExpression: "0 9 * * *", cronReadable: "Every day at 9:00 AM" },
        { pattern: /daily\s*at\s*(\d{1,2})\s*(am|pm)?/i, cronExpression: "", cronReadable: "" }, // Handled specially
        { pattern: /every\s*monday/i, cronExpression: "0 9 * * 1", cronReadable: "Every Monday at 9:00 AM" },
        { pattern: /every\s*tuesday/i, cronExpression: "0 9 * * 2", cronReadable: "Every Tuesday at 9:00 AM" },
        { pattern: /every\s*wednesday/i, cronExpression: "0 9 * * 3", cronReadable: "Every Wednesday at 9:00 AM" },
        { pattern: /every\s*thursday/i, cronExpression: "0 9 * * 4", cronReadable: "Every Thursday at 9:00 AM" },
        { pattern: /every\s*friday/i, cronExpression: "0 9 * * 5", cronReadable: "Every Friday at 9:00 AM" },
        { pattern: /every\s*saturday/i, cronExpression: "0 9 * * 6", cronReadable: "Every Saturday at 9:00 AM" },
        { pattern: /every\s*sunday/i, cronExpression: "0 9 * * 0", cronReadable: "Every Sunday at 9:00 AM" },
        { pattern: /every\s*weekday/i, cronExpression: "0 9 * * 1-5", cronReadable: "Every weekday (Mon-Fri) at 9:00 AM" },
        { pattern: /every\s*weekend/i, cronExpression: "0 9 * * 0,6", cronReadable: "Every weekend at 9:00 AM" },
        { pattern: /monthly|every\s*month/i, cronExpression: "0 9 1 * *", cronReadable: "On the 1st of every month at 9:00 AM" },
        { pattern: /weekly|every\s*week/i, cronExpression: "0 9 * * 1", cronReadable: "Every week on Monday at 9:00 AM" },
    ];

/**
 * Parse NL with pattern matching (fast path)
 */
function parseWithPatterns(nlDescription: string): { cronExpression: string; cronReadable: string } | null {
    const input = nlDescription.toLowerCase().trim();

    for (const { pattern, cronExpression, cronReadable } of NL_PATTERNS) {
        if (pattern.test(input) && cronExpression) {
            return { cronExpression, cronReadable };
        }
    }

    // Special handling for "daily at X" pattern
    const dailyMatch = input.match(/daily\s*at\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (dailyMatch) {
        let hour = parseInt(dailyMatch[1], 10);
        const minute = dailyMatch[2] ? parseInt(dailyMatch[2], 10) : 0;
        const ampm = dailyMatch[3]?.toLowerCase();

        if (ampm === "pm" && hour < 12) hour += 12;
        if (ampm === "am" && hour === 12) hour = 0;

        return {
            cronExpression: `${minute} ${hour} * * *`,
            cronReadable: `Every day at ${hour}:${minute.toString().padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`,
        };
    }

    return null;
}

/**
 * Parse NL to cron using LLM (for complex patterns)
 */
async function parseWithLLM(
    nlDescription: string,
    model = "asi1-mini"
): Promise<{ cronExpression: string; cronReadable: string } | null> {
    const prompt = `Convert this natural language schedule to a cron expression.

Input: "${nlDescription}"

Respond ONLY with a JSON object (no markdown):
{"cronExpression": "* * * * *", "cronReadable": "Human readable description"}

Cron format: minute hour day-of-month month day-of-week
Examples:
- "every minute" → {"cronExpression": "* * * * *", "cronReadable": "Every minute"}
- "every day at 9:30 AM" → {"cronExpression": "30 9 * * *", "cronReadable": "Every day at 9:30 AM"}
- "every Monday at 3 PM" → {"cronExpression": "0 15 * * 1", "cronReadable": "Every Monday at 3:00 PM"}`;

    try {
        const response = await fetch(`${requireApiInternalUrl()}/api/inference`, {
            method: "POST",
            headers: buildApiInternalHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({
                model,
                messages: [
                    { role: "system", content: "You are a precise cron expression converter. Respond only with valid JSON." },
                    { role: "user", content: prompt },
                ],
                temperature: 0,
            }),
        });

        if (!response.ok) {
            console.error("[triggers] LLM parse failed:", response.status);
            return null;
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || data.content || "";

        // Parse JSON from response
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;

        const parsed = JSON.parse(jsonMatch[0]);
        return {
            cronExpression: parsed.cronExpression,
            cronReadable: parsed.cronReadable,
        };
    } catch (error) {
        console.error("[triggers] LLM parse error:", error);
        return null;
    }
}

/**
 * Main NL to cron parser - tries patterns first, then LLM
 */
export async function parseTriggerFromNL(
    nlDescription: string,
    options?: { model?: string }
): Promise<{ success: boolean; cronExpression?: string; cronReadable?: string; error?: string }> {
    if (!nlDescription?.trim()) {
        return { success: false, error: "Empty description" };
    }

    // Try fast pattern matching first
    const patternResult = parseWithPatterns(nlDescription);
    if (patternResult) {
        return { success: true, ...patternResult };
    }

    // Fall back to LLM for complex patterns
    const llmResult = await parseWithLLM(nlDescription, options?.model);
    if (llmResult) {
        return { success: true, ...llmResult };
    }

    return { success: false, error: "Could not parse schedule" };
}

// =============================================================================
// Trigger Store (Temporal Schedule Backing)
// =============================================================================

/**
 * Store or update a trigger definition in Temporal Schedule metadata.
 */
export async function storeTrigger(
    trigger: TriggerDefinition,
    _userId?: string
): Promise<string | null> {
    try {
        const normalized = normalizeTrigger(trigger);
        if (!normalized.cronExpression) {
            console.warn(`[triggers] Skipping trigger ${normalized.id}: cronExpression is required for Temporal schedules`);
            return null;
        }

        await upsertTriggerSchedule(normalized);
        await refreshActiveTriggerCount();
        console.log(`[triggers] Stored trigger ${normalized.id} for ${normalized.workflowWallet} in Temporal schedule`);
        return normalized.id;
    } catch (error) {
        console.error("[triggers] Temporal store error:", error);
        return null;
    }
}

/**
 * Retrieve all triggers for a Workflow from Temporal schedules.
 */
export async function retrieveTriggers(
    workflowWallet: string,
    _userId?: string
): Promise<TriggerDefinition[]> {
    try {
        const wallet = workflowWallet;
        const schedules = await listTriggerSchedules(wallet);
        const triggers = schedules.map((snapshot) => parseTriggerFromSchedule(snapshot, wallet));

        triggers.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        await refreshActiveTriggerCount();
        console.log(`[triggers] Retrieved ${triggers.length} triggers for ${wallet} from Temporal schedules`);
        return triggers;
    } catch (error) {
        console.error("[triggers] Temporal retrieval error:", error);
        return [];
    }
}

/**
 * Delete a trigger schedule from Temporal.
 */
export async function deleteTriggerFromMemory(
    triggerId: string,
    workflowWallet: string,
    _userId?: string
): Promise<boolean> {
    try {
        const wallet = workflowWallet;
        await deleteTriggerSchedule(wallet, triggerId);
        await refreshActiveTriggerCount();
        console.log(`[triggers] Deleted trigger ${triggerId} for ${wallet} from Temporal schedules`);
        return true;
    } catch (error) {
        console.error("[triggers] Temporal delete error:", error);
        return false;
    }
}

/**
 * Update a trigger's enabled status via Temporal schedule state.
 */
export async function updateTriggerEnabled(
    triggerId: string,
    workflowWallet: string,
    enabled: boolean
): Promise<boolean> {
    try {
        const existing = await getTriggerById(triggerId, workflowWallet);
        if (!existing || !existing.cronExpression) {
            return false;
        }

        const updated = normalizeTrigger({
            ...existing,
            enabled,
            updatedAt: Date.now(),
        });
        await upsertTriggerSchedule(updated);
        await refreshActiveTriggerCount();
        console.log(`[triggers] Updated trigger ${triggerId} enabled=${enabled} in Temporal`);
        return true;
    } catch (error) {
        console.error("[triggers] Temporal update error:", error);
        return false;
    }
}

/**
 * Get a single trigger by ID from Temporal schedule metadata.
 */
export async function getTriggerById(
    triggerId: string,
    workflowWallet: string
): Promise<TriggerDefinition | null> {
    try {
        const wallet = workflowWallet;
        const schedule = await getTriggerSchedule(wallet, triggerId);
        if (!schedule) {
            return null;
        }
        return parseTriggerFromSchedule(schedule, wallet);
    } catch (error) {
        console.error("[triggers] Temporal get error:", error);
        return null;
    }
}

// =============================================================================
// Cron Scheduler (Temporal Schedules)
// =============================================================================

/**
 * Calculate next run time from cron expression
 */
export function getNextRunTime(cronExpression: string, timezone?: string): number {
    // Simple implementation - for production, use a proper cron parser like cron-parser
    // This is a placeholder that returns approximate next run
    const now = Date.now();

    // Parse basic intervals
    if (cronExpression === "* * * * *") return now + 60000; // 1 min
    if (cronExpression.startsWith("*/5")) return now + 5 * 60000; // 5 min
    if (cronExpression.startsWith("*/10")) return now + 10 * 60000; // 10 min
    if (cronExpression.startsWith("*/15")) return now + 15 * 60000; // 15 min
    if (cronExpression.startsWith("*/30")) return now + 30 * 60000; // 30 min
    if (cronExpression.startsWith("0 *")) return now + 60 * 60000; // 1 hour
    if (cronExpression.startsWith("0 */")) return now + 2 * 60 * 60000; // 2+ hours

    // Default to 24 hours for daily schedules
    return now + 24 * 60 * 60000;
}

/**
 * Register a trigger to run on schedule
 */
export async function registerTrigger(
    trigger: TriggerDefinition,
    _executor: (trigger: TriggerDefinition) => Promise<void>
): Promise<void> {
    const normalized = normalizeTrigger(trigger);
    if (!normalized.enabled || !normalized.cronExpression) {
        return;
    }

    await unregisterTrigger(normalized.id, normalized.workflowWallet).catch(() => undefined);
    await upsertTriggerSchedule(normalized);
    await refreshActiveTriggerCount();
    console.log(`[triggers] Temporal schedule upserted for trigger ${normalized.id}`);
}

/**
 * Unregister a trigger
 */
export async function unregisterTrigger(triggerId: string, workflowWallet?: string): Promise<void> {
    const wallet = workflowWallet || await resolveWalletForTriggerId(triggerId) || "";
    if (!wallet) {
        throw new Error(`Missing workflow wallet for trigger ${triggerId}`);
    }
    await deleteTriggerSchedule(wallet, triggerId);
    await refreshActiveTriggerCount();
    console.log(`[triggers] Unregistered trigger ${triggerId}`);
}

/**
 * Unregister all triggers
 */
export async function unregisterAllTriggers(): Promise<void> {
    const client = await getTemporalClient();
    for await (const schedule of client.schedule.list()) {
        if (!schedule.scheduleId.startsWith("workflow-trigger-")) {
            continue;
        }
        const memo = schedule.memo as Record<string, unknown> | undefined;
        const walletFromMemo = typeof memo?.workflowWallet === "string" ? memo.workflowWallet : null;
        const triggerIdFromMemo = typeof memo?.triggerId === "string" ? memo.triggerId : null;
        const identifier = schedule.scheduleId.slice("workflow-trigger-".length);
        const separator = identifier.indexOf("-");
        const walletFromId = separator > 0 ? identifier.slice(0, separator) : null;
        const triggerIdFromId = separator > 0 ? identifier.slice(separator + 1) : null;
        const wallet = walletFromMemo || walletFromId;
        const triggerId = triggerIdFromMemo || triggerIdFromId;
        if (!wallet || !triggerId) {
            continue;
        }
        try {
            await deleteTriggerSchedule(wallet, triggerId);
        } catch (error) {
            console.warn(`[triggers] Failed to delete schedule ${triggerId}:`, error);
        }
    }
    await refreshActiveTriggerCount();
    console.log("[triggers] Unregistered all triggers");
}

/**
 * Get active trigger count
 */
export function getActiveTriggerCount(): number {
    return activeTriggerCount;
}

/**
 * Initialize triggers from Redis on server startup
 * 
 * Call this when the server starts to reload all persisted triggers
 * and rebuild active trigger indexes in memory.
 * 
 * @param workflowWallets - List of workflow wallet addresses to load triggers for
 * @param executor - Unused; kept for API compatibility.
 * @returns Number of triggers registered
 */
export async function initTriggersFromRedis(
    workflowWallets: string[],
    _executor: (trigger: TriggerDefinition) => Promise<void>
): Promise<number> {
    let totalRegistered = 0;

    console.log(`[triggers] Initializing triggers from Temporal schedules for ${workflowWallets.length} workflows...`);

    for (const wallet of workflowWallets) {
        try {
            const triggers = await retrieveTriggers(wallet);

            for (const trigger of triggers) {
                if (trigger.enabled && trigger.cronExpression) {
                    totalRegistered++;
                }
            }

            if (triggers.length > 0) {
                console.log(`[triggers] Loaded ${triggers.length} triggers for ${wallet}, ${triggers.filter(t => t.enabled).length} enabled`);
            }
        } catch (error) {
            console.error(`[triggers] Failed to load triggers for ${wallet}:`, error);
        }
    }

    await refreshActiveTriggerCount();
    console.log(`[triggers] Initialization complete: ${totalRegistered} triggers registered`);
    return totalRegistered;
}

/**
 * Initialize triggers for a single workflow
 * 
 * Convenience function for loading triggers when a workflow is accessed.
 */
export async function initTriggersForWorkflow(
    workflowWallet: string,
    executor: (trigger: TriggerDefinition) => Promise<void>
): Promise<number> {
    return initTriggersFromRedis([workflowWallet], executor);
}
