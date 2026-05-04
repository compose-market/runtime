/**
 * Health rollup.
 *
 * Aggregates per-bucket health rows into transport.priority adjustments
 * and updates failure_streak / last_success / last_failure / median latency.
 *
 * Servers with consistent failure across all transports for >= 7 days
 * transition to 'quarantined'. Quarantined servers re-enter inspect on a
 * weekly trigger (handled by gc workflow's revival pass).
 */

import type { Env } from "../worker/env.js";

export interface HealthReport {
    started_at: string;
    finished_at: string;
    servers_examined: number;
    transports_updated: number;
    quarantined: number;
}

export async function runHealth(env: Env): Promise<HealthReport> {
    const started = new Date().toISOString();
    const sinceCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recentCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    let serversExamined = 0;
    let transportsUpdated = 0;
    let quarantined = 0;

    const transports = await env.CATALOG.prepare(
        `SELECT server_slug, kind FROM transports`,
    ).all<{ server_slug: string; kind: string }>();

    for (const t of transports.results || []) {
        const okRow = await env.CATALOG.prepare(
            `SELECT MAX(bucket_at) AS last_at, AVG(latency_ms) AS lat
             FROM health WHERE server_slug = ?1 AND transport_kind = ?2 AND outcome = 'ok' AND bucket_at >= ?3`,
        ).bind(t.server_slug, t.kind, recentCutoff).first<{ last_at: string | null; lat: number | null }>();
        const failRow = await env.CATALOG.prepare(
            `SELECT MAX(bucket_at) AS last_at, SUM(count) AS streak
             FROM health WHERE server_slug = ?1 AND transport_kind = ?2 AND outcome != 'ok' AND bucket_at >= ?3`,
        ).bind(t.server_slug, t.kind, recentCutoff).first<{ last_at: string | null; streak: number | null }>();

        const priority = (okRow?.last_at ? 100 : 0) - (failRow?.streak ?? 0) * 5;
        await env.CATALOG.prepare(
            `UPDATE transports SET
                last_success_at = COALESCE(?1, last_success_at),
                last_failure_at = COALESCE(?2, last_failure_at),
                failure_streak = COALESCE(?3, failure_streak),
                median_latency_ms = COALESCE(?4, median_latency_ms),
                priority = ?5
             WHERE server_slug = ?6 AND kind = ?7`,
        ).bind(
            okRow?.last_at ?? null,
            failRow?.last_at ?? null,
            failRow?.streak ?? null,
            okRow?.lat ?? null,
            priority,
            t.server_slug, t.kind,
        ).run();
        transportsUpdated++;
    }

    const failingServers = await env.CATALOG.prepare(
        `SELECT s.slug
         FROM servers s
         WHERE s.status = 'live'
         AND NOT EXISTS (
             SELECT 1 FROM transports tr
             WHERE tr.server_slug = s.slug
             AND tr.last_success_at IS NOT NULL AND tr.last_success_at >= ?1
         )
         AND EXISTS (
             SELECT 1 FROM transports tr2
             WHERE tr2.server_slug = s.slug AND tr2.last_failure_at IS NOT NULL
         )`,
    ).bind(sinceCutoff).all<{ slug: string }>();

    for (const row of failingServers.results || []) {
        await env.CATALOG.prepare(
            `UPDATE servers SET status = 'quarantined', updated_at = CURRENT_TIMESTAMP WHERE slug = ?1`,
        ).bind(row.slug).run();
        quarantined++;
        serversExamined++;
    }

    return {
        started_at: started,
        finished_at: new Date().toISOString(),
        servers_examined: serversExamined,
        transports_updated: transportsUpdated,
        quarantined,
    };
}
