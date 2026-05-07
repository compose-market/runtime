import type { Env } from "../worker/env.js";

export type CatalogStage = "seed" | "verify" | "metadata" | "publish" | "embed";

export async function ensureStageErrorSchema(env: Env): Promise<void> {
    await env.CATALOG.prepare(
        `CREATE TABLE IF NOT EXISTS catalog_stage_errors (
            item_id        TEXT NOT NULL,
            item_version   TEXT NOT NULL DEFAULT '',
            stage          TEXT NOT NULL CHECK (stage IN ('seed', 'verify', 'metadata', 'publish', 'embed')),
            error_message  TEXT NOT NULL,
            attempts       INTEGER NOT NULL DEFAULT 1,
            next_retry_at  TEXT,
            first_seen_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (item_id, item_version, stage)
        )`,
    ).run();
    await env.CATALOG.prepare(
        `CREATE INDEX IF NOT EXISTS idx_catalog_stage_errors_retry
         ON catalog_stage_errors(stage, next_retry_at, updated_at)`,
    ).run();
}

export async function recordStageItemError(
    env: Env,
    input: { itemId: string; itemVersion?: string | null; stage: CatalogStage; message: string; retryAfterSeconds?: number },
): Promise<void> {
    await ensureStageErrorSchema(env);
    const retryAfterSeconds = Math.max(60, Math.min(Math.floor(input.retryAfterSeconds ?? 1800), 86400));
    await env.CATALOG.prepare(
        `INSERT INTO catalog_stage_errors (item_id, item_version, stage, error_message, attempts, next_retry_at, first_seen_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 1, datetime('now', ?5), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(item_id, item_version, stage) DO UPDATE SET
            error_message = excluded.error_message,
            attempts = catalog_stage_errors.attempts + 1,
            next_retry_at = excluded.next_retry_at,
            updated_at = CURRENT_TIMESTAMP`,
    ).bind(input.itemId, input.itemVersion ?? "", input.stage, input.message, `+${retryAfterSeconds} seconds`).run();
}

export async function clearStageItemError(
    env: Env,
    input: { itemId: string; itemVersion?: string | null; stage: CatalogStage },
): Promise<void> {
    await ensureStageErrorSchema(env);
    await env.CATALOG.prepare(
        `DELETE FROM catalog_stage_errors
         WHERE item_id = ?1
           AND item_version = ?2
           AND stage = ?3`,
    ).bind(input.itemId, input.itemVersion ?? "", input.stage).run();
}
