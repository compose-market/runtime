import type { Env, R2Object } from "../worker/env.js";
import { listToolsHttp } from "../container/transports/http.js";
import { listToolsViaRunner, RunnerDispatchError } from "../container/dispatcher.js";
import { detectFromJsonRpc, detectFromStderr } from "../worker/credentials.js";
import {
    shadowObjectKey,
    type CatalogCandidate,
    type CatalogCandidateTransport,
} from "./candidates.js";
import type { ServerSpawnConfig } from "../catalog/spawn.js";
import {
    hashShard,
    hasTerminalScreening,
    hasRecentRetryableScreening,
    writeScreeningArtifact,
    type ObservedCandidateTool,
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
        const parsed = await body.json<CatalogCandidate>();
        if (!parsed.slug || !parsed.sourceHash || !Array.isArray(parsed.transports)) return null;
        return parsed;
    } catch {
        return null;
    }
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

async function listCandidateBatch(
    env: Env,
    shardId: number,
    shardCount: number,
    limit: number,
): Promise<CandidateBatch> {
    const out: Array<{ key: string; candidate: CatalogCandidate }> = [];
    const state = await readVerificationCursor(env, shardId, shardCount);
    if (state.done) {
        return {
            candidates: [],
            nextCursor: null,
            done: true,
            scanned: 0,
        };
    }
    let cursor: string | undefined = state.cursor;
    let pages = 0;
    let scanned = 0;
    let reachedEnd = false;
    while (out.length < limit && pages < VERIFY_LIST_PAGES_PER_CALL) {
        const page = await env.RAW.list({ prefix: "candidates/", cursor, limit: 1000 });
        pages++;
        scanned += page.objects.length;
        for (const object of page.objects) {
            if (out.length >= limit) break;
            const keySlug = object.key.split("/")[1] || object.key;
            if (hashShard(keySlug, shardCount) !== shardId) continue;
            const candidate = await readCandidate(env, object);
            if (!candidate) continue;
            if (await hasRecentRetryableScreening(env, candidate)) continue;
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
        await env.RAW.delete(input.deleteCandidateKey);
    }
}

async function probeTransport(env: Env, candidate: CatalogCandidate, transport: CatalogCandidateTransport): Promise<TransportProbe> {
    const started = Date.now();
    try {
        const listingPromise = transport.transport === "http"
            ? listToolsHttp({
                url: requireRemoteUrl(transport),
                requiredCredentialVars: transport.envRequired,
                timeoutMs: VERIFY_PROBE_DEADLINE_MS,
            })
            : listToolsViaRunner(env, candidate.slug, toSpawnConfig(transport), { deadlineMs: VERIFY_PROBE_DEADLINE_MS });
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
            return {
                ok: false,
                error: {
                    transport: transport.transport,
                    code: "TOOL_VALIDATION",
                    message: "server returned zero tools",
                    retryable: false,
                },
            };
        }
        return {
            ok: true,
            transport,
            tools,
            latencyMs: Date.now() - started,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const credentialVars = [...new Set([
            ...detectFromStderr(message),
            ...detectFromJsonRpc(safeJsonParse(message)),
            ...(error instanceof RunnerDispatchError ? error.credentialVars : []),
        ])];
        return {
            ok: false,
            error: {
                transport: transport.transport,
                code: credentialVars.length > 0 ? "CREDENTIALS_REQUIRED" : "MCP_SPAWN_FAILED",
                message,
                credentialVars,
                retryable: credentialVars.length === 0 && isRetryableVerificationFailure(error, message),
            },
        };
    }
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

    if (errors.some((error) => error.retryable === true)) {
        return {
            status: "retryable",
            functionalTransports: [],
            credentialVars: [],
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

function isRetryableVerificationFailure(error: unknown, message: string): boolean {
    if (error instanceof RunnerDispatchError) return error.retryable;
    return /timed out|timeout|aborted|too many subrequests|not yet provisioned|container|temporar|rate limit|network|fetch failed/i.test(message);
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
                await env.RAW.delete(key);
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

            if (result.status === "retryable") {
                retryable++;
                errors.push({ slug: candidate.slug, message: "retryable verification failure retained in R2" });
                continue;
            }

            if (result.status === "shadowed") {
                await writeShadow(env, candidate, {
                    reason: "permanent screening failure",
                    errors: result.errors,
                    deleteCandidateKey: key,
                });
                shadowed++;
                continue;
            }

            await env.RAW.delete(key);
            if (result.status === "functional") functional++;
            if (result.status === "credential_gated") credentialGated++;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push({ slug: candidate.slug, message });
            retryable++;
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
                    message,
                    retryable: true,
                }],
                screenedAt: new Date().toISOString(),
            });
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
};
