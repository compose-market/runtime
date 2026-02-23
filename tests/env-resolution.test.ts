import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

async function importFresh<T = unknown>(path: string): Promise<T> {
    vi.resetModules();
    return await import(`${path}?t=${Date.now()}`) as T;
}

afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
});

describe("agent env resolution", () => {
    it("loads callbacks with API_URL alias when LAMBDA_API_URL is missing", async () => {
        delete process.env.LAMBDA_API_URL;
        process.env.API_URL = "https://api.compose.market";

        const mod = await importFresh<{ Mem0CallbackHandler: unknown }>("../callbacks.ts");
        expect(mod.Mem0CallbackHandler).toBeDefined();
    });

    it("loads tools with API_URL and RUNTIME_URL aliases", async () => {
        delete process.env.LAMBDA_API_URL;
        delete process.env.RUNTIME_SERVICE_URL;
        process.env.API_URL = "https://api.compose.market";
        process.env.RUNTIME_URL = "https://runtime.compose.market";
        process.env.MANOWAR_INTERNAL_SECRET = "test-internal-secret";

        const mod = await importFresh<{ createAgentTools: unknown; createMem0Tools: unknown }>("../tools.ts");
        expect(mod.createAgentTools).toBeDefined();
        expect(mod.createMem0Tools).toBeDefined();
    });

    it("fails fast when lambda url aliases are missing", async () => {
        delete process.env.LAMBDA_API_URL;
        delete process.env.API_URL;
        process.env.RUNTIME_URL = "https://runtime.compose.market";
        process.env.MANOWAR_INTERNAL_SECRET = "test-internal-secret";

        await expect(importFresh("../tools.ts")).rejects.toThrow(/LAMBDA_API_URL or API_URL is required/);
    });
});
