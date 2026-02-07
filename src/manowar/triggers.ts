/**
 * Trigger Management Service
 * 
 * Handles NL-to-cron parsing, trigger storage via Redis,
 * and cron scheduling for autonomous workflow execution.
 * 
 * Redis Key Patterns (isolated from session/key storage):
 * - manowar:trigger:{wallet}:{triggerId} - Individual trigger hash
 * - manowar:triggers:{wallet} - Set of trigger IDs for a manowar
 */

import {
    TriggerDefinition,
    TriggerType,
} from "./types.js";
import {
    redisHGetAll,
    redisHSet,
    redisSAdd,
    redisSMembers,
    redisSRem,
    redisDel,
} from "../../../lambda/shared/config/redis.js";

const LAMBDA_API_URL = process.env.LAMBDA_API_URL || "https://api.compose.market";

// =============================================================================
// Redis Key Patterns (isolated namespace - doesn't conflict with session/keys)
// =============================================================================

const TRIGGER_PREFIX = "manowar:trigger:";
const TRIGGER_SET_PREFIX = "manowar:triggers:";

function getTriggerKey(wallet: string, triggerId: string): string {
    return `${TRIGGER_PREFIX}${wallet.toLowerCase()}:${triggerId}`;
}

function getTriggerSetKey(wallet: string): string {
    return `${TRIGGER_SET_PREFIX}${wallet.toLowerCase()}`;
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
        const response = await fetch(`${LAMBDA_API_URL}/api/inference`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
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
// Trigger Store (Redis - isolated from session/key storage)
// =============================================================================

/**
 * Store a trigger definition in Redis
 * 
 * Keys created:
 * - manowar:trigger:{wallet}:{id} (hash with all trigger fields)
 * - manowar:triggers:{wallet} (set containing trigger IDs)
 */
export async function storeTrigger(
    trigger: TriggerDefinition,
    _userId?: string
): Promise<string | null> {
    try {
        const wallet = trigger.manowarWallet.toLowerCase();
        const key = getTriggerKey(wallet, trigger.id);

        // Store trigger as hash fields
        await redisHSet(key, {
            id: trigger.id,
            name: trigger.name,
            type: trigger.type,
            manowarWallet: wallet,
            nlDescription: trigger.nlDescription || "",
            cronExpression: trigger.cronExpression || "",
            cronReadable: trigger.cronReadable || "",
            enabled: String(trigger.enabled),
            timezone: trigger.timezone || "UTC",
            inputTemplate: JSON.stringify(trigger.inputTemplate || {}),
            createdAt: String(trigger.createdAt || Date.now()),
            updatedAt: String(trigger.updatedAt || Date.now()),
        });

        // Add to the manowar's trigger set for fast listing
        await redisSAdd(getTriggerSetKey(wallet), trigger.id);

        console.log(`[triggers] Stored trigger ${trigger.id} for ${wallet} in Redis`);
        return trigger.id;
    } catch (error) {
        console.error("[triggers] Redis storage error:", error);
        return null;
    }
}

/**
 * Retrieve all triggers for a Manowar from Redis
 * Deterministic retrieval - no vector search needed
 */
export async function retrieveTriggers(
    manowarWallet: string,
    _userId?: string
): Promise<TriggerDefinition[]> {
    try {
        const wallet = manowarWallet.toLowerCase();
        const triggerIds = await redisSMembers(getTriggerSetKey(wallet));

        if (!triggerIds || triggerIds.length === 0) {
            return [];
        }

        const triggers: TriggerDefinition[] = [];
        for (const triggerId of triggerIds) {
            const data = await redisHGetAll(getTriggerKey(wallet, triggerId));
            if (data && Object.keys(data).length > 0) {
                triggers.push({
                    id: data.id || triggerId,
                    name: data.name || "Unnamed Trigger",
                    type: data.type as TriggerType,
                    manowarWallet: data.manowarWallet || wallet,
                    nlDescription: data.nlDescription || "",
                    cronExpression: data.cronExpression || undefined,
                    cronReadable: data.cronReadable || undefined,
                    enabled: data.enabled === "true",
                    timezone: data.timezone || "UTC",
                    inputTemplate: data.inputTemplate ? JSON.parse(data.inputTemplate) : undefined,
                    createdAt: parseInt(data.createdAt, 10) || Date.now(),
                    updatedAt: parseInt(data.updatedAt, 10) || Date.now(),
                });
            }
        }

        // Sort by creation date, newest first
        triggers.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        console.log(`[triggers] Retrieved ${triggers.length} triggers for ${wallet} from Redis`);
        return triggers;
    } catch (error) {
        console.error("[triggers] Redis retrieval error:", error);
        return [];
    }
}

/**
 * Delete a trigger from Redis
 */
export async function deleteTriggerFromMemory(
    triggerId: string,
    manowarWallet: string,
    _userId?: string
): Promise<boolean> {
    try {
        const wallet = manowarWallet.toLowerCase();

        // Remove from the trigger set
        await redisSRem(getTriggerSetKey(wallet), triggerId);

        // Delete the trigger hash
        const deleted = await redisDel(getTriggerKey(wallet, triggerId));

        // Also unregister from scheduler if active
        unregisterTrigger(triggerId);

        console.log(`[triggers] Deleted trigger ${triggerId} for ${wallet} from Redis`);
        return deleted;
    } catch (error) {
        console.error("[triggers] Redis delete error:", error);
        return false;
    }
}

/**
 * Update a trigger's enabled status in Redis
 */
export async function updateTriggerEnabled(
    triggerId: string,
    manowarWallet: string,
    enabled: boolean
): Promise<boolean> {
    try {
        const wallet = manowarWallet.toLowerCase();
        const key = getTriggerKey(wallet, triggerId);

        await redisHSet(key, "enabled", String(enabled));
        await redisHSet(key, "updatedAt", String(Date.now()));

        console.log(`[triggers] Updated trigger ${triggerId} enabled=${enabled}`);
        return true;
    } catch (error) {
        console.error("[triggers] Redis update error:", error);
        return false;
    }
}

/**
 * Get a single trigger by ID from Redis
 */
export async function getTriggerById(
    triggerId: string,
    manowarWallet: string
): Promise<TriggerDefinition | null> {
    try {
        const wallet = manowarWallet.toLowerCase();
        const data = await redisHGetAll(getTriggerKey(wallet, triggerId));

        if (!data || Object.keys(data).length === 0) {
            return null;
        }

        return {
            id: data.id || triggerId,
            name: data.name || "Unnamed Trigger",
            type: data.type as TriggerType,
            manowarWallet: data.manowarWallet || wallet,
            nlDescription: data.nlDescription || "",
            cronExpression: data.cronExpression || undefined,
            cronReadable: data.cronReadable || undefined,
            enabled: data.enabled === "true",
            timezone: data.timezone || "UTC",
            inputTemplate: data.inputTemplate ? JSON.parse(data.inputTemplate) : undefined,
            createdAt: parseInt(data.createdAt, 10) || Date.now(),
            updatedAt: parseInt(data.updatedAt, 10) || Date.now(),
        };
    } catch (error) {
        console.error("[triggers] Redis get error:", error);
        return null;
    }
}

// =============================================================================
// Cron Scheduler (in-memory for now)
// =============================================================================

// Store active cron jobs
const activeJobs = new Map<string, NodeJS.Timeout>();

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
export function registerTrigger(
    trigger: TriggerDefinition,
    executor: (trigger: TriggerDefinition) => Promise<void>
): void {
    if (!trigger.enabled || !trigger.cronExpression) return;

    // Cancel existing job if any
    unregisterTrigger(trigger.id);

    // Calculate interval from cron (simplified)
    let intervalMs: number;
    const cron = trigger.cronExpression;

    if (cron === "* * * * *") intervalMs = 60000;
    else if (cron.startsWith("*/5")) intervalMs = 5 * 60000;
    else if (cron.startsWith("*/10")) intervalMs = 10 * 60000;
    else if (cron.startsWith("*/15")) intervalMs = 15 * 60000;
    else if (cron.startsWith("*/30")) intervalMs = 30 * 60000;
    else if (cron.startsWith("0 *")) intervalMs = 60 * 60000;
    else if (cron.startsWith("0 */2")) intervalMs = 2 * 60 * 60000;
    else if (cron.startsWith("0 */4")) intervalMs = 4 * 60 * 60000;
    else if (cron.startsWith("0 */6")) intervalMs = 6 * 60 * 60000;
    else if (cron.startsWith("0 */12")) intervalMs = 12 * 60 * 60000;
    else intervalMs = 24 * 60 * 60000; // Default to daily

    console.log(`[triggers] Registering trigger ${trigger.id} with interval ${intervalMs}ms`);

    const job = setInterval(async () => {
        console.log(`[triggers] Executing trigger ${trigger.id}`);
        try {
            await executor(trigger);
        } catch (error) {
            console.error(`[triggers] Trigger ${trigger.id} failed:`, error);
        }
    }, intervalMs);

    activeJobs.set(trigger.id, job);
}

/**
 * Unregister a trigger
 */
export function unregisterTrigger(triggerId: string): void {
    const job = activeJobs.get(triggerId);
    if (job) {
        clearInterval(job);
        activeJobs.delete(triggerId);
        console.log(`[triggers] Unregistered trigger ${triggerId}`);
    }
}

/**
 * Unregister all triggers
 */
export function unregisterAllTriggers(): void {
    for (const [id, job] of activeJobs) {
        clearInterval(job);
    }
    activeJobs.clear();
    console.log("[triggers] Unregistered all triggers");
}

/**
 * Get active trigger count
 */
export function getActiveTriggerCount(): number {
    return activeJobs.size;
}

/**
 * Initialize triggers from Redis on server startup
 * 
 * Call this when the server starts to reload all persisted triggers
 * and re-register them with the in-memory scheduler.
 * 
 * @param manowarWallets - List of manowar wallet addresses to load triggers for
 * @param executor - Function to execute when a trigger fires
 * @returns Number of triggers registered
 */
export async function initTriggersFromRedis(
    manowarWallets: string[],
    executor: (trigger: TriggerDefinition) => Promise<void>
): Promise<number> {
    let totalRegistered = 0;

    console.log(`[triggers] Initializing triggers from Redis for ${manowarWallets.length} manowars...`);

    for (const wallet of manowarWallets) {
        try {
            const triggers = await retrieveTriggers(wallet);

            for (const trigger of triggers) {
                if (trigger.enabled && trigger.cronExpression) {
                    registerTrigger(trigger, executor);
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

    console.log(`[triggers] Initialization complete: ${totalRegistered} triggers registered`);
    return totalRegistered;
}

/**
 * Initialize triggers for a single manowar
 * 
 * Convenience function for loading triggers when a manowar is accessed.
 */
export async function initTriggersForManowar(
    manowarWallet: string,
    executor: (trigger: TriggerDefinition) => Promise<void>
): Promise<number> {
    return initTriggersFromRedis([manowarWallet], executor);
}
