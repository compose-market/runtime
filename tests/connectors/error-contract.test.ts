import { describe, expect, it } from "vitest";

// Pure-logic helpers we can test without a running Worker. The full
// inspect path needs a CF Worker environment to exercise (D1, R2). Here
// we cover the critical derivations.

import { detectFromStderr, formatMissingMessage, detectRequiredVars } from "../../src/connectors/worker/credentials.js";

describe("connectors error message contract", () => {
    it("formatMissingMessage matches the literal string runtime/src/connectors/client.ts emits", () => {
        expect(formatMissingMessage(["NOTION_API_KEY"]))
            .toBe("MCP credentials required: NOTION_API_KEY");
        expect(formatMissingMessage(["A", "B"]))
            .toBe("MCP credentials required: A, B");
    });

    it("'requires credentials: X' remains a recognized signal", () => {
        const stderr = `Server "mcp:notion" requires credentials: NOTION_API_KEY. Add your API key via the Backpack credentials.`;
        expect(detectFromStderr(stderr)).toEqual(["NOTION_API_KEY"]);
    });

    it("detectRequiredVars merges JSON-RPC and stderr signals without duplicates", () => {
        const result = detectRequiredVars({
            stderr: "Missing environment variable: SHARED_KEY",
            jsonRpcEnvelope: { error: { code: -32602, data: { envVar: "SHARED_KEY" } } },
            evidenceKey: "key-1",
        });
        expect(result.varNames).toEqual(["SHARED_KEY"]);
        expect(result.evidenceKey).toBe("key-1");
    });
});
