import { beforeEach, describe, expect, it, vi } from "vitest";

const runnerMock = vi.hoisted(() => ({
    profiles: [] as Array<string | null | undefined>,
}));

vi.mock("@cloudflare/containers", () => ({
    getRandom: async () => {
        throw new Error("container binding should not be used in verify state-machine tests");
    },
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
        listToolsViaRunner: async (_env: unknown, _serverId: string, _config: unknown, input: { runnerProfile?: string | null }) => {
            runnerMock.profiles.push(input.runnerProfile);
            throw new RunnerDispatchError({
                code: "MCP_SPAWN_TIMEOUT",
                message: `MCP runner timed out for ${input.runnerProfile}`,
                retryable: true,
            });
        },
    };
});

import { runVerifyShard } from "../../src/connectors/workflows/verify.js";
import type { CatalogCandidate } from "../../src/connectors/workflows/candidates.js";

class MemoryR2Object {
    key: string;
    size: number;
    etag = "etag";
    httpEtag = "etag";
    uploaded = new Date();
    httpMetadata = { contentType: "application/json" };

    constructor(key: string, private readonly value: string) {
        this.key = key;
        this.size = value.length;
    }

    async json<T>(): Promise<T> {
        return JSON.parse(this.value) as T;
    }

    async text(): Promise<string> {
        return this.value;
    }
}

class MemoryR2 {
    objects = new Map<string, string>();

    async get(key: string): Promise<MemoryR2Object | null> {
        const value = this.objects.get(key);
        return value === undefined ? null : new MemoryR2Object(key, value);
    }

    async put(key: string, value: string): Promise<MemoryR2Object> {
        this.objects.set(key, value);
        return new MemoryR2Object(key, value);
    }

    async delete(key: string): Promise<void> {
        this.objects.delete(key);
    }

    async head(key: string): Promise<MemoryR2Object | null> {
        return await this.get(key);
    }

    async list(options: { prefix?: string; cursor?: string; limit?: number } = {}) {
        const keys = [...this.objects.keys()]
            .filter((key) => !options.prefix || key.startsWith(options.prefix))
            .sort();
        return {
            objects: keys.map((key) => new MemoryR2Object(key, this.objects.get(key)!)),
            truncated: false,
        };
    }
}

class MemoryD1 {
    cursors = new Map<number, { shard_count: number; r2_cursor: string | null; done: number }>();
    screenings = new Map<string, { status: string; errors: string; updated_at: string }>();
    retryQueue = new Map<string, { candidate_key: string; retry_class: string; attempts: number }>();
    attempts: Array<{
        server_slug: string;
        source_hash: string;
        stage: string;
        transport_kind: string;
        runner_profile: string | null;
        attempt_no: number;
        status: "success" | "failed";
        retry_class: string;
        error_code: string | null;
        error_message: string | null;
        latency_ms: number | null;
        observed_tools: number;
        attempted_at: string;
    }> = [];

    prepare(query: string) {
        const db = this;
        const bindings: unknown[] = [];
        return {
            bind(...values: unknown[]) {
                bindings.splice(0, bindings.length, ...values);
                return this;
            },
            async first<T>() {
                if (query.includes("FROM verification_cursor WHERE shard_id")) {
                    return (db.cursors.get(Number(bindings[0])) ?? null) as T | null;
                }
                if (query.includes("FROM candidate_screenings") && query.includes("status IN ('functional'")) {
                    const key = `${bindings[0]}:${bindings[1]}`;
                    const row = db.screenings.get(key);
                    return row && ["functional", "credential_gated", "shadowed"].includes(row.status)
                        ? ({ status: row.status } as T)
                        : null;
                }
                if (query.includes("FROM spawn_attempts")) {
                    const row = db.attempts.find((attempt) =>
                        attempt.server_slug === bindings[0] &&
                        attempt.source_hash === bindings[1] &&
                        attempt.stage === bindings[2] &&
                        attempt.transport_kind === bindings[3] &&
                        attempt.runner_profile === (bindings[4] as string | null) &&
                        attempt.attempt_no === Number(bindings[5]));
                    return row ? ({
                        status: row.status,
                        retry_class: row.retry_class,
                        error_code: row.error_code,
                        error_message: row.error_message,
                        latency_ms: row.latency_ms,
                        observed_tools: row.observed_tools,
                        attempted_at: row.attempted_at,
                    } as T) : null;
                }
                return null;
            },
            async run() {
                if (query.includes("INSERT INTO verification_cursor")) {
                    db.cursors.set(Number(bindings[0]), {
                        shard_count: Number(bindings[1]),
                        r2_cursor: bindings[3] as string | null,
                        done: Number(bindings[4]),
                    });
                }
                if (query.includes("INSERT INTO candidate_screenings")) {
                    db.screenings.set(`${bindings[0]}:${bindings[1]}`, {
                        status: String(bindings[5]),
                        errors: String(bindings[8]),
                        updated_at: new Date().toISOString(),
                    });
                }
                if (query.includes("INSERT INTO candidate_retry_queue")) {
                    const key = `${bindings[0]}:${bindings[1]}`;
                    const current = db.retryQueue.get(key);
                    db.retryQueue.set(key, {
                        candidate_key: String(bindings[4]),
                        retry_class: String(bindings[5]),
                        attempts: (current?.attempts ?? 0) + 1,
                    });
                }
                if (query.includes("DELETE FROM candidate_retry_queue")) {
                    db.retryQueue.delete(`${bindings[0]}:${bindings[1]}`);
                }
                if (query.includes("INSERT INTO spawn_attempts")) {
                    const row = {
                        server_slug: String(bindings[1]),
                        source_hash: String(bindings[2]),
                        stage: String(bindings[4]),
                        transport_kind: String(bindings[5]),
                        runner_profile: bindings[6] as string | null,
                        attempt_no: Number(bindings[8]),
                        status: bindings[9] as "success" | "failed",
                        retry_class: String(bindings[10]),
                        error_code: bindings[11] as string | null,
                        error_message: bindings[12] as string | null,
                        latency_ms: bindings[13] as number | null,
                        observed_tools: Number(bindings[14]),
                        attempted_at: new Date().toISOString(),
                    };
                    const index = db.attempts.findIndex((attempt) =>
                        attempt.server_slug === row.server_slug &&
                        attempt.source_hash === row.source_hash &&
                        attempt.stage === row.stage &&
                        attempt.transport_kind === row.transport_kind &&
                        attempt.runner_profile === row.runner_profile &&
                        attempt.attempt_no === row.attempt_no);
                    if (index >= 0) db.attempts[index] = row;
                    else db.attempts.push(row);
                }
                return { success: true, meta: { duration: 0, changes: 1 } };
            },
            async all<T>() {
                return { success: true, results: [] as T[], meta: { duration: 0 } };
            },
        };
    }
}

function candidate(): CatalogCandidate {
    return {
        slug: "needs-runner",
        namespace: "acme",
        rawName: "acme/needs-runner",
        rawDescription: "Needs a runner",
        tags: [],
        repoUrl: null,
        image: null,
        statefulness: "unknown",
        sourceVersion: "v0:1.0.0",
        sourceHash: "hash123",
        rawKey: "raw/pages/1.json",
        transports: [{
            transport: "npx",
            package: "@acme/needs-runner",
            image: null,
            remoteUrl: null,
            protocol: null,
            args: [],
            envRequired: [],
            envOptional: [],
            priority: 80,
        }],
        credentials: [],
        rawTools: [],
    };
}

function envWith(raw: MemoryR2, snapshots: MemoryR2, d1: MemoryD1) {
    return {
        RAW: raw,
        SNAPSHOTS: snapshots,
        CATALOG: d1,
        MCP_RUNNER: {},
        MCP_RUNNER_BASIC: {},
        MCP_RUNNER_STANDARD_1: {},
        MCP_RUNNER_STANDARD_2: {},
    };
}

describe("verify retry state machine", () => {
    beforeEach(() => {
        runnerMock.profiles = [];
    });

    it("tries every configured runner profile for retryable failures, then shadows instead of reparking", async () => {
        const raw = new MemoryR2();
        const snapshots = new MemoryR2();
        const d1 = new MemoryD1();
        const c = candidate();
        await raw.put("candidates/needs-runner/hash123.json", JSON.stringify(c));

        const first = await runVerifyShard(envWith(raw, snapshots, d1) as never, { shardId: 0, shardCount: 1, limit: 10 });

        expect(first.examined).toBe(1);
        expect(first.retryable).toBe(0);
        expect(first.shadowed).toBe(1);
        expect(runnerMock.profiles).toEqual(["lite", "basic", "standard-1", "standard-2"]);
        expect(d1.attempts.map((attempt) => attempt.runner_profile)).toEqual(["lite", "basic", "standard-1", "standard-2"]);
        expect(await raw.get("candidates/needs-runner/hash123.json")).toBeNull();
        expect(await snapshots.get("shadows/needs-runner/hash123.json")).not.toBeNull();
        expect(d1.screenings.get("needs-runner:hash123")?.status).toBe("shadowed");
    });

    it("resumes legacy retry-queue objects through the terminal state machine", async () => {
        const raw = new MemoryR2();
        const snapshots = new MemoryR2();
        const d1 = new MemoryD1();
        const c = candidate();
        await raw.put("retry-queue/needs-runner/hash123.json", JSON.stringify({ candidate: c }));
        d1.retryQueue.set("needs-runner:hash123", {
            candidate_key: "retry-queue/needs-runner/hash123.json",
            retry_class: "runner_capacity",
            attempts: 1,
        });

        const report = await runVerifyShard(envWith(raw, snapshots, d1) as never, { shardId: 0, shardCount: 1, limit: 10 });

        expect(report.examined).toBe(1);
        expect(report.retryable).toBe(0);
        expect(report.shadowed).toBe(1);
        expect(await raw.get("retry-queue/needs-runner/hash123.json")).toBeNull();
        expect(d1.retryQueue.has("needs-runner:hash123")).toBe(false);
    });
});
