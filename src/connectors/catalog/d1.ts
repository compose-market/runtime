/**
 * Catalog access layer (D1).
 *
 * Mirrors the existing `services/connector/src/registry.ts` resolution
 * shape (UnifiedServerRecord) but reads from D1 instead of filesystem JSON.
 * Tools, transports, credentials, health are joined per request.
 */

import type {
    Env,
    D1PreparedStatement,
} from "../worker/env.js";

// ─── Row shapes (mirror the SQL schema) ──────────────────────────────────

export interface ServerRow {
    slug: string;
    origin: "tools" | "onchain";
    name: string;
    namespace: string;
    description: string;
    tags: string;        // JSON
    category: string | null;
    repo_url: string | null;
    image: string | null;
    status: "live" | "credential_gated" | "inspecting" | "verified" | "metadata_reviewed" | "embedded" | "shadowed" | "quarantined" | "deprecated";
    statefulness: "stateless" | "stateful" | "unknown";
    card_version: string;
    compiled_at: string | null;
    inspected_at: string | null;
    created_at: string;
    updated_at: string;
}

export interface TransportRow {
    server_slug: string;
    kind: "stdio" | "http" | "docker" | "npx" | "goat-plugin";
    package: string | null;
    image: string | null;
    remote_url: string | null;
    protocol: "sse" | "streamable-http" | null;
    port_observed: number | null;
    cmd_args: string;       // JSON
    env_required: string;   // JSON
    env_optional: string;   // JSON
    last_success_at: string | null;
    last_failure_at: string | null;
    failure_streak: number;
    median_latency_ms: number | null;
    runner_profile?: string | null;
    deadline_ms?: number | null;
    priority: number;
}

export interface ToolRow {
    server_slug: string;
    name: string;
    description: string | null;
    input_schema: string;    // JSON
    embedding_id: string | null;
    last_seen_at: string;
    card_version: string;
}

export interface CredentialRow {
    server_slug: string;
    var_name: string;
    description: string | null;
    obtain_url: string | null;
    evidence_key: string | null;
}

export interface AliasRow {
    alias_id: string;
    server_slug: string;
}

// ─── Public helpers ──────────────────────────────────────────────────────

export function parseTags(s: string): string[] {
    try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : []; }
    catch { return []; }
}

export function parseStringArray(s: string): string[] {
    try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : []; }
    catch { return []; }
}

export function parseJsonObject(s: string): Record<string, unknown> {
    try { const v = JSON.parse(s); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }
    catch { return {}; }
}

export function normalizeConnectorSlug(input: string): string {
    let id = input.trim();
    while (id.match(/^(mcp|goat|tools|onchain)[-:]/i)) {
        id = id.replace(/^(mcp|goat|tools|onchain)[-:]/i, "");
    }
    return id;
}

/**
 * Resolve registryId, slug, package name, or prefix variant to the D1 slug.
 */
export async function resolveServerSlug(env: Env, idOrSlug: string): Promise<string | null> {
    const raw = idOrSlug.trim();
    const normalized = normalizeConnectorSlug(raw);

    // 1. Exact slug match (canonical D1 PK)
    const direct = await env.CATALOG.prepare(
        "SELECT slug FROM servers WHERE slug = ?1 LIMIT 1",
    ).bind(normalized).first<{ slug: string }>();
    if (direct?.slug) return direct.slug;

    const aliased = await env.CATALOG.prepare(
        "SELECT server_slug AS slug FROM aliases WHERE alias_id = ?1 LIMIT 1",
    ).bind(raw).first<{ slug: string }>();
    if (aliased?.slug) return aliased.slug;

    const aliasedNorm = await env.CATALOG.prepare(
        "SELECT server_slug AS slug FROM aliases WHERE alias_id = ?1 LIMIT 1",
    ).bind(normalized).first<{ slug: string }>();
    if (aliasedNorm?.slug) return aliasedNorm.slug;

    const byName = await env.CATALOG.prepare(
        "SELECT slug FROM servers WHERE name = ?1 LIMIT 1",
    ).bind(normalized).first<{ slug: string }>();
    if (byName?.slug) return byName.slug;

    const partial = await env.CATALOG.prepare(
        `SELECT slug FROM servers
         WHERE slug LIKE ?1 OR name LIKE ?1
         ORDER BY LENGTH(slug) ASC
         LIMIT 1`,
    ).bind(`%${normalized}%`).first<{ slug: string }>();
    if (partial?.slug) return partial.slug;

    const variations = [
        `${normalized}-web-search`,
        `${normalized}-search`,
        `${normalized}-mcp`,
        normalized.replace(/-web-search$/, ""),
        normalized.replace(/-search$/, ""),
        normalized.replace(/-mcp$/, ""),
    ].filter((v) => v && v !== normalized);

    for (const variation of variations) {
        const hit = await env.CATALOG.prepare(
            "SELECT slug FROM servers WHERE slug = ?1 OR name = ?1 LIMIT 1",
        ).bind(variation).first<{ slug: string }>();
        if (hit?.slug) return hit.slug;
    }

    return null;
}

export async function getServer(env: Env, slug: string): Promise<ServerRow | null> {
    return await env.CATALOG.prepare(
        "SELECT * FROM servers WHERE slug = ?1 LIMIT 1",
    ).bind(slug).first<ServerRow>();
}

export async function hasReviewedCatalogEntry(env: Env, slug: string): Promise<boolean> {
    const row = await env.CATALOG.prepare(
        `SELECT 1 AS ok
         FROM metadata_reviews mr
         JOIN servers s
           ON s.slug = mr.server_slug
          AND s.card_version = mr.card_version
         WHERE mr.server_slug = ?1
         LIMIT 1`,
    ).bind(slug).first<{ ok: number }>();
    return Boolean(row?.ok);
}

export async function listServers(
    env: Env,
    filters: { origin?: "tools" | "onchain"; status?: ServerRow["status"]; statuses?: ServerRow["status"][]; category?: string; servedOnly?: boolean; limit: number; offset: number },
): Promise<{ rows: ServerRow[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.origin) {
        where.push(`origin = ?${params.length + 1}`);
        params.push(filters.origin);
    }
    if (filters.status) {
        where.push(`status = ?${params.length + 1}`);
        params.push(filters.status);
    }
    if (filters.statuses && filters.statuses.length > 0) {
        const placeholders = filters.statuses.map((_status, index) => `?${params.length + index + 1}`);
        where.push(`status IN (${placeholders.join(", ")})`);
        params.push(...filters.statuses);
    }
    if (filters.category) {
        where.push(`category = ?${params.length + 1}`);
        params.push(filters.category);
    }
    if (filters.servedOnly) {
        where.push(
             `servers.status IN ('live', 'credential_gated')
             AND EXISTS (
                SELECT 1 FROM metadata_reviews mr
                WHERE mr.server_slug = servers.slug
                  AND mr.card_version = servers.card_version
             )`,
        );
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const total = await env.CATALOG.prepare(
        `SELECT COUNT(*) AS n FROM servers ${whereSql}`,
    ).bind(...params).first<{ n: number }>();

    const limitPos = params.length + 1;
    const offsetPos = params.length + 2;
    const rowsRes = await env.CATALOG.prepare(
        `SELECT * FROM servers ${whereSql} ORDER BY slug LIMIT ?${limitPos} OFFSET ?${offsetPos}`,
    ).bind(...params, filters.limit, filters.offset).all<ServerRow>();

    return { rows: rowsRes.results || [], total: total?.n ?? 0 };
}

export async function getTools(env: Env, slug: string): Promise<ToolRow[]> {
    const res = await env.CATALOG.prepare(
        "SELECT * FROM tools WHERE server_slug = ?1 ORDER BY name",
    ).bind(slug).all<ToolRow>();
    return res.results || [];
}

export async function getTransports(env: Env, slug: string): Promise<TransportRow[]> {
    const res = await env.CATALOG.prepare(
        "SELECT * FROM transports WHERE server_slug = ?1 ORDER BY priority DESC",
    ).bind(slug).all<TransportRow>();
    return res.results || [];
}

export async function getCredentials(env: Env, slug: string): Promise<CredentialRow[]> {
    const res = await env.CATALOG.prepare(
        "SELECT * FROM credentials WHERE server_slug = ?1 ORDER BY var_name",
    ).bind(slug).all<CredentialRow>();
    return res.results || [];
}

export async function listCategories(env: Env): Promise<string[]> {
    const res = await env.CATALOG.prepare(
        `SELECT DISTINCT category FROM servers
         WHERE category IS NOT NULL AND category != ''
           AND status IN ('live', 'credential_gated')
           AND EXISTS (
              SELECT 1 FROM metadata_reviews mr
              WHERE mr.server_slug = servers.slug
                AND mr.card_version = servers.card_version
           )
         ORDER BY category`,
    ).all<{ category: string }>();
    return (res.results || []).map((r) => r.category);
}

export async function listTags(env: Env): Promise<string[]> {
    const res = await env.CATALOG.prepare(
        `SELECT tags FROM servers
         WHERE tags != '[]'
           AND status IN ('live', 'credential_gated')
           AND EXISTS (
              SELECT 1 FROM metadata_reviews mr
              WHERE mr.server_slug = servers.slug
                AND mr.card_version = servers.card_version
           )`,
    ).all<{ tags: string }>();
    const set = new Set<string>();
    for (const row of res.results || []) {
        for (const t of parseTags(row.tags)) set.add(t);
    }
    return [...set].sort();
}

export async function meta(env: Env): Promise<{ origins: Record<string, number>; statuses: Record<string, number>; total: number }> {
    const servedWhere = `status IN ('live', 'credential_gated')
      AND EXISTS (
          SELECT 1 FROM metadata_reviews mr
          WHERE mr.server_slug = servers.slug
            AND mr.card_version = servers.card_version
      )`;
    const byOriginRes = await env.CATALOG.prepare(
        `SELECT origin, COUNT(*) AS n FROM servers WHERE ${servedWhere} GROUP BY origin`,
    ).all<{ origin: string; n: number }>();
    const byStatusRes = await env.CATALOG.prepare(
        `SELECT status, COUNT(*) AS n FROM servers WHERE ${servedWhere} GROUP BY status`,
    ).all<{ status: string; n: number }>();
    const totalRow = await env.CATALOG.prepare(`SELECT COUNT(*) AS n FROM servers WHERE ${servedWhere}`).first<{ n: number }>();
    const origins: Record<string, number> = {};
    for (const r of byOriginRes.results || []) origins[r.origin] = r.n;
    const statuses: Record<string, number> = {};
    for (const r of byStatusRes.results || []) statuses[r.status] = r.n;
    return { origins, statuses, total: totalRow?.n ?? 0 };
}

// ─── Writes used by the inspect / compile workflows ──────────────────────

export function upsertServerStmt(env: Env, row: ServerRow): D1PreparedStatement {
    return env.CATALOG.prepare(
        `INSERT INTO servers (slug, origin, name, namespace, description, tags, category, repo_url, image, status, statefulness, card_version, compiled_at, inspected_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, CURRENT_TIMESTAMP)
         ON CONFLICT(slug) DO UPDATE SET
            origin       = excluded.origin,
            name         = CASE
                             WHEN servers.status IN ('live', 'credential_gated', 'shadowed', 'quarantined', 'deprecated')
                              AND excluded.status = 'inspecting' THEN servers.name
                             WHEN excluded.status = 'inspecting'
                              AND EXISTS (
                                SELECT 1 FROM metadata_reviews
                                WHERE metadata_reviews.server_slug = servers.slug
                                  AND metadata_reviews.card_version = servers.card_version
                              ) THEN servers.name
                             ELSE excluded.name
                           END,
            namespace    = excluded.namespace,
            description  = CASE
                             WHEN servers.status IN ('live', 'credential_gated', 'shadowed', 'quarantined', 'deprecated')
                              AND excluded.status = 'inspecting' THEN servers.description
                             WHEN excluded.status = 'inspecting'
                              AND EXISTS (
                                SELECT 1 FROM metadata_reviews
                                WHERE metadata_reviews.server_slug = servers.slug
                                  AND metadata_reviews.card_version = servers.card_version
                              ) THEN servers.description
                             ELSE excluded.description
                           END,
            tags         = CASE
                             WHEN servers.status IN ('live', 'credential_gated', 'shadowed', 'quarantined', 'deprecated')
                              AND excluded.status = 'inspecting' THEN servers.tags
                             WHEN excluded.status = 'inspecting'
                              AND EXISTS (
                                SELECT 1 FROM metadata_reviews
                                WHERE metadata_reviews.server_slug = servers.slug
                                  AND metadata_reviews.card_version = servers.card_version
                              ) THEN servers.tags
                             ELSE excluded.tags
                           END,
            category     = CASE
                             WHEN servers.status IN ('live', 'credential_gated', 'shadowed', 'quarantined', 'deprecated')
                              AND excluded.status = 'inspecting' THEN servers.category
                             WHEN excluded.status = 'inspecting'
                              AND EXISTS (
                                SELECT 1 FROM metadata_reviews
                                WHERE metadata_reviews.server_slug = servers.slug
                                  AND metadata_reviews.card_version = servers.card_version
                              ) THEN servers.category
                             ELSE excluded.category
                           END,
            repo_url     = excluded.repo_url,
            image        = excluded.image,
            status       = CASE
                             WHEN servers.status IN ('live', 'credential_gated', 'shadowed', 'quarantined', 'deprecated')
                              AND excluded.status = 'inspecting' THEN servers.status
                             ELSE excluded.status
                           END,
            statefulness = CASE
                             WHEN servers.status IN ('live', 'credential_gated', 'shadowed', 'quarantined', 'deprecated')
                              AND excluded.status = 'inspecting' THEN servers.statefulness
                             ELSE excluded.statefulness
                           END,
            card_version = excluded.card_version,
            compiled_at  = COALESCE(servers.compiled_at, excluded.compiled_at),
            inspected_at = COALESCE(servers.inspected_at, excluded.inspected_at),
            updated_at   = CURRENT_TIMESTAMP`,
    ).bind(
        row.slug, row.origin, row.name, row.namespace, row.description, row.tags,
        row.category, row.repo_url, row.image, row.status, row.statefulness,
        row.card_version, row.compiled_at, row.inspected_at,
    );
}

export function upsertTransportStmt(env: Env, row: TransportRow): D1PreparedStatement {
    return env.CATALOG.prepare(
        `INSERT INTO transports (server_slug, kind, package, image, remote_url, protocol, port_observed, cmd_args, env_required, env_optional, runner_profile, deadline_ms, priority)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(server_slug, kind) DO UPDATE SET
            package        = excluded.package,
            image          = excluded.image,
            remote_url     = excluded.remote_url,
            protocol       = excluded.protocol,
            port_observed  = excluded.port_observed,
            cmd_args       = excluded.cmd_args,
            env_required   = excluded.env_required,
            env_optional   = excluded.env_optional,
            runner_profile = excluded.runner_profile,
            deadline_ms    = excluded.deadline_ms,
            priority       = excluded.priority`,
    ).bind(
        row.server_slug, row.kind, row.package, row.image, row.remote_url,
        row.protocol, row.port_observed, row.cmd_args, row.env_required,
        row.env_optional, row.runner_profile ?? null, row.deadline_ms ?? null, row.priority,
    );
}

export function upsertToolStmt(env: Env, row: ToolRow): D1PreparedStatement {
    return env.CATALOG.prepare(
        `INSERT INTO tools (server_slug, name, description, input_schema, embedding_id, last_seen_at, card_version)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(server_slug, name) DO UPDATE SET
            description   = excluded.description,
            input_schema  = excluded.input_schema,
            embedding_id  = excluded.embedding_id,
            last_seen_at  = excluded.last_seen_at,
            card_version  = excluded.card_version`,
    ).bind(
        row.server_slug, row.name, row.description, row.input_schema,
        row.embedding_id, row.last_seen_at, row.card_version,
    );
}

export function upsertCredentialStmt(env: Env, row: CredentialRow): D1PreparedStatement {
    return env.CATALOG.prepare(
        `INSERT INTO credentials (server_slug, var_name, description, obtain_url, evidence_key)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(server_slug, var_name) DO UPDATE SET
            description  = excluded.description,
            obtain_url   = excluded.obtain_url,
            evidence_key = excluded.evidence_key`,
    ).bind(
        row.server_slug, row.var_name, row.description, row.obtain_url, row.evidence_key,
    );
}

export function upsertAliasStmt(env: Env, row: AliasRow): D1PreparedStatement {
    return env.CATALOG.prepare(
        `INSERT INTO aliases (alias_id, server_slug) VALUES (?1, ?2)
         ON CONFLICT(alias_id) DO UPDATE SET server_slug = excluded.server_slug`,
    ).bind(row.alias_id, row.server_slug);
}

export function recordHealthStmt(
    env: Env,
    row: { server_slug: string; transport_kind: string; bucket_at: string; outcome: string; latency_ms: number },
): D1PreparedStatement {
    return env.CATALOG.prepare(
        `INSERT INTO health (server_slug, transport_kind, bucket_at, outcome, latency_ms, count)
         VALUES (?1, ?2, ?3, ?4, ?5, 1)
         ON CONFLICT(server_slug, transport_kind, bucket_at, outcome) DO UPDATE SET
            count      = count + 1,
            latency_ms = (latency_ms + excluded.latency_ms) / 2`,
    ).bind(row.server_slug, row.transport_kind, row.bucket_at, row.outcome, row.latency_ms);
}
