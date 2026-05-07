import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/containers", () => ({
    getRandom: async () => {
        throw new Error("container binding should not be used in pipeline workflow tests");
    },
    Container: class {},
}));

vi.mock("../../src/connectors/container/dispatcher.js", () => {
    class RunnerDispatchError extends Error {
        code: string;
        credentialVars: string[];
        retryable: boolean;

        constructor(input: { code: string; message: string; credentialVars?: string[]; retryable?: boolean }) {
            super(input.message);
            this.name = "RunnerDispatchError";
            this.code = input.code;
            this.credentialVars = input.credentialVars || [];
            this.retryable = input.retryable ?? true;
        }
    }
    return {
        RunnerDispatchError,
        listToolsViaRunner: async () => {
            throw new RunnerDispatchError({ code: "MCP_RUNTIME_UNAVAILABLE", message: "mocked runner unavailable", retryable: false });
        },
    };
});

import { __test as pipelineConfigTest, createPipelineRunId } from "../../src/connectors/workflows/pipeline/config.js";
import { __test as pipelineTest, startConnectorCatalogPipeline } from "../../src/connectors/workflows/pipeline/pipeline.js";
import { runSeed } from "../../src/connectors/workflows/seed.js";

describe("connector catalog pipeline workflow", () => {
    it("uses first-pass defaults for a complete Cloudflare-owned catalog fill", () => {
        const input = pipelineConfigTest.normalizePipelineInput({ mode: "first-pass" });

        expect(input.stage).toBe("seed");
        expect(input.supervisorPolls).toBe(12);
        expect(input.seedWorkerCount).toBe(1);
        expect(input.seedMaxPages).toBe(1);
        expect(input.seedCandidateLimit).toBe(10);
        expect(input.seedIterations).toBe(30);
        expect(input.shardCount).toBe(48);
        expect(input.verifyLimit).toBe(10);
        expect(input.verifyParallelism).toBe(12);
        expect(input.verifyWorkerCount).toBe(12);
        expect(input.verifyIterations).toBe(64);
        expect(input.metadataLimit).toBe(5);
        expect(input.metadataParallelism).toBe(4);
        expect(input.metadataWorkerCount).toBe(12);
        expect(input.metadataIterations).toBe(64);
        expect(input.publishLimit).toBe(25);
        expect(input.publishWorkerCount).toBe(4);
        expect(input.embedLimit).toBe(25);
        expect(input.embedWorkerCount).toBe(4);
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
            verifyWorkerCount: 999,
            metadataLimit: 999,
            metadataParallelism: 999,
            metadataWorkerCount: 999,
            publishWorkerCount: 999,
            embedWorkerCount: 999,
            shardCount: 999,
        });

        expect(input.mode).toBe("maintenance");
        expect(input.stage).toBe("publish");
        expect(input.seedMaxPages).toBe(64);
        expect(input.seedCandidateLimit).toBe(25);
        expect(input.seedIterations).toBe(80);
        expect(input.verifyLimit).toBe(200);
        expect(input.verifyParallelism).toBe(64);
        expect(input.verifyWorkerCount).toBe(64);
        expect(input.metadataLimit).toBe(100);
        expect(input.metadataParallelism).toBe(16);
        expect(input.metadataWorkerCount).toBe(48);
        expect(input.publishWorkerCount).toBe(64);
        expect(input.embedWorkerCount).toBe(64);
        expect(input.shardCount).toBe(64);
    });

    it("defines every batch stage as an independently supervised worker role", () => {
        const input = pipelineConfigTest.normalizePipelineInput({ mode: "first-pass" });

        expect(pipelineTest.pipelineWorkerRoles).toEqual([
            "seed-worker",
            "verify-worker",
            "metadata-worker",
            "publish-worker",
            "embed-worker",
        ]);
        expect(pipelineTest.pipelineWorkerRoles.map((role) => pipelineTest.workerStage(role))).toEqual([
            "seed",
            "verify",
            "metadata",
            "publish",
            "embed",
        ]);
        expect(pipelineTest.pipelineWorkerRoles.map((role) => pipelineTest.workerCount(input, role))).toEqual([
            1,
            12,
            12,
            4,
            4,
        ]);
    });

    it("creates deterministic verify worker ids with disjoint shard groups", () => {
        const ids = Array.from({ length: 12 }, (_value, index) =>
            pipelineTest.workerPipelineId("connector-catalog-first-pass-20260503223000-abcdef12", "verify-worker", index),
        );
        const shardGroups = Array.from({ length: 12 }, (_value, index) =>
            pipelineTest.verifyWorkerShardIds(index, 12, 48),
        );
        const allShards = shardGroups.flat().sort((a, b) => a - b);

        expect(new Set(ids).size).toBe(12);
        expect(ids.every((id) => id.length <= 100)).toBe(true);
        expect(allShards).toEqual(Array.from({ length: 48 }, (_value, index) => index));
        expect(shardGroups.every((group) => group.length === 4)).toBe(true);
    });

    it("creates bounded retry worker ids for replacement workflows", () => {
        const base = "connector-catalog-first-pass-20260503223000-abcdef12";
        const retryA = pipelineTest.workerPipelineRetryId(base, "verify-worker", 8, 1, 12);
        const retryB = pipelineTest.workerPipelineRetryId(base, "verify-worker", 8, 2, 13);

        expect(retryA).not.toBe(retryB);
        expect(retryA).toContain("verify-worker-8");
        expect(retryB).toContain("verify-worker-8");
        expect(retryA.length).toBeLessThanOrEqual(100);
        expect(retryB.length).toBeLessThanOrEqual(100);
    });

    it("maps 12 metadata workers to three agents across four lanes without duplicates", () => {
        const assignments = Array.from({ length: 12 }, (_value, index) =>
            pipelineTest.metadataWorkerAssignment(index, 12),
        );
        const keys = assignments.map((assignment) => `${assignment.agentId}:${assignment.laneId}`);

        expect(new Set(keys).size).toBe(12);
        expect(assignments.every((assignment) => assignment.laneCount === 4)).toBe(true);
        expect(assignments.filter((assignment) => assignment.agentId === 0).map((assignment) => assignment.laneId)).toEqual([0, 1, 2, 3]);
        expect(assignments.filter((assignment) => assignment.agentId === 1).map((assignment) => assignment.laneId)).toEqual([0, 1, 2, 3]);
        expect(assignments.filter((assignment) => assignment.agentId === 2).map((assignment) => assignment.laneId)).toEqual([0, 1, 2, 3]);
    });

    it("starts worker workflows without claiming the singleton coordinator lock", async () => {
        const created: Array<{ id?: string; params?: unknown }> = [];
        const env = {
            CATALOG: {
                prepare(query: string) {
                    if (query.includes("pipeline_lock")) {
                        throw new Error(`worker should not touch pipeline_lock: ${query}`);
                    }
                    return {
                        bind() { return this; },
                        async first() { return null; },
                        async run() { return { success: true, meta: { duration: 0, changes: 1 } }; },
                    };
                },
            },
            CATALOG_PIPELINE: {
                async create(options: { id?: string; params?: unknown }) {
                    created.push(options);
                    return {
                        id: options.id || "worker-id",
                        async status() { return { status: "queued" }; },
                    };
                },
                async get(id: string) {
                    return {
                        id,
                        async status() { return { status: "queued" }; },
                    };
                },
            },
        };

        const report = await startConnectorCatalogPipeline(env as never, {
            mode: "first-pass",
            stage: "verify",
            workerRole: "verify-worker",
            workerIndex: 4,
            verifyWorkerCount: 12,
        }, {
            id: "root-verify-worker-4",
            rootId: "root",
            parentId: "root",
        });

        expect(report.id).toBe("root-verify-worker-4");
        expect(report.input.workerRole).toBe("verify-worker");
        expect(created).toHaveLength(1);
        expect(created[0]?.params).toMatchObject({ workerRole: "verify-worker", workerIndex: 4 });
    });

    it("reuses a running sibling worker instead of creating a duplicate lane", async () => {
        const created: Array<{ id?: string; params?: unknown }> = [];
        const activeInput = {
            mode: "first-pass",
            stage: "metadata",
            workerRole: "metadata-worker",
            workerIndex: 3,
            metadataWorkerCount: 12,
        };
        const env = {
            CATALOG: {
                prepare(query: string) {
                    return {
                        bind() { return this; },
                        async first() {
                            if (query.includes("FROM pipeline_runs") && query.includes("json_extract(input, '$.workerRole')")) {
                                return { id: "active-metadata-worker-3", input: JSON.stringify(activeInput) };
                            }
                            return null;
                        },
                        async run() { return { success: true, meta: { duration: 0, changes: 1 } }; },
                    };
                },
            },
            CATALOG_PIPELINE: {
                async create(options: { id?: string; params?: unknown }) {
                    created.push(options);
                    return {
                        id: options.id || "worker-id",
                        async status() { return { status: "queued" }; },
                    };
                },
                async get(id: string) {
                    return {
                        id,
                        async status() { return { status: "running" }; },
                    };
                },
            },
        };

        const report = await startConnectorCatalogPipeline(env as never, {
            mode: "first-pass",
            stage: "metadata",
            workerRole: "metadata-worker",
            workerIndex: 3,
            metadataWorkerCount: 12,
        }, {
            id: "duplicate-metadata-worker-3",
            rootId: "root",
            parentId: "root",
        });

        expect(report.id).toBe("active-metadata-worker-3");
        expect(report.reused_active).toBe(true);
        expect(created).toHaveLength(0);
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

    it("recognizes superseded worker stages as an in-band stop signal", async () => {
        expect(pipelineTest.isSupersededStage("superseded:duplicate-worker")).toBe(true);
        expect(pipelineTest.isSupersededStage("metadata-agents:12")).toBe(false);
        expect(pipelineTest.isSupersededStage(null)).toBe(false);
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
