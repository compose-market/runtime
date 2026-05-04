import { describe, expect, it } from "vitest";
import { __test as publishTest } from "../../src/connectors/workflows/publish.js";
import { __test as reviewTest } from "../../src/connectors/workflows/metadata/review.js";
import { hashShard, metadataArtifactObjectKey, metadataLaneShard, screeningObjectKey } from "../../src/connectors/workflows/screening.js";

function baseArtifact(overrides: Record<string, unknown> = {}) {
    return {
        slug: "payments",
        sourceHash: "abc123",
        sourceVersion: "v0:1.0.0",
        agentId: 0,
        reviewer: "metadata-agent-0:gemini-2.5-flash",
        status: "complete",
        catalogStatus: "live",
        card: {
            name: "Payments",
            description: "Observed payment operations exposed by the MCP server.",
            tags: ["payments", "commerce"],
        },
        cardVersion: "card123",
        candidate: {
            slug: "payments",
            namespace: "acme",
            rawName: "io.github.acme/payments-mcp",
            rawDescription: "Raw description",
            tags: [],
            repoUrl: "https://github.com/acme/payments-mcp",
            image: null,
            statefulness: "unknown",
            sourceVersion: "v0:1.0.0",
            sourceHash: "abc123",
            rawKey: "raw/pages/first.json",
            transports: [],
            credentials: [],
            rawTools: [{ name: "guessed_tool", description: "registry-only" }],
        },
        observedTools: [{
            name: "charge",
            description: "Create a charge",
            inputSchema: { type: "object", properties: { amount: { type: "number" } } },
        }],
        observedSchemas: { charge: { type: "object", properties: { amount: { type: "number" } } } },
        observedTransports: [{
            transport: {
                transport: "http",
                package: null,
                image: null,
                remoteUrl: "https://example.com/mcp",
                protocol: "streamable-http",
                args: [],
                envRequired: [],
                envOptional: [],
                priority: 100,
            },
            tools: [{
                name: "charge",
                description: "Create a charge",
                inputSchema: { type: "object", properties: { amount: { type: "number" } } },
            }],
            latencyMs: 123,
            observedAt: "2026-05-03T00:00:00.000Z",
        }],
        credentialVars: [],
        sourceScreeningKey: "screenings/payments/abc123.json",
        reviewedAt: "2026-05-03T00:00:00.000Z",
        ...overrides,
    };
}

describe("metadata pipeline gates", () => {
    it("requires observed tools, schemas, and transports before publishing live rows", () => {
        expect(publishTest.validateArtifact(baseArtifact()).ok).toBe(true);
        expect(publishTest.validateArtifact(baseArtifact({ observedTools: [] })).ok).toBe(false);
        expect(publishTest.validateArtifact(baseArtifact({ observedSchemas: {} })).ok).toBe(false);
        expect(publishTest.validateArtifact(baseArtifact({ observedTransports: [] })).ok).toBe(false);
    });

    it("allows credential-gated artifacts only when credential evidence exists", () => {
        expect(publishTest.validateArtifact(baseArtifact({
            catalogStatus: "credential_gated",
            observedTools: [],
            observedSchemas: {},
            observedTransports: [],
            credentialVars: ["STRIPE_SECRET_KEY"],
        })).ok).toBe(true);
        expect(publishTest.validateArtifact(baseArtifact({
            catalogStatus: "credential_gated",
            observedTools: [],
            observedSchemas: {},
            observedTransports: [],
            credentialVars: [],
        })).ok).toBe(false);
    });

    it("uses stable shard and artifact keys for idempotent retries", () => {
        expect(hashShard("payments:abc123", 3)).toBe(hashShard("payments:abc123", 3));
        expect(screeningObjectKey({ slug: "payments", sourceHash: "abc123" })).toBe("screenings/payments/abc123.json");
        expect(metadataArtifactObjectKey({ slug: "payments", sourceHash: "abc123", agentId: 2 })).toBe("metadata-agents/payments/abc123/agent-2.json");
    });

    it("splits each canonical metadata agent into deterministic execution lanes", () => {
        const row = { server_slug: "payments", source_hash: "abc123" };
        const lane = metadataLaneShard(row, 3);

        expect(lane).toBeGreaterThanOrEqual(0);
        expect(lane).toBeLessThan(3);
        expect(metadataLaneShard(row, 3)).toBe(lane);
        expect(metadataLaneShard(row, 1)).toBe(0);
    });

    it("publishes only the latest canonical shard review per server", () => {
        const canonicalOld = hashShard("payments:old", 3);
        const canonicalNew = hashShard("payments:new", 3);
        const nonCanonicalNew = (canonicalNew + 1) % 3;
        const rows = [
            {
                server_slug: "payments",
                source_hash: "old",
                source_version: "v0:old",
                agent_id: canonicalOld,
                artifact_key: "metadata-agents/payments/old/agent.json",
                card_version: "old-card",
                reviewed_at: "2026-05-01T00:00:00.000Z",
            },
            {
                server_slug: "payments",
                source_hash: "new",
                source_version: "v0:new",
                agent_id: nonCanonicalNew,
                artifact_key: "metadata-agents/payments/new/wrong-agent.json",
                card_version: "wrong-card",
                reviewed_at: "2026-05-03T00:00:00.000Z",
            },
            {
                server_slug: "payments",
                source_hash: "new",
                source_version: "v0:new",
                agent_id: canonicalNew,
                artifact_key: "metadata-agents/payments/new/agent.json",
                card_version: "new-card",
                reviewed_at: "2026-05-02T00:00:00.000Z",
            },
        ];

        expect(publishTest.selectLatestCanonicalRows(rows, 10).map((row) => row.card_version)).toEqual(["new-card"]);
    });

    it("honors persisted canonical agent ids when selecting publishable reviews", () => {
        const rows = [
            {
                server_slug: "calendar",
                source_hash: "hash",
                source_version: "v0:1",
                agent_id: 1,
                canonical_agent_id: 0,
                artifact_key: "metadata-agents/calendar/hash/agent-1.json",
                card_version: "wrong-agent",
                reviewed_at: "2026-05-03T00:00:00.000Z",
            },
            {
                server_slug: "calendar",
                source_hash: "hash",
                source_version: "v0:1",
                agent_id: 0,
                canonical_agent_id: 0,
                artifact_key: "metadata-agents/calendar/hash/agent-0.json",
                card_version: "right-agent",
                reviewed_at: "2026-05-02T00:00:00.000Z",
            },
        ];

        expect(publishTest.selectLatestCanonicalRows(rows, 10).map((row) => row.card_version)).toEqual(["right-agent"]);
    });

    it("accepts fenced model JSON without rewriting model decisions", () => {
        const card = reviewTest.parseStrict("```json\n{\"name\":\"Payments MCP Server\",\"description\":\"Observed payment operations for creating and checking charges.\",\"tags\":[\"payments\",\"commerce\",\"billing\"]}\n```");
        expect(card).toEqual({
            name: "Payments MCP Server",
            description: "Observed payment operations for creating and checking charges.",
            tags: ["payments", "commerce", "billing"],
        });
    });

    it("extracts Workers AI text from REST-wrapped chat responses", () => {
        expect(reviewTest.extractAiText({
            result: {
                choices: [{
                    message: {
                        content: "{\"name\":\"Calendar\",\"description\":\"Observed calendar scheduling operations for events and availability.\",\"tags\":[\"calendar\",\"scheduling\"]}",
                    },
                }],
            },
        })).toContain("\"Calendar\"");
    });

});
