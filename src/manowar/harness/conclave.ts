/**
 * Shared swarm-bus conclave, backed by Redis.
 *
 * "Conclave" is the gathering of intelligent agents working a single
 * swarm task. Companion to `harness/scratchpad.ts`:
 *   - `scratchpad.ts` is PRIVATE per-agent state, keyed by
 *     `cal:scratch:<agentWallet>:<composeRunId>:<key>`. Each layer of a
 *     swarm has its own. Used by the cal interpreter for `op: scratch`
 *     and for the `scratchpad_*` tool surface.
 *   - `conclave.ts` (this file) is the SHARED swarm bus, keyed by
 *     `cal:conclave:<rootComposeRunId>:<key>`. ALL agents in the same
 *     swarm (layer-0 coordinator + every depth-N descendant) read and
 *     write the same keyspace. Used for hand-off artifacts, coordination
 *     state, "hot" artifacts that should survive a child crash, and the
 *     operational conclave concept (Manus-style `todo.md` / `plan.md`
 *     shared file).
 *
 * Why this is distinct from the future user-project "workspace":
 *   - Conclave = ephemeral swarm-task scope (TTL 24h). Think "all agents
 *     collaborating on this single user request".
 *   - Workspace (Phase 6 / `knowledge/`) = durable per-user-project scope.
 *     Persists across many turns, many runs, many days. Think "this
 *     creator's branding project" or "this team's marketing campaign".
 *
 * Why a separate path from scratchpad:
 *   - Privacy. A specialist depth-2 agent shouldn't accidentally
 *     overwrite the coordinator's private notes.
 *   - Auditability. Every conclave write carries `writtenBy` (the
 *     agentWallet that wrote it) so the coordinator can see which
 *     specialist contributed which artifact.
 *   - Survivability. Conclave TTL (default 24h) is long; private
 *     scratchpad TTL is 1h. The conclave outlives a single run so a
 *     follow-up turn (or resume) can pick up where the swarm left off.
 *
 * Storage: REDIS_MEMORY_* (the runtime's hot Redis, same client as
 * memory/cache.ts and harness/checkpoint.ts).
 */
import { getRedisClient } from "../memory/cache.js";

const CONCLAVE_TTL_SECONDS = 24 * 60 * 60; // 24h
const KEY_PREFIX = "cal:conclave";

export interface ConclaveEntry<T = unknown> {
    /** The stored value (JSON-serialized in Redis, parsed on read). */
    value: T;
    /** agentWallet that wrote this entry. */
    writtenBy: string;
    /** Wall clock of the last write (ms since epoch). */
    ts: number;
    /**
     * Monotonic version counter — incremented on every write so a reader
     * can detect whether a value changed since their last read without
     * comparing serialized payloads. Useful for coordinator polling.
     */
    version: number;
}

export interface ConclaveBus {
    /** Write a value under `key`. Bumps version. Resets TTL. */
    write(key: string, value: unknown): Promise<ConclaveEntry>;
    /** Read a value, or null when missing / expired. */
    read<T = unknown>(key: string): Promise<ConclaveEntry<T> | null>;
    /** List all live keys in the conclave (cheap, set-membership read). */
    list(): Promise<string[]>;
    /** Drop a key. Returns true when the key existed. */
    delete(key: string): Promise<boolean>;
    /** Drop the entire conclave. Used at run completion. */
    clear(): Promise<void>;
}

function entryKey(rootComposeRunId: string, key: string): string {
    return `${KEY_PREFIX}:${rootComposeRunId}:k:${key}`;
}

function indexKey(rootComposeRunId: string): string {
    return `${KEY_PREFIX}:${rootComposeRunId}:_index`;
}

/**
 * Create a conclave bus scoped to one root run id.
 *
 * `rootComposeRunId` is the LAYER-0 composeRunId — the original user
 * request's run id, NOT a child's derived id. Every layer of the swarm
 * passes the SAME rootComposeRunId so the bus is shared.
 *
 * `writtenBy` defaults to the local agent's wallet so writes carry
 * authorship for free; pass an explicit override only in tests.
 */
export function createConclaveBus(input: {
    rootComposeRunId: string;
    writtenBy: string;
    ttlSeconds?: number;
}): ConclaveBus {
    const ttl = input.ttlSeconds ?? CONCLAVE_TTL_SECONDS;
    const idxKey = indexKey(input.rootComposeRunId);
    const versionPrefix = `${KEY_PREFIX}:${input.rootComposeRunId}:v:`;

    return {
        async write(key, value): Promise<ConclaveEntry> {
            const redis = await getRedisClient();
            const valKey = entryKey(input.rootComposeRunId, key);
            const verKey = `${versionPrefix}${key}`;
            const ts = Date.now();
            // Atomic version bump (Redis INCR creates the key at 0+1 if
            // missing). Slightly chatty (3 writes + 1 set ADD) but
            // accurate under concurrent swarm writes.
            const version = await redis.incr(verKey);
            await redis.expire(verKey, ttl);
            const entry: ConclaveEntry = {
                value,
                writtenBy: input.writtenBy,
                ts,
                version,
            };
            await redis.setEx(valKey, ttl, JSON.stringify(entry));
            await redis.sAdd(idxKey, key);
            await redis.expire(idxKey, ttl);
            return entry;
        },
        async read<T = unknown>(key: string): Promise<ConclaveEntry<T> | null> {
            const redis = await getRedisClient();
            const raw = await redis.get(entryKey(input.rootComposeRunId, key));
            if (!raw) return null;
            try {
                return JSON.parse(raw) as ConclaveEntry<T>;
            } catch {
                return null;
            }
        },
        async list() {
            const redis = await getRedisClient();
            const keys = await redis.sMembers(idxKey);
            return Array.isArray(keys) ? keys : [];
        },
        async delete(key: string) {
            const redis = await getRedisClient();
            const removed = await redis.del(entryKey(input.rootComposeRunId, key));
            await redis.sRem(idxKey, key);
            await redis.del(`${versionPrefix}${key}`);
            return removed > 0;
        },
        async clear() {
            const redis = await getRedisClient();
            const members = await redis.sMembers(idxKey);
            if (Array.isArray(members) && members.length > 0) {
                const keysToDelete: string[] = [];
                for (const k of members) {
                    keysToDelete.push(entryKey(input.rootComposeRunId, k));
                    keysToDelete.push(`${versionPrefix}${k}`);
                }
                if (keysToDelete.length > 0) {
                    await redis.del(keysToDelete);
                }
            }
            await redis.del(idxKey);
        },
    };
}
