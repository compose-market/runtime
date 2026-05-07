import { beforeEach, describe, expect, it, vi } from "vitest";

const runSeedMock = vi.hoisted(() => vi.fn());
const runVerifyShardMock = vi.hoisted(() => vi.fn());
const runMetadataAgentMock = vi.hoisted(() => vi.fn());
const runPublishMock = vi.hoisted(() => vi.fn());
const runEmbedMock = vi.hoisted(() => vi.fn());
const runHealthMock = vi.hoisted(() => vi.fn());
const runGcMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/connectors/workflows/seed.js", () => ({ runSeed: runSeedMock }));
vi.mock("../../src/connectors/workflows/verify.js", () => ({ runVerifyShard: runVerifyShardMock }));
vi.mock("../../src/connectors/workflows/metadata/agents.js", () => ({ runMetadataAgent: runMetadataAgentMock }));
vi.mock("../../src/connectors/workflows/publish.js", () => ({ runPublish: runPublishMock }));
vi.mock("../../src/connectors/workflows/embed.js", () => ({ runEmbed: runEmbedMock }));
vi.mock("../../src/connectors/workflows/health.js", () => ({ runHealth: runHealthMock }));
vi.mock("../../src/connectors/workflows/gc.js", () => ({ runGc: runGcMock }));

import { runConnectorCatalogPipeline, type WorkflowStepLike } from "../../src/connectors/workflows/pipeline/pipeline.js";

function createStep(names: string[] = []): WorkflowStepLike {
    return {
        async do(name, _config, callback) {
            names.push(name);
            return await callback();
        },
        async sleep(name) {
            names.push(name);
        },
    };
}

function createEnv(options: {
    activeWorkerRoles?: Set<string>;
    publishBacklog?: number;
    embedBacklog?: number;
} = {}) {
    const created: Array<{ id?: string; params?: Record<string, unknown> }> = [];
    const statuses = new Map<string, unknown>();
    const stmt = (query: string) => {
        let params: unknown[] = [];
        const statement = {
            bind(...values: unknown[]) {
                params = values;
                return statement;
            },
            async first() {
                if (query.includes("SELECT root_id FROM pipeline_runs")) return { root_id: "root" };
                if (query.includes("SELECT current_stage FROM pipeline_runs")) return { current_stage: null };
                if (query.includes("SELECT input FROM pipeline_runs")) return null;
                if (query.includes("FROM pipeline_lock")) return null;
                if (query.includes("json_extract(input, '$.workerRole')")) {
                    const activeRoles = options.activeWorkerRoles || new Set<string>();
                    return params.some((value) => activeRoles.has(String(value))) ? { active: 1 } : null;
                }
                if (query.includes("FROM metadata_agent_reviews r")) return { n: options.publishBacklog ?? 0 };
                if (query.includes("FROM servers s") && query.includes("embedding_state")) return { n: options.embedBacklog ?? 0 };
                return null;
            },
            async all() { return { success: true, results: [] }; },
            async run() { return { success: true, meta: { duration: 0, changes: 1 } }; },
            async raw() { return []; },
        };
        return statement;
    };
    return {
        created,
        env: {
            CATALOG: {
                prepare: stmt,
                async batch() { return []; },
                async exec() { return { count: 0, duration: 0 }; },
            },
            CATALOG_PIPELINE: {
                async create(options: { id?: string; params?: Record<string, unknown> }) {
                    created.push(options);
                    if (options.id && !statuses.has(options.id)) statuses.set(options.id, { status: "queued" });
                    return {
                        id: options.id || "created-workflow",
                        async status() {
                            return options.id ? statuses.get(options.id) || { status: "queued" } : { status: "queued" };
                        },
                    };
                },
                async get(id: string) {
                    return {
                        id,
                        async status() {
                            return statuses.get(id) || { status: "running" };
                        },
                    };
                },
            },
        },
        statuses,
    };
}

function verifyReport(done: boolean) {
    return {
        started_at: "2026-05-07T00:00:00.000Z",
        finished_at: "2026-05-07T00:00:00.000Z",
        shard_id: 0,
        shard_count: 1,
        done,
        scanned: 1,
        examined: 1,
        functional: 0,
        credential_gated: 0,
        retryable: 0,
        shadowed: 0,
        skipped: 0,
        errors: [],
    };
}

describe("parallel connector catalog pipeline", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        runSeedMock.mockResolvedValue({
            started_at: "2026-05-07T00:00:00.000Z",
            finished_at: "2026-05-07T00:00:00.000Z",
            pages: 0,
            processed: 0,
            candidates_archived: 0,
            done: true,
        });
        runVerifyShardMock.mockResolvedValue(verifyReport(true));
        runMetadataAgentMock.mockResolvedValue({
            started_at: "2026-05-07T00:00:00.000Z",
            finished_at: "2026-05-07T00:00:00.000Z",
            agent_id: 0,
            lane_id: 0,
            lane_count: 1,
            reviewer: "metadata-agent-0:gemini-2.5-flash",
            examined: 0,
            completed: 0,
            credential_gated: 0,
            retryable: 0,
            skipped: 0,
            errors: [],
        });
        runPublishMock.mockResolvedValue({
            started_at: "2026-05-07T00:00:00.000Z",
            finished_at: "2026-05-07T00:00:00.000Z",
            examined: 0,
            published: 0,
            skipped: 0,
            errors: [],
        });
        runEmbedMock.mockResolvedValue({
            started_at: "2026-05-07T00:00:00.000Z",
            finished_at: "2026-05-07T00:00:00.000Z",
            embedded: 0,
            skipped: 0,
            errors: [],
        });
        runHealthMock.mockResolvedValue({ ok: true });
        runGcMock.mockResolvedValue({ ok: true });
    });

    it("supervisor starts seed, verify, metadata, publish, and embed worker groups before polling", async () => {
        const { env, created } = createEnv();

        await runConnectorCatalogPipeline(env as never, {
            payload: {
                mode: "first-pass",
                supervisorPolls: 1,
                verifyWorkerCount: 2,
                metadataWorkerCount: 3,
                publishWorkerCount: 2,
                embedWorkerCount: 2,
                shardCount: 2,
            },
            timestamp: new Date(),
            instanceId: "root",
        }, createStep());

        const roles = created.map((entry) => entry.params?.workerRole).filter(Boolean);
        expect(roles).toEqual(expect.arrayContaining([
            "seed-worker",
            "verify-worker",
            "metadata-worker",
            "publish-worker",
            "embed-worker",
        ]));
        expect(created.findIndex((entry) => entry.params?.workerRole === "publish-worker")).toBeGreaterThan(-1);
        expect(created.findIndex((entry) => entry.params?.workerRole === "embed-worker")).toBeGreaterThan(-1);
    });

    it("continues a verify worker slice instead of throwing when its budget is exhausted", async () => {
        const { env, created } = createEnv();
        runVerifyShardMock.mockResolvedValue(verifyReport(false));

        const result = await runConnectorCatalogPipeline(env as never, {
            payload: {
                mode: "first-pass",
                stage: "verify",
                workerRole: "verify-worker",
                workerIndex: 0,
                verifyWorkerCount: 1,
                verifyIterations: 1,
                shardCount: 1,
            },
            timestamp: new Date(),
            instanceId: "verify-worker-0",
        }, createStep());

        expect(result.pipeline_complete).toBe(false);
        expect(result.continued_to).toBeTruthy();
        expect(created.at(-1)?.params).toMatchObject({ workerRole: "verify-worker", stage: "verify" });
    });

    it("keeps publish and embed worker failures item-local at the workflow layer", async () => {
        const publishEnv = createEnv();
        runPublishMock.mockRejectedValueOnce(new Error("publish item failed"));

        const publish = await runConnectorCatalogPipeline(publishEnv.env as never, {
            payload: {
                mode: "first-pass",
                stage: "publish",
                workerRole: "publish-worker",
                workerIndex: 0,
                publishWorkerCount: 1,
                publishIterations: 1,
            },
            timestamp: new Date(),
            instanceId: "publish-worker-0",
        }, createStep());

        const embedEnv = createEnv();
        runEmbedMock.mockRejectedValueOnce(new Error("embed item failed"));
        const embed = await runConnectorCatalogPipeline(embedEnv.env as never, {
            payload: {
                mode: "first-pass",
                stage: "embed",
                workerRole: "embed-worker",
                workerIndex: 0,
                embedWorkerCount: 1,
                embedIterations: 1,
            },
            timestamp: new Date(),
            instanceId: "embed-worker-0",
        }, createStep());

        expect(publish.status).toBe("complete");
        expect(publish.progress.publish.iterations).toBe(1);
        expect(publish.pipeline_complete).toBe(false);
        expect(embed.status).toBe("complete");
        expect(embed.progress.embed.iterations).toBe(1);
        expect(embed.pipeline_complete).toBe(false);
    });

    it("keeps an idle embed worker alive while upstream publish can still produce rows", async () => {
        const { env, created } = createEnv({ activeWorkerRoles: new Set(["publish-worker"]) });
        const steps: string[] = [];

        const result = await runConnectorCatalogPipeline(env as never, {
            payload: {
                mode: "first-pass",
                stage: "embed",
                workerRole: "embed-worker",
                workerIndex: 0,
                embedWorkerCount: 1,
                embedIterations: 1,
            },
            timestamp: new Date(),
            instanceId: "embed-worker-0",
        }, createStep(steps));

        expect(result.pipeline_complete).toBe(false);
        expect(result.continued_to).toBeTruthy();
        expect(steps).toContain("embed-worker-0-idle-1");
        expect(created.at(-1)?.params).toMatchObject({ workerRole: "embed-worker", stage: "embed" });
    });

    it("keeps an idle embed worker alive when embedding backlog exists", async () => {
        const { env, created } = createEnv({ embedBacklog: 437 });

        const result = await runConnectorCatalogPipeline(env as never, {
            payload: {
                mode: "first-pass",
                stage: "embed",
                workerRole: "embed-worker",
                workerIndex: 0,
                embedWorkerCount: 1,
                embedIterations: 1,
            },
            timestamp: new Date(),
            instanceId: "embed-worker-0",
        }, createStep());

        expect(result.pipeline_complete).toBe(false);
        expect(result.continued_to).toBeTruthy();
        expect(created.at(-1)?.params).toMatchObject({ workerRole: "embed-worker", stage: "embed" });
    });

    it("keeps an idle publish worker alive while metadata can still produce rows", async () => {
        const { env, created } = createEnv({ activeWorkerRoles: new Set(["metadata-worker"]) });

        const result = await runConnectorCatalogPipeline(env as never, {
            payload: {
                mode: "first-pass",
                stage: "publish",
                workerRole: "publish-worker",
                workerIndex: 0,
                publishWorkerCount: 1,
                publishIterations: 1,
            },
            timestamp: new Date(),
            instanceId: "publish-worker-0",
        }, createStep());

        expect(result.pipeline_complete).toBe(false);
        expect(result.continued_to).toBeTruthy();
        expect(created.at(-1)?.params).toMatchObject({ workerRole: "publish-worker", stage: "publish" });
    });
});
