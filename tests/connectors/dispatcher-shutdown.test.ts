import { beforeEach, describe, expect, it, vi } from "vitest";

const containerMock = vi.hoisted(() => ({
    shutdowns: 0,
    inspectCalls: 0,
}));

vi.mock("@cloudflare/containers", () => ({
    getRandom: async () => ({
        async fetch(input: Request | string) {
            const url = typeof input === "string" ? input : input.url;
            if (url.endsWith("/shutdown")) {
                containerMock.shutdowns++;
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }
            containerMock.inspectCalls++;
            throw new Error("fetch failed before response");
        },
    }),
}));

vi.mock("../../src/connectors/node_modules/@cloudflare/containers/dist/index.js", () => ({
    getRandom: async () => ({
        async fetch(input: Request | string) {
            const url = typeof input === "string" ? input : input.url;
            if (url.endsWith("/shutdown")) {
                containerMock.shutdowns++;
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }
            containerMock.inspectCalls++;
            throw new Error("fetch failed before response");
        },
    }),
}));

import { listToolsViaRunner } from "../../src/connectors/container/dispatcher.js";

describe("runner dispatcher shutdown", () => {
    beforeEach(() => {
        containerMock.shutdowns = 0;
        containerMock.inspectCalls = 0;
    });

    it("requests container shutdown when the runner fetch fails before a response exists", async () => {
        await expect(listToolsViaRunner({
            MCP_RUNNER: {},
            MCP_RUNNER_SHUTDOWN_AFTER_REQUEST: "true",
        } as never, "server", {
            transport: "npx",
            package: "@acme/fails",
            args: [],
            env: {},
            envRequired: [],
            envOptional: [],
        })).rejects.toThrow("fetch failed before response");

        expect(containerMock.inspectCalls).toBe(1);
        expect(containerMock.shutdowns).toBe(1);
    });
});
