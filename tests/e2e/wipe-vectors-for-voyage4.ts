/**
 * Fresh-slate wipe of the entire memory subsystem.
 *
 * - Mongo: deletes ALL rows from `memory`, `session_transcripts`, `sessions`,
 *   `patterns`, `archives`, `skills`, `memory_jobs`.
 * - Redis: deletes ALL keys under `memory:*` and `embedding:*` namespaces.
 *
 * After this script the next agent turn rebuilds state from zero with the
 * current voyage-4-large embedding family.
 *
 * Safety: scoped to the memory namespaces only — does not touch session
 * tokens, agent registry, or anything outside compose_memory db / those two
 * Redis prefixes. Confirmation prompt unless WIPE_CONFIRM=yes is set.
 *
 * Run from runtime/:
 *   WIPE_CONFIRM=yes npx tsx tests/e2e/wipe-vectors-for-voyage4.ts
 */
import "dotenv/config";
import {
    getMemoryVectorsCollection,
    getSessionTranscriptsCollection,
    getPatternsCollection,
    getArchivesCollection,
    getMemoryJobsCollection,
    getSkillsCollection,
    getSessionsCollection,
    closeMemoryMongo,
} from "../../src/manowar/memory/mongo.js";
import { getRedisClient, closeRedis } from "../../src/manowar/memory/cache.js";

interface ScanReply { cursor: string; keys: string[] }

async function deleteRedisPrefix(redis: any, pattern: string): Promise<number> {
    let cursor: string | number = "0";
    let deleted = 0;
    for (let safetyIter = 0; safetyIter < 1000; safetyIter += 1) {
        const reply = await redis.scan(cursor, { MATCH: pattern, COUNT: 1000 }) as ScanReply | { cursor: number; keys: string[] };
        cursor = (reply as any).cursor;
        const keys: string[] = (reply as any).keys || [];
        if (keys.length > 0) {
            deleted += await redis.del(keys);
        }
        if (String(cursor) === "0") break;
    }
    return deleted;
}

async function main(): Promise<void> {
    const safety = setTimeout(() => {
        console.error("[wipe] safety timeout");
        process.exit(1);
    }, 120_000);
    safety.unref();

    if (process.env.WIPE_CONFIRM !== "yes") {
        console.error("[wipe] refusing to run without WIPE_CONFIRM=yes");
        console.error("[wipe] usage: WIPE_CONFIRM=yes npx tsx tests/e2e/wipe-vectors-for-voyage4.ts");
        process.exit(2);
    }

    console.log("[wipe] === Mongo ===");
    const collections: Array<[string, () => Promise<{ countDocuments: (filter: object) => Promise<number>; deleteMany: (filter: object) => Promise<{ deletedCount?: number }> }>]> = [
        ["memory", getMemoryVectorsCollection as any],
        ["session_transcripts", getSessionTranscriptsCollection as any],
        ["sessions", getSessionsCollection as any],
        ["patterns", getPatternsCollection as any],
        ["archives", getArchivesCollection as any],
        ["skills", getSkillsCollection as any],
        ["memory_jobs", getMemoryJobsCollection as any],
    ];
    for (const [name, getter] of collections) {
        const c = await getter();
        const before = await c.countDocuments({});
        const result = await c.deleteMany({});
        console.log(`[wipe] ${name.padEnd(22)} before=${before}  deleted=${result.deletedCount ?? 0}`);
    }

    console.log("\n[wipe] === Redis ===");
    try {
        const redis = await getRedisClient();
        const memDeleted = await deleteRedisPrefix(redis, "memory:*");
        console.log(`[wipe] memory:*    keys deleted: ${memDeleted}`);
        const embDeleted = await deleteRedisPrefix(redis, "embedding:*");
        console.log(`[wipe] embedding:* keys deleted: ${embDeleted}`);
    } catch (err) {
        console.warn("[wipe] redis flush failed:", err instanceof Error ? err.message : err);
    }

    await closeMemoryMongo();
    try { await closeRedis(); } catch { /* ignore */ }
    console.log("\n[wipe] done. Next agent turn rebuilds state from zero with voyage-4-large.");
    process.exit(0);
}

main().catch((err) => {
    console.error("[wipe] fatal:", err);
    process.exit(2);
});
