/**
 * Tests for cal-plan resume from checkpoint
 * (Phase 3.1 — `runtime/src/manowar/harness/interpreter.ts`).
 *
 * The interpreter must:
 *   - Save a checkpoint after every non-terminal step.
 *   - On a fresh `runCalPlan` call with the same composeRunId, skip
 *     already-completed steps and replay state.
 *   - Clear the checkpoint on terminal completion (success or stop_op).
 *   - Skip checkpointing for inline cal recursion (interpreterDepth > 0).
 *
 * We use an in-memory checkpoint store to avoid live Redis dependence
 * and exercise the full save/load/resume contract deterministically.
 */
import { describe, expect, it } from "vitest";

import { runCalPlan } from "../../src/manowar/harness/interpreter.js";
import type {
    CalCheckpoint,
    CalCheckpointStore,
} from "../../src/manowar/harness/checkpoint.js";

function memoryCheckpointStore(): CalCheckpointStore & { snapshots: CalCheckpoint[] } {
    const snapshots: CalCheckpoint[] = [];
    let current: CalCheckpoint | null = null;
    return {
        snapshots,
        async save(checkpoint) {
            current = checkpoint;
            snapshots.push(JSON.parse(JSON.stringify(checkpoint)));
        },
        async load() {
            return current ? JSON.parse(JSON.stringify(current)) : null;
        },
        async clear() {
            current = null;
        },
    };
}

const TEST_AGENT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const STUB_RESOLVE_TOOLS = async () => [];

describe("runCalPlan checkpoint contract (Phase 3.1)", () => {
    it("saves a checkpoint after every non-terminal step", async () => {
        const store = memoryCheckpointStore();
        const plan = {
            id: "checkpoint_save_test",
            steps: [
                { op: "scratch", action: "write", key: "k1", value: "v1", saveAs: "s1" },
                { op: "scratch", action: "write", key: "k2", value: "v2", saveAs: "s2" },
                { op: "scratch", action: "read", key: "k1", saveAs: "s3" },
                { op: "stop", output: "done" },
            ],
        } as const;

        const result = await runCalPlan(plan as any, {
            agentWallet: TEST_AGENT,
            composeRunId: "checkpoint-save-run-1",
            resolveTools: STUB_RESOLVE_TOOLS,
            checkpointStore: store,
            skipAgentRegistryCheck: true,
        });

        expect(result.success).toBe(true);
        // Three non-terminal steps (scratch x3); the `stop` step is terminal
        // and skipped from save (we only save non-terminal). So 3 snapshots.
        expect(store.snapshots.length).toBe(3);
        // Indexes match the order they were completed.
        expect(store.snapshots[0].completedStepIndex).toBe(0);
        expect(store.snapshots[1].completedStepIndex).toBe(1);
        expect(store.snapshots[2].completedStepIndex).toBe(2);
        // Saved values accumulate across snapshots.
        expect(store.snapshots[2].saved).toEqual({ s1: true, s2: true, s3: "v1" });
    });

    it("clears the checkpoint on terminal completion", async () => {
        const store = memoryCheckpointStore();
        const plan = {
            id: "checkpoint_clear_test",
            steps: [
                { op: "scratch", action: "write", key: "k1", value: "v1", saveAs: "s1" },
                { op: "stop", output: "{{s1}}" },
            ],
        } as const;

        await runCalPlan(plan as any, {
            agentWallet: TEST_AGENT,
            composeRunId: "checkpoint-clear-run-1",
            resolveTools: STUB_RESOLVE_TOOLS,
            checkpointStore: store,
            skipAgentRegistryCheck: true,
        });
        // After clear, load returns null.
        expect(await store.load()).toBeNull();
    });

    it("resumes from the last completed step on re-invocation with same composeRunId", async () => {
        const store = memoryCheckpointStore();
        // Pre-load a checkpoint to simulate "first run completed steps 0 and 1
        // but never finished" (e.g. crashed before clear).
        await store.save({
            planId: "resume_test",
            composeRunId: "resume-run-1",
            completedStepIndex: 1,
            steps: [
                { op: "scratch", saveAs: "s1", success: true, value: true },
                { op: "scratch", saveAs: "s2", success: true, value: true },
            ],
            saved: { s1: true, s2: true, "preloaded-key": "preloaded-value" },
            aggregateUsage: {
                inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0,
                toolCalls: 0, toolBatches: 0, wallMs: 0,
            },
            updatedAt: Date.now(),
        });

        const plan = {
            id: "resume_test",
            steps: [
                { op: "scratch", action: "write", key: "k1", value: "v1", saveAs: "s1" },
                { op: "scratch", action: "write", key: "k2", value: "v2", saveAs: "s2" },
                // This is the step the resumed run should START at.
                { op: "scratch", action: "read", key: "preloaded-key", saveAs: "s3" },
            ],
        } as const;

        // Track which step ops actually executed (we use scratch ops which
        // hit Redis-backed scratchpad; we substitute an in-memory pad).
        const padEntries = new Map<string, unknown>();
        const memoryScratchpad = {
            async write(k: string, v: unknown) {
                padEntries.set(k, v);
            },
            async read(k: string) {
                return padEntries.get(k) ?? null;
            },
            async list() {
                return Array.from(padEntries.keys());
            },
            async delete(k: string) {
                return padEntries.delete(k);
            },
        };

        const result = await runCalPlan(plan as any, {
            agentWallet: TEST_AGENT,
            composeRunId: "resume-run-1",
            resolveTools: STUB_RESOLVE_TOOLS,
            checkpointStore: store,
            scratchpad: memoryScratchpad,
            skipAgentRegistryCheck: true,
        });

        expect(result.success).toBe(true);
        // The first two scratch.write ops were SKIPPED (replayed from
        // checkpoint). The scratchpad never saw those keys — only the
        // step-3 read happened.
        expect(padEntries.has("k1")).toBe(false);
        expect(padEntries.has("k2")).toBe(false);
        // The replayed `saved` map was carried into step 3, which read
        // `preloaded-key` from the scratchpad — but the scratchpad doesn't
        // have it, so step3 saves null. The point is: it ran, with the
        // resumed saved state, and the prior steps were not re-executed.
        expect(result.steps.length).toBe(3);
        // Steps 0 and 1 are the replayed ones.
        expect(result.steps[0].saveAs).toBe("s1");
        expect(result.steps[1].saveAs).toBe("s2");
        expect(result.steps[2].saveAs).toBe("s3");
    });

    it("ignores a checkpoint with a different planId (no cross-plan corruption)", async () => {
        const store = memoryCheckpointStore();
        // Stale checkpoint from a different plan.
        await store.save({
            planId: "other_plan",
            composeRunId: "shared-run",
            completedStepIndex: 5,
            steps: [],
            saved: { stale: "value" },
            aggregateUsage: {
                inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0,
                toolCalls: 0, toolBatches: 0, wallMs: 0,
            },
            updatedAt: Date.now(),
        });

        const plan = {
            id: "fresh_plan",
            steps: [
                { op: "scratch", action: "write", key: "k1", value: "v1", saveAs: "s1" },
                { op: "stop", output: "{{s1}}" },
            ],
        } as const;

        const result = await runCalPlan(plan as any, {
            agentWallet: TEST_AGENT,
            composeRunId: "shared-run",
            resolveTools: STUB_RESOLVE_TOOLS,
            checkpointStore: store,
            skipAgentRegistryCheck: true,
        });

        expect(result.success).toBe(true);
        // Fresh plan ran from step 0, didn't inherit the stale `saved.stale`.
        expect(result.steps[0].saveAs).toBe("s1");
    });

    it("skips checkpointing for inline cal recursion (interpreterDepth > 0)", async () => {
        const store = memoryCheckpointStore();
        const plan = {
            id: "depth_gate_test",
            steps: [
                { op: "scratch", action: "write", key: "k1", value: "v1", saveAs: "s1" },
            ],
        } as const;

        await runCalPlan(plan as any, {
            agentWallet: TEST_AGENT,
            composeRunId: "depth-gate-run",
            resolveTools: STUB_RESOLVE_TOOLS,
            checkpointStore: store,
            interpreterDepth: 1, // simulate inner if/loop/inline-fanout
            skipAgentRegistryCheck: true,
        });

        // No save because interpreterDepth > 0.
        expect(store.snapshots.length).toBe(0);
    });

    it("when ctx.checkpointStore is provided, takes precedence over enableCheckpoints", async () => {
        const store = memoryCheckpointStore();
        const plan = {
            id: "precedence_test",
            steps: [{ op: "scratch", action: "write", key: "k", value: "v", saveAs: "s" }],
        } as const;

        await runCalPlan(plan as any, {
            agentWallet: TEST_AGENT,
            composeRunId: "precedence-run",
            resolveTools: STUB_RESOLVE_TOOLS,
            checkpointStore: store,
            enableCheckpoints: true, // ignored because checkpointStore present
            skipAgentRegistryCheck: true,
        });

        expect(store.snapshots.length).toBe(1);
    });
});
