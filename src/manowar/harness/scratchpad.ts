/**
 * Per-run scratchpad backed by Redis.
 *
 * Used by the cal interpreter to share state across steps (Manus-style
 * `todo.md` analog) without polluting the parent agent's prompt context.
 *
 * Keys are scoped by `(agentWallet, composeRunId, key)` and TTL'd for 1h
 * by default — cal plans rarely outlive a single run, and orphans should
 * not accumulate.
 */
import { getRedisClient } from "../memory/cache.js";
import type { HarnessScratchpad } from "./types.js";

const SCRATCHPAD_TTL_SECONDS = 60 * 60;
const KEY_PREFIX = "cal:scratch";

function entryKey(agentWallet: string, composeRunId: string, key: string): string {
    return `${KEY_PREFIX}:${agentWallet}:${composeRunId}:${key}`;
}

function indexKey(agentWallet: string, composeRunId: string): string {
    return `${KEY_PREFIX}:${agentWallet}:${composeRunId}:_index`;
}

export function createScratchpad(input: {
    agentWallet: string;
    composeRunId: string;
    ttlSeconds?: number;
}): HarnessScratchpad {
    const ttl = input.ttlSeconds ?? SCRATCHPAD_TTL_SECONDS;
    const idxKey = indexKey(input.agentWallet, input.composeRunId);

    return {
        async write(key, value) {
            const redis = await getRedisClient();
            const valKey = entryKey(input.agentWallet, input.composeRunId, key);
            const payload = JSON.stringify({ value, ts: Date.now() });
            await redis.setEx(valKey, ttl, payload);
            await redis.sAdd(idxKey, key);
            await redis.expire(idxKey, ttl);
        },
        async read(key) {
            const redis = await getRedisClient();
            const raw = await redis.get(entryKey(input.agentWallet, input.composeRunId, key));
            if (!raw) return null;
            try {
                const parsed = JSON.parse(raw) as { value: unknown };
                return parsed.value;
            } catch {
                return raw;
            }
        },
        async list() {
            const redis = await getRedisClient();
            const keys = await redis.sMembers(idxKey);
            return Array.isArray(keys) ? keys : [];
        },
        async delete(key) {
            const redis = await getRedisClient();
            const removed = await redis.del(entryKey(input.agentWallet, input.composeRunId, key));
            await redis.sRem(idxKey, key);
            return removed > 0;
        },
    };
}
