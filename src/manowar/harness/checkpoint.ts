/**
 * Cal-plan step-by-step checkpoint store.
 *
 * The cal interpreter (`harness/interpreter.ts`) executes a typed plan
 * step by step. Without checkpoints, a network blip or pod rotation
 * mid-plan kills a 30-step run with no recovery — the model has to
 * re-emit the entire plan and re-run every step.
 *
 * This module persists the partial `CalRunResult` to Redis after each
 * step. On resume, the interpreter reads the snapshot, restores the
 * `saved` map, and replays from the first uncompleted step. Same
 * `composeRunId` ⇒ same checkpoint key.
 *
 * Storage discipline:
 *   - One key per run: `cal:run:<agentWallet>:<composeRunId>`.
 *   - Value: JSON-encoded `CalCheckpoint` (typed below).
 *   - TTL: 24h (matches our `/v1/responses` retention so a paused
 *     plan can be resumed within the same response window).
 *
 * Backed by `runtime/src/manowar/memory/cache.ts`'s shared memory-Redis
 * client (REDIS_MEMORY_*), the same instance the 6-layer memory
 * framework uses for hot caches. Keeps Redis ops on the hot Redis,
 * away from session/keys Redis.
 */
import { getRedisClient } from "../memory/cache.js";
import type { CalRunResult, CalStepResult } from "./types.js";

const CHECKPOINT_TTL_SECONDS = 24 * 60 * 60; // 24h
const CHECKPOINT_KEY_PREFIX = "cal:run";

/**
 * Wire-format snapshot of an in-progress cal plan. Persisted after every
 * step. `completedStepIndex` is the highest step index whose result has
 * been written into `steps[]`; the resumer replays from
 * `completedStepIndex + 1`.
 */
export interface CalCheckpoint {
    /** Plan id (echoes `CalPlan.id` so the resumer can sanity-check). */
    planId: string;
    /** `composeRunId` that owns the run (also part of the Redis key). */
    composeRunId: string;
    /** Highest 0-based step index whose result is in `steps`. */
    completedStepIndex: number;
    /** Per-step results so far. */
    steps: CalStepResult[];
    /** Saved-values map ({{stepId.path}} resolution). */
    saved: Record<string, unknown>;
    /** Aggregate usage so far. */
    aggregateUsage: CalRunResult["aggregateUsage"];
    /** Wall clock the snapshot was written. */
    updatedAt: number;
}

function checkpointKey(agentWallet: string, composeRunId: string): string {
    return `${CHECKPOINT_KEY_PREFIX}:${agentWallet}:${composeRunId}`;
}

export interface CalCheckpointStore {
    /** Persist the latest snapshot. Idempotent on re-write. */
    save(checkpoint: CalCheckpoint): Promise<void>;
    /** Read the latest snapshot, or null when no run exists. */
    load(): Promise<CalCheckpoint | null>;
    /** Drop the checkpoint at run completion / abort. */
    clear(): Promise<void>;
}

/**
 * Build a checkpoint store scoped to one (agentWallet, composeRunId).
 * The interpreter calls `save` after each step, `load` at the top of
 * every run to detect a resume, and `clear` once the plan terminates
 * with `success` (or the caller decides to abandon).
 */
export function createCalCheckpointStore(input: {
    agentWallet: string;
    composeRunId: string;
    ttlSeconds?: number;
}): CalCheckpointStore {
    const ttl = input.ttlSeconds ?? CHECKPOINT_TTL_SECONDS;
    const key = checkpointKey(input.agentWallet, input.composeRunId);

    return {
        async save(checkpoint: CalCheckpoint): Promise<void> {
            const redis = await getRedisClient();
            await redis.setEx(key, ttl, JSON.stringify(checkpoint));
        },
        async load(): Promise<CalCheckpoint | null> {
            const redis = await getRedisClient();
            const raw = await redis.get(key);
            if (!raw) return null;
            try {
                const parsed = JSON.parse(raw) as CalCheckpoint;
                if (
                    typeof parsed?.planId === "string" &&
                    typeof parsed?.composeRunId === "string" &&
                    typeof parsed?.completedStepIndex === "number" &&
                    Array.isArray(parsed?.steps) &&
                    parsed?.saved &&
                    typeof parsed?.saved === "object" &&
                    parsed?.aggregateUsage
                ) {
                    return parsed;
                }
                return null;
            } catch {
                return null;
            }
        },
        async clear(): Promise<void> {
            const redis = await getRedisClient();
            await redis.del(key);
        },
    };
}
