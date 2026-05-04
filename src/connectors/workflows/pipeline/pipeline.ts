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

const STEP_CONFIG = {
    retries: { limit: 3, delay: "30 seconds", backoff: "exponential" as const },
    timeout: "30 minutes",
};
const VERIFY_STEP_CONFIG = {
    retries: { limit: 1, delay: "10 seconds", backoff: "linear" as const },
    timeout: "2 minutes",
};

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
            updated_at = CURRENT_TIMESTAMP`,
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

export async function startConnectorCatalogPipeline(
    env: Env,
    rawInput: ConnectorCatalogPipelineInput = {},
    options: { id?: string; parentId?: string | null; rootId?: string; continuation?: boolean; force?: boolean } = {},
): Promise<ConnectorCatalogPipelineStartReport> {
    const input = normalizePipelineInput(rawInput);
    const id = options.id || createPipelineRunId(input.mode);
    const meta = {
        rootId: options.rootId || id,
        parentId: options.parentId ?? null,
    };
    const active = await claimPipelineLock(env, id, input, meta, {
        continuation: options.continuation,
        force: options.force || rawInput.force === true,
    });
    if (active) return active;

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
            await markPipelineLockTerminal(env, id, "errored");
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
    await ensurePipelineRunTable(env);
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
}

async function recordPipelineStage(env: Env, runId: string, stage: string, result?: unknown): Promise<void> {
    const current = await env.CATALOG.prepare(
        `SELECT current_stage FROM pipeline_runs WHERE id = ?1 LIMIT 1`,
    ).bind(runId).first<{ current_stage: string | null }>();
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
}

async function recordPipelineComplete(env: Env, runId: string, result: ConnectorCatalogPipelineResult): Promise<void> {
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
}

async function recordPipelineError(env: Env, runId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
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

async function runVerifySlice(env: Env, input: NormalizedPipelineInput, iteration: number): Promise<VerifyReport[]> {
    const shardId = iteration % input.shardCount;
    return [
        await runVerifyShard(env, {
            shardId,
            shardCount: input.shardCount,
            limit: input.verifyLimit,
        }),
    ];
}

async function runMetadataAgents(env: Env, input: NormalizedPipelineInput): Promise<MetadataAgentReport[]> {
    return await Promise.all([
        runMetadataAgent(env, { agentId: 0, limit: input.metadataLimit, retryRecent: input.retryRecent }),
        runMetadataAgent(env, { agentId: 1, limit: input.metadataLimit, retryRecent: input.retryRecent }),
        runMetadataAgent(env, { agentId: 2, limit: input.metadataLimit, retryRecent: input.retryRecent }),
    ]);
}

function metadataExamined(reports: MetadataAgentReport[]): number {
    return reports.reduce((total, report) => total + report.examined, 0);
}

function nextStage(stage: ConnectorCatalogPipelineStage): ConnectorCatalogPipelineStage | null {
    switch (stage) {
        case "seed": return "verify";
        case "verify": return "metadata";
        case "metadata": return "publish";
        case "publish": return "embed";
        case "embed": return "health";
        case "health": return null;
    }
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

function makeSegmentResult(
    runId: string,
    input: NormalizedPipelineInput,
    started: string,
    progress: PipelineProgress,
    continuation: ConnectorCatalogPipelineStartReport | null,
    health?: unknown,
    gc?: unknown,
): ConnectorCatalogPipelineResult {
    return {
        runId,
        mode: input.mode,
        stage: input.stage,
        status: "complete",
        pipeline_complete: continuation === null,
        next_stage: continuation ? continuation.input.stage : null,
        continued_to: continuation?.id ?? null,
        started_at: started,
        finished_at: new Date().toISOString(),
        progress,
        health,
        gc,
    };
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
        let continuation: ConnectorCatalogPipelineStartReport | null = null;
        let health: unknown;
        let gc: unknown;

        if (input.stage === "seed") {
            let seedDone = false;
            for (let i = 0; i < input.seedIterations; i += 1) {
                const report = await step.do(`seed-${i + 1}`, STEP_CONFIG, async () =>
                    await runSeed(env, {
                        maxPages: input.seedMaxPages,
                        maxCandidates: input.seedCandidateLimit,
                        reset: input.resetSeed && i === 0,
                    }),
                );
                addSeed(progress, report);
                await recordPipelineStage(env, runId, `seed:${i + 1}`, progress);
                if (report.done) {
                    seedDone = true;
                    break;
                }
            }
            const stage = seedDone ? nextStage(input.stage)! : input.stage;
            continuation = await step.do(`continue-${stage}`, STEP_CONFIG, async () => await startContinuation(env, input, stage, runId));
        } else if (input.stage === "verify") {
            let stageComplete = false;
            let doneStreak = 0;
            for (let i = 0; i < input.verifyIterations; i += 1) {
                const reports = await step.do(`verify-${i + 1}`, VERIFY_STEP_CONFIG, async () =>
                    await runVerifySlice(env, input, i),
                );
                addVerify(progress, reports);
                await recordPipelineStage(env, runId, `verify:${i + 1}`, progress);
                if (reports.every((report) => report.done)) {
                    doneStreak += reports.length;
                } else {
                    doneStreak = 0;
                }
                if (doneStreak >= input.shardCount) {
                    stageComplete = true;
                    break;
                }
            }
            const stage = stageComplete ? nextStage(input.stage)! : input.stage;
            continuation = await step.do(`continue-${stage}`, STEP_CONFIG, async () => await startContinuation(env, input, stage, runId));
        } else if (input.stage === "metadata") {
            let exhausted = true;
            for (let i = 0; i < input.metadataIterations; i += 1) {
                const reports = await step.do(`metadata-agents-${i + 1}`, STEP_CONFIG, async () =>
                    await runMetadataAgents(env, input),
                );
                addMetadata(progress, reports);
                await recordPipelineStage(env, runId, `metadata-agents:${i + 1}`, progress);
                if (metadataExamined(reports) === 0) {
                    exhausted = false;
                    break;
                }
            }
            const stage = exhausted ? input.stage : nextStage(input.stage)!;
            continuation = await step.do(`continue-${stage}`, STEP_CONFIG, async () => await startContinuation(env, input, stage, runId));
        } else if (input.stage === "publish") {
            let exhausted = true;
            for (let i = 0; i < input.publishIterations; i += 1) {
                const report = await step.do(`publish-${i + 1}`, STEP_CONFIG, async () =>
                    await runPublish(env, { limit: input.publishLimit }),
                );
                addPublish(progress, report);
                await recordPipelineStage(env, runId, `publish:${i + 1}`, progress);
                if (report.examined === 0) {
                    exhausted = false;
                    break;
                }
            }
            const stage = exhausted ? input.stage : nextStage(input.stage)!;
            continuation = await step.do(`continue-${stage}`, STEP_CONFIG, async () => await startContinuation(env, input, stage, runId));
        } else if (input.stage === "embed") {
            let exhausted = true;
            for (let i = 0; i < input.embedIterations; i += 1) {
                const report = await step.do(`embed-${i + 1}`, STEP_CONFIG, async () =>
                    await runEmbed(env, { limit: input.embedLimit }),
                );
                addEmbed(progress, report);
                await recordPipelineStage(env, runId, `embed:${i + 1}`, progress);
                if (report.embedded === 0 && report.errors.length === 0) {
                    exhausted = false;
                    break;
                }
            }
            const stage = exhausted ? input.stage : nextStage(input.stage)!;
            continuation = await step.do(`continue-${stage}`, STEP_CONFIG, async () => await startContinuation(env, input, stage, runId));
        } else {
            health = await step.do("health-rollup", STEP_CONFIG, async () => await runHealth(env));
            await recordPipelineStage(env, runId, "health", progress);
            gc = await step.do("gc", STEP_CONFIG, async () => await runGc(env));
            await recordPipelineStage(env, runId, "gc", progress);
        }

        const result = makeSegmentResult(runId, input, started, progress, continuation, health, gc);
        await recordPipelineComplete(env, runId, result);
        return result;
    } catch (error) {
        await recordPipelineError(env, runId, error);
        throw error;
    }
}

export const __test = {
    normalizePipelineInput,
    derivePipelineTerminalUpdate,
};
