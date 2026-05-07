import type { Env } from "../worker/env.js";
import type { CatalogCandidate, CatalogCandidateTransport } from "./candidates.js";

export type ScreeningStatus = "functional" | "credential_gated" | "retryable" | "shadowed";

export interface ObservedCandidateTool {
    name: string;
    description?: string | null;
    inputSchema?: Record<string, unknown>;
}

export interface ScreenedTransport {
    transport: CatalogCandidateTransport;
    tools: ObservedCandidateTool[];
    latencyMs: number;
    runnerProfile?: string | null;
    deadlineMs?: number | null;
    serverInfo?: Record<string, unknown> | null;
    observedAt: string;
}

export interface ScreeningError {
    transport: string;
    code: string;
    message: string;
    credentialVars?: string[];
    retryable?: boolean;
    retryClass?: string;
}

export interface ScreeningArtifact {
    slug: string;
    sourceHash: string;
    sourceVersion: string;
    rawKey: string;
    status: ScreeningStatus;
    candidate: CatalogCandidate;
    functionalTransports: ScreenedTransport[];
    credentialVars: string[];
    errors: ScreeningError[];
    screenedAt: string;
}

export interface ScreeningRow {
    server_slug: string;
    source_hash: string;
    source_version: string;
    raw_key: string;
    screening_key: string;
    status: ScreeningStatus;
    functional_transports: string;
    credential_vars: string;
    errors: string;
    metadata_agent_id?: number | null;
    screened_at: string;
    updated_at: string;
}

export function hashShard(input: string, shardCount: number): number {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) % Math.max(1, shardCount);
}

export function metadataLaneShard(row: Pick<ScreeningRow, "server_slug" | "source_hash">, laneCount: number): number {
    return hashShard(`${row.server_slug}:${row.source_hash}:metadata-lane`, laneCount);
}

export function screeningObjectKey(candidate: Pick<CatalogCandidate, "slug" | "sourceHash">): string {
    return `screenings/${candidate.slug}/${candidate.sourceHash}.json`;
}

export function metadataArtifactObjectKey(input: { slug: string; sourceHash: string; agentId: number }): string {
    return `metadata-agents/${input.slug}/${input.sourceHash}/agent-${input.agentId}.json`;
}

export async function ensureScreeningSchema(env: Env): Promise<void> {
    try {
        await env.CATALOG.prepare(`SELECT metadata_agent_id FROM candidate_screenings LIMIT 1`).first();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/no such column/i.test(message)) throw error;
        await env.CATALOG.prepare(`ALTER TABLE candidate_screenings ADD COLUMN metadata_agent_id INTEGER`).run();
    }
    await env.CATALOG.prepare(
        `CREATE INDEX IF NOT EXISTS idx_candidate_screenings_agent
         ON candidate_screenings(status, metadata_agent_id, updated_at)`,
    ).run();
}

export async function writeScreeningArtifact(
    env: Env,
    artifact: ScreeningArtifact,
): Promise<string> {
    const key = screeningObjectKey({ slug: artifact.slug, sourceHash: artifact.sourceHash });
    const metadataAgentId = hashShard(`${artifact.slug}:${artifact.sourceHash}`, 3);
    await ensureScreeningSchema(env);
    await env.SNAPSHOTS.put(key, JSON.stringify(artifact), {
        httpMetadata: { contentType: "application/json" },
    });
    await env.CATALOG.prepare(
        `INSERT INTO candidate_screenings
            (server_slug, source_hash, source_version, raw_key, screening_key, status, functional_transports, credential_vars, errors, metadata_agent_id, screened_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, CURRENT_TIMESTAMP)
         ON CONFLICT(server_slug, source_hash) DO UPDATE SET
            source_version = excluded.source_version,
            raw_key = excluded.raw_key,
            screening_key = excluded.screening_key,
            status = excluded.status,
            functional_transports = excluded.functional_transports,
            credential_vars = excluded.credential_vars,
            errors = excluded.errors,
            metadata_agent_id = excluded.metadata_agent_id,
            screened_at = excluded.screened_at,
            updated_at = CURRENT_TIMESTAMP`,
    ).bind(
        artifact.slug,
        artifact.sourceHash,
        artifact.sourceVersion,
        artifact.rawKey,
        key,
        artifact.status,
        JSON.stringify(artifact.functionalTransports),
        JSON.stringify(artifact.credentialVars),
        JSON.stringify(artifact.errors),
        metadataAgentId,
        artifact.screenedAt,
    ).run();
    return key;
}

export async function readScreeningArtifact(env: Env, row: ScreeningRow): Promise<ScreeningArtifact | null> {
    const object = await env.SNAPSHOTS.get(row.screening_key);
    if (!object) return null;
    try {
        return await object.json<ScreeningArtifact>();
    } catch {
        return null;
    }
}

export async function hasTerminalScreening(
    env: Env,
    candidate: Pick<CatalogCandidate, "slug" | "sourceHash">,
): Promise<boolean> {
    const row = await env.CATALOG.prepare(
        `SELECT status FROM candidate_screenings
         WHERE server_slug = ?1
           AND source_hash = ?2
           AND status IN ('functional', 'credential_gated', 'shadowed')
         LIMIT 1`,
    ).bind(candidate.slug, candidate.sourceHash).first<{ status: ScreeningStatus }>();
    return Boolean(row);
}

export async function hasRecentRetryableScreening(
    env: Env,
    candidate: Pick<CatalogCandidate, "slug" | "sourceHash">,
    backoffMs = 30 * 60 * 1000,
): Promise<boolean> {
    const row = await env.CATALOG.prepare(
        `SELECT updated_at FROM candidate_screenings
         WHERE server_slug = ?1
           AND source_hash = ?2
           AND status = 'retryable'
         LIMIT 1`,
    ).bind(candidate.slug, candidate.sourceHash).first<{ updated_at: string }>();
    if (!row?.updated_at) return false;
    const updatedAt = new Date(row.updated_at).getTime();
    return Number.isFinite(updatedAt) && Date.now() - updatedAt < backoffMs;
}

export async function readRetryableScreeningErrors(
    env: Env,
    candidate: Pick<CatalogCandidate, "slug" | "sourceHash">,
): Promise<ScreeningError[] | null> {
    const row = await env.CATALOG.prepare(
        `SELECT errors FROM candidate_screenings
         WHERE server_slug = ?1
           AND source_hash = ?2
           AND status = 'retryable'
         LIMIT 1`,
    ).bind(candidate.slug, candidate.sourceHash).first<{ errors: string }>();
    if (!row) return null;
    return parseScreeningJsonArray<ScreeningError>(row.errors);
}

export function parseScreeningJsonArray<T>(value: string): T[] {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed as T[] : [];
    } catch {
        return [];
    }
}
