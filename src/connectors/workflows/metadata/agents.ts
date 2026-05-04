import type { Env } from "../../worker/env.js";
import { listToolsHttp } from "../../container/transports/http.js";
import { listToolsViaRunner, RunnerDispatchError } from "../../container/dispatcher.js";
import { detectFromJsonRpc, detectFromStderr } from "../../worker/credentials.js";
import type { CatalogCandidateTransport } from "../candidates.js";
import type { ServerSpawnConfig } from "../../catalog/spawn.js";
import {
    hashReviewedArtifact,
    reviewMetadataWithAgent,
    reviewerForAgent,
    type ReviewedCard,
} from "./review.js";
import {
    hashShard,
    ensureScreeningSchema,
    metadataArtifactObjectKey,
    parseScreeningJsonArray,
    readScreeningArtifact,
    type ObservedCandidateTool,
    type ScreenedTransport,
    type ScreeningArtifact,
    type ScreeningError,
    type ScreeningRow,
} from "../screening.js";

export interface MetadataAgentReport {
    started_at: string;
    finished_at: string;
    agent_id: number;
    reviewer: string;
    examined: number;
    completed: number;
    credential_gated: number;
    retryable: number;
    skipped: number;
    errors: Array<{ slug: string; message: string }>;
}

export interface MetadataAgentArtifact {
    slug: string;
    sourceHash: string;
    sourceVersion: string;
    agentId: number;
    reviewer: string;
    status: "complete";
    catalogStatus: "live" | "credential_gated";
    card: ReviewedCard;
    cardVersion: string;
    candidate: ScreeningArtifact["candidate"];
    observedTools: ObservedCandidateTool[];
    observedSchemas: Record<string, Record<string, unknown>>;
    observedTransports: ScreenedTransport[];
    credentialVars: string[];
    sourceScreeningKey: string;
    reviewedAt: string;
}

interface RespawnResult {
    ok: boolean;
    observedTransports: ScreenedTransport[];
    credentialVars: string[];
    errors: ScreeningError[];
}

const RETRYABLE_REVIEW_BACKOFF_MS = 30 * 60 * 1000;
const METADATA_RESPAWN_DEADLINE_MS = 20_000;

async function ensureMetadataAgentReviewSchema(env: Env): Promise<void> {
    try {
        await env.CATALOG.prepare(`SELECT canonical_agent_id FROM metadata_agent_reviews LIMIT 1`).first();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/no such column/i.test(message)) throw error;
        await env.CATALOG.prepare(`ALTER TABLE metadata_agent_reviews ADD COLUMN canonical_agent_id INTEGER`).run();
    }
}

async function listScreeningRows(
    env: Env,
    agentId: number,
    limit: number,
    options: { retryRecent?: boolean } = {},
): Promise<ScreeningRow[]> {
    await ensureScreeningSchema(env);
    await ensureMetadataAgentReviewSchema(env);
    const out: ScreeningRow[] = [];
    const pageSize = Math.min(Math.max(limit * 200, 10_000), 50_000);
    const retryCutoff = new Date(Date.now() - RETRYABLE_REVIEW_BACKOFF_MS).toISOString();
    const rows = await env.CATALOG.prepare(
        `SELECT s.*
         FROM candidate_screenings s
         LEFT JOIN metadata_agent_reviews r
           ON r.server_slug = s.server_slug
          AND r.source_hash = s.source_hash
          AND r.agent_id = ?1
         WHERE s.status IN ('functional', 'credential_gated')
           AND (s.metadata_agent_id = ?1 OR s.metadata_agent_id IS NULL)
           AND (
                r.status IS NULL
             OR r.status = 'failed'
             OR (r.status = 'retryable' AND (?2 = 1 OR r.updated_at <= ?3))
           )
         ORDER BY s.updated_at ASC
         LIMIT ?4`,
    ).bind(agentId, options.retryRecent ? 1 : 0, retryCutoff, pageSize).all<ScreeningRow>();

    for (const row of rows.results || []) {
        if (out.length >= limit) break;
        const computedAgentId = hashShard(`${row.server_slug}:${row.source_hash}`, 3);
        if (row.metadata_agent_id == null) {
            await env.CATALOG.prepare(
                `UPDATE candidate_screenings
                 SET metadata_agent_id = ?3
                 WHERE server_slug = ?1
                   AND source_hash = ?2
                   AND metadata_agent_id IS NULL`,
            ).bind(row.server_slug, row.source_hash, computedAgentId).run();
        }
        if (computedAgentId !== agentId) continue;
        out.push(row);
    }
    return out;
}

async function respawnTransport(
    env: Env,
    slug: string,
    transport: CatalogCandidateTransport,
    requiredCredentialVars: string[] = [],
): Promise<{
    transport: CatalogCandidateTransport;
    tools: ObservedCandidateTool[];
    latencyMs: number;
}> {
    const started = Date.now();
    const listing = transport.transport === "http"
        ? await listToolsHttp({
            url: requireRemoteUrl(transport),
            requiredCredentialVars: [...new Set([...transport.envRequired, ...requiredCredentialVars])].sort(),
            timeoutMs: METADATA_RESPAWN_DEADLINE_MS,
        })
        : await listToolsViaRunner(env, slug, toSpawnConfig(transport), { deadlineMs: METADATA_RESPAWN_DEADLINE_MS });
    const tools = (listing.tools || []).map((tool) => ({
        name: String(tool.name),
        description: typeof tool.description === "string" ? tool.description : null,
        inputSchema: tool.inputSchema || {},
    }));
    if (tools.length === 0) {
        throw new Error("server returned zero tools on metadata-agent respawn");
    }
    return { transport, tools, latencyMs: Date.now() - started };
}

async function respawnFunctional(env: Env, screening: ScreeningArtifact): Promise<RespawnResult> {
    const errors: ScreeningError[] = [];
    const observedTransports: ScreenedTransport[] = [];
    const credentialVars: string[] = [];
    const successfulTransports = screening.functionalTransports.map((entry) => entry.transport);

    for (const transport of successfulTransports) {
        try {
            const out = await respawnTransport(env, screening.slug, transport);
            observedTransports.push({
                transport: out.transport,
                tools: out.tools,
                latencyMs: out.latencyMs,
                observedAt: new Date().toISOString(),
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const vars = detectCredentialVars(error, message);
            credentialVars.push(...vars);
            errors.push({
                transport: transport.transport,
                code: vars.length > 0 ? "CREDENTIALS_REQUIRED" : "MCP_SPAWN_FAILED",
                message,
                credentialVars: vars,
                retryable: vars.length === 0 && isRetryableMetadataFailure(error, message),
            });
        }
    }

    return {
        ok: observedTransports.length === successfulTransports.length && observedTransports.length > 0,
        observedTransports,
        credentialVars: [...new Set(credentialVars)].sort(),
        errors,
    };
}

async function respawnCredentialGated(env: Env, screening: ScreeningArtifact): Promise<RespawnResult> {
    const errors: ScreeningError[] = [];
    const observedTransports: ScreenedTransport[] = [];
    const credentialVars = new Set(screening.credentialVars);

    for (const transport of screening.candidate.transports) {
        try {
            const out = await respawnTransport(env, screening.slug, transport, screening.credentialVars);
            observedTransports.push({
                transport: out.transport,
                tools: out.tools,
                latencyMs: out.latencyMs,
                observedAt: new Date().toISOString(),
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const vars = detectCredentialVars(error, message);
            for (const v of vars) credentialVars.add(v);
            errors.push({
                transport: transport.transport,
                code: vars.length > 0 ? "CREDENTIALS_REQUIRED" : "MCP_SPAWN_FAILED",
                message,
                credentialVars: vars,
                retryable: vars.length === 0 && isRetryableMetadataFailure(error, message),
            });
        }
    }

    if (observedTransports.length > 0) {
        return { ok: true, observedTransports, credentialVars: [...credentialVars].sort(), errors };
    }
    return {
        ok: credentialVars.size > 0,
        observedTransports: [],
        credentialVars: [...credentialVars].sort(),
        errors,
    };
}

function uniqueTools(observedTransports: ScreenedTransport[]): ObservedCandidateTool[] {
    const byName = new Map<string, ObservedCandidateTool>();
    for (const transport of observedTransports) {
        for (const tool of transport.tools) {
            if (!byName.has(tool.name)) {
                byName.set(tool.name, {
                    name: tool.name,
                    description: tool.description ?? null,
                    inputSchema: tool.inputSchema || {},
                });
            }
        }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function observedSchemas(tools: ObservedCandidateTool[]): Record<string, Record<string, unknown>> {
    const schemas: Record<string, Record<string, unknown>> = {};
    for (const tool of tools) {
        schemas[tool.name] = tool.inputSchema || {};
    }
    return schemas;
}

async function writeRetryableReview(
    env: Env,
    row: ScreeningRow,
    agentId: number,
    reviewer: string,
    message: string,
): Promise<void> {
    await ensureMetadataAgentReviewSchema(env);
    await env.CATALOG.prepare(
        `INSERT INTO metadata_agent_reviews
            (server_slug, source_hash, source_version, agent_id, status, reviewer, canonical_agent_id, error_message, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'retryable', ?5, ?6, ?7, CURRENT_TIMESTAMP)
         ON CONFLICT(server_slug, source_hash, agent_id) DO UPDATE SET
            status = excluded.status,
            reviewer = excluded.reviewer,
            canonical_agent_id = excluded.canonical_agent_id,
            error_message = excluded.error_message,
            updated_at = CURRENT_TIMESTAMP`,
    ).bind(
        row.server_slug,
        row.source_hash,
        row.source_version,
        agentId,
        reviewer,
        hashShard(`${row.server_slug}:${row.source_hash}`, 3),
        message,
    ).run();
}

async function writeCompleteReview(env: Env, artifact: MetadataAgentArtifact): Promise<void> {
    await ensureMetadataAgentReviewSchema(env);
    const key = metadataArtifactObjectKey({
        slug: artifact.slug,
        sourceHash: artifact.sourceHash,
        agentId: artifact.agentId,
    });
    await env.CARDS.put(key, JSON.stringify(artifact), {
        httpMetadata: { contentType: "application/json" },
    });
    await env.CATALOG.prepare(
        `INSERT INTO metadata_agent_reviews
            (server_slug, source_hash, source_version, agent_id, status, human_name, short_description, tags, observed_tools, observed_schemas, observed_transports, credential_vars, reviewer, artifact_key, card_version, canonical_agent_id, reviewed_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'complete', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, CURRENT_TIMESTAMP)
         ON CONFLICT(server_slug, source_hash, agent_id) DO UPDATE SET
            status = excluded.status,
            human_name = excluded.human_name,
            short_description = excluded.short_description,
            tags = excluded.tags,
            observed_tools = excluded.observed_tools,
            observed_schemas = excluded.observed_schemas,
            observed_transports = excluded.observed_transports,
            credential_vars = excluded.credential_vars,
            reviewer = excluded.reviewer,
            artifact_key = excluded.artifact_key,
            card_version = excluded.card_version,
            canonical_agent_id = excluded.canonical_agent_id,
            reviewed_at = excluded.reviewed_at,
            error_message = NULL,
            updated_at = CURRENT_TIMESTAMP`,
    ).bind(
        artifact.slug,
        artifact.sourceHash,
        artifact.sourceVersion,
        artifact.agentId,
        artifact.card.name,
        artifact.card.description,
        JSON.stringify(artifact.card.tags),
        JSON.stringify(artifact.observedTools),
        JSON.stringify(artifact.observedSchemas),
        JSON.stringify(artifact.observedTransports),
        JSON.stringify(artifact.credentialVars),
        artifact.reviewer,
        key,
        artifact.cardVersion,
        hashShard(`${artifact.slug}:${artifact.sourceHash}`, 3),
        artifact.reviewedAt,
    ).run();
}

export async function runMetadataAgent(
    env: Env,
    options: { agentId: number; limit?: number; retryRecent?: boolean } = { agentId: 0 },
): Promise<MetadataAgentReport> {
    const started = new Date().toISOString();
    const agentId = Math.max(0, Math.min(options.agentId, 2));
    const reviewer = reviewerForAgent(agentId);
    const limit = Math.max(1, Math.min(options.limit ?? 25, 100));
    const errors: Array<{ slug: string; message: string }> = [];
    let examined = 0;
    let completed = 0;
    let credentialGated = 0;
    let retryable = 0;
    let skipped = 0;

    const rows = await listScreeningRows(env, agentId, limit, { retryRecent: options.retryRecent });
    for (const row of rows) {
        examined++;
        try {
            const screening = await readScreeningArtifact(env, row);
            if (!screening) {
                retryable++;
                await writeRetryableReview(env, row, agentId, reviewer, "screening artifact missing or invalid");
                continue;
            }

            const respawn = screening.status === "credential_gated"
                ? await respawnCredentialGated(env, screening)
                : await respawnFunctional(env, screening);
            const tools = uniqueTools(respawn.observedTransports);
            const credentialVars = [...new Set([...screening.credentialVars, ...respawn.credentialVars])].sort();
            const catalogStatus = tools.length > 0 ? "live" : "credential_gated";

            if (!respawn.ok || (catalogStatus === "live" && tools.length === 0) || (catalogStatus === "credential_gated" && credentialVars.length === 0)) {
                retryable++;
                const message = respawn.errors.map((error) => `${error.transport}: ${error.message}`).join("; ") || "metadata-agent respawn incomplete";
                await writeRetryableReview(env, row, agentId, reviewer, message);
                errors.push({ slug: row.server_slug, message });
                continue;
            }

            const card = await reviewMetadataWithAgent(env, agentId, {
                repoUrl: screening.candidate.repoUrl,
                name: screening.candidate.rawName,
                description: screening.candidate.rawDescription,
                tools: tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description ?? null,
                    inputSchema: tool.inputSchema,
                })),
                credentialVars: catalogStatus === "credential_gated" ? credentialVars : undefined,
            });
            if (!card) {
                retryable++;
                await writeRetryableReview(env, row, agentId, reviewer, "model did not produce a valid metadata card");
                errors.push({ slug: row.server_slug, message: "model did not produce a valid metadata card" });
                continue;
            }

            const schemas = observedSchemas(tools);
            const cardVersion = await hashReviewedArtifact({
                card,
                observedTools: tools,
                observedSchemas: schemas,
                observedTransports: respawn.observedTransports.map((transport) => transport.transport),
                credentialVars,
                sourceHash: screening.sourceHash,
            });
            const artifact: MetadataAgentArtifact = {
                slug: screening.slug,
                sourceHash: screening.sourceHash,
                sourceVersion: screening.sourceVersion,
                agentId,
                reviewer,
                status: "complete",
                catalogStatus,
                card,
                cardVersion,
                candidate: screening.candidate,
                observedTools: tools,
                observedSchemas: schemas,
                observedTransports: respawn.observedTransports,
                credentialVars,
                sourceScreeningKey: row.screening_key,
                reviewedAt: new Date().toISOString(),
            };
            await writeCompleteReview(env, artifact);
            completed++;
            if (catalogStatus === "credential_gated") credentialGated++;
        } catch (error) {
            retryable++;
            const message = error instanceof Error ? error.message : String(error);
            await writeRetryableReview(env, row, agentId, reviewer, message);
            errors.push({ slug: row.server_slug, message });
        }
    }

    return {
        started_at: started,
        finished_at: new Date().toISOString(),
        agent_id: agentId,
        reviewer,
        examined,
        completed,
        credential_gated: credentialGated,
        retryable,
        skipped,
        errors,
    };
}

function detectCredentialVars(error: unknown, message: string): string[] {
    return [...new Set([
        ...detectFromStderr(message),
        ...detectFromJsonRpc(safeJsonParse(message)),
        ...(error instanceof RunnerDispatchError ? error.credentialVars : []),
    ])].sort();
}

function isRetryableMetadataFailure(error: unknown, message: string): boolean {
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

function safeJsonParse(s: string): unknown {
    try { return JSON.parse(s); } catch { return null; }
}

export const __test = {
    uniqueTools,
    observedSchemas,
    parseScreeningJsonArray,
};
