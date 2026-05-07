/**
 * Tests for the shared swarm-bus conclave (Phase 3.2)
 * `runtime/src/manowar/harness/conclave.ts`.
 *
 * The conclave is the operational hand-off bus across every layer of
 * a depth-N swarm:
 *   - All agents in the same swarm (layer-0 + every depth-N descendant)
 *     share the same keyspace, keyed by `rootComposeRunId`.
 *   - Authorship is automatic: every write carries `writtenBy`.
 *   - Version counter is monotonic so readers can detect changes
 *     without comparing payloads.
 *   - TTL 24h (vs 1h for the private scratchpad) so a follow-up turn /
 *     resume picks up where the swarm left off.
 *
 * Backed by REDIS_MEMORY_* (the runtime's hot Redis). Skipped when
 * REDIS_MEMORY_* is not configured.
 */
import "dotenv/config";

import { afterEach, describe, expect, it } from "vitest";

import { createConclaveBus } from "../../src/manowar/harness/conclave.js";
import { closeRedis } from "../../src/manowar/memory/cache.js";

const REDIS_AVAILABLE = Boolean(
    process.env.REDIS_MEMORY_DATABASE_PUBLIC_ENDPOINT &&
        process.env.REDIS_MEMORY_DEFAULT_PASSWORD,
);

const COORDINATOR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SPECIALIST_A = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SPECIALIST_B = "0xcccccccccccccccccccccccccccccccccccccccc";

afterEach(async () => {
    if (REDIS_AVAILABLE) {
        await closeRedis();
    }
});

describe("createConclaveBus — round-trip (Phase 3.2)", () => {
    it.skipIf(!REDIS_AVAILABLE)(
        "write → read returns the value with authorship + version",
        async () => {
            const rootComposeRunId = `conclave-rt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const bus = createConclaveBus({
                rootComposeRunId,
                writtenBy: COORDINATOR,
                ttlSeconds: 60,
            });
            const written = await bus.write("plan.md", "step 1: research");
            expect(written.writtenBy).toBe(COORDINATOR);
            expect(written.version).toBe(1);
            expect(written.value).toBe("step 1: research");

            const read = await bus.read<string>("plan.md");
            expect(read).not.toBeNull();
            expect(read?.value).toBe("step 1: research");
            expect(read?.writtenBy).toBe(COORDINATOR);
            expect(read?.version).toBe(1);

            await bus.clear();
        },
        15_000,
    );

    it.skipIf(!REDIS_AVAILABLE)(
        "version increments on every overwrite",
        async () => {
            const rootComposeRunId = `conclave-ver-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const bus = createConclaveBus({
                rootComposeRunId,
                writtenBy: COORDINATOR,
                ttlSeconds: 60,
            });
            const v1 = await bus.write("phase", "research");
            const v2 = await bus.write("phase", "drafting");
            const v3 = await bus.write("phase", "review");
            expect(v1.version).toBe(1);
            expect(v2.version).toBe(2);
            expect(v3.version).toBe(3);
            const read = await bus.read("phase");
            expect(read?.version).toBe(3);
            expect(read?.value).toBe("review");
            await bus.clear();
        },
        15_000,
    );

    it.skipIf(!REDIS_AVAILABLE)(
        "list returns all live keys",
        async () => {
            const rootComposeRunId = `conclave-list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const bus = createConclaveBus({
                rootComposeRunId,
                writtenBy: COORDINATOR,
                ttlSeconds: 60,
            });
            await bus.write("plan.md", "...");
            await bus.write("phase", "research");
            await bus.write("draft.html", "<h1>Hello</h1>");
            const keys = (await bus.list()).sort();
            expect(keys).toEqual(["draft.html", "phase", "plan.md"]);
            await bus.clear();
        },
        15_000,
    );

    it.skipIf(!REDIS_AVAILABLE)(
        "delete removes the key and excludes it from list",
        async () => {
            const rootComposeRunId = `conclave-del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const bus = createConclaveBus({
                rootComposeRunId,
                writtenBy: COORDINATOR,
                ttlSeconds: 60,
            });
            await bus.write("plan.md", "x");
            await bus.write("phase", "y");
            const removed = await bus.delete("plan.md");
            expect(removed).toBe(true);
            expect(await bus.list()).toEqual(["phase"]);
            expect(await bus.read("plan.md")).toBeNull();
            await bus.clear();
        },
        15_000,
    );

    it.skipIf(!REDIS_AVAILABLE)(
        "clear empties the entire conclave",
        async () => {
            const rootComposeRunId = `conclave-clear-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const bus = createConclaveBus({
                rootComposeRunId,
                writtenBy: COORDINATOR,
                ttlSeconds: 60,
            });
            await bus.write("a", 1);
            await bus.write("b", 2);
            await bus.clear();
            expect(await bus.list()).toEqual([]);
            expect(await bus.read("a")).toBeNull();
        },
        15_000,
    );
});

describe("createConclaveBus — multi-agent swarm semantics (Phase 3.2)", () => {
    it.skipIf(!REDIS_AVAILABLE)(
        "all agents in the same swarm share the same keyspace via rootComposeRunId",
        async () => {
            const rootComposeRunId = `conclave-shared-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            // Three agents at different depths, same swarm.
            const coordBus = createConclaveBus({
                rootComposeRunId,
                writtenBy: COORDINATOR,
                ttlSeconds: 60,
            });
            const specialistABus = createConclaveBus({
                rootComposeRunId,
                writtenBy: SPECIALIST_A,
                ttlSeconds: 60,
            });
            const specialistBBus = createConclaveBus({
                rootComposeRunId,
                writtenBy: SPECIALIST_B,
                ttlSeconds: 60,
            });

            // Coordinator writes the plan.
            await coordBus.write("plan.md", "1. specialistA: research\n2. specialistB: draft");

            // Specialist A reads it via their own bus instance.
            const planByA = await specialistABus.read<string>("plan.md");
            expect(planByA?.value).toBe("1. specialistA: research\n2. specialistB: draft");
            expect(planByA?.writtenBy).toBe(COORDINATOR);

            // Specialist A appends research output.
            const wroteResearch = await specialistABus.write("research.md", "found three sources...");
            expect(wroteResearch.writtenBy).toBe(SPECIALIST_A);

            // Specialist B sees both files.
            const keysByB = (await specialistBBus.list()).sort();
            expect(keysByB).toEqual(["plan.md", "research.md"]);

            // Specialist B reads research.
            const researchByB = await specialistBBus.read<string>("research.md");
            expect(researchByB?.writtenBy).toBe(SPECIALIST_A);

            await coordBus.clear();
        },
        20_000,
    );

    it.skipIf(!REDIS_AVAILABLE)(
        "different swarms (different rootComposeRunId) are isolated",
        async () => {
            const swarmA = `conclave-iso-A-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const swarmB = `conclave-iso-B-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const busA = createConclaveBus({
                rootComposeRunId: swarmA,
                writtenBy: COORDINATOR,
                ttlSeconds: 60,
            });
            const busB = createConclaveBus({
                rootComposeRunId: swarmB,
                writtenBy: COORDINATOR,
                ttlSeconds: 60,
            });
            await busA.write("plan.md", "swarm-A plan");
            await busB.write("plan.md", "swarm-B plan");
            const fromA = await busA.read<string>("plan.md");
            const fromB = await busB.read<string>("plan.md");
            expect(fromA?.value).toBe("swarm-A plan");
            expect(fromB?.value).toBe("swarm-B plan");
            await busA.clear();
            await busB.clear();
        },
        15_000,
    );

    it.skipIf(!REDIS_AVAILABLE)(
        "version is monotonic across writes from different agents",
        async () => {
            const rootComposeRunId = `conclave-monoton-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const a = createConclaveBus({ rootComposeRunId, writtenBy: SPECIALIST_A, ttlSeconds: 60 });
            const b = createConclaveBus({ rootComposeRunId, writtenBy: SPECIALIST_B, ttlSeconds: 60 });
            const v1 = await a.write("phase", "research");
            const v2 = await b.write("phase", "drafting");
            const v3 = await a.write("phase", "review");
            expect(v1.version).toBe(1);
            expect(v2.version).toBe(2);
            expect(v3.version).toBe(3);
            await a.clear();
        },
        15_000,
    );
});

describe("createConclaveBus — read tolerance", () => {
    it.skipIf(!REDIS_AVAILABLE)(
        "read returns null for missing keys (no throw)",
        async () => {
            const rootComposeRunId = `conclave-miss-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const bus = createConclaveBus({
                rootComposeRunId,
                writtenBy: COORDINATOR,
                ttlSeconds: 60,
            });
            const result = await bus.read("does-not-exist");
            expect(result).toBeNull();
        },
        15_000,
    );
});
