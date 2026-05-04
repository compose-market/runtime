import { describe, expect, it } from "vitest";
import { __test as attemptsTest } from "../../src/connectors/workflows/attempts.js";

describe("connector spawn attempt classification", () => {
    it("separates capacity, protocol, unavailable, credentials, and permanent failures", () => {
        expect(attemptsTest.classifySpawnFailure({
            transport: "npx",
            message: "npx probe timed out after 20000ms",
        })).toMatchObject({ retryClass: "runner_capacity", retryable: true });

        expect(attemptsTest.classifySpawnFailure({
            transport: "npx",
            message: "Bad Request: No valid session ID provided",
        })).toMatchObject({ retryClass: "transport_protocol", retryable: true });

        expect(attemptsTest.classifySpawnFailure({
            transport: "docker",
            message: "docker transport requires ENABLE_DOCKER_TRANSPORT and a Docker-capable runner",
        })).toMatchObject({ retryClass: "transport_unavailable", retryable: true });

        expect(attemptsTest.classifySpawnFailure({
            transport: "http",
            message: "credentials required: NOTION_API_KEY",
            credentialVars: ["NOTION_API_KEY"],
        })).toMatchObject({ retryClass: "credentials_required", retryable: false });

        expect(attemptsTest.classifySpawnFailure({
            transport: "http",
            message: "server returned zero tools",
        })).toMatchObject({ retryClass: "permanent_invalid", retryable: false });
    });

    it("uses configured runner profiles without inventing unavailable compute tiers", () => {
        expect(attemptsTest.profilesForTransport({ MCP_RUNNER: {} } as never, "npx")).toEqual(["lite"]);
        expect(attemptsTest.profilesForTransport({
            MCP_RUNNER: {},
            MCP_RUNNER_BASIC: {},
            MCP_RUNNER_STANDARD_1: {},
        } as never, "docker")).toEqual(["lite", "basic", "standard-1"]);
        expect(attemptsTest.profilesForTransport({} as never, "http")).toEqual([]);
    });
});
