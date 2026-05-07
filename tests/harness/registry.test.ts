/**
 * Tests for the registered-agent validator
 * (Phase 3.1 follow-up — `runtime/src/manowar/harness/registry.ts`).
 *
 * Compose enforces agent-only swarms: every cal `task` / `delegate`
 * step must target a registered on-chain agent. Raw model ids stay
 * accessible as TOOLS (image gen, embeddings, transcription) but are
 * never swarm participants.
 *
 * The validator hits `GET ${API_URL}/agent/${wallet}` and caches
 * results for 5 minutes. Failure modes:
 *   - 404 → cached as "not registered"
 *   - 200 → cached as "registered"
 *   - network error / 5xx → returns null (don't cache, don't trust)
 *   - missing or non-EVM wallet → returns false fast (no fetch)
 *
 * `ensureRegisteredAgent` throws `UnregisteredAgentError` when the
 * lookup is anything other than `true`. Cal interpreter catches and
 * fails the step.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    UnregisteredAgentError,
    clearAgentRegistryCache,
    ensureRegisteredAgent,
    isRegisteredAgent,
} from "../../src/manowar/harness/registry.js";

const ORIGINAL_FETCH = globalThis.fetch;
let lastFetchUrl: string | null = null;

function mockAgentRegistry(status: number, body: unknown = {}): void {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        lastFetchUrl = url;
        return new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json" },
        });
    }) as typeof fetch;
}

function mockAgentRegistryError(): void {
    globalThis.fetch = (async () => {
        throw new Error("ENOTFOUND api.compose.market");
    }) as typeof fetch;
}

beforeEach(() => {
    process.env.API_URL = "https://api.compose.market";
    process.env.RUNTIME_INTERNAL_SECRET = "test-secret";
    clearAgentRegistryCache();
    lastFetchUrl = null;
});

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
});

describe("isRegisteredAgent — wallet shape gating", () => {
    it("returns false fast for empty / undefined wallet (no fetch)", async () => {
        mockAgentRegistry(404);
        expect(await isRegisteredAgent("")).toBe(false);
        expect(lastFetchUrl).toBeNull();
    });

    it("returns false fast for non-EVM-shaped wallet (no fetch)", async () => {
        mockAgentRegistry(404);
        expect(await isRegisteredAgent("not-a-wallet")).toBe(false);
        expect(await isRegisteredAgent("0xshort")).toBe(false);
        expect(await isRegisteredAgent("gpt-4o")).toBe(false);
        expect(lastFetchUrl).toBeNull();
    });
});

describe("isRegisteredAgent — registry resolution", () => {
    it("returns true on 200", async () => {
        mockAgentRegistry(200, { walletAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
        expect(await isRegisteredAgent("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(true);
        expect(lastFetchUrl).toBe("https://api.compose.market/agent/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    });

    it("returns false on 404", async () => {
        mockAgentRegistry(404, { error: "Agent not found" });
        expect(await isRegisteredAgent("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toBe(false);
    });

    it("returns null on network error (don't cache)", async () => {
        mockAgentRegistryError();
        const result = await isRegisteredAgent("0xcccccccccccccccccccccccccccccccccccccccc");
        expect(result).toBeNull();
    });

    it("returns null on 5xx (don't cache)", async () => {
        mockAgentRegistry(503, { error: "Service unavailable" });
        const result = await isRegisteredAgent("0xdddddddddddddddddddddddddddddddddddddddd");
        expect(result).toBeNull();
    });
});

describe("isRegisteredAgent — caching", () => {
    it("caches positive results (single fetch for repeated lookups)", async () => {
        let fetchCount = 0;
        globalThis.fetch = (async () => {
            fetchCount += 1;
            return new Response("{}", { status: 200 });
        }) as typeof fetch;

        const wallet = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
        expect(await isRegisteredAgent(wallet)).toBe(true);
        expect(await isRegisteredAgent(wallet)).toBe(true);
        expect(await isRegisteredAgent(wallet)).toBe(true);
        expect(fetchCount).toBe(1);
    });

    it("caches negative results (404)", async () => {
        let fetchCount = 0;
        globalThis.fetch = (async () => {
            fetchCount += 1;
            return new Response("{}", { status: 404 });
        }) as typeof fetch;

        const wallet = "0xffffffffffffffffffffffffffffffffffffffff";
        expect(await isRegisteredAgent(wallet)).toBe(false);
        expect(await isRegisteredAgent(wallet)).toBe(false);
        expect(fetchCount).toBe(1);
    });

    it("does NOT cache transient failures (network / 5xx)", async () => {
        let fetchCount = 0;
        globalThis.fetch = (async () => {
            fetchCount += 1;
            return new Response("{}", { status: 503 });
        }) as typeof fetch;

        const wallet = "0x1111111111111111111111111111111111111111";
        await isRegisteredAgent(wallet);
        await isRegisteredAgent(wallet);
        await isRegisteredAgent(wallet);
        expect(fetchCount).toBe(3);
    });
});

describe("ensureRegisteredAgent — throwing variant", () => {
    it("returns silently for a registered agent", async () => {
        mockAgentRegistry(200);
        await expect(
            ensureRegisteredAgent("task", "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        ).resolves.toBeUndefined();
    });

    it("throws UnregisteredAgentError on missing wallet", async () => {
        await expect(ensureRegisteredAgent("task", undefined)).rejects.toBeInstanceOf(UnregisteredAgentError);
        await expect(ensureRegisteredAgent("delegate", "")).rejects.toBeInstanceOf(UnregisteredAgentError);
    });

    it("throws on 404 (unregistered agent)", async () => {
        mockAgentRegistry(404);
        await expect(
            ensureRegisteredAgent("task", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
        ).rejects.toBeInstanceOf(UnregisteredAgentError);
    });

    it("throws on raw model id", async () => {
        // Raw model id never matches EVM_WALLET_RE, so no fetch happens.
        await expect(
            ensureRegisteredAgent("delegate", "gpt-4o"),
        ).rejects.toBeInstanceOf(UnregisteredAgentError);
    });

    it("throws on transient failure (fail closed)", async () => {
        mockAgentRegistryError();
        await expect(
            ensureRegisteredAgent("task", "0xcccccccccccccccccccccccccccccccccccccccc"),
        ).rejects.toBeInstanceOf(UnregisteredAgentError);
    });

    it("error message names the wallet and tells the caller what to do", async () => {
        mockAgentRegistry(404);
        try {
            await ensureRegisteredAgent("task", "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
            expect.fail("should have thrown");
        } catch (error) {
            expect(error).toBeInstanceOf(UnregisteredAgentError);
            const message = (error as Error).message;
            expect(message).toContain("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
            expect(message).toContain("task");
            expect(message).toContain("registered agent");
            // Also names the legitimate raw-model use case so the dev knows
            // how to migrate (use tool surface for image / audio / etc).
            expect(message).toMatch(/tool surface/i);
        }
    });
});
