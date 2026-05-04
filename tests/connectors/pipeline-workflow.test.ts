import { describe, expect, it, vi } from "vitest";
import { __test as pipelineConfigTest, createPipelineRunId } from "../../src/connectors/workflows/pipeline/config.js";
import { runSeed } from "../../src/connectors/workflows/seed.js";

describe("connector catalog pipeline workflow", () => {
    it("uses first-pass defaults for a complete Cloudflare-owned catalog fill", () => {
        const input = pipelineConfigTest.normalizePipelineInput({ mode: "first-pass" });

        expect(input.stage).toBe("seed");
        expect(input.seedMaxPages).toBe(1);
        expect(input.seedCandidateLimit).toBe(10);
        expect(input.seedIterations).toBe(60);
        expect(input.shardCount).toBe(12);
        expect(input.verifyParallelism).toBe(12);
        expect(input.verifyIterations).toBe(40);
        expect(input.metadataParallelism).toBe(3);
        expect(input.metadataIterations).toBe(80);
        expect(input.publishLimit).toBe(100);
        expect(input.embedLimit).toBe(100);
    });

    it("keeps maintenance smaller than first-pass and clamps unsafe limits", () => {
        const input = pipelineConfigTest.normalizePipelineInput({
            mode: "maintenance",
            stage: "publish",
            seedMaxPages: 999,
            seedCandidateLimit: 999,
            seedIterations: 9999,
            verifyLimit: 999,
            verifyParallelism: 999,
            metadataLimit: 999,
            metadataParallelism: 999,
            shardCount: 999,
        });

        expect(input.mode).toBe("maintenance");
        expect(input.stage).toBe("publish");
        expect(input.seedMaxPages).toBe(64);
        expect(input.seedCandidateLimit).toBe(25);
        expect(input.seedIterations).toBe(80);
        expect(input.verifyLimit).toBe(200);
        expect(input.verifyParallelism).toBe(64);
        expect(input.metadataLimit).toBe(100);
        expect(input.metadataParallelism).toBe(16);
        expect(input.shardCount).toBe(64);
    });

    it("creates deterministic-looking workflow ids without embedding secrets", () => {
        const id = createPipelineRunId("first-pass", new Date("2026-05-03T22:30:00.000Z"));

        expect(id).toMatch(/^connector-catalog-first-pass-20260503223000-[0-9a-f-]{8}$/);
    });

    it("does not let Workflow replay make visible progress move backward", async () => {
        expect(pipelineConfigTest.isStageRegression("verify:24", "verify:7")).toBe(true);
        expect(pipelineConfigTest.isStageRegression("verify:24", "verify:25")).toBe(false);
        expect(pipelineConfigTest.isStageRegression("verify:24", "metadata-agents:1")).toBe(false);
    });

    it("skips seed without fetching the registry once the seed cursor is terminal", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        const env = {
            CATALOG: {
                prepare(query: string) {
                    return {
                        bind() { return this; },
                        async first() {
                            if (query.includes("SELECT cursor, page_offset, complete")) {
                                return { cursor: null, page_offset: 0, complete: 1 };
                            }
                            return null;
                        },
                        async run() { return { success: true }; },
                    };
                },
            },
            MCP_REGISTRY_URL: "https://registry.modelcontextprotocol.io/v0/servers",
        };

        const report = await runSeed(env as never, { maxPages: 1 });

        expect(report).toMatchObject({ done: true, pages: 0, processed: 0, candidates_archived: 0 });
        expect(fetchSpy).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
    });
});
