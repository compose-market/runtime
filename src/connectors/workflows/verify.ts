import type { Env, R2Object } from "../worker/env.js";
import { listToolsHttp } from "../container/transports/http.js";
import { listToolsViaRunner, RunnerDispatchError } from "../container/dispatcher.js";
import { detectFromJsonRpc, detectFromStderr } from "../worker/credentials.js";
import {
    candidateObjectKey,
    shadowObjectKey,
    type CatalogCandidate,
    type CatalogCandidateTransport,
} from "./candidates.js";
import type { ServerSpawnConfig } from "../catalog/spawn.js";
import {
    classifySpawnFailure,
    profilesForTransport,
    readSpawnAttempt,
    recordSpawnAttempt,
    type RunnerProfile,
} from "./attempts.js";
import {
    hashShard,
    hasTerminalScreening,
    readScreeningArtifact,
    writeScreeningArtifact,
    type ObservedCandidateTool,
    type ScreeningRow,
    type ScreenedTransport,
    type ScreeningError,
    type ScreeningStatus,
} from "./screening.js";

export interface VerifyReport {
    started_at: string;
    finished_at: string;
    shard_id: number;
    shard_count: number;
    done: boolean;
    scanned: number;
    examined: number;
    functional: number;
    credential_gated: number;
    retryable: number;
    shadowed: number;
    skipped: number;
    errors: Array<{ slug: string; message: string }>;
}

interface TransportProbeSuccess {
    ok: true;
    transport: CatalogCandidateTransport;
    tools: ObservedCandidateTool[];
    latencyMs: number;
    runnerProfile: string | null;
    deadlineMs: number;
    serverInfo?: Record<string, unknown> | null;
}

interface TransportProbeFailure {
    ok: false;
    error: ScreeningError;
}

type TransportProbe = TransportProbeSuccess | TransportProbeFailure;

interface CandidateScreeningResult {
    status: ScreeningStatus;
    functionalTransports: ScreenedTransport[];
    credentialVars: string[];
    errors: ScreeningError[];
}

interface CandidateBatch {
    candidates: Array<{ key: string; candidate: CatalogCandidate }>;
    nextCursor: string | null;
    done: boolean;
    scanned: number;
}

interface VerificationCursorState {
    cursor: string | undefined;
    done: boolean;
}

const VERIFY_PROBE_DEADLINE_MS = 20_000;
const VERIFY_LIST_PAGES_PER_CALL = 4;

async function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), ms);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function readCandidate(env: Env, object: R2Object): Promise<CatalogCandidate | null> {
    const body = await env.RAW.get(object.key);
    if (!body) return null;
    try {
        const parsed = await body.json<unknown>();
        const envelope = parsed && typeof parsed === "object" ? parsed as { candidate?: unknown } : {};
        const candidate = (envelope.candidate && typeof envelope.candidate === "object" ? envelope.candidate : parsed) as Partial<CatalogCandidate>;
        if (!candidate.slug || !candidate.sourceHash || !Array.isArray(candidate.transports)) return null;
        return candidate as CatalogCandidate;
    } catch {
        return null;
    }
}

function hashText(input: string): string {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

function probeAttemptObjectKey(
    candidate: Pick<CatalogCandidate, "slug" | "sourceHash">,
    transport: CatalogCandidateTransport,
    runnerProfile: RunnerProfile | null,
    attemptNo: number,
): string {
    const transportHash = hashText(JSON.stringify(transport));
    return [
        "screening-attempts",
        candidate.slug,
        candidate.sourceHash,
        "verify",
        `${transport.transport}-${transportHash}`,
        `${runnerProfile ?? "remote"}-${attemptNo}.json`,
    ].join("/");
}

async function readStoredProbeAttempt(
    env: Env,
    candidate: CatalogCandidate,
    transport: CatalogCandidateTransport,
    runnerProfile: RunnerProfile | null,
    attemptNo: number,
): Promise<TransportProbe | null> {
    const key = probeAttemptObjectKey(candidate, transport, runnerProfile, attemptNo);
    const object = await env.SNAPSHOTS.get(key);
    if (object) {
        try {
            const parsed = await object.json<{
                ok: boolean;
                tools?: ObservedCandidateTool[];
                latencyMs?: number;
                deadlineMs?: number;
                serverInfo?: Record<string, unknown> | null;
                error?: ScreeningError;
            }>();
            if (parsed.ok) {
                return {
                    ok: true,
                    transport,
                    tools: Array.isArray(parsed.tools) ? parsed.tools : [],
                    latencyMs: Number(parsed.latencyMs ?? 0),
                    runnerProfile,
                    deadlineMs: Number(parsed.deadlineMs ?? VERIFY_PROBE_DEADLINE_MS),
                    serverInfo: parsed.serverInfo ?? null,
                };
            }
            if (parsed.error) return { ok: false, error: parsed.error };
        } catch {
            return null;
        }
    }

    const recorded = await readSpawnAttempt(env, {
        serverSlug: candidate.slug,
        sourceHash: candidate.sourceHash,
        stage: "verify",
        transportKind: transport.transport,
        runnerProfile,
        attemptNo,
    });
    if (recorded?.status !== "failed") return null;
    return {
        ok: false,
        error: {
            transport: transport.transport,
            code: recorded.errorCode || "MCP_SPAWN_FAILED",
            message: recorded.errorMessage || "previous failed verification attempt",
            retryable: !["credentials_required", "permanent_invalid"].includes(recorded.retryClass),
            retryClass: recorded.retryClass,
        },
    };
}

async function writeStoredProbeAttempt(
    env: Env,
    candidate: CatalogCandidate,
    transport: CatalogCandidateTransport,
    runnerProfile: RunnerProfile | null,
    attemptNo: number,
    probe: TransportProbe,
): Promise<void> {
    const key = probeAttemptObjectKey(candidate, transport, runnerProfile, attemptNo);
    await env.SNAPSHOTS.put(key, JSON.stringify({
        ok: probe.ok,
        transport,
        runnerProfile,
        attemptNo,
        deadlineMs: probe.ok ? probe.deadlineMs : VERIFY_PROBE_DEADLINE_MS,
        latencyMs: probe.ok ? probe.latencyMs : undefined,
        tools: probe.ok ? probe.tools : undefined,
        serverInfo: probe.ok ? probe.serverInfo ?? null : undefined,
        error: probe.ok ? undefined : probe.error,
        attemptedAt: new Date().toISOString(),
    }), { httpMetadata: { contentType: "application/json" } });
}

function candidateObjectSlug(objectKey: string): string {
    return objectKey.split("/")[1] || objectKey;
}

async function listCandidateObjectsForPrefix(
    env: Env,
    input: {
        prefix: string;
        shardId: number;
        shardCount: number;
        limit: number;
        cursor?: string;
    },
): Promise<CandidateBatch> {
    const out: Array<{ key: string; candidate: CatalogCandidate }> = [];
    let cursor = input.cursor;
    let pages = 0;
    let scanned = 0;
    let reachedEnd = false;
    while (out.length < input.limit && pages < VERIFY_LIST_PAGES_PER_CALL) {
        const page = await env.RAW.list({ prefix: input.prefix, cursor, limit: 1000 });
        pages++;
        scanned += page.objects.length;
        for (const object of page.objects) {
            if (out.length >= input.limit) break;
            const keySlug = candidateObjectSlug(object.key);
            if (hashShard(keySlug, input.shardCount) !== input.shardId) continue;
            const candidate = await readCandidate(env, object);
            if (!candidate) continue;
            out.push({ key: object.key, candidate });
        }
        if (!page.truncated || !page.cursor) {
            cursor = undefined;
            reachedEnd = true;
            break;
        }
        cursor = page.cursor;
    }

    return {
        candidates: out,
        nextCursor: cursor || null,
        done: Boolean(reachedEnd && out.length === 0),
        scanned,
    };
}

function candidateBatchKey(candidate: Pick<CatalogCandidate, "slug" | "sourceHash">): string {
    return `${candidate.slug}\u001f${candidate.sourceHash}`;
}

async function listRetryableScreeningCandidates(
    env: Env,
    shardId: number,
    shardCount: number,
    limit: number,
    seen: Set<string>,
): Promise<Array<{ key: string; candidate: CatalogCandidate }>> {
    if (limit <= 0) return [];
    const out: Array<{ key: string; candidate: CatalogCandidate }> = [];
    const pageSize = Math.min(Math.max(limit * 200, 1000), 10_000);
    const rows = await env.CATALOG.prepare(
        `SELECT *
         FROM candidate_screenings
         WHERE status = 'retryable'
         ORDER BY updated_at ASC
         LIMIT ?1`,
    ).bind(pageSize).all<ScreeningRow>();

    for (const row of rows.results || []) {
        if (out.length >= limit) break;
        if (hashShard(row.server_slug, shardCount) !== shardId) continue;
        const key = `${row.server_slug}\u001f${row.source_hash}`;
        if (seen.has(key)) continue;
        const artifact = await readScreeningArtifact(env, row);
        if (!artifact?.candidate) continue;
        if (await hasTerminalScreening(env, artifact.candidate)) continue;
        seen.add(key);
        out.push({
            key: candidateObjectKey(artifact.candidate),
            candidate: artifact.candidate,
        });
    }
    return out;
}

async function ensureVerificationCursorColumns(env: Env): Promise<void> {
    await env.CATALOG.prepare(
        `CREATE TABLE IF NOT EXISTS verification_cursor (
            shard_id          INTEGER PRIMARY KEY,
            shard_count       INTEGER NOT NULL,
            last_slug         TEXT,
            r2_cursor         TEXT,
            done              INTEGER NOT NULL DEFAULT 0,
            updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
    ).run();
    try {
        await env.CATALOG.prepare(`SELECT r2_cursor FROM verification_cursor LIMIT 1`).first();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/no such column/i.test(message)) throw error;
        await env.CATALOG.prepare(`ALTER TABLE verification_cursor ADD COLUMN r2_cursor TEXT`).run();
    }
    try {
        await env.CATALOG.prepare(`SELECT done FROM verification_cursor LIMIT 1`).first();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/no such column/i.test(message)) throw error;
        await env.CATALOG.prepare(`ALTER TABLE verification_cursor ADD COLUMN done INTEGER NOT NULL DEFAULT 0`).run();
    }
}

async function readVerificationCursor(env: Env, shardId: number, shardCount: number): Promise<VerificationCursorState> {
    await ensureVerificationCursorColumns(env);
    const row = await env.CATALOG.prepare(
        `SELECT shard_count, r2_cursor, done FROM verification_cursor WHERE shard_id = ?1 LIMIT 1`,
    ).bind(shardId).first<{ shard_count: number; r2_cursor: string | null; done: number | null }>();
    if (!row || row.shard_count !== shardCount) return { cursor: undefined, done: false };
    return {
        cursor: row.r2_cursor || undefined,
        done: Number(row.done ?? 0) === 1,
    };
}

async function persistVerificationCursor(
    env: Env,
    input: {
        shardId: number;
        shardCount: number;
        lastSlug: string | null;
        nextCursor: string | null;
        done: boolean;
    },
): Promise<void> {
    await ensureVerificationCursorColumns(env);
    await env.CATALOG.prepare(
        `INSERT INTO verification_cursor (shard_id, shard_count, last_slug, r2_cursor, done, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, CURRENT_TIMESTAMP)
         ON CONFLICT(shard_id) DO UPDATE SET
            shard_count = excluded.shard_count,
            last_slug = excluded.last_slug,
            r2_cursor = excluded.r2_cursor,
            done = excluded.done,
            updated_at = CURRENT_TIMESTAMP`,
    ).bind(input.shardId, input.shardCount, input.lastSlug, input.nextCursor, input.done ? 1 : 0).run();
}

async function ensureRetryQueueSchema(env: Env): Promise<void> {
    await env.CATALOG.prepare(
        `CREATE TABLE IF NOT EXISTS candidate_retry_queue (
            server_slug     TEXT NOT NULL,
            source_hash     TEXT NOT NULL,
            source_version  TEXT NOT NULL,
            raw_key         TEXT NOT NULL,
            candidate_key   TEXT NOT NULL,
            retry_class     TEXT NOT NULL,
            attempts        INTEGER NOT NULL DEFAULT 1,
            next_retry_at   TEXT NOT NULL,
            last_error      TEXT,
            parked_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (server_slug, source_hash)
        )`,
    ).run();
    await env.CATALOG.prepare(
        `CREATE INDEX IF NOT EXISTS idx_candidate_retry_queue_next
         ON candidate_retry_queue(next_retry_at, retry_class, updated_at)`,
    ).run();
}

async function deleteRetryQueueEntry(env: Env, candidate: Pick<CatalogCandidate, "slug" | "sourceHash">): Promise<void> {
    await ensureRetryQueueSchema(env);
    await env.CATALOG.prepare(
        `DELETE FROM candidate_retry_queue
         WHERE server_slug = ?1
           AND source_hash = ?2`,
    ).bind(candidate.slug, candidate.sourceHash).run();
}

async function deleteCandidateState(
    env: Env,
    candidate: Pick<CatalogCandidate, "slug" | "sourceHash">,
    key: string,
): Promise<void> {
    await env.RAW.delete(key);
    await deleteRetryQueueEntry(env, candidate);
}

async function listCandidateBatch(
    env: Env,
    shardId: number,
    shardCount: number,
    limit: number,
): Promise<CandidateBatch> {
    const out: Array<{ key: string; candidate: CatalogCandidate }> = [];
    const seen = new Set<string>();
    const state = await readVerificationCursor(env, shardId, shardCount);
    const active = state.done
        ? { candidates: [], nextCursor: null, done: true, scanned: 0 }
        : await listCandidateObjectsForPrefix(env, {
            prefix: "candidates/",
            shardId,
            shardCount,
            limit,
            cursor: state.cursor,
        });
    out.push(...active.candidates);
    for (const entry of active.candidates) seen.add(candidateBatchKey(entry.candidate));
    let scanned = active.scanned;
    if (active.nextCursor || out.length >= limit) {
        return {
            candidates: out,
            nextCursor: active.nextCursor,
            done: false,
            scanned,
        };
    }

    const retryQueue = await listCandidateObjectsForPrefix(env, {
        prefix: "retry-queue/",
        shardId,
        shardCount,
        limit: limit - out.length,
    });
    out.push(...retryQueue.candidates);
    for (const entry of retryQueue.candidates) seen.add(candidateBatchKey(entry.candidate));
    scanned += retryQueue.scanned;
    if (out.length < limit) {
        const retryableScreenings = await listRetryableScreeningCandidates(env, shardId, shardCount, limit - out.length, seen);
        out.push(...retryableScreenings);
    }
    return {
        candidates: out,
        nextCursor: null,
        done: Boolean(active.done && retryQueue.done && out.length === 0),
        scanned,
    };
}

async function writeShadow(
    env: Env,
    candidate: CatalogCandidate,
    input: {
        reason: string;
        errors: unknown;
        deleteCandidateKey?: string;
    },
): Promise<void> {
    await env.SNAPSHOTS.put(shadowObjectKey(candidate), JSON.stringify({
        slug: candidate.slug,
        sourceHash: candidate.sourceHash,
        sourceVersion: candidate.sourceVersion,
        reason: input.reason,
        errors: input.errors,
        decidedAt: new Date().toISOString(),
        rawKey: candidate.rawKey,
    }), { httpMetadata: { contentType: "application/json" } });
    if (input.deleteCandidateKey) {
        await deleteCandidateState(env, candidate, input.deleteCandidateKey);
    }
}

async function probeTransportOnce(
    env: Env,
    candidate: CatalogCandidate,
    transport: CatalogCandidateTransport,
    input: { runnerProfile: RunnerProfile | null; attemptNo: number },
): Promise<TransportProbe> {
    const stored = await readStoredProbeAttempt(env, candidate, transport, input.runnerProfile, input.attemptNo);
    if (stored) return stored;

    const started = Date.now();
    try {
        const listingPromise = transport.transport === "http"
            ? listToolsHttp({
                url: requireRemoteUrl(transport),
                requiredCredentialVars: transport.envRequired,
                timeoutMs: VERIFY_PROBE_DEADLINE_MS,
            })
            : listToolsViaRunner(env, candidate.slug, toSpawnConfig(transport), {
                deadlineMs: VERIFY_PROBE_DEADLINE_MS,
                runnerProfile: input.runnerProfile,
            });
        const listing = await withDeadline(
            Promise.resolve(listingPromise),
            VERIFY_PROBE_DEADLINE_MS + 5_000,
            `${transport.transport} probe timed out after ${VERIFY_PROBE_DEADLINE_MS}ms`,
        );
        const tools = (listing.tools || []).map((tool) => ({
            name: String(tool.name),
            description: typeof tool.description === "string" ? tool.description : null,
            inputSchema: tool.inputSchema || {},
        }));
        if (tools.length === 0) {
            await recordSpawnAttempt(env, {
                serverSlug: candidate.slug,
                sourceHash: candidate.sourceHash,
                sourceVersion: candidate.sourceVersion,
                stage: "verify",
                transportKind: transport.transport,
                runnerProfile: input.runnerProfile,
                deadlineMs: VERIFY_PROBE_DEADLINE_MS,
                attemptNo: input.attemptNo,
                status: "failed",
                retryClass: "permanent_invalid",
                errorCode: "TOOL_VALIDATION",
                errorMessage: "server returned zero tools",
                latencyMs: Date.now() - started,
                observedTools: 0,
            });
            const failed: TransportProbe = {
                ok: false,
                error: {
                    transport: transport.transport,
                    code: "TOOL_VALIDATION",
                    message: "server returned zero tools",
                    retryable: false,
                    retryClass: "permanent_invalid",
                },
            };
            await writeStoredProbeAttempt(env, candidate, transport, input.runnerProfile, input.attemptNo, failed).catch(() => undefined);
            return failed;
        }
        await recordSpawnAttempt(env, {
            serverSlug: candidate.slug,
            sourceHash: candidate.sourceHash,
            sourceVersion: candidate.sourceVersion,
            stage: "verify",
            transportKind: transport.transport,
            runnerProfile: input.runnerProfile,
            deadlineMs: VERIFY_PROBE_DEADLINE_MS,
            attemptNo: input.attemptNo,
            status: "success",
            retryClass: "success",
            latencyMs: Date.now() - started,
            observedTools: tools.length,
        });
        const succeeded: TransportProbe = {
            ok: true,
            transport,
            tools,
            latencyMs: Date.now() - started,
            runnerProfile: input.runnerProfile,
            deadlineMs: VERIFY_PROBE_DEADLINE_MS,
            serverInfo: "serverInfo" in listing ? listing.serverInfo ?? null : null,
        };
        await writeStoredProbeAttempt(env, candidate, transport, input.runnerProfile, input.attemptNo, succeeded).catch(() => undefined);
        return succeeded;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const credentialVars = [...new Set([
            ...detectFromStderr(message),
            ...detectFromJsonRpc(safeJsonParse(message)),
            ...(error instanceof RunnerDispatchError ? error.credentialVars : []),
        ])];
        const classification = classifySpawnFailure({
            message,
            transport: transport.transport,
            credentialVars,
            runnerRetryable: error instanceof RunnerDispatchError ? error.retryable : undefined,
        });
        await recordSpawnAttempt(env, {
            serverSlug: candidate.slug,
            sourceHash: candidate.sourceHash,
            sourceVersion: candidate.sourceVersion,
            stage: "verify",
            transportKind: transport.transport,
            runnerProfile: input.runnerProfile,
            deadlineMs: VERIFY_PROBE_DEADLINE_MS,
            attemptNo: input.attemptNo,
            status: "failed",
            retryClass: classification.retryClass,
            errorCode: classification.code,
            errorMessage: message,
            latencyMs: Date.now() - started,
            observedTools: 0,
        });
        const failed: TransportProbe = {
            ok: false,
            error: {
                transport: transport.transport,
                code: classification.code,
                message,
                credentialVars,
                retryable: classification.retryable,
                retryClass: classification.retryClass,
            },
        };
        await writeStoredProbeAttempt(env, candidate, transport, input.runnerProfile, input.attemptNo, failed).catch(() => undefined);
        return failed;
    }
}

async function probeTransport(env: Env, candidate: CatalogCandidate, transport: CatalogCandidateTransport): Promise<TransportProbe> {
    if (transport.transport === "http") {
        return await probeTransportOnce(env, candidate, transport, { runnerProfile: null, attemptNo: 1 });
    }
    const profiles = profilesForTransport(env, transport.transport);
    let last: TransportProbe | null = null;
    for (let i = 0; i < profiles.length; i += 1) {
        const profile = profiles[i]!;
        const probe = await probeTransportOnce(env, candidate, transport, { runnerProfile: profile, attemptNo: i + 1 });
        if (probe.ok) return probe;
        last = probe;
    }
    return last || await probeTransportOnce(env, candidate, transport, { runnerProfile: "lite", attemptNo: 1 });
}

async function screenCandidate(env: Env, candidate: CatalogCandidate): Promise<CandidateScreeningResult> {
    if (candidate.transports.length === 0) {
        return {
            status: "shadowed",
            functionalTransports: [],
            credentialVars: [],
            errors: [{ transport: "none", code: "TOOL_VALIDATION", message: "no transports supplied", retryable: false }],
        };
    }

    const probes: TransportProbe[] = [];
    for (const transport of [...candidate.transports].sort((a, b) => b.priority - a.priority)) {
        probes.push(await probeTransport(env, candidate, transport));
    }

    const now = new Date().toISOString();
    const successes = probes.filter((probe): probe is TransportProbeSuccess => probe.ok);
    const errors = probes.filter((probe): probe is TransportProbeFailure => !probe.ok).map((probe) => probe.error);
    const detectedCredentialVars = errors.flatMap((error) => error.credentialVars || []);
    const credentialVars = [...new Set(detectedCredentialVars)].sort();

    if (successes.length > 0) {
        return {
            status: "functional",
            functionalTransports: successes.map((success) => ({
                transport: success.transport,
                tools: success.tools,
                latencyMs: success.latencyMs,
                runnerProfile: success.runnerProfile,
                deadlineMs: success.deadlineMs,
                serverInfo: success.serverInfo ?? null,
                observedAt: now,
            })),
            credentialVars,
            errors,
        };
    }

    if (credentialVars.length > 0) {
        return {
            status: "credential_gated",
            functionalTransports: [],
            credentialVars,
            errors,
        };
    }

    return {
        status: "shadowed",
        functionalTransports: [],
        credentialVars: [],
        errors,
    };
}

function requireRemoteUrl(transport: CatalogCandidateTransport): string {
    if (!transport.remoteUrl) throw new Error("remoteUrl required");
    return transport.remoteUrl;
}

function toSpawnConfig(transport: CatalogCandidateTransport): ServerSpawnConfig {
    return {
        transport: transport.transport,
        command: transport.transport === "stdio" ? transport.args[0] : undefined,
        args: transport.transport === "stdio" ? transport.args.slice(1) : transport.args,
        env: {},
        envRequired: transport.envRequired,
        envOptional: transport.envOptional,
        image: transport.image ?? undefined,
        remoteUrl: transport.remoteUrl ?? undefined,
        protocol: transport.protocol ?? undefined,
        package: transport.package ?? undefined,
    };
}

export async function runVerifyShard(
    env: Env,
    options: { shardId?: number; shardCount?: number; limit?: number } = {},
): Promise<VerifyReport> {
    const started = new Date().toISOString();
    const shardCount = Math.max(1, Math.min(options.shardCount ?? 3, 64));
    const shardId = Math.max(0, Math.min(options.shardId ?? 0, shardCount - 1));
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const errors: Array<{ slug: string; message: string }> = [];
    let done = false;
    let scanned = 0;
    let examined = 0;
    let functional = 0;
    let credentialGated = 0;
    let retryable = 0;
    let shadowed = 0;
    let skipped = 0;

    const batch = await listCandidateBatch(env, shardId, shardCount, limit);
    const candidates = batch.candidates;
    done = batch.done;
    scanned = batch.scanned;
    await persistVerificationCursor(env, {
        shardId,
        shardCount,
        lastSlug: candidates.at(-1)?.candidate.slug || null,
        nextCursor: batch.nextCursor,
        done,
    });
    for (const { key, candidate } of candidates) {
        examined++;
        try {
            const alreadyShadowed = await env.SNAPSHOTS.head(shadowObjectKey(candidate));
            if (alreadyShadowed || await hasTerminalScreening(env, candidate)) {
                await deleteCandidateState(env, candidate, key);
                skipped++;
                continue;
            }

            await writeScreeningArtifact(env, {
                slug: candidate.slug,
                sourceHash: candidate.sourceHash,
                sourceVersion: candidate.sourceVersion,
                rawKey: candidate.rawKey,
                status: "retryable",
                candidate,
                functionalTransports: [],
                credentialVars: [],
                errors: [{
                    transport: "none",
                    code: "MCP_SPAWN_FAILED",
                    message: "verification claimed before MCP spawn; retry if the workflow step terminates before final screening",
                    retryable: true,
                }],
                screenedAt: new Date().toISOString(),
            });

            const result = await screenCandidate(env, candidate);
            const artifact = {
                slug: candidate.slug,
                sourceHash: candidate.sourceHash,
                sourceVersion: candidate.sourceVersion,
                rawKey: candidate.rawKey,
                status: result.status,
                candidate,
                functionalTransports: result.functionalTransports,
                credentialVars: result.credentialVars,
                errors: result.errors,
                screenedAt: new Date().toISOString(),
            };
            await writeScreeningArtifact(env, artifact);

            if (result.status === "shadowed") {
                await writeShadow(env, candidate, {
                    reason: "permanent screening failure",
                    errors: result.errors,
                    deleteCandidateKey: key,
                });
                shadowed++;
                continue;
            }

            await deleteCandidateState(env, candidate, key);
            if (result.status === "functional") functional++;
            if (result.status === "credential_gated") credentialGated++;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push({ slug: candidate.slug, message });
            const fallbackErrors: ScreeningError[] = [{
                transport: "none",
                code: "MCP_SPAWN_FAILED",
                message,
                retryable: false,
                retryClass: "permanent_invalid",
            }];
            await writeScreeningArtifact(env, {
                slug: candidate.slug,
                sourceHash: candidate.sourceHash,
                sourceVersion: candidate.sourceVersion,
                rawKey: candidate.rawKey,
                status: "shadowed",
                candidate,
                functionalTransports: [],
                credentialVars: [],
                errors: fallbackErrors,
                screenedAt: new Date().toISOString(),
            });
            await writeShadow(env, candidate, {
                reason: "verification exception after exhaustive probe",
                errors: fallbackErrors,
                deleteCandidateKey: key,
            });
            shadowed++;
        }
    }

    return {
        started_at: started,
        finished_at: new Date().toISOString(),
        shard_id: shardId,
        shard_count: shardCount,
        done,
        scanned,
        examined,
        functional,
        credential_gated: credentialGated,
        retryable,
        shadowed,
        skipped,
        errors,
    };
}

function safeJsonParse(s: string): unknown {
    try { return JSON.parse(s); } catch { return null; }
}

export const __test = {
    screenCandidate,
    listCandidateBatch,
    probeAttemptObjectKey,
};
