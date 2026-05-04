import type { Env } from "../worker/env.js";
import {
    upsertAliasStmt,
    upsertCredentialStmt,
    upsertServerStmt,
    upsertToolStmt,
    upsertTransportStmt,
    type ServerRow,
    type ToolRow,
    type TransportRow,
} from "../catalog/d1.js";
import type { MetadataAgentArtifact } from "./metadata/agents.js";
import type { CatalogCandidate, CatalogCandidateTransport } from "./candidates.js";
import { hashShard, type ObservedCandidateTool, type ScreenedTransport } from "./screening.js";

interface MetadataAgentReviewRow {
    server_slug: string;
    source_hash: string;
    source_version: string;
    agent_id: number;
    artifact_key: string | null;
    card_version: string | null;
    canonical_agent_id?: number | null;
    reviewed_at: string | null;
}

export interface PublishReport {
    started_at: string;
    finished_at: string;
    examined: number;
    published: number;
    skipped: number;
    errors: Array<{ slug: string; message: string }>;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function ensurePublishSchema(env: Env): Promise<void> {
    try {
        await env.CATALOG.prepare(`SELECT canonical_agent_id FROM metadata_agent_reviews LIMIT 1`).first();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/no such column/i.test(message)) throw error;
        await env.CATALOG.prepare(`ALTER TABLE metadata_agent_reviews ADD COLUMN canonical_agent_id INTEGER`).run();
    }
}

function validateArtifact(artifact: MetadataAgentArtifact): { ok: true; status: "live" | "credential_gated" } | { ok: false; reason: string } {
    if (artifact.status !== "complete") return { ok: false, reason: "artifact is not complete" };
    if (!artifact.card?.name || !artifact.card.description || !Array.isArray(artifact.card.tags)) {
        return { ok: false, reason: "artifact missing reviewed card" };
    }
    if (artifact.catalogStatus === "credential_gated") {
        if (!Array.isArray(artifact.credentialVars) || artifact.credentialVars.length === 0) {
            return { ok: false, reason: "credential-gated artifact missing credential evidence" };
        }
        return { ok: true, status: "credential_gated" };
    }
    if (!Array.isArray(artifact.observedTools) || artifact.observedTools.length === 0) {
        return { ok: false, reason: "live artifact missing observed tools" };
    }
    if (!artifact.observedSchemas || Object.keys(artifact.observedSchemas).length === 0) {
        return { ok: false, reason: "live artifact missing observed schemas" };
    }
    if (!Array.isArray(artifact.observedTransports) || artifact.observedTransports.length === 0) {
        return { ok: false, reason: "live artifact missing observed transport evidence" };
    }
    return { ok: true, status: "live" };
}

function toTransportRow(candidate: CatalogCandidate, observed: ScreenedTransport): TransportRow {
    const transport = observed.transport;
    return {
        server_slug: candidate.slug,
        kind: transport.transport,
        package: transport.package,
        image: transport.image,
        remote_url: transport.remoteUrl,
        protocol: transport.protocol,
        port_observed: null,
        cmd_args: JSON.stringify(transport.args),
        env_required: JSON.stringify(transport.envRequired),
        env_optional: JSON.stringify(transport.envOptional),
        last_success_at: observed.observedAt,
        last_failure_at: null,
        failure_streak: 0,
        median_latency_ms: observed.latencyMs,
        priority: transport.priority,
    };
}

function toCredentialGatedTransportRow(candidate: CatalogCandidate, transport: CatalogCandidateTransport, credentialVars: string[]): TransportRow {
    return {
        server_slug: candidate.slug,
        kind: transport.transport,
        package: transport.package,
        image: transport.image,
        remote_url: transport.remoteUrl,
        protocol: transport.protocol,
        port_observed: null,
        cmd_args: JSON.stringify(transport.args),
        env_required: JSON.stringify([...new Set([...transport.envRequired, ...credentialVars])].sort()),
        env_optional: JSON.stringify(transport.envOptional),
        last_success_at: null,
        last_failure_at: new Date().toISOString(),
        failure_streak: 1,
        median_latency_ms: null,
        priority: transport.priority,
    };
}

function toToolRows(slug: string, tools: ObservedCandidateTool[], cardVersion: string): ToolRow[] {
    return tools.map((tool) => ({
        server_slug: slug,
        name: tool.name,
        description: tool.description ?? null,
        input_schema: JSON.stringify(parseJsonObject(tool.inputSchema || {})),
        embedding_id: null,
        last_seen_at: new Date().toISOString(),
        card_version: cardVersion,
    }));
}

function dedupeTransportRows(rows: TransportRow[]): TransportRow[] {
    const byKind = new Map<string, TransportRow>();
    for (const row of rows.sort((a, b) => b.priority - a.priority)) {
        if (!byKind.has(row.kind)) byKind.set(row.kind, row);
    }
    return [...byKind.values()];
}

async function readArtifact(env: Env, row: MetadataAgentReviewRow): Promise<MetadataAgentArtifact | null> {
    if (!row.artifact_key) return null;
    const object = await env.CARDS.get(row.artifact_key);
    if (!object) return null;
    try {
        return await object.json<MetadataAgentArtifact>();
    } catch {
        return null;
    }
}

async function alreadyPublished(env: Env, row: MetadataAgentReviewRow): Promise<boolean> {
    if (!row.card_version) return false;
    const hit = await env.CATALOG.prepare(
        `SELECT 1 AS ok
         FROM servers s
         JOIN metadata_reviews m ON m.server_slug = s.slug AND m.card_version = s.card_version
         WHERE s.slug = ?1
           AND s.card_version = ?2
           AND s.status IN ('live', 'credential_gated')
         LIMIT 1`,
    ).bind(row.server_slug, row.card_version).first<{ ok: number }>();
    return Boolean(hit);
}

async function markReviewRetryable(env: Env, row: MetadataAgentReviewRow, message: string): Promise<void> {
    await env.CATALOG.prepare(
        `UPDATE metadata_agent_reviews
         SET status = 'retryable',
             error_message = ?4,
             updated_at = CURRENT_TIMESTAMP
         WHERE server_slug = ?1
           AND source_hash = ?2
           AND agent_id = ?3`,
    ).bind(row.server_slug, row.source_hash, row.agent_id, message).run();
}

function isCanonicalShard(row: Pick<MetadataAgentReviewRow, "server_slug" | "source_hash" | "agent_id">): boolean {
    return hashShard(`${row.server_slug}:${row.source_hash}`, 3) === row.agent_id;
}

function hasCanonicalAgent(row: MetadataAgentReviewRow): boolean {
    return typeof row.canonical_agent_id === "number"
        ? row.canonical_agent_id === row.agent_id
        : isCanonicalShard(row);
}

function reviewTimestamp(row: Pick<MetadataAgentReviewRow, "reviewed_at">): number {
    const ts = new Date(row.reviewed_at || 0).getTime();
    return Number.isFinite(ts) ? ts : 0;
}

function isNewerReview(a: MetadataAgentReviewRow, b: MetadataAgentReviewRow): boolean {
    const at = reviewTimestamp(a);
    const bt = reviewTimestamp(b);
    if (at !== bt) return at > bt;
    if (a.source_version !== b.source_version) return a.source_version > b.source_version;
    if (a.source_hash !== b.source_hash) return a.source_hash > b.source_hash;
    return (a.card_version || "") > (b.card_version || "");
}

function selectLatestCanonicalRows(rows: MetadataAgentReviewRow[], limit: number): MetadataAgentReviewRow[] {
    const latestBySlug = new Map<string, MetadataAgentReviewRow>();
    for (const row of rows) {
        if (!row.card_version || !row.artifact_key) continue;
        if (!hasCanonicalAgent(row)) continue;
        const previous = latestBySlug.get(row.server_slug);
        if (!previous || isNewerReview(row, previous)) {
            latestBySlug.set(row.server_slug, row);
        }
    }
    return [...latestBySlug.values()]
        .sort((a, b) => reviewTimestamp(a) - reviewTimestamp(b) || a.server_slug.localeCompare(b.server_slug))
        .slice(0, limit);
}

export async function runPublish(env: Env, options: { limit?: number } = {}): Promise<PublishReport> {
    const started = new Date().toISOString();
    await ensurePublishSchema(env);
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    const errors: Array<{ slug: string; message: string }> = [];
    let examined = 0;
    let published = 0;
    let skipped = 0;

    const pageSize = Math.min(Math.max(limit * 200, 10_000), 50_000);
    const rows = await env.CATALOG.prepare(
        `SELECT r.server_slug, r.source_hash, r.source_version, r.agent_id, r.artifact_key, r.card_version, r.canonical_agent_id, r.reviewed_at
         FROM metadata_agent_reviews r
         WHERE r.status = 'complete'
           AND r.artifact_key IS NOT NULL
           AND r.card_version IS NOT NULL
           AND (r.canonical_agent_id = r.agent_id OR r.canonical_agent_id IS NULL)
         ORDER BY reviewed_at DESC
         LIMIT ?1`,
    ).bind(pageSize).all<MetadataAgentReviewRow>();

    for (const row of selectLatestCanonicalRows(rows.results || [], pageSize)) {
        try {
            if (await alreadyPublished(env, row)) {
                skipped++;
                continue;
            }
            if (examined >= limit) break;
            examined++;
            const artifact = await readArtifact(env, row);
            if (!artifact) {
                const message = "metadata artifact missing or invalid";
                await markReviewRetryable(env, row, message);
                errors.push({ slug: row.server_slug, message });
                continue;
            }
            const validation = validateArtifact(artifact);
            if (!validation.ok) {
                await markReviewRetryable(env, row, validation.reason);
                errors.push({ slug: row.server_slug, message: validation.reason });
                continue;
            }
            const now = new Date().toISOString();
            const server: ServerRow = {
                slug: artifact.slug,
                origin: "tools",
                name: artifact.card.name,
                namespace: artifact.candidate.namespace,
                description: artifact.card.description,
                tags: JSON.stringify(artifact.card.tags),
                category: null,
                repo_url: artifact.candidate.repoUrl,
                image: artifact.candidate.image,
                status: validation.status,
                statefulness: artifact.candidate.statefulness,
                card_version: artifact.cardVersion,
                compiled_at: artifact.reviewedAt,
                inspected_at: artifact.reviewedAt,
                created_at: now,
                updated_at: now,
            };
            const transportRows = validation.status === "live"
                ? dedupeTransportRows(artifact.observedTransports.map((transport) => toTransportRow(artifact.candidate, transport)))
                : dedupeTransportRows(artifact.candidate.transports.map((transport) => toCredentialGatedTransportRow(artifact.candidate, transport, artifact.credentialVars)));
            const toolRows = validation.status === "live" ? toToolRows(artifact.slug, artifact.observedTools, artifact.cardVersion) : [];
            const credentialRows = artifact.credentialVars.map((varName) => {
                const declared = artifact.candidate.credentials.find((credential) => credential.varName === varName);
                return upsertCredentialStmt(env, {
                    server_slug: artifact.slug,
                    var_name: varName,
                    description: declared?.description ?? null,
                    obtain_url: declared?.obtainUrl ?? null,
                    evidence_key: artifact.sourceScreeningKey,
                });
            });
            const finalCardKey = `cards/${artifact.slug}/${artifact.cardVersion}.json`;
            await env.CARDS.put(finalCardKey, JSON.stringify({
                ...artifact.card,
                slug: artifact.slug,
                sourceVersion: artifact.sourceVersion,
                sourceHash: artifact.sourceHash,
                cardVersion: artifact.cardVersion,
                status: validation.status,
                tools: toolRows.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    inputSchema: JSON.parse(tool.input_schema) as Record<string, unknown>,
                })),
                credentialsRequired: artifact.credentialVars,
                reviewer: artifact.reviewer,
            }), { httpMetadata: { contentType: "application/json" } });

            await env.CATALOG.batch([
                env.CATALOG.prepare("DELETE FROM tools WHERE server_slug = ?1").bind(artifact.slug),
                env.CATALOG.prepare("DELETE FROM transports WHERE server_slug = ?1").bind(artifact.slug),
                env.CATALOG.prepare("DELETE FROM credentials WHERE server_slug = ?1").bind(artifact.slug),
                upsertServerStmt(env, server),
                ...transportRows.map((transport) => upsertTransportStmt(env, transport)),
                ...toolRows.map((tool) => upsertToolStmt(env, tool)),
                ...credentialRows,
                env.CATALOG.prepare(
                    `INSERT INTO metadata_reviews (server_slug, human_name, short_description, tags, category, tool_summary, reviewer, reviewed_at, card_version)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                     ON CONFLICT(server_slug) DO UPDATE SET
                        human_name = excluded.human_name,
                        short_description = excluded.short_description,
                        tags = excluded.tags,
                        category = excluded.category,
                        tool_summary = excluded.tool_summary,
                        reviewer = excluded.reviewer,
                        reviewed_at = excluded.reviewed_at,
                        card_version = excluded.card_version`,
                ).bind(
                    artifact.slug,
                    artifact.card.name,
                    artifact.card.description,
                    JSON.stringify(artifact.card.tags),
                    null,
                    JSON.stringify(artifact.observedTools.map((tool) => ({ name: tool.name, description: tool.description ?? null }))),
                    artifact.reviewer,
                    artifact.reviewedAt,
                    artifact.cardVersion,
                ),
                env.CATALOG.prepare(
                    `INSERT INTO versions (server_slug, card_version, card_key) VALUES (?1, ?2, ?3)
                     ON CONFLICT(server_slug, card_version) DO NOTHING`,
                ).bind(artifact.slug, artifact.cardVersion, finalCardKey),
                env.CATALOG.prepare(
                    `INSERT INTO catalog_decisions (server_slug, decision, reason, source_version, decided_by, decided_at)
                     VALUES (?1, 'serve', ?2, ?3, 'catalog-publisher', CURRENT_TIMESTAMP)
                     ON CONFLICT(server_slug) DO UPDATE SET
                        decision = excluded.decision,
                        reason = excluded.reason,
                        source_version = excluded.source_version,
                        decided_by = excluded.decided_by,
                        decided_at = CURRENT_TIMESTAMP`,
                ).bind(
                    artifact.slug,
                    validation.status === "credential_gated"
                        ? "metadata-agent respawn produced credential-required evidence"
                        : "metadata-agent respawn produced observed tools and schemas",
                    `${artifact.sourceVersion}:${artifact.sourceHash}`,
                ),
                upsertAliasStmt(env, { alias_id: `mcp:${artifact.slug}`, server_slug: artifact.slug }),
                upsertAliasStmt(env, { alias_id: `mcp-${artifact.slug}`, server_slug: artifact.slug }),
                upsertAliasStmt(env, { alias_id: artifact.candidate.rawName, server_slug: artifact.slug }),
            ]);
            published++;
        } catch (error) {
            errors.push({ slug: row.server_slug, message: error instanceof Error ? error.message : String(error) });
        }
    }

    return {
        started_at: started,
        finished_at: new Date().toISOString(),
        examined,
        published,
        skipped,
        errors,
    };
}

export const __test = {
    validateArtifact,
    selectLatestCanonicalRows,
    isCanonicalShard,
};
