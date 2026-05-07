import { describe, expect, it } from "vitest";
import {
    buildCandidateFromGhcrPackage,
    buildCandidateFromRegistryEntry,
    candidateObjectKey,
    declaredCredentialVars,
    isServedCatalogStatus,
    retryCandidateObjectKey,
    shadowObjectKey,
} from "../../src/connectors/workflows/candidates.js";

describe("connector candidate state", () => {
    it("turns registry entries into R2 candidates without serving metadata", async () => {
        const candidate = await buildCandidateFromRegistryEntry(
            {
                server: {
                    name: "io.github.acme/payments-mcp",
                    title: "Acme Payments MCP Server",
                    description: "Raw registry description",
                    version: "1.2.3",
                    repository: { url: "https://github.com/acme/payments-mcp" },
                    packages: [{
                        registryType: "npm",
                        identifier: "@acme/payments-mcp",
                        environmentVariables: [
                            { name: "STRIPE_SECRET_KEY", description: "Stripe key", isSecret: true },
                            { name: "LOG_LEVEL", isSecret: false },
                        ],
                    }],
                    remotes: [{ type: "streamable-http", url: "https://acme.example/mcp" }],
                },
                _meta: { "io.modelcontextprotocol.registry/official": { isLatest: true } },
            },
            { payments: "ghcr.io/compose-market/mcp/payments:latest" },
            "raw/pages/first.json",
        );

        expect(candidate.slug).toBe("payments");
        expect(candidate.rawName).toBe("io.github.acme/payments-mcp");
        expect(candidate.rawDescription).toBe("Raw registry description");
        expect(candidate.transports.map((t) => t.transport)).toEqual(["http", "npx", "docker"]);
        expect(declaredCredentialVars(candidate)).toEqual(["STRIPE_SECRET_KEY"]);
        expect(candidateObjectKey(candidate)).toMatch(/^candidates\/payments\/[a-f0-9]{64}\.json$/);
        expect(retryCandidateObjectKey(candidate)).toMatch(/^retry-queue\/payments\/[a-f0-9]{64}\.json$/);
        expect(shadowObjectKey(candidate)).toMatch(/^shadows\/payments\/[a-f0-9]{64}\.json$/);
    });

    it("turns GHCR MCP packages into equal Docker candidates", async () => {
        const candidate = await buildCandidateFromGhcrPackage(
            {
                packageName: "mcp/mesh-agent",
                slug: "mesh-agent",
                image: "ghcr.io/compose-market/mcp/mesh-agent:latest",
                tag: "latest",
                updatedAt: "2026-02-09T11:19:36Z",
            },
            "ghcr-index/v1.json",
        );

        expect(candidate?.slug).toBe("mesh-agent");
        expect(candidate?.namespace).toBe("compose-market");
        expect(candidate?.image).toBe("ghcr.io/compose-market/mcp/mesh-agent:latest");
        expect(candidate?.sourceVersion).toBe("ghcr:latest");
        expect(candidate?.transports).toEqual([{
            transport: "docker",
            package: null,
            image: "ghcr.io/compose-market/mcp/mesh-agent:latest",
            remoteUrl: null,
            protocol: null,
            args: [],
            envRequired: [],
            envOptional: [],
            priority: 60,
        }]);
    });

    it("serves only reviewed live or credential-gated catalog rows", () => {
        expect(isServedCatalogStatus("live")).toBe(true);
        expect(isServedCatalogStatus("credential_gated")).toBe(true);
        expect(isServedCatalogStatus("inspecting")).toBe(false);
        expect(isServedCatalogStatus("shadowed")).toBe(false);
        expect(isServedCatalogStatus("quarantined")).toBe(false);
    });
});
