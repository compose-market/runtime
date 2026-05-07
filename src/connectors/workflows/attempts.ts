import type { Env } from "../worker/env.js";

export type RunnerProfile = "lite" | "basic" | "standard-1" | "standard-2";
export type RetryClass =
    | "success"
    | "credentials_required"
    | "runner_transient"
    | "runner_capacity"
    | "transport_protocol"
    | "transport_unavailable"
    | "permanent_invalid";

export interface SpawnFailureClassification {
    retryClass: RetryClass;
    retryable: boolean;
    code: string;
}

export interface SpawnAttemptRecord {
    serverSlug: string;
    sourceHash: string;
    sourceVersion: string;
    stage: "verify" | "metadata";
    transportKind: string;
    runnerProfile?: string | null;
    deadlineMs?: number | null;
    attemptNo?: number;
    status: "success" | "failed";
    retryClass: RetryClass;
    errorCode?: string | null;
    errorMessage?: string | null;
    latencyMs?: number | null;
    observedTools?: number;
}

export interface SpawnAttemptLookup {
    serverSlug: string;
    sourceHash: string;
    stage: "verify" | "metadata";
    transportKind: string;
    runnerProfile?: string | null;
    attemptNo?: number;
}

export interface StoredSpawnAttempt {
    status: "success" | "failed";
    retryClass: RetryClass;
    errorCode: string | null;
    errorMessage: string | null;
    latencyMs: number | null;
    observedTools: number;
    attemptedAt: string;
}

function hashText(input: string): string {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

function spawnAttemptId(record: SpawnAttemptLookup): string {
    return `spawn-attempt-${hashText([
        record.serverSlug,
        record.sourceHash,
        record.stage,
        record.transportKind,
        record.runnerProfile ?? "remote",
        String(record.attemptNo ?? 1),
    ].join("\u001f"))}`;
}

export async function ensureSpawnAttemptSchema(env: Env): Promise<void> {
    await env.CATALOG.prepare(
        `CREATE TABLE IF NOT EXISTS spawn_attempts (
            id                 TEXT PRIMARY KEY,
            server_slug        TEXT NOT NULL,
            source_hash        TEXT NOT NULL,
            source_version     TEXT NOT NULL,
            stage              TEXT NOT NULL CHECK (stage IN ('verify', 'metadata')),
            transport_kind     TEXT NOT NULL,
            runner_profile     TEXT,
            deadline_ms        INTEGER,
            attempt_no         INTEGER NOT NULL DEFAULT 1,
            status             TEXT NOT NULL CHECK (status IN ('success', 'failed')),
            retry_class        TEXT NOT NULL,
            error_code         TEXT,
            error_message      TEXT,
            latency_ms         INTEGER,
            observed_tools     INTEGER NOT NULL DEFAULT 0,
            attempted_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
    ).run();
    await env.CATALOG.prepare(
        `CREATE INDEX IF NOT EXISTS idx_spawn_attempts_candidate
         ON spawn_attempts(server_slug, source_hash, stage, attempted_at)`,
    ).run();
    await env.CATALOG.prepare(
        `CREATE INDEX IF NOT EXISTS idx_spawn_attempts_status
         ON spawn_attempts(status, retry_class, attempted_at)`,
    ).run();
    for (const column of [
        ["runner_profile", "TEXT"],
        ["deadline_ms", "INTEGER"],
    ] as const) {
        try {
            await env.CATALOG.prepare(`SELECT ${column[0]} FROM spawn_attempts LIMIT 1`).first();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!/no such column/i.test(message)) throw error;
            await env.CATALOG.prepare(`ALTER TABLE spawn_attempts ADD COLUMN ${column[0]} ${column[1]}`).run();
        }
    }
}

export async function readSpawnAttempt(env: Env, lookup: SpawnAttemptLookup): Promise<StoredSpawnAttempt | null> {
    await ensureSpawnAttemptSchema(env);
    const row = await env.CATALOG.prepare(
        `SELECT status, retry_class, error_code, error_message, latency_ms, observed_tools, attempted_at
         FROM spawn_attempts
         WHERE server_slug = ?1
           AND source_hash = ?2
           AND stage = ?3
           AND transport_kind = ?4
           AND ((runner_profile IS NULL AND ?5 IS NULL) OR runner_profile = ?5)
           AND attempt_no = ?6
         ORDER BY attempted_at DESC
         LIMIT 1`,
    ).bind(
        lookup.serverSlug,
        lookup.sourceHash,
        lookup.stage,
        lookup.transportKind,
        lookup.runnerProfile ?? null,
        lookup.attemptNo ?? 1,
    ).first<{
        status: "success" | "failed";
        retry_class: RetryClass;
        error_code: string | null;
        error_message: string | null;
        latency_ms: number | null;
        observed_tools: number | null;
        attempted_at: string;
    }>();
    if (!row) return null;
    return {
        status: row.status,
        retryClass: row.retry_class,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        latencyMs: row.latency_ms,
        observedTools: Number(row.observed_tools ?? 0),
        attemptedAt: row.attempted_at,
    };
}

export async function recordSpawnAttempt(env: Env, record: SpawnAttemptRecord): Promise<void> {
    await ensureSpawnAttemptSchema(env);
    await env.CATALOG.prepare(
        `INSERT INTO spawn_attempts
            (id, server_slug, source_hash, source_version, stage, transport_kind, runner_profile, deadline_ms, attempt_no, status, retry_class, error_code, error_message, latency_ms, observed_tools, attempted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET
            source_version = excluded.source_version,
            deadline_ms = excluded.deadline_ms,
            status = excluded.status,
            retry_class = excluded.retry_class,
            error_code = excluded.error_code,
            error_message = excluded.error_message,
            latency_ms = excluded.latency_ms,
            observed_tools = excluded.observed_tools,
            attempted_at = CURRENT_TIMESTAMP`,
    ).bind(
        spawnAttemptId(record),
        record.serverSlug,
        record.sourceHash,
        record.sourceVersion,
        record.stage,
        record.transportKind,
        record.runnerProfile ?? null,
        record.deadlineMs ?? null,
        record.attemptNo ?? 1,
        record.status,
        record.retryClass,
        record.errorCode ?? null,
        record.errorMessage ?? null,
        record.latencyMs ?? null,
        record.observedTools ?? 0,
    ).run();
}

export function classifySpawnFailure(input: {
    message: string;
    transport: string;
    credentialVars?: string[];
    runnerRetryable?: boolean;
    observedTools?: number;
}): SpawnFailureClassification {
    if ((input.credentialVars || []).length > 0) {
        return { retryClass: "credentials_required", retryable: false, code: "CREDENTIALS_REQUIRED" };
    }
    const lower = input.message.toLowerCase();
    if (lower.includes("server returned zero tools") || lower.includes("no transports supplied")) {
        return { retryClass: "permanent_invalid", retryable: false, code: "TOOL_VALIDATION" };
    }
    if (
        lower.includes("no valid session id") ||
        lower.includes("no connection established") ||
        lower.includes("connection closed") ||
        lower.includes("transport closed") ||
        lower.includes("mcp-session-id")
    ) {
        return { retryClass: "transport_protocol", retryable: true, code: "MCP_SESSION_INVALID" };
    }
    if (
        lower.includes("not found") ||
        lower.includes("cannot find module") ||
        lower.includes("no module named") ||
        lower.includes("manifest unknown") ||
        lower.includes("pull access denied") ||
        lower.includes("docker transport requires") ||
        lower.includes("runner profile") ||
        lower.includes("not configured") ||
        lower.includes("unsupported runner transport")
    ) {
        return { retryClass: "transport_unavailable", retryable: true, code: "MCP_TRANSPORT_UNAVAILABLE" };
    }
    if (
        lower.includes("timed out") ||
        lower.includes("timeout") ||
        lower.includes("aborted") ||
        lower.includes("oom") ||
        lower.includes("out of memory") ||
        lower.includes("memory") ||
        lower.includes("cpu")
    ) {
        return { retryClass: "runner_capacity", retryable: true, code: "MCP_SPAWN_TIMEOUT" };
    }
    if (
        input.runnerRetryable === true ||
        lower.includes("too many subrequests") ||
        lower.includes("not yet provisioned") ||
        lower.includes("container") ||
        lower.includes("temporar") ||
        lower.includes("rate limit") ||
        lower.includes("network") ||
        lower.includes("fetch failed")
    ) {
        return { retryClass: "runner_transient", retryable: true, code: "MCP_SPAWN_FAILED" };
    }
    return { retryClass: "permanent_invalid", retryable: false, code: "MCP_SPAWN_FAILED" };
}

export function availableRunnerProfiles(env: Env): RunnerProfile[] {
    const profiles: RunnerProfile[] = [];
    if (env.MCP_RUNNER) profiles.push("lite");
    if (env.MCP_RUNNER_BASIC) profiles.push("basic");
    if (env.MCP_RUNNER_STANDARD_1) profiles.push("standard-1");
    if (env.MCP_RUNNER_STANDARD_2) profiles.push("standard-2");
    return profiles;
}

export function profilesForTransport(env: Env, transportKind: string): RunnerProfile[] {
    if (transportKind === "http") return [];
    const available = availableRunnerProfiles(env);
    if (available.length === 0) return ["lite"];
    return available;
}

export const __test = {
    classifySpawnFailure,
    profilesForTransport,
    spawnAttemptId,
};
