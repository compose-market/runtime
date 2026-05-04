/**
 * Embed workflow.
 *
 * For every final-catalog server whose card_version has not been embedded,
 * embed the reviewed card text via Voyage and upsert Vectorize. This workflow
 * never reads raw registry candidates or metadata-agent drafts directly.
 */

import type { Env } from "../worker/env.js";
import { embedTexts, buildCardEmbeddingText, buildVectorId } from "../catalog/embeddings.js";
import { getTools, parseTags } from "../catalog/d1.js";

async function sha256Hex(text: string): Promise<string> {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface EmbedReport {
    started_at: string;
    finished_at: string;
    embedded: number;
    skipped: number;
    errors: Array<{ slug: string; message: string }>;
}

export async function runEmbed(env: Env, options: { limit?: number } = {}): Promise<EmbedReport> {
    const started = new Date().toISOString();
    const errors: Array<{ slug: string; message: string }> = [];
    let embedded = 0;
    let skipped = 0;

    const limit = Math.min(options.limit || 100, 500);
    const rows = await env.CATALOG.prepare(
        `SELECT s.slug,
                m.human_name AS name,
                m.short_description AS description,
                m.tags AS tags,
                s.card_version,
                s.status
         FROM servers s
         INNER JOIN metadata_reviews m ON m.server_slug = s.slug AND m.card_version = s.card_version
         LEFT JOIN embedding_state es
           ON es.server_slug = s.slug
          AND es.card_version = s.card_version
          AND es.provider = 'mongodb-voyage'
          AND es.model = ?2
          AND es.dimensions = 1024
          AND es.input_type = 'document'
         WHERE s.status IN ('live', 'credential_gated')
           AND es.server_slug IS NULL
         ORDER BY s.compiled_at DESC
         LIMIT ?1`,
    ).bind(limit, env.EMBEDDING_MODEL || "voyage-4-large").all<{ slug: string; name: string; description: string; tags: string; card_version: string; status: "live" | "credential_gated" }>();

    const targets = rows.results || [];
    if (targets.length === 0) {
        return { started_at: started, finished_at: new Date().toISOString(), embedded: 0, skipped: 0, errors: [] };
    }

    for (const row of targets) {
        try {
            const tools = await getTools(env, row.slug);
            const card = {
                name: row.name,
                description: row.description,
                tags: parseTags(row.tags),
                tools: tools.map((t) => ({ name: t.name, description: t.description })),
            };
            const text = buildCardEmbeddingText(card);
            const [vector] = await embedTexts(env, [text], "document");
            if (!vector) {
                errors.push({ slug: row.slug, message: "embedding returned empty" });
                continue;
            }
            const vectorId = buildVectorId(row.slug, row.card_version);
            const textHash = await sha256Hex(text);
            await env.EMBEDDINGS.upsert([{
                id: vectorId,
                values: vector,
                    metadata: {
                        slug: row.slug,
                        origin: "tools",
                        indexed: "final-catalog",
                        status: row.status,
                        name: row.name,
                        cardVersion: row.card_version,
                        tags: parseTags(row.tags),
                },
            }]);
            await env.CATALOG.batch([
                env.CATALOG.prepare(
                    `INSERT INTO embedding_state (server_slug, vector_id, provider, model, dimensions, input_type, text_hash, card_version, embedded_at)
                     VALUES (?1, ?2, 'mongodb-voyage', ?3, 1024, 'document', ?4, ?5, CURRENT_TIMESTAMP)
                     ON CONFLICT(server_slug) DO UPDATE SET
                        vector_id = excluded.vector_id,
                        provider = excluded.provider,
                        model = excluded.model,
                        dimensions = excluded.dimensions,
                        input_type = excluded.input_type,
                        text_hash = excluded.text_hash,
                        card_version = excluded.card_version,
                        embedded_at = CURRENT_TIMESTAMP`,
                ).bind(row.slug, vectorId, env.EMBEDDING_MODEL || "voyage-4-large", textHash, row.card_version),
                env.CATALOG.prepare(
                    `UPDATE tools SET embedding_id = ?1 WHERE server_slug = ?2 AND card_version = ?3`,
                ).bind(vectorId, row.slug, row.card_version),
                env.CATALOG.prepare(
                    `INSERT INTO catalog_decisions (server_slug, decision, reason, source_version, decided_by, decided_at)
                     VALUES (?1, 'serve', 'final catalog embedded', ?2, 'embed-workflow', CURRENT_TIMESTAMP)
                     ON CONFLICT(server_slug) DO UPDATE SET
                        decision = excluded.decision,
                        reason = excluded.reason,
                        source_version = excluded.source_version,
                        decided_by = excluded.decided_by,
                        decided_at = CURRENT_TIMESTAMP`,
                ).bind(row.slug, row.card_version),
            ]);
            embedded++;
        } catch (err) {
            errors.push({ slug: row.slug, message: err instanceof Error ? err.message : String(err) });
        }
    }

    return {
        started_at: started,
        finished_at: new Date().toISOString(),
        embedded,
        skipped,
        errors,
    };
}
