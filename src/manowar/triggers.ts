/**
 * Trigger Management Service
 * 
 * Handles NL-to-cron parsing, trigger storage via mem0 graph memory,
 * and cron scheduling for autonomous workflow execution.
 */

import {
    TriggerDefinition,
    TriggerType,
} from "./types.js";

const LAMBDA_API_URL = process.env.LAMBDA_API_URL || "https://api.compose.market";

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
// Trigger Store (mem0 graph memory)
// =============================================================================

/**
 * Store a trigger definition in mem0
 */
export async function storeTrigger(
    trigger: TriggerDefinition,
    userId?: string
): Promise<string | null> {
    try {
        const response = await fetch(`${LAMBDA_API_URL}/api/memory/add`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                messages: [
                    {
                        role: "system",
                        content: `Trigger definition for Manowar ${trigger.manowarId}`,
                    },
                    {
                        role: "assistant",
                        content: `Trigger "${trigger.name}" (${trigger.type}): ${trigger.nlDescription}. Cron: ${trigger.cronExpression || "N/A"}. Enabled: ${trigger.enabled}.`,
                    },
                ],
                agent_id: `manowar-${trigger.manowarId}`,
                user_id: userId,
                metadata: {
                    type: "trigger",
                    trigger_id: trigger.id,
                    trigger_type: trigger.type,
                    manowar_id: trigger.manowarId,
                    cron_expression: trigger.cronExpression,
                    enabled: trigger.enabled,
                    timezone: trigger.timezone,
                    created_at: trigger.createdAt,
                    // Store full trigger as JSON for retrieval
                    trigger_data: JSON.stringify(trigger),
                },
            }),
        });

        if (!response.ok) {
            console.error("[triggers] Failed to store in mem0:", response.status);
            return null;
        }

        const data = await response.json();
        return data.memory_id || data.id || trigger.id;
    } catch (error) {
        console.error("[triggers] mem0 storage error:", error);
        return null;
    }
}

/**
 * Retrieve triggers for a Manowar from mem0
 */
export async function retrieveTriggers(
    manowarId: number | string,
    userId?: string
): Promise<TriggerDefinition[]> {
    try {
        const response = await fetch(`${LAMBDA_API_URL}/api/memory/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                query: `triggers for manowar ${manowarId}`,
                agent_id: `manowar-${manowarId}`,
                user_id: userId,
                limit: 50,
                filters: {
                    type: "trigger",
                    manowar_id: String(manowarId),
                },
            }),
        });

        if (!response.ok) {
            return [];
        }

        const data = await response.json();
        const memories = data.memories || data.results || [];

        const triggers: TriggerDefinition[] = [];
        for (const memory of memories) {
            try {
                // Extract trigger from metadata
                if (memory.metadata?.trigger_data) {
                    triggers.push(JSON.parse(memory.metadata.trigger_data));
                }
            } catch {
                // Skip malformed triggers
            }
        }

        return triggers;
    } catch (error) {
        console.error("[triggers] Failed to retrieve:", error);
        return [];
    }
}

/**
 * Delete a trigger from mem0
 */
export async function deleteTriggerFromMemory(
    triggerId: string,
    manowarId: number | string,
    userId?: string
): Promise<boolean> {
    try {
        // Search for the specific trigger
        const response = await fetch(`${LAMBDA_API_URL}/api/memory/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                query: `trigger ${triggerId}`,
                agent_id: `manowar-${manowarId}`,
                user_id: userId,
                limit: 1,
                filters: {
                    type: "trigger",
                    trigger_id: triggerId,
                },
            }),
        });

        if (!response.ok) return false;

        const data = await response.json();
        const memories = data.memories || data.results || [];

        if (memories.length === 0) return true; // Already deleted

        const memoryId = memories[0].id;

        // Delete the memory
        const deleteResponse = await fetch(`${LAMBDA_API_URL}/api/memory/${memoryId}`, {
            method: "DELETE",
        });

        return deleteResponse.ok;
    } catch (error) {
        console.error("[triggers] Delete error:", error);
        return false;
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
