/**
 * Cal-plan proof bundle (Phase 3.3).
 *
 * When a `CalPlan` declares `requireProof: true`, the harness accumulates
 * a typed bundle through plan execution and pins it to IPFS via Pinata at
 * plan termination. The CID is returned on `CalRunResult.proofCid` and
 * embedded in receipts so any third party can fetch and verify the bundle
 * without trusting Compose.
 *
 * Trust model — be honest about what this proves:
 *   - It does NOT establish TEE-level attestation (Daytona has no TEE).
 *   - It DOES establish: a hash of every input the plan saw, every output
 *     it produced, every inference run id (which the api/inference layer
 *     settled on x402), and an EVM signature from api.compose.market's
 *     signer over the lot.
 *   - Verifiers cross-check `inferenceRunIds` against x402 receipts (those
 *     ARE cryptographically authoritative), confirm the api signature,
 *     and (when `daytona.sandboxId` is present) optionally pull
 *     Daytona's audit log for that sandbox to corroborate lifecycle
 *     timestamps.
 *
 * The bundle is ~1-3 KB JSON. Pinata CIDv1 (matches `web/src/lib/pinata.ts`).
 */
import { createHash } from "node:crypto";

import { requirePinataApiUrl } from "../../auth.js";

/** A single observable from a step (one of `input`, `output`, or both). */
export interface ProofStepRecord {
    /** Plan step index (0-based). */
    index: number;
    /** Step op (task / delegate / fanout / tool / synthesize / scratch / ...). */
    op: string;
    /** Saved-as key when applicable. */
    saveAs?: string;
    /** sha256(JSON.stringify(input)) where input is op-specific. */
    inputHash: string;
    /** sha256(JSON.stringify(value)) where value is the saved/return value. */
    outputHash: string;
    /** Whether the step succeeded. */
    success: boolean;
    /** Tool / sub-agent id when applicable (NOT the wallet — already in agentWallet). */
    invokedTool?: string;
    /** Inference run ids surfaced by the step (each x402-settled). */
    inferenceRunIds?: string[];
    /** Wall ms taken by the step. */
    wallMs?: number;
}

/** Optional Daytona sandbox metadata when `requireIsolation: true`. */
export interface ProofSandboxMetadata {
    sandboxId: string;
    snapshotId?: string | null;
    imageRef?: string | null;
    startedAt: number;
    finishedAt: number;
    exitCode: number;
    /** Compose-computed root hash of metering lines emitted by the sandbox. */
    meteringRootHash?: string;
    /** Compose-computed root hash of file-system writes the plan made. */
    artifactRootHash?: string;
}

/** The payload that gets pinned to IPFS. */
export interface ProofBundle {
    /** Bundle schema version. */
    schemaVersion: "compose.proof.v1";
    /** Plan id. */
    planId: string;
    /** composeRunId for the run. */
    composeRunId: string;
    /** Layer-0 root composeRunId for swarm runs. Equals composeRunId at top. */
    rootComposeRunId: string;
    /** Coordinator agent that owned the plan. */
    agentWallet: string;
    /** End-user wallet that initiated the swarm. */
    userAddress?: string;
    /** Wall clock (ms) the plan started. */
    startedAt: number;
    /** Wall clock (ms) the plan finished. */
    finishedAt: number;
    /** Plan's terminal stop reason (echoes CalRunResult.stopReason). */
    stopReason: "completed" | "stop_op" | "error" | "aborted";
    /** Per-step hashes. Order matches plan.steps. */
    steps: ProofStepRecord[];
    /** sha256 of the canonical-JSON-serialized plan, computed BEFORE execution. */
    planHash: string;
    /** All inference run ids surfaced through the plan, deduped. */
    inferenceRunIds: string[];
    /** Optional sandbox metadata when isolation was active. */
    sandbox?: ProofSandboxMetadata;
    /** EVM signature over the canonical-JSON form of the bundle (minus this field). */
    composeSig?: string;
    /** Compose signer address (for verification). */
    composeSigner?: string;
}

/**
 * Stable JSON serialization. We sort object keys recursively so the same
 * logical bundle always serializes to the same bytes, which is what the
 * EVM signature is computed over.
 */
export function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) {
        return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** sha256 hex of a value's canonical JSON form. */
export function hashValue(value: unknown): string {
    return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

// ---------------------------------------------------------------------------
// Accumulator
// ---------------------------------------------------------------------------

export interface ProofAccumulator {
    /** Record one step's contribution. */
    recordStep(record: ProofStepRecord): void;
    /** Attach sandbox metadata when isolation was active. */
    recordSandbox(metadata: ProofSandboxMetadata): void;
    /** Append inference run ids surfaced outside the per-step path. */
    recordInferenceRunIds(ids: string[]): void;
    /** Build the final bundle. */
    build(input: {
        stopReason: ProofBundle["stopReason"];
        finishedAt: number;
    }): ProofBundle;
}

/**
 * Build a proof accumulator scoped to one plan run.
 *
 * `planHash` is computed once at the call site (plan is known up front).
 * `startedAt` is the wall clock when the runner first entered runCalPlan.
 */
export function createProofAccumulator(input: {
    planId: string;
    composeRunId: string;
    rootComposeRunId: string;
    agentWallet: string;
    userAddress?: string;
    startedAt: number;
    planHash: string;
}): ProofAccumulator {
    const steps: ProofStepRecord[] = [];
    const runIds = new Set<string>();
    let sandbox: ProofSandboxMetadata | undefined;

    return {
        recordStep(record) {
            steps.push(record);
            for (const id of record.inferenceRunIds ?? []) {
                if (id) runIds.add(id);
            }
        },
        recordSandbox(metadata) {
            sandbox = metadata;
        },
        recordInferenceRunIds(ids) {
            for (const id of ids) {
                if (id) runIds.add(id);
            }
        },
        build({ stopReason, finishedAt }) {
            return {
                schemaVersion: "compose.proof.v1",
                planId: input.planId,
                composeRunId: input.composeRunId,
                rootComposeRunId: input.rootComposeRunId,
                agentWallet: input.agentWallet,
                userAddress: input.userAddress,
                startedAt: input.startedAt,
                finishedAt,
                stopReason,
                steps,
                planHash: input.planHash,
                inferenceRunIds: Array.from(runIds).sort(),
                ...(sandbox ? { sandbox } : {}),
            };
        },
    };
}

// ---------------------------------------------------------------------------
// EVM signing
// ---------------------------------------------------------------------------

/**
 * Sign a bundle with the api gateway's signer and attach `composeSig` +
 * `composeSigner`. We DON'T sign here directly — the runtime doesn't have
 * the api signer's key. Instead the runtime POSTs to the api's signing
 * endpoint, which holds the key.
 *
 * Phase 5 will wire the on-the-wire endpoint shape; for now this helper
 * leaves the sig fields blank (verifiers can still hash-check the bundle
 * without the sig). The function exists so the call site is stable when
 * Phase 5 lands.
 */
export async function signProofBundle(bundle: ProofBundle): Promise<ProofBundle> {
    // Placeholder: leave sig blank. The bundle is still useful as a
    // hash-anchored artifact. Phase 5 wires the real signing path through
    // a dedicated api endpoint that holds the signer key.
    return bundle;
}

// ---------------------------------------------------------------------------
// Pinata pinning
// ---------------------------------------------------------------------------

interface PinataPinResponse {
    IpfsHash: string;
    PinSize: number;
    Timestamp: string;
}

/**
 * Pin a proof bundle to Pinata IPFS. Returns the CIDv1.
 *
 * Mirrors the canonical pattern from `web/src/lib/pinata.ts`:
 * `pinJSONToIPFS` with `pinataContent` + `pinataMetadata` +
 * `pinataOptions: { cidVersion: 1 }`. Authenticated by `PINATA_JWT`.
 *
 * Returns null when Pinata is not configured (caller logs the warning).
 */
export async function pinProofBundleToIPFS(bundle: ProofBundle): Promise<string | null> {
    const jwt = process.env.PINATA_JWT;
    if (!jwt) {
        console.warn("[harness:proof] PINATA_JWT not set, skipping proof pinning");
        return null;
    }
    const response = await fetch(`${requirePinataApiUrl()}/pinning/pinJSONToIPFS`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${jwt}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            pinataContent: bundle,
            pinataMetadata: {
                name: `compose-proof-${bundle.planId}`,
                keyvalues: {
                    type: "compose-proof",
                    schemaVersion: bundle.schemaVersion,
                    composeRunId: bundle.composeRunId,
                    rootComposeRunId: bundle.rootComposeRunId,
                    agentWallet: bundle.agentWallet,
                    stopReason: bundle.stopReason,
                },
            },
            pinataOptions: { cidVersion: 1 },
        }),
        signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
        const body = await response.text().catch(() => "");
        console.warn(`[harness:proof] pinata pin failed (${response.status}): ${body.slice(0, 240)}`);
        return null;
    }
    const parsed = (await response.json()) as PinataPinResponse;
    return typeof parsed?.IpfsHash === "string" ? parsed.IpfsHash : null;
}
