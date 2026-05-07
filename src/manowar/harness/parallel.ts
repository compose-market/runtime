/**
 * Parallel sub-agent fan-out with cooperative cancellation.
 *
 * Wraps `Promise.all` over `runSubAgent` with three gather modes (`all`,
 * `any-success`, `first`) and a concurrency cap. Children inherit the
 * parent's AbortSignal so cancelling the parent cancels all in-flight
 * branches.
 *
 * The runtime runs all branches in the same Node process — true physical
 * isolation is opt-in per branch via the SubAgentSpec.isolated flag (which
 * dispatches into harness/sandbox.ts inside runSubAgent).
 */
import { runSubAgent, type RunSubAgentOptions } from "./engine.js";
import type { SubAgentResult, SubAgentSpec } from "./types.js";

export type GatherMode = "all" | "any-success" | "first";

export interface ParallelInput {
    specs: SubAgentSpec[];
    /** How to gather results. Default `all`. */
    gather?: GatherMode;
    /** Concurrency cap. Default 4 (most LLM gateways are happy with 4-8). */
    concurrency?: number;
    /** Inherited abort signal. Wired to every branch's spec.abortSignal. */
    abortSignal?: AbortSignal;
}

export interface ParallelOutput {
    /** Results in the same order as the input specs. */
    results: SubAgentResult[];
    /** Index of the winner branch when gather="any-success" or "first". */
    winnerIndex?: number;
    /** Whether the gather criterion was satisfied. */
    success: boolean;
}

/**
 * Run multiple sub-agents in parallel, cooperatively bounded by `concurrency`.
 * Returns when the gather criterion is met or every spec resolves.
 */
export async function runParallel(
    input: ParallelInput,
    options: RunSubAgentOptions,
): Promise<ParallelOutput> {
    const gather: GatherMode = input.gather ?? "all";
    const concurrency = Math.max(1, Math.min(input.concurrency ?? 4, 16));

    if (input.specs.length === 0) {
        return { results: [], success: true };
    }

    // Internal abort to wake up unfinished branches when a winner emerges.
    const internalAbort = new AbortController();
    const onParentAbort = () => internalAbort.abort();
    if (input.abortSignal) {
        if (input.abortSignal.aborted) internalAbort.abort();
        else input.abortSignal.addEventListener("abort", onParentAbort, { once: true });
    }

    // Each branch's spec.abortSignal is our internal one (or anded with the
    // caller's existing signal if any).
    const branchSpecs: SubAgentSpec[] = input.specs.map((spec) => ({
        ...spec,
        abortSignal: anySignal(spec.abortSignal, internalAbort.signal),
    }));

    const results: (SubAgentResult | undefined)[] = new Array(branchSpecs.length).fill(undefined);
    let winnerIndex: number | undefined;
    let firstSuccessIndex: number | undefined;
    let firstResolvedIndex: number | undefined;

    // Simple worker-pool dispatch.
    let cursor = 0;
    const workers: Promise<void>[] = [];
    const finishedDeferred: { resolve: () => void; promise: Promise<void> } = (() => {
        let resolveFn!: () => void;
        const promise = new Promise<void>((r) => { resolveFn = r; });
        return { resolve: resolveFn, promise };
    })();

    const tryFinish = () => {
        if (gather === "any-success" && firstSuccessIndex !== undefined) {
            winnerIndex = firstSuccessIndex;
            internalAbort.abort();
            finishedDeferred.resolve();
            return;
        }
        if (gather === "first" && firstResolvedIndex !== undefined) {
            winnerIndex = firstResolvedIndex;
            internalAbort.abort();
            finishedDeferred.resolve();
            return;
        }
        if (results.every((r) => r !== undefined)) {
            finishedDeferred.resolve();
        }
    };

    const launch = async (workerId: number): Promise<void> => {
        void workerId;
        while (true) {
            if (internalAbort.signal.aborted) return;
            const idx = cursor;
            if (idx >= branchSpecs.length) return;
            cursor = idx + 1;
            try {
                const result = await runSubAgent(branchSpecs[idx], {
                    ...options,
                    parentRunKeyChain: options.parentRunKeyChain,
                });
                results[idx] = result;
                if (firstResolvedIndex === undefined) firstResolvedIndex = idx;
                if (result.success && firstSuccessIndex === undefined) firstSuccessIndex = idx;
            } catch (error) {
                results[idx] = {
                    success: false,
                    output: "",
                    stopReason: "error",
                    error: error instanceof Error ? error.message : String(error),
                    toolCalls: [],
                    usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 },
                    toolBatches: 0,
                    wallMs: 0,
                    runKey: `parallel:${idx}`,
                    runKeyChain: options.parentRunKeyChain ?? [],
                };
                if (firstResolvedIndex === undefined) firstResolvedIndex = idx;
            }
            tryFinish();
        }
    };

    const workerCount = Math.min(concurrency, branchSpecs.length);
    for (let i = 0; i < workerCount; i += 1) workers.push(launch(i));

    await Promise.race([
        finishedDeferred.promise,
        Promise.allSettled(workers).then(() => undefined),
    ]);

    if (input.abortSignal) input.abortSignal.removeEventListener("abort", onParentAbort);

    // Fill in undefined slots with synthetic aborted results so the array
    // index alignment with input.specs is stable.
    for (let i = 0; i < results.length; i += 1) {
        if (results[i] === undefined) {
            results[i] = {
                success: false,
                output: "",
                stopReason: "aborted",
                toolCalls: [],
                usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 },
                toolBatches: 0,
                wallMs: 0,
                runKey: `parallel:${i}`,
                runKeyChain: options.parentRunKeyChain ?? [],
            };
        }
    }

    const final = results as SubAgentResult[];
    const success =
        gather === "all"
            ? final.every((r) => r.success)
            : gather === "any-success"
                ? winnerIndex !== undefined
                : winnerIndex !== undefined && final[winnerIndex].success;

    return { results: final, winnerIndex, success };
}

/**
 * Compose two AbortSignals into one. Returns undefined when both are absent.
 * Avoids `AbortSignal.any` for compat with older Node versions.
 */
function anySignal(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
    if (!a && !b) return undefined;
    if (!a) return b;
    if (!b) return a;
    if (a.aborted) return a;
    if (b.aborted) return b;
    const controller = new AbortController();
    const onA = () => { try { controller.abort(a.reason); } catch { /* noop */ } };
    const onB = () => { try { controller.abort(b.reason); } catch { /* noop */ } };
    a.addEventListener("abort", onA, { once: true });
    b.addEventListener("abort", onB, { once: true });
    return controller.signal;
}
