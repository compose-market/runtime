/**
 * Seed workflow.
 *
 * Pulls server metadata from the official MCP Registry in small candidate
 * windows. Registry pages can contain enough servers that per-candidate R2
 * and D1 checks hit Cloudflare's per-invocation API request limit, so the
 * cursor stores both the registry cursor and the next candidate offset
 * within that page.
 *
 * Pagination state lives in D1 `seed_cursor`. The endpoint returns the
 * next cursor; the caller (or the daily cron) keeps invoking until
 * `done: true`. Stateless and resumable across invocations.
 *
 * GHCR images are attached opportunistically per-page using a once-loaded
 * GHCR snapshot persisted in R2 to avoid re-fetching on every page.
 */

import type { Env } from "../worker/env.js";
import {
    buildCandidateFromGhcrPackage,
    buildCandidateFromRegistryEntry,
    candidateObjectKey,
    cleanCandidateSlug,
    shadowObjectKey,
    type GhcrContainerPackage,
    type RegistryEntry,
} from "./candidates.js";
import { hasTerminalScreening } from "./screening.js";

interface RegistryPage {
    servers: RegistryEntry[];
    metadata: { nextCursor?: string; count: number };
}

const GHCR_INDEX_KEY = "ghcr-index/v1.json";
const GHCR_INDEX_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const DEFAULT_CANDIDATE_LIMIT = 10;
const MAX_CANDIDATE_LIMIT = 25;

interface SeedCursor {
    cursor: string | null;
    pageOffset: number;
    registryComplete: boolean;
    ghcrOffset: number;
    ghcrComplete: boolean;
    complete: boolean;
}

async function ensureSeedCursorTable(env: Env): Promise<void> {
    await env.CATALOG.prepare(
        `CREATE TABLE IF NOT EXISTS seed_cursor (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            cursor TEXT,
            page_offset INTEGER NOT NULL DEFAULT 0,
            complete INTEGER NOT NULL DEFAULT 0,
            completed_at TEXT,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
    ).run();
    try {
        await env.CATALOG.prepare(`SELECT page_offset FROM seed_cursor LIMIT 1`).first();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/no such column/i.test(message)) throw error;
        await env.CATALOG.prepare(`ALTER TABLE seed_cursor ADD COLUMN page_offset INTEGER NOT NULL DEFAULT 0`).run();
    }
    try {
        await env.CATALOG.prepare(`SELECT complete FROM seed_cursor LIMIT 1`).first();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/no such column/i.test(message)) throw error;
        await env.CATALOG.prepare(`ALTER TABLE seed_cursor ADD COLUMN complete INTEGER NOT NULL DEFAULT 0`).run();
    }
    try {
        await env.CATALOG.prepare(`SELECT completed_at FROM seed_cursor LIMIT 1`).first();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/no such column/i.test(message)) throw error;
        await env.CATALOG.prepare(`ALTER TABLE seed_cursor ADD COLUMN completed_at TEXT`).run();
    }
    try {
        await env.CATALOG.prepare(`SELECT registry_complete FROM seed_cursor LIMIT 1`).first();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/no such column/i.test(message)) throw error;
        await env.CATALOG.prepare(`ALTER TABLE seed_cursor ADD COLUMN registry_complete INTEGER NOT NULL DEFAULT 0`).run();
        await env.CATALOG.prepare(`UPDATE seed_cursor SET registry_complete = complete`).run();
    }
    try {
        await env.CATALOG.prepare(`SELECT ghcr_offset FROM seed_cursor LIMIT 1`).first();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/no such column/i.test(message)) throw error;
        await env.CATALOG.prepare(`ALTER TABLE seed_cursor ADD COLUMN ghcr_offset INTEGER NOT NULL DEFAULT 0`).run();
    }
    try {
        await env.CATALOG.prepare(`SELECT ghcr_complete FROM seed_cursor LIMIT 1`).first();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/no such column/i.test(message)) throw error;
        await env.CATALOG.prepare(`ALTER TABLE seed_cursor ADD COLUMN ghcr_complete INTEGER NOT NULL DEFAULT 0`).run();
        await env.CATALOG.prepare(
            `UPDATE seed_cursor
             SET complete = 0
             WHERE complete = 1
               AND registry_complete = 1
               AND ghcr_complete = 0`,
        ).run();
    }
}

async function getCursor(env: Env): Promise<SeedCursor> {
    await ensureSeedCursorTable(env);
    const row = await env.CATALOG.prepare(
        `SELECT cursor, page_offset, complete, registry_complete, ghcr_offset, ghcr_complete FROM seed_cursor WHERE id = 1`,
    ).first<{
        cursor: string | null;
        page_offset: number | null;
        registry_complete: number | null;
        ghcr_offset: number | null;
        ghcr_complete: number | null;
        complete: number | null;
    }>();
    return {
        cursor: row?.cursor ?? null,
        pageOffset: Math.max(0, Number(row?.page_offset ?? 0)),
        registryComplete: Number(row?.registry_complete ?? row?.complete ?? 0) === 1,
        ghcrOffset: Math.max(0, Number(row?.ghcr_offset ?? 0)),
        ghcrComplete: Number(row?.ghcr_complete ?? row?.complete ?? 0) === 1,
        complete: Number(row?.complete ?? 0) === 1,
    };
}

async function persistCursor(
    env: Env,
    input: {
        cursor: string | null;
        pageOffset?: number;
        registryComplete?: boolean;
        ghcrOffset?: number;
        ghcrComplete?: boolean;
        complete?: boolean;
    },
): Promise<void> {
    await ensureSeedCursorTable(env);
    await env.CATALOG.prepare(
        `INSERT INTO seed_cursor (id, cursor, page_offset, registry_complete, ghcr_offset, ghcr_complete, complete, completed_at, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, CASE WHEN ?6 = 1 THEN CURRENT_TIMESTAMP ELSE NULL END, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET
            cursor = excluded.cursor,
            page_offset = excluded.page_offset,
            registry_complete = excluded.registry_complete,
            ghcr_offset = excluded.ghcr_offset,
            ghcr_complete = excluded.ghcr_complete,
            complete = excluded.complete,
            completed_at = excluded.completed_at,
            updated_at = CURRENT_TIMESTAMP`,
    ).bind(
        input.cursor,
        input.pageOffset ?? 0,
        input.registryComplete ? 1 : 0,
        input.ghcrOffset ?? 0,
        input.ghcrComplete ? 1 : 0,
        input.complete ? 1 : 0,
    ).run();
}

async function markVerificationIncomplete(env: Env): Promise<void> {
    try {
        await env.CATALOG.prepare(
            `UPDATE verification_cursor
             SET done = 0,
                 r2_cursor = NULL,
                 updated_at = CURRENT_TIMESTAMP`,
        ).run();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/no such table|no such column/i.test(message)) throw error;
    }
}

interface GhcrIndex {
    fetched_at: number;
    package_page: number;
    package_complete: boolean;
    pending_packages: Array<{ name: string; updated_at?: string | null }>;
    images: Record<string, string>; // slug -> image ref
    packages: Record<string, GhcrContainerPackage>; // slug -> package metadata
}

function ghcrToken(env: Env): string | undefined {
    return env.GHCR_GITHUB_PAT || env.GITHUB_GHCR_PAT || env.GHCR_TOKEN;
}

function ghcrImageForPackage(env: Env, packageName: string, tag: string): { slug: string; image: string } | null {
    const cleanPackage = packageName.replace(/^\/+|\/+$/g, "");
    if (!cleanPackage) return null;
    const parts = cleanPackage.split("/");
    const slugPart = parts.at(-1);
    if (!slugPart) return null;
    const slug = cleanCandidateSlug(slugPart);
    if (!slug) return null;
    const namespace = env.GHCR_NAMESPACE.replace(/\/+$/g, "");
    const registryRoot = namespace.endsWith("/mcp") ? namespace.slice(0, -4) : namespace;
    const image = cleanPackage.includes("/")
        ? `${registryRoot}/${cleanPackage}:${tag}`
        : `${namespace}/${cleanPackage}:${tag}`;
    return { slug, image };
}

async function loadOrRefreshGhcrIndex(env: Env, options: { budget?: number } = {}): Promise<GhcrIndex> {
    const stored = env.RAW ? await env.RAW.get(GHCR_INDEX_KEY) : null;
    const empty: GhcrIndex = {
        fetched_at: Date.now(),
        package_page: 1,
        package_complete: false,
        pending_packages: [],
        images: {},
        packages: {},
    };
    if (stored) {
        try {
            const parsed = await stored.json<GhcrIndex>();
            if (
                Date.now() - parsed.fetched_at < GHCR_INDEX_TTL_MS &&
                parsed.package_complete &&
                parsed.pending_packages.length === 0
            ) {
                return parsed;
            }
            if (Date.now() - parsed.fetched_at < GHCR_INDEX_TTL_MS) {
                return await advanceGhcrIndex(env, parsed, options.budget ?? 60);
            }
        } catch {
            // fall through to refresh
        }
    }
    const next = await advanceGhcrIndex(env, empty, options.budget ?? 60);
    if (env.RAW) {
        await env.RAW.put(GHCR_INDEX_KEY, JSON.stringify(next), {
            httpMetadata: { contentType: "application/json" },
        });
    }
    return next;
}

async function advanceGhcrIndex(env: Env, index: GhcrIndex, budget: number): Promise<GhcrIndex> {
    const token = ghcrToken(env);
    if (!token) return index;
    let remaining = Math.max(1, Math.min(budget, 80));
    const next: GhcrIndex = {
        fetched_at: Date.now(),
        package_page: index.package_page || 1,
        package_complete: index.package_complete === true,
        pending_packages: [...(index.pending_packages || [])],
        images: { ...(index.images || {}) },
        packages: { ...(index.packages || {}) },
    };

    while (!next.package_complete && next.pending_packages.length < 50 && remaining > 0) {
        remaining--;
        const r = await fetch(
            `https://api.github.com/orgs/compose-market/packages?package_type=container&per_page=100&page=${next.package_page}`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                    "User-Agent": "compose-market-connectors",
                },
            },
        );
        if (!r.ok) break;
        const list = await r.json() as Array<{ name?: string; updated_at?: string | null }>;
        if (!Array.isArray(list) || list.length === 0) {
            next.package_complete = true;
            break;
        }
        for (const item of list) {
            if (typeof item.name === "string" && item.name.startsWith("mcp/")) {
                next.pending_packages.push({ name: item.name, updated_at: item.updated_at ?? null });
            }
        }
        next.package_page += 1;
    }

    while (next.pending_packages.length > 0 && remaining > 0) {
        const item = next.pending_packages.shift()!;
        const tag = "latest";
        const mapped = ghcrImageForPackage(env, item.name, tag);
        if (!mapped) continue;
        next.images[mapped.slug] = mapped.image;
        next.packages[mapped.slug] = {
            packageName: item.name,
            slug: mapped.slug,
            image: mapped.image,
            tag,
            updatedAt: item.updated_at ?? null,
        };
    }

    if (env.RAW) {
        await env.RAW.put(GHCR_INDEX_KEY, JSON.stringify(next), {
            httpMetadata: { contentType: "application/json" },
        });
    }
    return next;
}

export interface SeedPageReport {
    started_at: string;
    finished_at: string;
    cursor_in: string | null;
    cursor_out: string | null;
    page_offset_in: number;
    page_offset_out: number;
    page_size: number;
    processed: number;
    upserted: number;
    candidates_archived: number;
    shadow_skipped: number;
    complete_skipped: number;
    images_attached: number;
    done: boolean;
    errors: Array<{ slug: string; message: string }>;
}

/**
 * Process one candidate window from the current registry page.
 */
export async function runSeedPage(env: Env, options: { reset?: boolean; maxCandidates?: number } = {}): Promise<SeedPageReport> {
    const started = new Date().toISOString();
    const errors: Array<{ slug: string; message: string }> = [];
    const maxCandidates = Math.max(1, Math.min(Math.floor(options.maxCandidates ?? DEFAULT_CANDIDATE_LIMIT), MAX_CANDIDATE_LIMIT));

    if (options.reset) {
        await persistCursor(env, {
            cursor: null,
            pageOffset: 0,
            registryComplete: false,
            ghcrOffset: 0,
            ghcrComplete: false,
            complete: false,
        });
        await markVerificationIncomplete(env);
    }

    const state = await getCursor(env);
    const cursorIn = state.cursor;
    const offsetIn = state.pageOffset;
    if (state.complete) {
        return {
            started_at: started,
            finished_at: new Date().toISOString(),
            cursor_in: cursorIn,
            cursor_out: cursorIn,
            page_offset_in: offsetIn,
            page_offset_out: offsetIn,
            page_size: 0,
            processed: 0,
            upserted: 0,
            candidates_archived: 0,
            shadow_skipped: 0,
            complete_skipped: 0,
            images_attached: 0,
            done: true,
            errors,
        };
    }

    if (state.registryComplete) {
        const ghcr = await loadOrRefreshGhcrIndex(env);
        if (!ghcr.package_complete || ghcr.pending_packages.length > 0) {
            await persistCursor(env, {
                cursor: state.cursor,
                pageOffset: state.pageOffset,
                registryComplete: true,
                ghcrOffset: 0,
                ghcrComplete: false,
                complete: false,
            });
            return {
                started_at: started,
                finished_at: new Date().toISOString(),
                cursor_in: cursorIn,
                cursor_out: cursorIn,
                page_offset_in: 0,
                page_offset_out: 0,
                page_size: Object.keys(ghcr.packages || {}).length,
                processed: 0,
                upserted: 0,
                candidates_archived: 0,
                shadow_skipped: 0,
                complete_skipped: 0,
                images_attached: 0,
                done: false,
                errors,
            };
        }
        const packages = Object.values(ghcr.packages || {}).sort((a, b) => a.slug.localeCompare(b.slug));
        const entries = packages.slice(state.ghcrOffset, state.ghcrOffset + maxCandidates);
        const rawKey = "ghcr-index/v1.json";
        let candidatesArchived = 0;
        let shadowSkipped = 0;
        let completeSkipped = 0;

        for (const pkg of entries) {
            try {
                const candidate = await buildCandidateFromGhcrPackage(pkg, rawKey);
                if (!candidate) continue;
                const shadowed = await env.SNAPSHOTS.head(shadowObjectKey(candidate));
                if (shadowed) {
                    shadowSkipped++;
                    continue;
                }
                if (await hasTerminalScreening(env, candidate)) {
                    completeSkipped++;
                    continue;
                }
                await env.RAW.put(candidateObjectKey(candidate), JSON.stringify(candidate), {
                    httpMetadata: { contentType: "application/json" },
                });
                candidatesArchived++;
            } catch (err) {
                errors.push({ slug: pkg.slug, message: err instanceof Error ? err.message : String(err) });
            }
        }

        const offsetOut = Math.min(state.ghcrOffset + entries.length, packages.length);
        const ghcrComplete = ghcr.package_complete && ghcr.pending_packages.length === 0 && offsetOut >= packages.length;
        await persistCursor(env, {
            cursor: state.cursor,
            pageOffset: state.pageOffset,
            registryComplete: true,
            ghcrOffset: ghcrComplete ? 0 : offsetOut,
            ghcrComplete,
            complete: ghcrComplete,
        });
        if (candidatesArchived > 0) {
            await markVerificationIncomplete(env);
        }
        return {
            started_at: started,
            finished_at: new Date().toISOString(),
            cursor_in: cursorIn,
            cursor_out: cursorIn,
            page_offset_in: state.ghcrOffset,
            page_offset_out: ghcrComplete ? 0 : offsetOut,
            page_size: packages.length,
            processed: entries.length,
            upserted: 0,
            candidates_archived: candidatesArchived,
            shadow_skipped: shadowSkipped,
            complete_skipped: completeSkipped,
            images_attached: entries.length,
            done: ghcrComplete,
            errors,
        };
    }

    const url = cursorIn
        ? `${env.MCP_REGISTRY_URL}?cursor=${encodeURIComponent(cursorIn)}`
        : env.MCP_REGISTRY_URL;
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) {
        throw new Error(`registry ${r.status}`);
    }
    const page = await r.json() as RegistryPage;
    const ghcr = await loadOrRefreshGhcrIndex(env);

    let candidatesArchived = 0;
    let shadowSkipped = 0;
    let completeSkipped = 0;
    let imagesAttached = 0;

    // Persist the page's raw archive before candidate envelopes so each
    // candidate can point back to the immutable source payload.
    const cursorOut = page.metadata.nextCursor ?? null;
    const rawKey = `mcp-registry/pages/${cursorIn ? await sha256Hex(cursorIn) : "first"}.json`;
    await env.RAW.put(rawKey, JSON.stringify({ cursor: cursorIn, page }), {
        httpMetadata: { contentType: "application/json" },
    });

    const entries = page.servers.slice(offsetIn, offsetIn + maxCandidates);

    for (const entry of entries) {
        try {
            const candidate = await buildCandidateFromRegistryEntry(entry, ghcr.images, rawKey);
            if (!candidate) continue;
            if (candidate.image) imagesAttached++;

            const shadowed = await env.SNAPSHOTS.head(shadowObjectKey(candidate));
            if (shadowed) {
                shadowSkipped++;
                continue;
            }
            if (await hasTerminalScreening(env, candidate)) {
                completeSkipped++;
                continue;
            }
            await env.RAW.put(candidateObjectKey(candidate), JSON.stringify(candidate), {
                httpMetadata: { contentType: "application/json" },
            });
            candidatesArchived++;
        } catch (err) {
            const slug = (entry?.server?.name || "unknown");
            errors.push({ slug, message: err instanceof Error ? err.message : String(err) });
        }
    }

    const offsetOut = Math.min(offsetIn + entries.length, page.servers.length);
    const pageComplete = offsetOut >= page.servers.length;
    const nextCursor = pageComplete ? cursorOut : cursorIn;
    const nextOffset = pageComplete ? 0 : offsetOut;
    const registryComplete = pageComplete && cursorOut === null;

    // Cursor update is kept last so a failed chunk replays from the same
    // candidate offset. Candidate object keys are deterministic, so replay is
    // idempotent.
    await persistCursor(env, {
        cursor: nextCursor,
        pageOffset: nextOffset,
        registryComplete,
        ghcrOffset: state.ghcrOffset,
        ghcrComplete: state.ghcrComplete,
        complete: false,
    });
    if (candidatesArchived > 0) {
        await markVerificationIncomplete(env);
    }

    return {
        started_at: started,
        finished_at: new Date().toISOString(),
        cursor_in: cursorIn,
        cursor_out: nextCursor,
        page_offset_in: offsetIn,
        page_offset_out: nextOffset,
        page_size: page.servers.length,
        processed: entries.length,
        upserted: 0,
        candidates_archived: candidatesArchived,
        shadow_skipped: shadowSkipped,
        complete_skipped: completeSkipped,
        images_attached: imagesAttached,
        done: false,
        errors,
    };
}

export interface SeedReport {
    started_at: string;
    finished_at: string;
    pages: number;
    processed: number;
    upserted: number;
    candidates_archived: number;
    shadow_skipped: number;
    complete_skipped: number;
    images_attached: number;
    errors: Array<{ slug: string; message: string }>;
    done: boolean;
}

/**
 * Drive the candidate-window loop until either we run out of registry data or
 * hit the caller's chunk budget.
 */
export async function runSeed(env: Env, options: { maxPages?: number; maxCandidates?: number; reset?: boolean } = {}): Promise<SeedReport> {
    const started = new Date().toISOString();
    const max = Math.max(1, Math.min(options.maxPages ?? 8, 64));
    if (options.reset !== true) {
        const state = await getCursor(env);
        if (state.complete) {
            return {
                started_at: started,
                finished_at: new Date().toISOString(),
                pages: 0,
                processed: 0,
                upserted: 0,
                candidates_archived: 0,
                shadow_skipped: 0,
                complete_skipped: 0,
                images_attached: 0,
                errors: [],
                done: true,
            };
        }
    }
    let pages = 0;
    let processed = 0;
    let upserted = 0;
    let candidatesArchived = 0;
    let shadowSkipped = 0;
    let completeSkipped = 0;
    let imagesAttached = 0;
    const errors: Array<{ slug: string; message: string }> = [];
    let done = false;
    let firstReset = options.reset === true;

    while (pages < max) {
        const report = await runSeedPage(env, { reset: firstReset, maxCandidates: options.maxCandidates });
        firstReset = false;
        pages++;
        processed += report.processed;
        upserted += report.upserted;
        candidatesArchived += report.candidates_archived;
        shadowSkipped += report.shadow_skipped;
        completeSkipped += report.complete_skipped;
        imagesAttached += report.images_attached;
        for (const e of report.errors) errors.push(e);
        if (report.done) { done = true; break; }
    }

    return {
        started_at: started,
        finished_at: new Date().toISOString(),
        pages,
        processed,
        upserted,
        candidates_archived: candidatesArchived,
        shadow_skipped: shadowSkipped,
        complete_skipped: completeSkipped,
        images_attached: imagesAttached,
        errors,
        done,
    };
}

async function sha256Hex(text: string): Promise<string> {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
