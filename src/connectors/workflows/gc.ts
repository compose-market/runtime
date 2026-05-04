/**
 * GC workflow.
 *
 * Cleans up:
 *  - R2 raw/snapshots older than 30 days
 *  - Vectorize entries with no D1 row
 *  - quarantined servers older than 7 days are re-queued for inspect
 */

import type { Env } from "../worker/env.js";

export interface GcReport {
    started_at: string;
    finished_at: string;
    raw_pruned: number;
    snapshots_pruned: number;
    retryable_shadows_released: number;
    vectors_pruned: number;
    quarantined_revived: number;
}

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

async function pruneR2Bucket(bucket: Env["RAW"]): Promise<number> {
    let cursor: string | undefined;
    let pruned = 0;
    const cutoff = Date.now() - THIRTY_DAYS;
    while (true) {
        const page = await bucket.list({ cursor, limit: 1000 });
        const oldKeys = page.objects
            .filter((o) => o.uploaded.getTime() < cutoff)
            .map((o) => o.key);
        if (oldKeys.length > 0) {
            await bucket.delete(oldKeys);
            pruned += oldKeys.length;
        }
        if (!page.truncated || !page.cursor) break;
        cursor = page.cursor;
    }
    return pruned;
}

function textContainsRetryableInfrastructureFailure(text: string): boolean {
    return /not yet provisioned|too many subrequests|timed out|timeout|aborted|container do|mcp_runtime_unavailable|fetch failed|rate limit|temporar/i.test(text);
}

async function releaseRetryableShadows(env: Env): Promise<number> {
    let cursor: string | undefined;
    let released = 0;
    while (true) {
        const page = await env.SNAPSHOTS.list({ prefix: "shadows/", cursor, limit: 1000 });
        const toDelete: string[] = [];
        for (const object of page.objects) {
            const body = await env.SNAPSHOTS.get(object.key);
            if (!body) continue;
            const text = await body.text();
            if (textContainsRetryableInfrastructureFailure(text)) {
                toDelete.push(object.key);
            }
        }
        if (toDelete.length > 0) {
            await env.SNAPSHOTS.delete(toDelete);
            released += toDelete.length;
        }
        if (!page.truncated || !page.cursor) break;
        cursor = page.cursor;
    }
    return released;
}

export async function runGc(env: Env): Promise<GcReport> {
    const started = new Date().toISOString();
    const rawPruned = await pruneR2Bucket(env.RAW);
    const retryableShadowsReleased = await releaseRetryableShadows(env);
    const snapshotsPruned = await pruneR2Bucket(env.SNAPSHOTS);

    // Re-queue quarantined servers that have aged 7 days.
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const revival = await env.CATALOG.prepare(
        `UPDATE servers SET status = 'inspecting', updated_at = CURRENT_TIMESTAMP
         WHERE status = 'quarantined' AND updated_at < ?1`,
    ).bind(cutoff).run();
    const quarantinedRevived = revival.meta?.changes ?? 0;

    return {
        started_at: started,
        finished_at: new Date().toISOString(),
        raw_pruned: rawPruned,
        snapshots_pruned: snapshotsPruned,
        retryable_shadows_released: retryableShadowsReleased,
        vectors_pruned: 0, // Vectorize doesn't expose a bulk-list; pruning happens lazily on re-embed.
        quarantined_revived: quarantinedRevived,
    };
}
