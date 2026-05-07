/**
 * Physical-isolation adapter for sub-agent execution.
 *
 * When a SubAgentSpec sets `isolated: true`, the engine routes the run
 * through this module instead of executing in-process. We boot a fresh
 * Daytona sandbox, drop a tiny boot script that consumes the spec from env,
 * and capture the structured `MeteringRecord[]` the sandbox emits on stdout.
 *
 * Daytona is wired in runtime/src/mesh/sandbox.ts with full lifecycle
 * (create, session, exec, destroy, receipt persistence). This file is a
 * thin adapter that passes a SubAgentSpec into that machinery and shapes
 * the output back into a SubAgentResult.
 *
 * In dev/test environments without a snapshot, this module degrades to an
 * in-process fallback (the engine's logical-isolation path) and logs a
 * clear warning so we never silently skip the sandbox.
 */
import { randomUUID } from "node:crypto";
import {
    createDaytonaClient,
    loadDaytonaConfig,
    runConclaveSandbox,
    type DaytonaConclaveReceipt,
} from "../../mesh/sandbox.js";
import { runSubAgent, type RunSubAgentOptions } from "./engine.js";
import { buildSubAgentRunKey, type SubAgentResult, type SubAgentSpec } from "./types.js";

function snapshotConfigured(): boolean {
    try {
        const cfg = loadDaytonaConfig();
        return Boolean(cfg.snapshotId);
    } catch {
        return false;
    }
}

/**
 * Run the sub-agent inside a fresh Daytona sandbox. Falls back to in-process
 * execution when no snapshot is configured (with a warning).
 */
export async function runIsolatedSubAgent(
    spec: SubAgentSpec,
    options: RunSubAgentOptions,
): Promise<SubAgentResult> {
    if (!snapshotConfigured()) {
        console.warn(
            `[harness:sandbox] DAYTONA_CONCLAVE_SNAPSHOT_ID not configured, ` +
                `falling back to logical isolation for sub-agent ${spec.subId}`,
        );
        return runSubAgent({ ...spec, isolated: false }, options);
    }

    const startedAt = Date.now();
    const runKey = buildSubAgentRunKey(spec.parentRunId, spec.subId, spec.depth);
    const runKeyChain = [...(options.parentRunKeyChain ?? []), runKey];

    try {
        const config = loadDaytonaConfig();
        const client = createDaytonaClient(config);

        const conclaveId = `harness-${spec.parentRunId}-${spec.subId}-${randomUUID().slice(0, 8)}`;
        const command = buildBootCommand();
        const labels: Record<string, string> = {
            parentRunId: spec.parentRunId,
            subId: spec.subId,
            depth: String(spec.depth),
        };
        if (spec.agentWallet && spec.agentWallet.length > 0) {
            labels.agentWallet = spec.agentWallet.toLowerCase();
        }

        const receipt: DaytonaConclaveReceipt = await runConclaveSandbox(client, config, {
            conclaveId,
            command,
            envVars: buildSandboxEnv(spec),
            labels,
            networkBlockAll: false,
            timeoutMs: spec.budget?.maxWallMs,
        });

        const aggregatedTokens = receipt.meteringRecords.reduce(
            (acc, record) => {
                acc.inputTokens += record.tokensIn ?? 0;
                acc.outputTokens += record.tokensOut ?? 0;
                acc.toolCalls += record.toolCalls ?? 0;
                return acc;
            },
            { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
        );

        return {
            success: receipt.exitCode === 0,
            output: receipt.stdout.trim() || receipt.stderr.trim(),
            stopReason: receipt.exitCode === 0 ? "completed" : "error",
            error: receipt.exitCode === 0 ? undefined : receipt.stderr.slice(0, 500),
            toolCalls: [],
            usage: {
                inputTokens: aggregatedTokens.inputTokens,
                outputTokens: aggregatedTokens.outputTokens,
                reasoningTokens: 0,
                totalTokens: aggregatedTokens.inputTokens + aggregatedTokens.outputTokens,
            },
            toolBatches: aggregatedTokens.toolCalls,
            wallMs: receipt.finishedAt - receipt.startedAt,
            runKey,
            runKeyChain,
        };
    } catch (error) {
        return {
            success: false,
            output: "",
            stopReason: "error",
            error: error instanceof Error ? error.message : String(error),
            toolCalls: [],
            usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 },
            toolBatches: 0,
            wallMs: Date.now() - startedAt,
            runKey,
            runKeyChain,
        };
    }
}

/**
 * In-sandbox boot command. Operators bake a `compose-harness-runner` binary
 * into their Daytona snapshot to consume the spec via env. When that binary
 * is absent the sandbox prints a diagnostic and exits 0 — useful for smoke
 * testing the wiring without committing to a runner image.
 */
function buildBootCommand(): string {
    return [
        "if command -v compose-harness-runner >/dev/null 2>&1; then",
        '  compose-harness-runner --spec "$HARNESS_SPEC_JSON"',
        "else",
        `  echo "[harness:sandbox] no compose-harness-runner binary in snapshot"`,
        "fi",
    ].join("\n");
}

function buildSandboxEnv(spec: SubAgentSpec): Record<string, string> {
    return {
        HARNESS_SPEC_JSON: JSON.stringify({
            parentRunId: spec.parentRunId,
            subId: spec.subId,
            depth: spec.depth,
            agentWallet: spec.agentWallet,
            userAddress: spec.userAddress,
            model: spec.model,
            systemPrompt: spec.systemPrompt,
            prompt: spec.prompt,
            bind: spec.bind,
            budget: spec.budget,
        }),
    };
}
