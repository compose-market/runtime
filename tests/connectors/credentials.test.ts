import { describe, expect, it } from "vitest";
import {
    detectFromJsonRpc,
    detectFromStderr,
    detectRequiredVars,
    formatMissingMessage,
} from "../../src/connectors/worker/credentials.js";

describe("credentials.detectFromJsonRpc", () => {
    it("extracts envVar from -32602 error envelope", () => {
        const payload = {
            jsonrpc: "2.0",
            error: { code: -32602, message: "missing env", data: { envVar: "GITHUB_TOKEN" } },
        };
        expect(detectFromJsonRpc(payload)).toEqual(["GITHUB_TOKEN"]);
    });

    it("extracts required array", () => {
        const payload = {
            error: { code: -32602, data: { required: ["A_TOKEN", "B_TOKEN"] } },
        };
        expect(detectFromJsonRpc(payload)).toEqual(["A_TOKEN", "B_TOKEN"]);
    });

    it("ignores non -32602 errors", () => {
        const payload = { error: { code: -32601, data: { envVar: "X_TOKEN" } } };
        expect(detectFromJsonRpc(payload)).toEqual([]);
    });

    it("returns empty for non-object input", () => {
        expect(detectFromJsonRpc(null)).toEqual([]);
        expect(detectFromJsonRpc("error")).toEqual([]);
    });
});

describe("credentials.detectFromStderr", () => {
    it("matches structured 'requires credentials: X' messages", () => {
        expect(detectFromStderr('Server "mcp:notion" requires credentials: NOTION_API_KEY')).toEqual(["NOTION_API_KEY"]);
    });

    it("matches structured 'credentials required: X' messages from spawn preflight", () => {
        expect(detectFromStderr("credentials required: STRIPE_SECRET_KEY")).toEqual(["STRIPE_SECRET_KEY"]);
    });

    it("matches Missing environment variable: X", () => {
        expect(detectFromStderr("Error: Missing environment variable: STRIPE_SECRET_KEY")).toEqual(["STRIPE_SECRET_KEY"]);
    });

    it("matches X is not set / not defined / not configured", () => {
        expect(detectFromStderr("AIRTABLE_TOKEN is not set")).toEqual(["AIRTABLE_TOKEN"]);
        expect(detectFromStderr("PINECONE_KEY is not defined")).toEqual(["PINECONE_KEY"]);
        expect(detectFromStderr("HF_TOKEN is not configured")).toEqual(["HF_TOKEN"]);
    });

    it("matches ERR_INVALID_ENV variants", () => {
        const msg = "Error [ERR_INVALID_ENV]: invalid value for OPENAI_API_KEY";
        expect(detectFromStderr(msg)).toEqual(["OPENAI_API_KEY"]);
    });

    it("filters reserved generic names", () => {
        expect(detectFromStderr("SERVER environment variable required")).toEqual([]);
        expect(detectFromStderr("API is not set")).toEqual([]);
    });

    it("is empty for unrelated stderr", () => {
        expect(detectFromStderr("connection closed cleanly")).toEqual([]);
    });
});

describe("credentials.detectRequiredVars", () => {
    it("merges signals and dedupes", () => {
        const result = detectRequiredVars({
            stderr: "Missing environment variable: SHARED_TOKEN",
            jsonRpcEnvelope: { error: { code: -32602, data: { envVar: "SHARED_TOKEN" } } },
            evidenceKey: "snapshots/x/y.json",
        });
        expect(result.varNames).toEqual(["SHARED_TOKEN"]);
        expect(result.evidenceKey).toBe("snapshots/x/y.json");
    });
});

describe("credentials.formatMissingMessage", () => {
    it("matches the canonical format the runtime client reads", () => {
        expect(formatMissingMessage(["A", "B"])).toBe("MCP credentials required: A, B");
    });
});
