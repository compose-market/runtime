import type { Env } from "../../worker/env.js";
import { runSeed, type SeedReport } from "../seed.js";
import { runVerifyShard, type VerifyReport } from "../verify.js";
import { runMetadataAgent, type MetadataAgentReport } from "../metadata/agents.js";
import { runPublish, type PublishReport } from "../publish.js";
import { runEmbed, type EmbedReport } from "../embed.js";
import { runHealth } from "../health.js";
import { runGc } from "../gc.js";
import {
    createPipelineRunId,
    isStageRegression,
    normalizePipelineInput,
    type ConnectorCatalogPipelineInput,
    type ConnectorCatalogPipelineMode,
    type ConnectorCatalogPipelineStage,
    type ConnectorCatalogPipelineStatus,
    type ConnectorCatalogPipelineWorkerRole,
    type NormalizedPipelineInput,
} from "./config.js";

export type {
    ConnectorCatalogPipelineInput,
    ConnectorCatalogPipelineMode,
    ConnectorCatalogPipelineStage,
    ConnectorCatalogPipelineStatus,
    NormalizedPipelineInput,
} from "./config.js";

export interface WorkflowEventLike<T> {
    payload: Readonly<T>;
    timestamp: Date;
    instanceId: string;
}

export interface WorkflowStepLike {
    do<T>(name: string, config: { retries?: { limit: number; delay: string | number; backoff?: "constant" | "linear" | "exponential" }; timeout?: string | number }, callback: () => Promise<T>): Promise<T>;
    sleep?(name: string, duration: string | number): Promise<void>;
}

interface PipelineProgress {
    seed: { iterations: number; pages: number; processed: number; archived: number; done: boolean };
    verify: { iterations: number; examined: number; functional: number; credentialGated: number; retryable: number; shadowed: number; skipped: number };
    metadata: { iterations: number; examined: number; completed: number; credentialGated: number; retryable: number; skipped: number };
    publish: { iterations: number; examined: number; published: number; skipped: number };
    embed: { iterations: number; embedded: number; skipped: number };
}

export interface ConnectorCatalogPipelineResult {
    runId: string;
    mode: ConnectorCatalogPipelineMode;
    stage: ConnectorCatalogPipelineStage;
    status: "complete";
    pipeline_complete: boolean;
    next_stage: ConnectorCatalogPipelineStage | null;
    continued_to: string | null;
    started_at: string;
    finished_at: string;
    progress: PipelineProgress;
    health?: unknown;
    gc?: unknown;
    control_errors?: string[];
}

export interface ConnectorCatalogPipelineStartReport {
    id: string;
    status: unknown;
    input: NormalizedPipelineInput;
    reused_active?: boolean;
}

export interface ConnectorCatalogPipelineStatusReport {
    id: string;
    workflow: unknown;
    run: {
        id: string;
        mode: string;
        status: ConnectorCatalogPipelineStatus;
        current_stage: string | null;
        input: unknown;
        result: unknown;
        error: string | null;
        started_at: string | null;
        finished_at: string | null;
        updated_at: string;
    } | null;
}

interface PipelineTerminalUpdate {
    status: "complete" | "errored";
    current_stage: "complete" | "errored";
    error: string | null;
    result: unknown | undefined;
}

interface PipelineRunMeta {
    rootId?: string;
    parentId?: string | null;
}

interface PipelineLockRow {
    root_run_id: string;
    active_run_id: string;
    mode: ConnectorCatalogPipelineMode;
    status: "running" | "complete" | "errored";
    updated_at: string;
    fresh: number;
}

interface PipelineWorkerStartReport {
    id: string;
    worker_index: number;
    worker_role: Exclude<ConnectorCatalogPipelineWorkerRole, "coordinator">;
    input: NormalizedPipelineInput;
    attempt: number;
    initial_error?: string | null;
}

interface PipelineWorkerPollReport {
    id: string;
    status: string | null;
    output: ConnectorCatalogPipelineResult | null;
    error: string | null;
    failed: boolean;
}

interface PipelineWorkerReplacementReport {
    previous_id: string;
    replacement_id: string | null;
    worker_index: number;
    worker_role: Exclude<ConnectorCatalogPipelineWorkerRole, "coordinator">;
    reason: string;
    error: string | null;
}

const STEP_CONFIG = {
    retries: { limit: 3, delay: "30 seconds", backoff: "exponential" as const },
    timeout: "30 minutes",
};
const VERIFY_STEP_CONFIG = {
    retries: { limit: 1, delay: "10 seconds", backoff: "linear" as const },
    timeout: "30 minutes",
};
const VERIFY_SHARDS_PER_WORKER_STEP = 1;
const METADATA_IDLE_EMPTY_PASSES = 8;
const WORKER_POLL_SLEEP = "10 seconds";
const PIPELINE_WORKER_ROLES: Array<Exclude<ConnectorCatalogPipelineWorkerRole, "coordinator">> = [
    "seed-worker",
    "verify-worker",
    "metadata-worker",
    "publish-worker",
    "embed-worker",
];

export async function ensurePipelineRunTable(env: Env): Promise<void> {
    await env.CATALOG.prepare(
        `CREATE TABLE IF NOT EXISTS pipeline_runs (
            id             TEXT PRIMARY KEY,
            root_id        TEXT,
            parent_id      TEXT,
            mode           TEXT NOT NULL,
            status         TEXT NOT NULL CHECK (status IN ('queued', 'running', 'complete', 'errored')),
            current_stage  TEXT,
            input          TEXT NOT NULL DEFAULT '{}',
            result         TEXT,
            error          TEXT,
            started_at     TEXT,
            finished_at    TEXT,
            updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
    ).run();
    try {
        await env.CATALOG.prepare(`SELECT root_id FROM pipeline_runs LIMIT 1`).first();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/no such column/i.test(message)) throw error;
        await env.CATALOG.prepare(`ALTER TABLE pipeline_runs ADD COLUMN root_id TEXT`).run();
    }
    try {
        await env.CATALOG.prepare(`SELECT parent_id FROM pipeline_runs LIMIT 1`).first();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/no such column/i.test(message)) throw error;
        await env.CATALOG.prepare(`ALTER TABLE pipeline_runs ADD COLUMN parent_id TEXT`).run();
    }
    await env.CATALOG.prepare(`CREATE INDEX IF NOT EXISTS idx_pipeline_runs_root ON pipeline_runs(root_id, updated_at)`).run();
}

async function ensurePipelineLockTable(env: Env): Promise<void> {
    await env.CATALOG.prepare(
        `CREATE TABLE IF NOT EXISTS pipeline_lock (
            id             INTEGER PRIMARY KEY CHECK (id = 1),
            root_run_id    TEXT NOT NULL,
            active_run_id  TEXT NOT NULL,
            mode           TEXT NOT NULL,
            status         TEXT NOT NULL CHECK (status IN ('running', 'complete', 'errored')),
            acquired_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
    ).run();
}

export async function recordPipelineQueued(env: Env, runId: string, input: NormalizedPipelineInput, meta: PipelineRunMeta = {}): Promise<void> {
    await ensurePipelineRunTable(env);
    await env.CATALOG.prepare(
        `INSERT INTO pipeline_runs (id, root_id, parent_id, mode, status, current_stage, input, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'queued', 'queued', ?5, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET
            root_id = excluded.root_id,
            parent_id = excluded.parent_id,
            mode = excluded.mode,
            status = excluded.status,
            current_stage = excluded.current_stage,
            input = excluded.input,
            error = NULL,
            updated_at = CURRENT_TIMESTAMP
         WHERE pipeline_runs.status = 'queued'`,
    ).bind(runId, meta.rootId || runId, meta.parentId ?? null, input.mode, JSON.stringify(input)).run();
}

function parseStoredJson(value: string | null): unknown {
    if (!value) return null;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function isAlreadyExistsError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /already exists|already started|duplicate|conflict/i.test(message);
}

function workflowStatus(workflow: unknown): string | null {
    if (!workflow || typeof workflow !== "object") return null;
    const status = (workflow as { status?: unknown }).status;
    return typeof status === "string" ? status : null;
}

function workflowErrorMessage(workflow: unknown): string | null {
    if (!workflow || typeof workflow !== "object") return null;
    const error = (workflow as { error?: unknown }).error;
    if (!error) return null;
    if (typeof error === "string") return error;
    if (typeof error === "object") {
        const message = (error as { message?: unknown }).message;
        if (typeof message === "string" && message.trim()) return message;
        const name = (error as { name?: unknown }).name;
        if (typeof name === "string" && name.trim()) return name;
    }
    return String(error);
}

function derivePipelineTerminalUpdate(workflow: unknown): PipelineTerminalUpdate | null {
    const status = workflowStatus(workflow);
    if (status === "complete") {
        const output = workflow && typeof workflow === "object" ? (workflow as { output?: unknown }).output : undefined;
        return { status: "complete", current_stage: "complete", error: null, result: output };
    }
    if (status === "errored" || status === "terminated") {
        return {
            status: "errored",
            current_stage: "errored",
            error: workflowErrorMessage(workflow) || `Cloudflare Workflow ${status}`,
            result: undefined,
        };
    }
    return null;
}

async function reconcilePipelineRunWithWorkflowStatus(env: Env, id: string, workflow: unknown): Promise<void> {
    const terminal = derivePipelineTerminalUpdate(workflow);
    if (!terminal) return;

    await env.CATALOG.prepare(
        `UPDATE pipeline_runs
         SET status = ?2,
             current_stage = ?3,
             error = ?4,
             result = COALESCE(?5, result),
             finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?1
           AND status IN ('queued', 'running')`,
    ).bind(
        id,
        terminal.status,
        terminal.current_stage,
        terminal.error,
        terminal.result === undefined ? null : JSON.stringify(terminal.result),
    ).run();
}

async function heartbeatPipelineLock(env: Env, runId: string): Promise<void> {
    await ensurePipelineLockTable(env);
    await env.CATALOG.prepare(
        `UPDATE pipeline_lock
         SET status = 'running',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = 1
           AND active_run_id = ?1`,
    ).bind(runId).run();
}

async function readPipelineLock(env: Env): Promise<PipelineLockRow | null> {
    await ensurePipelineLockTable(env);
    return await env.CATALOG.prepare(
        `SELECT root_run_id, active_run_id, mode, status, updated_at,
                CASE WHEN updated_at >= datetime('now', '-10 minutes') THEN 1 ELSE 0 END AS fresh
         FROM pipeline_lock
         WHERE id = 1
         LIMIT 1`,
    ).first<PipelineLockRow>();
}

async function markPipelineLockTerminal(
    env: Env,
    runId: string,
    status: "complete" | "errored",
): Promise<void> {
    await ensurePipelineLockTable(env);
    await env.CATALOG.prepare(
        `UPDATE pipeline_lock
         SET status = ?2,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = 1
           AND active_run_id = ?1`,
    ).bind(runId, status).run();
}

async function activePipelineStartReport(env: Env): Promise<ConnectorCatalogPipelineStartReport | null> {
    const lock = await readPipelineLock(env);
    if (!lock || lock.status !== "running") return null;

    const instance = await env.CATALOG_PIPELINE.get(lock.active_run_id);
    const status = await instance.status().catch((error: unknown) => ({
        status: "unknown",
        error: { name: "WorkflowStatusError", message: error instanceof Error ? error.message : String(error) },
    }));
    await reconcilePipelineRunWithWorkflowStatus(env, lock.active_run_id, status);

    const terminal = derivePipelineTerminalUpdate(status);
    if (terminal) {
        await markPipelineLockTerminal(env, lock.active_run_id, terminal.status);
        return null;
    }
    if (workflowStatus(status) === "unknown" && !lock.fresh) {
        await markPipelineLockTerminal(env, lock.active_run_id, "errored");
        return null;
    }

    const row = await env.CATALOG.prepare(
        `SELECT input FROM pipeline_runs WHERE id = ?1 LIMIT 1`,
    ).bind(lock.active_run_id).first<{ input: string | null }>();
    const parsed = parseStoredJson(row?.input ?? null);
    const input = normalizePipelineInput((parsed && typeof parsed === "object" ? parsed : { mode: lock.mode }) as ConnectorCatalogPipelineInput);
    return {
        id: lock.active_run_id,
        status,
        input,
        reused_active: true,
    };
}

async function claimPipelineLock(
    env: Env,
    runId: string,
    input: NormalizedPipelineInput,
    meta: PipelineRunMeta,
    options: { continuation?: boolean; force?: boolean } = {},
): Promise<ConnectorCatalogPipelineStartReport | null> {
    await ensurePipelineLockTable(env);
    const rootId = meta.rootId || runId;

    if (options.continuation) {
        await env.CATALOG.prepare(
            `INSERT INTO pipeline_lock (id, root_run_id, active_run_id, mode, status, acquired_at, updated_at)
             VALUES (1, ?1, ?2, ?3, 'running', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT(id) DO UPDATE SET
                root_run_id = excluded.root_run_id,
                active_run_id = excluded.active_run_id,
                mode = excluded.mode,
                status = 'running',
                updated_at = CURRENT_TIMESTAMP`,
        ).bind(rootId, runId, input.mode).run();
        return null;
    }

    if (!options.force) {
        const active = await activePipelineStartReport(env);
        if (active) return active;
    }

    await env.CATALOG.prepare(
        `INSERT INTO pipeline_lock (id, root_run_id, active_run_id, mode, status, acquired_at, updated_at)
         VALUES (1, ?1, ?2, ?3, 'running', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET
            root_run_id = excluded.root_run_id,
            active_run_id = excluded.active_run_id,
            mode = excluded.mode,
            status = 'running',
            acquired_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
         WHERE pipeline_lock.status != 'running' OR ?4 = 1`,
    ).bind(rootId, runId, input.mode, options.force ? 1 : 0).run();

    const lock = await readPipelineLock(env);
    if (lock?.active_run_id !== runId && !options.force) {
        return await activePipelineStartReport(env);
    }
    return null;
}

async function activeSiblingWorkerStartReport(
    env: Env,
    runId: string,
    input: NormalizedPipelineInput,
    _meta: PipelineRunMeta,
): Promise<ConnectorCatalogPipelineStartReport | null> {
    if (input.workerRole === "coordinator") return null;
    await ensurePipelineRunTable(env);
    const row = await env.CATALOG.prepare(
        `SELECT id, input
         FROM pipeline_runs
         WHERE id != ?1
           AND status IN ('queued', 'running')
           AND json_extract(input, '$.workerRole') = ?2
           AND CAST(json_extract(input, '$.workerIndex') AS INTEGER) = ?3
           AND updated_at >= datetime('now', '-10 minutes')
         ORDER BY updated_at DESC, started_at DESC, id DESC
         LIMIT 1`,
    ).bind(
        runId,
        input.workerRole,
        input.workerIndex,
    ).first<{ id: string; input: string | null }>();
    if (!row?.id) return null;
    const parsed = parseStoredJson(row.input);
    return {
        id: row.id,
        status: { status: "running", reused_active_worker: true },
        input: normalizePipelineInput((parsed && typeof parsed === "object" ? parsed : input) as ConnectorCatalogPipelineInput),
        reused_active: true,
    };
}

export async function startConnectorCatalogPipeline(
    env: Env,
    rawInput: ConnectorCatalogPipelineInput = {},
    options: { id?: string; parentId?: string | null; rootId?: string; continuation?: boolean; force?: boolean } = {},
): Promise<ConnectorCatalogPipelineStartReport> {
    const input = normalizePipelineInput(rawInput);
    const id = options.id || createPipelineRunId(input.mode);
    const isWorker = input.workerRole !== "coordinator";
    const meta = {
        rootId: options.rootId || id,
        parentId: options.parentId ?? null,
    };
    if (!isWorker) {
        const active = await claimPipelineLock(env, id, input, meta, {
            continuation: options.continuation,
            force: options.force || rawInput.force === true,
        });
        if (active) return active;
    }

    if (isWorker && !options.force && rawInput.force !== true) {
        const active = await activeSiblingWorkerStartReport(env, id, input, meta);
        if (active) return active;
    }

    await recordPipelineQueued(env, id, input, meta);

    let instance;
    try {
        instance = await env.CATALOG_PIPELINE.create({
            id,
            params: input,
            retention: {
                successRetention: "30 days",
                errorRetention: "30 days",
            },
        });
    } catch (error) {
        if (!isAlreadyExistsError(error)) {
            await recordPipelineError(env, id, error);
            if (!isWorker) await markPipelineLockTerminal(env, id, "errored");
            throw error;
        }
        instance = await env.CATALOG_PIPELINE.get(id);
    }

    return {
        id: instance.id,
        status: await instance.status().catch((error: unknown) => ({
            status: "unknown",
            error: { name: "WorkflowStatusError", message: error instanceof Error ? error.message : String(error) },
        })),
        input,
    };
}

export async function getConnectorCatalogPipelineStatus(env: Env, id: string): Promise<ConnectorCatalogPipelineStatusReport> {
    await ensurePipelineRunTable(env);
    const instance = await env.CATALOG_PIPELINE.get(id);
    const workflow = await instance.status().catch((error: unknown) => ({
        status: "unknown",
        error: { name: "WorkflowStatusError", message: error instanceof Error ? error.message : String(error) },
    }));
    await reconcilePipelineRunWithWorkflowStatus(env, id, workflow);
    const row = await env.CATALOG.prepare(
        `SELECT id, mode, status, current_stage, input, result, error, started_at, finished_at, updated_at
         FROM pipeline_runs
         WHERE id = ?1
         LIMIT 1`,
    ).bind(id).first<{
        id: string;
        mode: string;
        status: ConnectorCatalogPipelineStatus;
        current_stage: string | null;
        input: string | null;
        result: string | null;
        error: string | null;
        started_at: string | null;
        finished_at: string | null;
        updated_at: string;
    }>();

    return {
        id,
        workflow,
        run: row
            ? {
                ...row,
                input: parseStoredJson(row.input),
                result: parseStoredJson(row.result),
            }
            : null,
    };
}

async function recordPipelineRunning(env: Env, runId: string, input: NormalizedPipelineInput): Promise<void> {
    try {
        await ensurePipelineRunTable(env);
        const existing = await env.CATALOG.prepare(
            `SELECT status, current_stage FROM pipeline_runs WHERE id = ?1 LIMIT 1`,
        ).bind(runId).first<{ status: ConnectorCatalogPipelineStatus; current_stage: string | null }>();
        if (existing?.status === "complete" && isSupersededStage(existing.current_stage)) return;
        await env.CATALOG.prepare(
            `INSERT INTO pipeline_runs (id, mode, status, current_stage, input, started_at, updated_at)
             VALUES (?1, ?2, 'running', 'starting', ?3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT(id) DO UPDATE SET
                status = 'running',
                current_stage = CASE
                    WHEN pipeline_runs.current_stage IS NULL OR pipeline_runs.current_stage IN ('queued', 'starting') THEN 'starting'
                    ELSE pipeline_runs.current_stage
                END,
                input = excluded.input,
                error = NULL,
                started_at = COALESCE(pipeline_runs.started_at, CURRENT_TIMESTAMP),
                updated_at = CURRENT_TIMESTAMP`,
        ).bind(runId, input.mode, JSON.stringify(input)).run();
        await heartbeatPipelineLock(env, runId);
    } catch {
        // Control-plane bookkeeping must not fail the worker slice.
    }
}

async function recordPipelineStage(env: Env, runId: string, stage: string, result?: unknown): Promise<void> {
    try {
        const current = await env.CATALOG.prepare(
            `SELECT status, current_stage FROM pipeline_runs WHERE id = ?1 LIMIT 1`,
        ).bind(runId).first<{ status: ConnectorCatalogPipelineStatus; current_stage: string | null }>();
        if (current?.status === "complete" && isSupersededStage(current.current_stage)) return;
        if (isStageRegression(current?.current_stage ?? null, stage)) {
            await heartbeatPipelineLock(env, runId);
            return;
        }
        await env.CATALOG.prepare(
            `UPDATE pipeline_runs
             SET status = 'running',
                 current_stage = ?2,
                 result = COALESCE(?3, result),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?1`,
        ).bind(runId, stage, result === undefined ? null : JSON.stringify(result)).run();
        await heartbeatPipelineLock(env, runId);
    } catch {
        // Control-plane bookkeeping must not fail the worker slice.
    }
}

async function recordPipelineComplete(env: Env, runId: string, result: ConnectorCatalogPipelineResult): Promise<void> {
    try {
        await env.CATALOG.prepare(
            `UPDATE pipeline_runs
             SET status = 'complete',
                 current_stage = ?3,
                 result = ?2,
                 error = NULL,
                 finished_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?1`,
        ).bind(
            runId,
            JSON.stringify(result),
            result.pipeline_complete ? "complete" : `continued:${result.next_stage ?? result.stage}`,
        ).run();
        if (result.pipeline_complete) {
            await markPipelineLockTerminal(env, runId, "complete");
        }
    } catch {
        // Control-plane bookkeeping must not fail the worker slice.
    }
}

async function recordPipelineError(env: Env, runId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    try {
        await env.CATALOG.prepare(
            `UPDATE pipeline_runs
             SET status = 'errored',
                 current_stage = 'errored',
                 error = ?2,
                 finished_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?1`,
        ).bind(runId, message).run();
        await markPipelineLockTerminal(env, runId, "errored");
    } catch {
        // Control-plane bookkeeping must not mask the original error.
    }
}

function isSupersededStage(stage: string | null | undefined): boolean {
    return typeof stage === "string" && stage.startsWith("superseded:");
}

async function isPipelineRunSuperseded(env: Env, runId: string): Promise<boolean> {
    try {
        const row = await env.CATALOG.prepare(
            `SELECT status, current_stage FROM pipeline_runs WHERE id = ?1 LIMIT 1`,
        ).bind(runId).first<{ status: ConnectorCatalogPipelineStatus; current_stage: string | null }>();
        return row?.status === "complete" && isSupersededStage(row.current_stage);
    } catch {
        return false;
    }
}

function emptyProgress(): PipelineProgress {
    return {
        seed: { iterations: 0, pages: 0, processed: 0, archived: 0, done: false },
        verify: { iterations: 0, examined: 0, functional: 0, credentialGated: 0, retryable: 0, shadowed: 0, skipped: 0 },
        metadata: { iterations: 0, examined: 0, completed: 0, credentialGated: 0, retryable: 0, skipped: 0 },
        publish: { iterations: 0, examined: 0, published: 0, skipped: 0 },
        embed: { iterations: 0, embedded: 0, skipped: 0 },
    };
}

function addSeed(progress: PipelineProgress, report: SeedReport): void {
    progress.seed.iterations += 1;
    progress.seed.pages += report.pages;
    progress.seed.processed += report.processed;
    progress.seed.archived += report.candidates_archived;
    progress.seed.done = report.done;
}

function addVerify(progress: PipelineProgress, reports: VerifyReport[]): void {
    progress.verify.iterations += 1;
    for (const report of reports) {
        progress.verify.examined += report.examined;
        progress.verify.functional += report.functional;
        progress.verify.credentialGated += report.credential_gated;
        progress.verify.retryable += report.retryable;
        progress.verify.shadowed += report.shadowed;
        progress.verify.skipped += report.skipped;
    }
}

function addMetadata(progress: PipelineProgress, reports: MetadataAgentReport[]): void {
    progress.metadata.iterations += 1;
    for (const report of reports) {
        progress.metadata.examined += report.examined;
        progress.metadata.completed += report.completed;
        progress.metadata.credentialGated += report.credential_gated;
        progress.metadata.retryable += report.retryable;
        progress.metadata.skipped += report.skipped;
    }
}

function addPublish(progress: PipelineProgress, report: PublishReport): void {
    progress.publish.iterations += 1;
    progress.publish.examined += report.examined;
    progress.publish.published += report.published;
    progress.publish.skipped += report.skipped;
}

function addEmbed(progress: PipelineProgress, report: EmbedReport): void {
    progress.embed.iterations += 1;
    progress.embed.embedded += report.embedded;
    progress.embed.skipped += report.skipped;
}

function hashText(input: string): string {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

export function workerPipelineId(
    rootId: string,
    workerRole: Exclude<ConnectorCatalogPipelineWorkerRole, "coordinator">,
    workerIndex: number,
): string {
    const suffix = `${workerRole}-${workerIndex}`;
    const maxRootLength = 100 - suffix.length - 1;
    const safeRoot = rootId.length <= maxRootLength
        ? rootId
        : `${rootId.slice(0, Math.max(1, maxRootLength - 9))}-${hashText(rootId)}`;
    return `${safeRoot}-${suffix}`;
}

export function workerPipelineRetryId(
    rootId: string,
    workerRole: Exclude<ConnectorCatalogPipelineWorkerRole, "coordinator">,
    workerIndex: number,
    attempt: number,
    pollIndex: number,
): string {
    return workerPipelineId(`${rootId}-retry-${Math.max(1, attempt)}-${Math.max(1, pollIndex)}`, workerRole, workerIndex);
}

export function workerStage(workerRole: Exclude<ConnectorCatalogPipelineWorkerRole, "coordinator">): ConnectorCatalogPipelineStage {
    switch (workerRole) {
        case "seed-worker": return "seed";
        case "verify-worker": return "verify";
        case "metadata-worker": return "metadata";
        case "publish-worker": return "publish";
        case "embed-worker": return "embed";
    }
}

export function workerCount(input: NormalizedPipelineInput, workerRole: Exclude<ConnectorCatalogPipelineWorkerRole, "coordinator">): number {
    switch (workerRole) {
        case "seed-worker": return input.seedWorkerCount;
        case "verify-worker": return input.verifyWorkerCount;
        case "metadata-worker": return input.metadataWorkerCount;
        case "publish-worker": return input.publishWorkerCount;
        case "embed-worker": return input.embedWorkerCount;
    }
}

function laneAssignment(workerIndex: number, laneCount: number): { laneId: number; laneCount: number } {
    const safeLaneCount = Math.max(1, Math.floor(laneCount));
    return {
        laneId: Math.max(0, Math.min(Math.floor(workerIndex), safeLaneCount - 1)),
        laneCount: safeLaneCount,
    };
}

export function verifyWorkerShardIds(workerIndex: number, workerCount: number, shardCount: number): number[] {
    const safeWorkerCount = Math.max(1, Math.floor(workerCount));
    const safeShardCount = Math.max(1, Math.floor(shardCount));
    const safeIndex = Math.max(0, Math.min(Math.floor(workerIndex), safeWorkerCount - 1));
    const out: number[] = [];
    for (let shardId = safeIndex; shardId < safeShardCount; shardId += safeWorkerCount) {
        out.push(shardId);
    }
    return out;
}

export function metadataWorkerAssignment(workerIndex: number, workerCount: number): { agentId: number; laneId: number; laneCount: number } {
    const safeWorkerCount = Math.max(3, Math.floor(workerCount / 3) * 3);
    const safeIndex = Math.max(0, Math.min(Math.floor(workerIndex), safeWorkerCount - 1));
    return {
        agentId: safeIndex % 3,
        laneId: Math.floor(safeIndex / 3),
        laneCount: safeWorkerCount / 3,
    };
}

async function rootIdForRun(env: Env, runId: string): Promise<string> {
    const row = await env.CATALOG.prepare(
        `SELECT root_id FROM pipeline_runs WHERE id = ?1 LIMIT 1`,
    ).bind(runId).first<{ root_id: string | null }>();
    return row?.root_id || runId;
}

function emptyVerifyReport(shardId: number, shardCount: number, input: Partial<VerifyReport> = {}): VerifyReport {
    const now = new Date().toISOString();
    return {
        started_at: now,
        finished_at: now,
        shard_id: shardId,
        shard_count: shardCount,
        done: input.done ?? false,
        scanned: input.scanned ?? 0,
        examined: input.examined ?? 0,
        functional: input.functional ?? 0,
        credential_gated: input.credential_gated ?? 0,
        retryable: input.retryable ?? 0,
        shadowed: input.shadowed ?? 0,
        skipped: input.skipped ?? 0,
        errors: input.errors ?? [],
    };
}

function seedErrorReport(started: string, error: unknown): SeedReport {
    return {
        started_at: started,
        finished_at: new Date().toISOString(),
        pages: 0,
        processed: 0,
        upserted: 0,
        candidates_archived: 0,
        shadow_skipped: 0,
        complete_skipped: 0,
        images_attached: 0,
        errors: [{ slug: "seed", message: error instanceof Error ? error.message : String(error) }],
        done: false,
    };
}

function metadataErrorReport(started: string, input: { agentId: number; laneId: number; laneCount: number }, error: unknown): MetadataAgentReport {
    return {
        started_at: started,
        finished_at: new Date().toISOString(),
        agent_id: input.agentId,
        lane_id: input.laneId,
        lane_count: input.laneCount,
        reviewer: `metadata-agent-${input.agentId}:unavailable`,
        examined: 0,
        completed: 0,
        credential_gated: 0,
        retryable: 1,
        skipped: 0,
        errors: [{ slug: "metadata", message: error instanceof Error ? error.message : String(error) }],
    };
}

async function runSeedSafely(env: Env, input: { maxPages: number; maxCandidates: number; reset: boolean }): Promise<SeedReport> {
    const started = new Date().toISOString();
    try {
        return await runSeed(env, {
            maxPages: input.maxPages,
            maxCandidates: input.maxCandidates,
            reset: input.reset,
        });
    } catch (error) {
        return seedErrorReport(started, error);
    }
}

async function runMetadataSafely(
    env: Env,
    input: { agentId: number; limit: number; retryRecent: boolean; laneId: number; laneCount: number },
): Promise<MetadataAgentReport> {
    const started = new Date().toISOString();
    try {
        return await runMetadataAgent(env, input);
    } catch (error) {
        return metadataErrorReport(started, input, error);
    }
}

async function runVerifyShardGroup(env: Env, input: NormalizedPipelineInput, shardIds: number[]): Promise<VerifyReport[]> {
    const reports: VerifyReport[] = [];
    let activeShards = 0;
    for (const shardId of shardIds) {
        if (activeShards >= VERIFY_SHARDS_PER_WORKER_STEP) {
            reports.push(emptyVerifyReport(shardId, input.shardCount, { done: false }));
            continue;
        }
        try {
            const report = await runVerifyShard(env, {
                shardId,
                shardCount: input.shardCount,
                limit: input.verifyLimit,
            });
            reports.push(report);
            if (!report.done) activeShards += 1;
        } catch (error) {
            activeShards += 1;
            const message = error instanceof Error ? error.message : String(error);
            reports.push(emptyVerifyReport(shardId, input.shardCount, {
                retryable: 1,
                errors: [{ slug: `verify-shard-${shardId}`, message }],
            }));
        }
    }
    return reports;
}

function metadataExamined(reports: MetadataAgentReport[]): number {
    return reports.reduce((total, report) => total + report.examined, 0);
}

function publishErrorReport(started: string, error: unknown): PublishReport {
    return {
        started_at: started,
        finished_at: new Date().toISOString(),
        examined: 0,
        published: 0,
        skipped: 0,
        errors: [{ slug: "publish", message: error instanceof Error ? error.message : String(error) }],
    };
}

function embedErrorReport(started: string, error: unknown): EmbedReport {
    return {
        started_at: started,
        finished_at: new Date().toISOString(),
        embedded: 0,
        skipped: 0,
        errors: [{ slug: "embed", message: error instanceof Error ? error.message : String(error) }],
    };
}

async function runPublishSafely(env: Env, limit: number, lane?: { laneId: number; laneCount: number }): Promise<PublishReport> {
    const started = new Date().toISOString();
    try {
        return await runPublish(env, { limit, laneId: lane?.laneId, laneCount: lane?.laneCount });
    } catch (error) {
        return publishErrorReport(started, error);
    }
}

async function runEmbedSafely(env: Env, limit: number, lane?: { laneId: number; laneCount: number }): Promise<EmbedReport> {
    const started = new Date().toISOString();
    try {
        return await runEmbed(env, { limit, laneId: lane?.laneId, laneCount: lane?.laneCount });
    } catch (error) {
        return embedErrorReport(started, error);
    }
}

async function countPipelineBacklog(env: Env, sql: string): Promise<number> {
    try {
        const row = await env.CATALOG.prepare(sql).first<{ n: number | null }>();
        return Number(row?.n ?? 0);
    } catch {
        // A failed observability query must keep the worker alive rather than
        // letting a downstream stage disappear while upstream is still moving.
        return 1;
    }
}

async function hasRecentActiveWorkerRole(env: Env, workerRoles: Array<Exclude<ConnectorCatalogPipelineWorkerRole, "coordinator">>): Promise<boolean> {
    if (workerRoles.length === 0) return false;
    const placeholders = workerRoles.map((_, index) => `?${index + 1}`).join(", ");
    try {
        const row = await env.CATALOG.prepare(
            `SELECT 1 AS active
             FROM pipeline_runs
             WHERE status IN ('queued', 'running')
               AND json_extract(input, '$.workerRole') IN (${placeholders})
               AND updated_at >= datetime('now', '-45 minutes')
             LIMIT 1`,
        ).bind(...workerRoles).first<{ active: number | null }>();
        return Number(row?.active ?? 0) === 1;
    } catch {
        return true;
    }
}

async function publishBacklog(env: Env): Promise<number> {
    return await countPipelineBacklog(env,
        `SELECT COUNT(*) AS n
         FROM metadata_agent_reviews r
         WHERE r.status = 'complete'
           AND r.artifact_key IS NOT NULL
           AND r.card_version IS NOT NULL
           AND (r.canonical_agent_id = r.agent_id OR r.canonical_agent_id IS NULL)
           AND NOT EXISTS (
                SELECT 1
                FROM servers s
                JOIN metadata_reviews m
                  ON m.server_slug = s.slug
                 AND m.card_version = s.card_version
                LEFT JOIN aliases a
                  ON a.server_slug = s.slug
                WHERE (s.slug = r.server_slug OR a.alias_id = r.server_slug)
                  AND s.card_version = r.card_version
                  AND s.status IN ('live', 'credential_gated')
           )`,
    );
}

async function embedBacklog(env: Env): Promise<number> {
    return await countPipelineBacklog(env,
        `SELECT COUNT(*) AS n
         FROM servers s
         INNER JOIN metadata_reviews m
           ON m.server_slug = s.slug
          AND m.card_version = s.card_version
         LEFT JOIN embedding_state es
           ON es.server_slug = s.slug
          AND es.card_version = s.card_version
          AND es.provider = 'mongodb-voyage'
          AND es.model = 'voyage-4-large'
          AND es.dimensions = 1024
          AND es.input_type = 'document'
         LEFT JOIN catalog_stage_errors se
           ON se.item_id = s.slug
          AND se.item_version = s.card_version
          AND se.stage = 'embed'
          AND se.next_retry_at > CURRENT_TIMESTAMP
         WHERE s.status IN ('live', 'credential_gated')
           AND es.server_slug IS NULL
           AND se.item_id IS NULL`,
    );
}

async function shouldKeepPublishWorkerOpen(env: Env): Promise<boolean> {
    if (await publishBacklog(env) > 0) return true;
    return await hasRecentActiveWorkerRole(env, ["seed-worker", "verify-worker", "metadata-worker"]);
}

async function shouldKeepEmbedWorkerOpen(env: Env): Promise<boolean> {
    if (await embedBacklog(env) > 0) return true;
    if (await publishBacklog(env) > 0) return true;
    return await hasRecentActiveWorkerRole(env, ["seed-worker", "verify-worker", "metadata-worker", "publish-worker"]);
}

async function startContinuation(
    env: Env,
    input: NormalizedPipelineInput,
    stage: ConnectorCatalogPipelineStage,
    parentRunId: string,
): Promise<ConnectorCatalogPipelineStartReport> {
    const row = await env.CATALOG.prepare(
        `SELECT root_id FROM pipeline_runs WHERE id = ?1 LIMIT 1`,
    ).bind(parentRunId).first<{ root_id: string | null }>();
    return await startConnectorCatalogPipeline(env, {
        ...input,
        stage,
        resetSeed: false,
    }, {
        parentId: parentRunId,
        rootId: row?.root_id || parentRunId,
        continuation: true,
    });
}

async function startContinuationSafely(
    env: Env,
    input: NormalizedPipelineInput,
    stage: ConnectorCatalogPipelineStage,
    parentRunId: string,
): Promise<{ continuation: ConnectorCatalogPipelineStartReport | null; controlErrors: string[] }> {
    try {
        return {
            continuation: await startContinuation(env, input, stage, parentRunId),
            controlErrors: [],
        };
    } catch (error) {
        return {
            continuation: null,
            controlErrors: [`failed to start ${stage} continuation: ${error instanceof Error ? error.message : String(error)}`],
        };
    }
}

function makeSegmentResult(
    runId: string,
    input: NormalizedPipelineInput,
    started: string,
    progress: PipelineProgress,
    continuation: ConnectorCatalogPipelineStartReport | null,
    health?: unknown,
    gc?: unknown,
    options: { forceIncomplete?: boolean; controlErrors?: string[] } = {},
): ConnectorCatalogPipelineResult {
    const pipelineComplete = continuation === null && options.forceIncomplete !== true;
    return {
        runId,
        mode: input.mode,
        stage: input.stage,
        status: "complete",
        pipeline_complete: pipelineComplete,
        next_stage: continuation ? continuation.input.stage : options.forceIncomplete ? input.stage : null,
        continued_to: continuation?.id ?? null,
        started_at: started,
        finished_at: new Date().toISOString(),
        progress,
        health,
        gc,
        control_errors: options.controlErrors && options.controlErrors.length > 0 ? options.controlErrors : undefined,
    };
}

async function startPipelineWorkers(
    env: Env,
    input: NormalizedPipelineInput,
    runId: string,
    workerRole: Exclude<ConnectorCatalogPipelineWorkerRole, "coordinator">,
    options: { idScope?: string } = {},
): Promise<PipelineWorkerStartReport[]> {
    const rootId = await rootIdForRun(env, runId);
    const idScope = options.idScope || runId;
    const count = workerCount(input, workerRole);
    const stage = workerStage(workerRole);
    const workers: PipelineWorkerStartReport[] = [];
    for (let workerIndex = 0; workerIndex < count; workerIndex += 1) {
        const workerInput = normalizePipelineInput({
            ...input,
            stage,
            workerRole,
            workerIndex,
            resetSeed: workerRole === "seed-worker" && workerIndex === 0 ? input.resetSeed : false,
        });
        const id = workerPipelineId(idScope, workerRole, workerIndex);
        try {
            const started = await startConnectorCatalogPipeline(env, workerInput, {
                id,
                parentId: runId,
                rootId,
            });
            workers.push({
                id: started.id,
                worker_index: workerIndex,
                worker_role: workerRole,
                input: workerInput,
                attempt: 0,
                initial_error: null,
            });
        } catch (error) {
            workers.push({
                id,
                worker_index: workerIndex,
                worker_role: workerRole,
                input: workerInput,
                attempt: 0,
                initial_error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return workers;
}

function parseWorkerOutput(value: unknown): ConnectorCatalogPipelineResult | null {
    if (!value || typeof value !== "object") return null;
    const output = value as Partial<ConnectorCatalogPipelineResult>;
    if (output.status !== "complete" || !output.progress) return null;
    return output as ConnectorCatalogPipelineResult;
}

async function pollWorkflowFollowingContinuations(
    env: Env,
    id: string,
): Promise<{ id: string; status: unknown; output: ConnectorCatalogPipelineResult | null }> {
    let currentId = id;
    let status: unknown = null;
    let output: ConnectorCatalogPipelineResult | null = null;
    for (let depth = 0; depth < 8; depth += 1) {
        const instance = await env.CATALOG_PIPELINE.get(currentId);
        status = await instance.status().catch((error: unknown) => ({
            status: "unknown" as const,
            error: { name: "WorkflowStatusError", message: error instanceof Error ? error.message : String(error) },
        }));
        await reconcilePipelineRunWithWorkflowStatus(env, currentId, status);
        output = parseWorkerOutput(status && typeof status === "object" ? (status as { output?: unknown }).output : null);
        if (workflowStatus(status) === "complete" && output?.continued_to && output.pipeline_complete === false) {
            currentId = output.continued_to;
            continue;
        }
        return { id: currentId, status, output };
    }
    return { id: currentId, status, output };
}

async function pollPipelineWorkers(env: Env, workers: PipelineWorkerStartReport[]): Promise<{ complete: boolean; reports: PipelineWorkerPollReport[] }> {
    const reports: PipelineWorkerPollReport[] = [];
    for (const worker of workers) {
        if (worker.initial_error) {
            reports.push({
                id: worker.id,
                status: "errored",
                output: null,
                error: worker.initial_error,
                failed: true,
            });
            continue;
        }
        try {
            const polled = await pollWorkflowFollowingContinuations(env, worker.id);
            worker.id = polled.id;
            const status = polled.status;
            const terminal = derivePipelineTerminalUpdate(status);
            const statusName = workflowStatus(status);
            const error = workflowErrorMessage(status);
            const failed = terminal?.status === "errored" || statusName === "errored" || statusName === "terminated";
            reports.push({
                id: worker.id,
                status: statusName,
                output: polled.output,
                error,
                failed,
            });
        } catch (error) {
            reports.push({
                id: worker.id,
                status: "unknown",
                output: null,
                error: error instanceof Error ? error.message : String(error),
                failed: false,
            });
        }
    }
    return {
        complete: reports.length > 0 && reports.every((report) => !report.failed && report.status === "complete" && report.output?.pipeline_complete === true),
        reports,
    };
}

async function sleepBetweenPolls(step: WorkflowStepLike, name: string): Promise<void> {
    if (step.sleep) {
        await step.sleep(name, WORKER_POLL_SLEEP);
    }
}

function workerReportById(reports: PipelineWorkerPollReport[]): Map<string, PipelineWorkerPollReport> {
    return new Map(reports.map((report) => [report.id, report]));
}

async function replacePipelineWorkers(
    env: Env,
    runId: string,
    workers: PipelineWorkerStartReport[],
    reports: PipelineWorkerPollReport[],
    input: { pollIndex: number; restartCompleted?: boolean },
): Promise<PipelineWorkerReplacementReport[]> {
    let rootId = runId;
    try {
        rootId = await rootIdForRun(env, runId);
    } catch {
        rootId = runId;
    }
    const byId = workerReportById(reports);
    const replacements: PipelineWorkerReplacementReport[] = [];
    for (let index = 0; index < workers.length; index += 1) {
        const worker = workers[index]!;
        const report = byId.get(worker.id);
        if (!report) continue;
        const shouldReplace = report.failed || (
            report.status === "complete" &&
            report.output?.pipeline_complete === false &&
            !report.output.continued_to
        ) || (
            input.restartCompleted === true &&
            report.status === "complete" &&
            report.output?.pipeline_complete === true
        );
        if (!shouldReplace) continue;

        const attempt = worker.attempt + 1;
        const reason = report.failed
            ? (report.error || report.status || "worker failed")
            : report.output?.pipeline_complete === false && !report.output.continued_to
                ? (report.output.control_errors?.join("; ") || "worker completed without a continuation")
                : "sidecar worker completed while upstream is still active";
        const id = workerPipelineRetryId(runId, worker.worker_role, worker.worker_index, attempt, input.pollIndex);
        try {
            const started = await startConnectorCatalogPipeline(env, worker.input, {
                id,
                parentId: runId,
                rootId,
            });
            workers[index] = {
                ...worker,
                id: started.id,
                attempt,
                initial_error: null,
            };
            replacements.push({
                previous_id: worker.id,
                replacement_id: started.id,
                worker_index: worker.worker_index,
                worker_role: worker.worker_role,
                reason,
                error: null,
            });
        } catch (error) {
            replacements.push({
                previous_id: worker.id,
                replacement_id: null,
                worker_index: worker.worker_index,
                worker_role: worker.worker_role,
                reason,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return replacements;
}

type PipelineWorkerGroups = Record<Exclude<ConnectorCatalogPipelineWorkerRole, "coordinator">, PipelineWorkerStartReport[]>;
type PipelineWorkerPolls = Record<Exclude<ConnectorCatalogPipelineWorkerRole, "coordinator">, { complete: boolean; reports: PipelineWorkerPollReport[] }>;

async function startAllPipelineWorkerGroups(env: Env, input: NormalizedPipelineInput, runId: string): Promise<PipelineWorkerGroups> {
    const entries = await Promise.all(PIPELINE_WORKER_ROLES.map(async (role) => [
        role,
        await startPipelineWorkers(env, input, runId, role, { idScope: runId }),
    ] as const));
    return Object.fromEntries(entries) as PipelineWorkerGroups;
}

async function pollPipelineWorkerGroups(env: Env, groups: PipelineWorkerGroups): Promise<PipelineWorkerPolls> {
    const entries = await Promise.all(PIPELINE_WORKER_ROLES.map(async (role) => [
        role,
        await pollPipelineWorkers(env, groups[role]),
    ] as const));
    return Object.fromEntries(entries) as PipelineWorkerPolls;
}

function hasActiveUpstream(role: Exclude<ConnectorCatalogPipelineWorkerRole, "coordinator">, polls: PipelineWorkerPolls): boolean {
    switch (role) {
        case "seed-worker":
            return false;
        case "verify-worker":
            return !polls["seed-worker"].complete;
        case "metadata-worker":
            return !polls["seed-worker"].complete || !polls["verify-worker"].complete;
        case "publish-worker":
            return !polls["seed-worker"].complete || !polls["verify-worker"].complete || !polls["metadata-worker"].complete;
        case "embed-worker":
            return !polls["seed-worker"].complete || !polls["verify-worker"].complete || !polls["metadata-worker"].complete || !polls["publish-worker"].complete;
    }
}

async function reconcilePipelineWorkerGroups(
    env: Env,
    runId: string,
    groups: PipelineWorkerGroups,
    polls: PipelineWorkerPolls,
    pollIndex: number,
): Promise<PipelineWorkerReplacementReport[]> {
    const replacements: PipelineWorkerReplacementReport[] = [];
    for (const role of PIPELINE_WORKER_ROLES) {
        replacements.push(...await replacePipelineWorkers(env, runId, groups[role], polls[role].reports, {
            pollIndex,
            restartCompleted: hasActiveUpstream(role, polls),
        }));
    }
    return replacements;
}

function summarizeWorkerGroups(groups: PipelineWorkerGroups): Record<string, Array<{ id: string; workerIndex: number }>> {
    return Object.fromEntries(PIPELINE_WORKER_ROLES.map((role) => [
        role,
        groups[role].map((worker) => ({ id: worker.id, workerIndex: worker.worker_index })),
    ]));
}

function summarizeWorkerPolls(polls: PipelineWorkerPolls): Record<string, {
    complete: boolean;
    workers: Array<{ id: string; status: string | null; error: string | null; failed: boolean }>;
}> {
    return Object.fromEntries(PIPELINE_WORKER_ROLES.map((role) => [
        role,
        {
            complete: polls[role].complete,
            workers: polls[role].reports.map((report) => ({
                id: report.id,
                status: report.status,
                error: report.error,
                failed: report.failed,
            })),
        },
    ]));
}

function allWorkerGroupsComplete(polls: PipelineWorkerPolls): boolean {
    return PIPELINE_WORKER_ROLES.every((role) => polls[role].complete);
}

async function runVerifyWorkerPipeline(
    env: Env,
    step: WorkflowStepLike,
    input: NormalizedPipelineInput,
    runId: string,
    started: string,
    progress: PipelineProgress,
): Promise<ConnectorCatalogPipelineResult> {
    const shardIds = verifyWorkerShardIds(input.workerIndex, input.verifyWorkerCount, input.shardCount);
    let complete = shardIds.length === 0;
    for (let i = 0; i < input.verifyIterations && !complete; i += 1) {
        if (await isPipelineRunSuperseded(env, runId)) {
            complete = true;
            break;
        }
        const reports = await step.do(`verify-worker-${input.workerIndex}-${i + 1}`, VERIFY_STEP_CONFIG, async () =>
            await runVerifyShardGroup(env, input, shardIds),
        );
        addVerify(progress, reports);
        await recordPipelineStage(env, runId, `verify:${i + 1}`, progress);
        complete = reports.every((report) => report.done);
    }
    const continuationResult = complete
        ? { continuation: null, controlErrors: [] }
        : await step.do(
            `continue-verify-worker-${input.workerIndex}`,
            STEP_CONFIG,
            async () => await startContinuationSafely(env, input, "verify", runId),
        );
    const result = makeSegmentResult(runId, input, started, progress, continuationResult.continuation, undefined, undefined, {
        forceIncomplete: !complete && !continuationResult.continuation,
        controlErrors: continuationResult.controlErrors,
    });
    await recordPipelineComplete(env, runId, result);
    return result;
}

async function runMetadataWorkerPipeline(
    env: Env,
    step: WorkflowStepLike,
    input: NormalizedPipelineInput,
    runId: string,
    started: string,
    progress: PipelineProgress,
): Promise<ConnectorCatalogPipelineResult> {
    const assignment = metadataWorkerAssignment(input.workerIndex, input.metadataWorkerCount);
    let complete = false;
    let emptyPasses = 0;
    for (let i = 0; i < input.metadataIterations; i += 1) {
        if (await isPipelineRunSuperseded(env, runId)) {
            complete = true;
            break;
        }
        const report = await step.do(`metadata-worker-${input.workerIndex}-${i + 1}`, STEP_CONFIG, async () =>
            await runMetadataSafely(env, {
                agentId: assignment.agentId,
                limit: input.metadataLimit,
                retryRecent: input.retryRecent,
                laneId: assignment.laneId,
                laneCount: assignment.laneCount,
            }),
        );
        addMetadata(progress, [report]);
        await recordPipelineStage(env, runId, `metadata-agents:${i + 1}`, progress);
        if (metadataExamined([report]) === 0) {
            emptyPasses += 1;
            if (emptyPasses >= METADATA_IDLE_EMPTY_PASSES) {
                complete = true;
                break;
            }
            await sleepBetweenPolls(step, `metadata-worker-${input.workerIndex}-idle-${i + 1}`);
            continue;
        }
        emptyPasses = 0;
    }
    const continuationResult = complete
        ? { continuation: null, controlErrors: [] }
        : await step.do(
            `continue-metadata-worker-${input.workerIndex}`,
            STEP_CONFIG,
            async () => await startContinuationSafely(env, input, "metadata", runId),
        );
    const result = makeSegmentResult(runId, input, started, progress, continuationResult.continuation, undefined, undefined, {
        forceIncomplete: !complete && !continuationResult.continuation,
        controlErrors: continuationResult.controlErrors,
    });
    await recordPipelineComplete(env, runId, result);
    return result;
}

async function runSeedWorkerPipeline(
    env: Env,
    step: WorkflowStepLike,
    input: NormalizedPipelineInput,
    runId: string,
    started: string,
    progress: PipelineProgress,
): Promise<ConnectorCatalogPipelineResult> {
    let complete = false;
    for (let i = 0; i < input.seedIterations; i += 1) {
        if (await isPipelineRunSuperseded(env, runId)) {
            complete = true;
            break;
        }
        const report = await step.do(`seed-worker-${input.workerIndex}-${i + 1}`, STEP_CONFIG, async () =>
            await runSeedSafely(env, {
                maxPages: input.seedMaxPages,
                maxCandidates: input.seedCandidateLimit,
                reset: input.resetSeed && i === 0,
            }),
        );
        addSeed(progress, report);
        await recordPipelineStage(env, runId, `seed:${i + 1}`, progress);
        if (report.done) {
            complete = true;
            break;
        }
    }
    const continuationResult = complete
        ? { continuation: null, controlErrors: [] }
        : await step.do(
            `continue-seed-worker-${input.workerIndex}`,
            STEP_CONFIG,
            async () => await startContinuationSafely(env, input, "seed", runId),
        );
    const result = makeSegmentResult(runId, input, started, progress, continuationResult.continuation, undefined, undefined, {
        forceIncomplete: !complete && !continuationResult.continuation,
        controlErrors: continuationResult.controlErrors,
    });
    await recordPipelineComplete(env, runId, result);
    return result;
}

async function runPublishWorkerPipeline(
    env: Env,
    step: WorkflowStepLike,
    input: NormalizedPipelineInput,
    runId: string,
    started: string,
    progress: PipelineProgress,
): Promise<ConnectorCatalogPipelineResult> {
    const lane = laneAssignment(input.workerIndex, input.publishWorkerCount);
    let complete = false;
    for (let i = 0; i < input.publishIterations; i += 1) {
        if (await isPipelineRunSuperseded(env, runId)) {
            complete = true;
            break;
        }
        const report = await step.do(`publish-worker-${input.workerIndex}-${i + 1}`, STEP_CONFIG, async () =>
            await runPublishSafely(env, input.publishLimit, lane),
        );
        addPublish(progress, report);
        await recordPipelineStage(env, runId, `publish:${i + 1}`, progress);
        if (report.examined === 0 && report.errors.length === 0) {
            if (await shouldKeepPublishWorkerOpen(env)) {
                await sleepBetweenPolls(step, `publish-worker-${input.workerIndex}-idle-${i + 1}`);
                continue;
            }
            complete = true;
            break;
        }
        if (report.examined === 0 && report.errors.length > 0) break;
    }
    const continuationResult = complete
        ? { continuation: null, controlErrors: [] }
        : await step.do(
            `continue-publish-worker-${input.workerIndex}`,
            STEP_CONFIG,
            async () => await startContinuationSafely(env, input, "publish", runId),
        );
    const result = makeSegmentResult(runId, input, started, progress, continuationResult.continuation, undefined, undefined, {
        forceIncomplete: !complete && !continuationResult.continuation,
        controlErrors: continuationResult.controlErrors,
    });
    await recordPipelineComplete(env, runId, result);
    return result;
}

async function runEmbedWorkerPipeline(
    env: Env,
    step: WorkflowStepLike,
    input: NormalizedPipelineInput,
    runId: string,
    started: string,
    progress: PipelineProgress,
): Promise<ConnectorCatalogPipelineResult> {
    const lane = laneAssignment(input.workerIndex, input.embedWorkerCount);
    let complete = false;
    for (let i = 0; i < input.embedIterations; i += 1) {
        if (await isPipelineRunSuperseded(env, runId)) {
            complete = true;
            break;
        }
        const report = await step.do(`embed-worker-${input.workerIndex}-${i + 1}`, STEP_CONFIG, async () =>
            await runEmbedSafely(env, input.embedLimit, lane),
        );
        addEmbed(progress, report);
        await recordPipelineStage(env, runId, `embed:${i + 1}`, progress);
        if (report.embedded === 0 && report.errors.length === 0) {
            if (await shouldKeepEmbedWorkerOpen(env)) {
                await sleepBetweenPolls(step, `embed-worker-${input.workerIndex}-idle-${i + 1}`);
                continue;
            }
            complete = true;
            break;
        }
        if (report.embedded === 0 && report.errors.length > 0) break;
    }
    const continuationResult = complete
        ? { continuation: null, controlErrors: [] }
        : await step.do(
            `continue-embed-worker-${input.workerIndex}`,
            STEP_CONFIG,
            async () => await startContinuationSafely(env, input, "embed", runId),
        );
    const result = makeSegmentResult(runId, input, started, progress, continuationResult.continuation, undefined, undefined, {
        forceIncomplete: !complete && !continuationResult.continuation,
        controlErrors: continuationResult.controlErrors,
    });
    await recordPipelineComplete(env, runId, result);
    return result;
}

export async function runConnectorCatalogPipeline(
    env: Env,
    event: WorkflowEventLike<ConnectorCatalogPipelineInput>,
    step: WorkflowStepLike,
): Promise<ConnectorCatalogPipelineResult> {
    const input = normalizePipelineInput(event.payload || {});
    const runId = event.instanceId;
    const started = new Date().toISOString();
    const progress = emptyProgress();

    await recordPipelineRunning(env, runId, input);

    try {
        if (input.workerRole === "seed-worker") {
            return await runSeedWorkerPipeline(env, step, input, runId, started, progress);
        }
        if (input.workerRole === "verify-worker") {
            return await runVerifyWorkerPipeline(env, step, input, runId, started, progress);
        }
        if (input.workerRole === "metadata-worker") {
            return await runMetadataWorkerPipeline(env, step, input, runId, started, progress);
        }
        if (input.workerRole === "publish-worker") {
            return await runPublishWorkerPipeline(env, step, input, runId, started, progress);
        }
        if (input.workerRole === "embed-worker") {
            return await runEmbedWorkerPipeline(env, step, input, runId, started, progress);
        }

        let continuation: ConnectorCatalogPipelineStartReport | null = null;
        let health: unknown;
        let gc: unknown;

        const groups = await step.do("pipeline-worker-groups-spawn", STEP_CONFIG, async () =>
            await startAllPipelineWorkerGroups(env, input, runId),
        );
        await recordPipelineStage(env, runId, "supervisor:spawn", summarizeWorkerGroups(groups));

        let complete = false;
        for (let i = 0; i < input.supervisorPolls; i += 1) {
            const polls = await step.do(`supervisor:poll:${i + 1}`, STEP_CONFIG, async () =>
                await pollPipelineWorkerGroups(env, groups),
            );
            const replacements = await step.do(`supervisor:reconcile:${i + 1}`, STEP_CONFIG, async () =>
                await reconcilePipelineWorkerGroups(env, runId, groups, polls, i + 1),
            );
            complete = allWorkerGroupsComplete(polls);
            await recordPipelineStage(env, runId, `supervisor:${i + 1}`, {
                complete,
                groups: summarizeWorkerPolls(polls),
                replacements,
            });
            if (complete) break;
            await sleepBetweenPolls(step, `supervisor:sleep:${i + 1}`);
        }

        if (complete) {
            health = await step.do("health-rollup", STEP_CONFIG, async () => await runHealth(env));
            await recordPipelineStage(env, runId, "health", progress);
            gc = await step.do("gc", STEP_CONFIG, async () => await runGc(env));
            await recordPipelineStage(env, runId, "gc", progress);
        } else {
            const continuationResult = await step.do(
                "continue-supervisor",
                STEP_CONFIG,
                async () => await startContinuationSafely(env, input, input.stage, runId),
            );
            continuation = continuationResult.continuation;
            if (continuationResult.controlErrors.length > 0) {
                const result = makeSegmentResult(runId, input, started, progress, continuation, health, gc, {
                    forceIncomplete: true,
                    controlErrors: continuationResult.controlErrors,
                });
                await recordPipelineComplete(env, runId, result);
                return result;
            }
        }

        const result = makeSegmentResult(runId, input, started, progress, continuation, health, gc);
        await recordPipelineComplete(env, runId, result);
        return result;
    } catch (error) {
        const continuationResult = await startContinuationSafely(env, input, input.stage, runId);
        const result = makeSegmentResult(runId, input, started, progress, continuationResult.continuation, undefined, undefined, {
            forceIncomplete: true,
            controlErrors: [
                error instanceof Error ? error.message : String(error),
                ...continuationResult.controlErrors,
            ],
        });
        await recordPipelineComplete(env, runId, result);
        return result;
    }
}

export const __test = {
    normalizePipelineInput,
    derivePipelineTerminalUpdate,
    pipelineWorkerRoles: PIPELINE_WORKER_ROLES,
    workerPipelineId,
    workerPipelineRetryId,
    workerStage,
    workerCount,
    verifyWorkerShardIds,
    metadataWorkerAssignment,
    publishBacklog,
    embedBacklog,
    shouldKeepPublishWorkerOpen,
    shouldKeepEmbedWorkerOpen,
    isSupersededStage,
};
