/**
 * Integration test for `requireProof: true` in cal plans (Phase 3.3).
 *
 * Drives `runCalPlan` end-to-end with the proof flag set; mocks the
 * Pinata HTTP endpoint so the test is fully hermetic. Verifies that:
 *   - The bundle gets built with the right shape.
 *   - The CID is returned on `CalRunResult.proofCid`.
 *   - The Pinata gateway URL is computed on `CalRunResult.proofUrl`.
 *   - Pinning failure (401, 5xx, network) does NOT fail the plan —
 *     it just leaves `proofCid` undefined.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCalPlan } from "../../src/manowar/harness/interpreter.js";
import type { CalCheckpointStore } from "../../src/manowar/harness/checkpoint.js";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_PINATA_JWT = process.env.PINATA_JWT;
const ORIGINAL_PINATA_GATEWAY = process.env.PINATA_GATEWAY_URL;

function inMemoryStore(): CalCheckpointStore {
    let current: unknown = null;
    return {
        async save(c) {
            current = c;
        },
        async load() {
            return current as never;
        },
        async clear() {
            current = null;
        },
    };
}

const STUB_RESOLVE_TOOLS = async () => [];
const TEST_AGENT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

beforeEach(() => {
    process.env.PINATA_JWT = "test-jwt";
    process.env.PINATA_GATEWAY_URL = "compose.mypinata.cloud";
});

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_PINATA_JWT === undefined) delete process.env.PINATA_JWT;
    else process.env.PINATA_JWT = ORIGINAL_PINATA_JWT;
    if (ORIGINAL_PINATA_GATEWAY === undefined) delete process.env.PINATA_GATEWAY_URL;
    else process.env.PINATA_GATEWAY_URL = ORIGINAL_PINATA_GATEWAY;
});

describe("runCalPlan + requireProof (Phase 3.3)", () => {
    it("pins a bundle and returns proofCid + proofUrl on success", async () => {
        const calls: Array<{ url: string; body: unknown }> = [];
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input.toString();
            calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
            return new Response(
                JSON.stringify({
                    IpfsHash: "bafyfakecidthatisalsosixtyplus000000000000000000",
                    PinSize: 100,
                    Timestamp: "2026-05-05T00:00:00Z",
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
            );
        }) as typeof fetch;

        const result = await runCalPlan(
            {
                id: "phase33_proof_happy",
                steps: [
                    { op: "scratch", action: "write", key: "k1", value: "v1", saveAs: "s1" },
                    { op: "scratch", action: "read", key: "k1", saveAs: "s2" },
                    { op: "stop", output: "{{s2}}" },
                ],
                requireProof: true,
            },
            {
                agentWallet: TEST_AGENT,
                composeRunId: "proof-happy-run",
                resolveTools: STUB_RESOLVE_TOOLS,
                checkpointStore: inMemoryStore(),
                skipAgentRegistryCheck: true,
            },
        );

        expect(result.success).toBe(true);
        expect(result.proofCid).toBe("bafyfakecidthatisalsosixtyplus000000000000000000");
        expect(result.proofUrl).toContain("compose.mypinata.cloud/ipfs/");
        expect(result.proofUrl).toContain(result.proofCid!);

        // Exactly one Pinata call, on /pinning/pinJSONToIPFS.
        const pinCalls = calls.filter((c) => c.url.includes("/pinning/pinJSONToIPFS"));
        expect(pinCalls.length).toBe(1);
        const pinned = pinCalls[0].body as {
            pinataContent: { steps: unknown[]; planHash: string; planId: string };
            pinataMetadata: { keyvalues: { type: string; composeRunId: string } };
            pinataOptions: { cidVersion: number };
        };
        expect(pinned.pinataContent.planId).toBe("phase33_proof_happy");
        expect(pinned.pinataContent.steps.length).toBe(3);
        expect(pinned.pinataContent.planHash).toMatch(/^[0-9a-f]{64}$/);
        expect(pinned.pinataMetadata.keyvalues.type).toBe("compose-proof");
        expect(pinned.pinataMetadata.keyvalues.composeRunId).toBe("proof-happy-run");
        expect(pinned.pinataOptions.cidVersion).toBe(1);
    });

    it("does NOT fail the plan when Pinata returns 5xx", async () => {
        let pinCalls = 0;
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.includes("/pinning/pinJSONToIPFS")) {
                pinCalls += 1;
                return new Response("internal error", {
                    status: 503,
                    headers: { "Content-Type": "text/plain" },
                });
            }
            return new Response("{}", { status: 200 });
        }) as typeof fetch;

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const result = await runCalPlan(
            {
                id: "phase33_proof_5xx",
                steps: [{ op: "stop", output: "ok" }],
                requireProof: true,
            },
            {
                agentWallet: TEST_AGENT,
                composeRunId: "proof-5xx-run",
                resolveTools: STUB_RESOLVE_TOOLS,
                checkpointStore: inMemoryStore(),
                skipAgentRegistryCheck: true,
            },
        );

        expect(result.success).toBe(true);
        expect(result.output).toBe("ok");
        expect(result.proofCid).toBeUndefined();
        expect(result.proofUrl).toBeUndefined();
        expect(pinCalls).toBe(1);

        warnSpy.mockRestore();
    });

    it("does NOT pin when requireProof is omitted (default false)", async () => {
        let pinCalls = 0;
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.includes("/pinning/pinJSONToIPFS")) pinCalls += 1;
            return new Response("{}", { status: 200 });
        }) as typeof fetch;

        const result = await runCalPlan(
            {
                id: "phase33_no_proof",
                steps: [{ op: "stop", output: "ok" }],
                // no requireProof
            },
            {
                agentWallet: TEST_AGENT,
                composeRunId: "no-proof-run",
                resolveTools: STUB_RESOLVE_TOOLS,
                checkpointStore: inMemoryStore(),
                skipAgentRegistryCheck: true,
            },
        );

        expect(result.success).toBe(true);
        expect(result.proofCid).toBeUndefined();
        expect(pinCalls).toBe(0);
    });

    it("preserves requireIsolation field through validateCalPlan", async () => {
        // Phase 3.3 only commits to round-tripping the field today.
        // The boot/teardown of a plan-shared sandbox lands in Phase 4.
        const { parseCalPlan } = await import("../../src/manowar/harness/interpreter.js");
        const plan = parseCalPlan({
            id: "iso_field_round_trip",
            steps: [{ op: "stop", output: "x" }],
            requireIsolation: true,
            requireProof: false,
        });
        expect(plan.requireIsolation).toBe(true);
        expect(plan.requireProof).toBe(false);
    });
});
