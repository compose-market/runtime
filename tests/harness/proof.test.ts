/**
 * Tests for the cal-plan proof bundle (Phase 3.3)
 * `runtime/src/manowar/harness/proof.ts`.
 *
 * Pure-unit tests — no Pinata round-trip, no Redis. The accompanying
 * `proof-pin.test.ts` exercises the live Pinata pin path against the
 * shared Compose Pinata account when `PINATA_JWT` is configured.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    canonicalJson,
    createProofAccumulator,
    hashValue,
    pinProofBundleToIPFS,
    type ProofBundle,
} from "../../src/manowar/harness/proof.js";

describe("canonicalJson — stable serialization (Phase 3.3)", () => {
    it("primitives serialize like JSON.stringify", () => {
        expect(canonicalJson("a")).toBe('"a"');
        expect(canonicalJson(123)).toBe("123");
        expect(canonicalJson(true)).toBe("true");
        expect(canonicalJson(null)).toBe("null");
    });

    it("sorts object keys deterministically", () => {
        const a = canonicalJson({ b: 1, a: 2 });
        const b = canonicalJson({ a: 2, b: 1 });
        expect(a).toBe(b);
        expect(a).toBe('{"a":2,"b":1}');
    });

    it("sorts nested keys recursively", () => {
        const value = { outer: { z: 1, a: 2 }, list: [{ b: 1, a: 2 }] };
        expect(canonicalJson(value)).toBe(
            '{"list":[{"a":2,"b":1}],"outer":{"a":2,"z":1}}',
        );
    });

    it("preserves array order", () => {
        expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    });
});

describe("hashValue — sha256 of canonical JSON (Phase 3.3)", () => {
    it("produces a stable 64-char hex digest", () => {
        const h = hashValue({ planId: "x", step: 1 });
        expect(h).toMatch(/^[0-9a-f]{64}$/);
    });

    it("returns the same hash for objects with reordered keys", () => {
        const a = hashValue({ b: 1, a: 2 });
        const b = hashValue({ a: 2, b: 1 });
        expect(a).toBe(b);
    });

    it("returns DIFFERENT hashes for different content", () => {
        const a = hashValue({ x: 1 });
        const b = hashValue({ x: 2 });
        expect(a).not.toBe(b);
    });
});

describe("createProofAccumulator — Phase 3.3", () => {
    it("builds a bundle with the expected schema fields", () => {
        const acc = createProofAccumulator({
            planId: "test_plan",
            composeRunId: "test_run",
            rootComposeRunId: "test_run",
            agentWallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            startedAt: 1_000,
            planHash: "deadbeef",
        });
        const bundle = acc.build({ stopReason: "completed", finishedAt: 2_000 });
        expect(bundle.schemaVersion).toBe("compose.proof.v1");
        expect(bundle.planId).toBe("test_plan");
        expect(bundle.composeRunId).toBe("test_run");
        expect(bundle.rootComposeRunId).toBe("test_run");
        expect(bundle.agentWallet).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        expect(bundle.startedAt).toBe(1_000);
        expect(bundle.finishedAt).toBe(2_000);
        expect(bundle.stopReason).toBe("completed");
        expect(bundle.steps).toEqual([]);
        expect(bundle.planHash).toBe("deadbeef");
        expect(bundle.inferenceRunIds).toEqual([]);
        expect(bundle.sandbox).toBeUndefined();
    });

    it("records steps in the order they're appended", () => {
        const acc = createProofAccumulator({
            planId: "p",
            composeRunId: "r",
            rootComposeRunId: "r",
            agentWallet: "0xa",
            startedAt: 0,
            planHash: "h",
        });
        acc.recordStep({
            index: 0,
            op: "task",
            saveAs: "s1",
            inputHash: "in1",
            outputHash: "out1",
            success: true,
        });
        acc.recordStep({
            index: 1,
            op: "stop",
            inputHash: "in2",
            outputHash: "out2",
            success: true,
        });
        const bundle = acc.build({ stopReason: "stop_op", finishedAt: 1 });
        expect(bundle.steps.map((s) => s.index)).toEqual([0, 1]);
        expect(bundle.steps[0].saveAs).toBe("s1");
        expect(bundle.steps[1].op).toBe("stop");
    });

    it("dedupes inferenceRunIds across steps", () => {
        const acc = createProofAccumulator({
            planId: "p",
            composeRunId: "r",
            rootComposeRunId: "r",
            agentWallet: "0xa",
            startedAt: 0,
            planHash: "h",
        });
        acc.recordStep({
            index: 0,
            op: "task",
            inputHash: "in1",
            outputHash: "out1",
            success: true,
            inferenceRunIds: ["sub:r:t1:d1", "sub:r:t2:d1"],
        });
        acc.recordStep({
            index: 1,
            op: "task",
            inputHash: "in2",
            outputHash: "out2",
            success: true,
            inferenceRunIds: ["sub:r:t1:d1"], // duplicate, should drop
        });
        acc.recordInferenceRunIds(["sub:r:t3:d1", "sub:r:t1:d1"]); // mixed
        const bundle = acc.build({ stopReason: "completed", finishedAt: 1 });
        expect(bundle.inferenceRunIds).toEqual([
            "sub:r:t1:d1",
            "sub:r:t2:d1",
            "sub:r:t3:d1",
        ]);
    });

    it("attaches sandbox metadata when set", () => {
        const acc = createProofAccumulator({
            planId: "p",
            composeRunId: "r",
            rootComposeRunId: "r",
            agentWallet: "0xa",
            startedAt: 0,
            planHash: "h",
        });
        acc.recordSandbox({
            sandboxId: "sandbox_123",
            snapshotId: "snap_xyz",
            imageRef: "compose/runner@sha256:abcd",
            startedAt: 100,
            finishedAt: 200,
            exitCode: 0,
        });
        const bundle = acc.build({ stopReason: "completed", finishedAt: 300 });
        expect(bundle.sandbox?.sandboxId).toBe("sandbox_123");
        expect(bundle.sandbox?.exitCode).toBe(0);
    });

    it("ignores empty / non-string inferenceRunIds", () => {
        const acc = createProofAccumulator({
            planId: "p",
            composeRunId: "r",
            rootComposeRunId: "r",
            agentWallet: "0xa",
            startedAt: 0,
            planHash: "h",
        });
        acc.recordStep({
            index: 0,
            op: "task",
            inputHash: "i",
            outputHash: "o",
            success: true,
            inferenceRunIds: ["", "valid"],
        });
        const bundle = acc.build({ stopReason: "completed", finishedAt: 1 });
        expect(bundle.inferenceRunIds).toEqual(["valid"]);
    });
});

describe("pinProofBundleToIPFS — Pinata wiring (Phase 3.3)", () => {
    const ORIGINAL_FETCH = globalThis.fetch;
    const ORIGINAL_JWT = process.env.PINATA_JWT;

    beforeEach(() => {
        process.env.PINATA_JWT = "test-jwt";
    });

    afterEach(() => {
        globalThis.fetch = ORIGINAL_FETCH;
        if (ORIGINAL_JWT === undefined) delete process.env.PINATA_JWT;
        else process.env.PINATA_JWT = ORIGINAL_JWT;
    });

    function mockPinata(payload: unknown, status = 200): Array<{ url: string; body: string }> {
        const calls: Array<{ url: string; body: string }> = [];
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input.toString();
            calls.push({ url, body: typeof init?.body === "string" ? init.body : "" });
            return new Response(JSON.stringify(payload), {
                status,
                headers: { "Content-Type": "application/json" },
            });
        }) as typeof fetch;
        return calls;
    }

    it("returns null when PINATA_JWT is not set", async () => {
        delete process.env.PINATA_JWT;
        const bundle: ProofBundle = makeMinimalBundle();
        const cid = await pinProofBundleToIPFS(bundle);
        expect(cid).toBeNull();
    });

    it("posts to /pinning/pinJSONToIPFS and returns the IpfsHash", async () => {
        const calls = mockPinata({
            IpfsHash: "bafytestcid",
            PinSize: 100,
            Timestamp: "2026-05-05T00:00:00Z",
        });
        const bundle = makeMinimalBundle();
        const cid = await pinProofBundleToIPFS(bundle);
        expect(cid).toBe("bafytestcid");
        expect(calls.length).toBe(1);
        expect(calls[0].url).toMatch(/\/pinning\/pinJSONToIPFS$/);
    });

    it("includes pinataMetadata.keyvalues with composeRunId + agentWallet", async () => {
        const calls = mockPinata({
            IpfsHash: "bafytest",
            PinSize: 0,
            Timestamp: "",
        });
        const bundle = makeMinimalBundle();
        await pinProofBundleToIPFS(bundle);
        const sent = JSON.parse(calls[0].body);
        expect(sent.pinataContent.planId).toBe(bundle.planId);
        expect(sent.pinataMetadata.keyvalues.composeRunId).toBe(bundle.composeRunId);
        expect(sent.pinataMetadata.keyvalues.agentWallet).toBe(bundle.agentWallet);
        expect(sent.pinataMetadata.keyvalues.type).toBe("compose-proof");
        expect(sent.pinataOptions.cidVersion).toBe(1);
    });

    it("returns null on non-200 (logs the warning)", async () => {
        mockPinata({ error: "unauthorized" }, 401);
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const cid = await pinProofBundleToIPFS(makeMinimalBundle());
        expect(cid).toBeNull();
        const calls = warnSpy.mock.calls.map((c) => c.join(" "));
        expect(calls.some((m) => m.includes("pinata pin failed"))).toBe(true);
        warnSpy.mockRestore();
    });
});

function makeMinimalBundle(): ProofBundle {
    process.env.PINATA_GATEWAY_URL = "compose.mypinata.cloud";
    return {
        schemaVersion: "compose.proof.v1",
        planId: "test_plan_123",
        composeRunId: "test_run_456",
        rootComposeRunId: "test_run_456",
        agentWallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        startedAt: 0,
        finishedAt: 1,
        stopReason: "completed",
        steps: [],
        planHash: "h",
        inferenceRunIds: [],
    };
}
