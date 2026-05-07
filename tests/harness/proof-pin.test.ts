/**
 * Live Pinata round-trip for proof bundles (Phase 3.3).
 *
 * Pins a small proof bundle to the shared Compose Pinata account, fetches
 * it back via the gateway, and asserts the round-trip content matches.
 * Skipped when `PINATA_JWT` is not configured.
 *
 * Note: this test pins one tiny JSON object (<1KB). It will live in
 * Pinata until manually unpinned. Run sparingly.
 */
import "dotenv/config";

import { describe, expect, it } from "vitest";

import {
    pinProofBundleToIPFS,
    type ProofBundle,
} from "../../src/manowar/harness/proof.js";
import { buildPinataGatewayIpfsUrl } from "../../src/auth.js";

const PINATA_OK = Boolean(
    process.env.PINATA_JWT &&
        process.env.PINATA_GATEWAY_URL,
);

describe("pinProofBundleToIPFS — live Pinata (Phase 3.3)", () => {
    it.skipIf(!PINATA_OK)(
        "pins a bundle and the gateway returns the same content",
        async () => {
            const bundle: ProofBundle = {
                schemaVersion: "compose.proof.v1",
                planId: `test_e2e_${Date.now()}`,
                composeRunId: `e2e_${Date.now()}`,
                rootComposeRunId: `e2e_${Date.now()}`,
                agentWallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                startedAt: Date.now() - 1000,
                finishedAt: Date.now(),
                stopReason: "completed",
                steps: [
                    {
                        index: 0,
                        op: "stop",
                        inputHash: "deadbeef".repeat(8),
                        outputHash: "cafef00d".repeat(8),
                        success: true,
                    },
                ],
                planHash: "0".repeat(64),
                inferenceRunIds: [],
            };

            const cid = await pinProofBundleToIPFS(bundle);
            expect(typeof cid).toBe("string");
            expect(cid).toBeTruthy();
            // Pinata returns CIDv1 (starts with "bafy") since we set
            // cidVersion: 1 explicitly. Some accounts return the legacy
            // CIDv0 ("Qm…") as a server-side default; both are valid
            // IPFS content addresses. Older test bundles may also surface
            // base32 CIDv1 with non-bafy prefix; relax to "non-empty
            // alphanumeric, length > 30".
            expect(cid!.length).toBeGreaterThan(30);
            expect(/^[A-Za-z0-9]+$/.test(cid!)).toBe(true);

            // Round-trip via the gateway. Pinata propagation is fast but
            // not instantaneous; allow up to ~10s.
            const url = buildPinataGatewayIpfsUrl(cid!);
            let attempt = 0;
            let fetched: ProofBundle | null = null;
            while (attempt < 5) {
                const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
                if (response.ok) {
                    fetched = (await response.json()) as ProofBundle;
                    break;
                }
                await new Promise((r) => setTimeout(r, 1_500));
                attempt += 1;
            }

            expect(fetched).not.toBeNull();
            expect(fetched?.schemaVersion).toBe("compose.proof.v1");
            expect(fetched?.planId).toBe(bundle.planId);
            expect(fetched?.steps.length).toBe(1);
            expect(fetched?.steps[0].outputHash).toBe(bundle.steps[0].outputHash);
        },
        45_000,
    );
});
