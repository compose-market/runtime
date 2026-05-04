import { describe, expect, it } from "vitest";
import {
    DEFAULT_OUTBOUND_ACCEPT,
    DEFAULT_OUTBOUND_USER_AGENT,
    applyOutboundFetchDefaults,
    withOutboundFetchDefaults,
} from "../../src/connectors/worker/outbound.js";

describe("connector outbound fetch defaults", () => {
    it("adds descriptive defaults without replacing caller headers", () => {
        const init = withOutboundFetchDefaults("https://example.com", {
            method: "POST",
            headers: {
                "User-Agent": "custom-agent/1.0",
                "X-Test": "1",
            },
        });
        const headers = new Headers(init.headers);

        expect(headers.get("User-Agent")).toBe("custom-agent/1.0");
        expect(headers.get("Accept")).toBe(DEFAULT_OUTBOUND_ACCEPT);
        expect(headers.get("X-Test")).toBe("1");
        expect(init.method).toBe("POST");
    });

    it("installs a single universal Worker fetch wrapper", async () => {
        const calls: RequestInit[] = [];
        const scope = {
            fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
                calls.push(init || {});
                return new Response("ok");
            },
        } as unknown as typeof globalThis;

        applyOutboundFetchDefaults(scope);
        applyOutboundFetchDefaults(scope);
        await scope.fetch("https://example.com");

        expect(calls).toHaveLength(1);
        const headers = new Headers(calls[0].headers);
        expect(headers.get("User-Agent")).toBe(DEFAULT_OUTBOUND_USER_AGENT);
        expect(headers.get("Accept")).toBe(DEFAULT_OUTBOUND_ACCEPT);
    });
});
