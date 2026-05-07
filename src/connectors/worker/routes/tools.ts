/**
 * /tools — MCP server catalog and execution.
 */
import { Hono } from "hono";
import type { Env } from "../env.js";
import {
    listServers,
    getServer,
    listCategories,
    listTags,
    meta,
    parseTags,
    parseJsonObject,
    resolveServerSlug,
    getTools,
    getCredentials,
    hasReviewedCatalogEntry,
    type ServerRow,
} from "../../catalog/d1.js";
import { getSpawnConfigs } from "../../catalog/spawn.js";
import { callServerTool, listServerTools } from "../broker.js";
import { requireInternalSecret } from "../auth.js";
import { runInspect } from "../../workflows/inspect.js";
import { embedTexts, rerankDocuments } from "../../catalog/embeddings.js";
import { isServedCatalogStatus, type ServedCatalogStatus } from "../../workflows/candidates.js";

const app = new Hono<{ Bindings: Env }>();
const CATALOG_CACHE_CONTROL = "public, max-age=60, s-maxage=3600";
const SEARCH_CACHE_CONTROL = "public, max-age=30, s-maxage=300";

app.get("/", async (c) => {
    const limitParam = c.req.query("limit");
    const offset = parseInt(c.req.query("offset") || "0", 10) || 0;
    const category = (c.req.query("category") || "").trim() || undefined;
    const statusParam = c.req.query("status");
    const limit = Math.min(limitParam ? Math.max(1, parseInt(limitParam, 10) || 0) : 50, 200);
    c.header("Cache-Control", CATALOG_CACHE_CONTROL);
    let status: ServedCatalogStatus | undefined;
    if (statusParam) {
        if (!isServedCatalogStatus(statusParam)) {
            return c.json({ total: 0, offset, limit: 0, servers: [] });
        }
        status = statusParam;
    }
    const { rows, total } = await listServers(c.env, status
        ? { origin: "tools", status, category, servedOnly: true, limit, offset }
        : { origin: "tools", statuses: ["live", "credential_gated"], category, servedOnly: true, limit, offset });
    return c.json({
        total,
        offset,
        limit: rows.length,
        servers: rows.map((r) => ({
            slug: r.slug,
            origin: r.origin,
            name: r.name,
            namespace: r.namespace,
            description: r.description,
            tags: parseTags(r.tags),
            category: r.category,
            status: r.status,
            statefulness: r.statefulness,
            cardVersion: r.card_version,
            inspectedAt: r.inspected_at,
        })),
    });
});

app.get("/categories", async (c) => {
    c.header("Cache-Control", CATALOG_CACHE_CONTROL);
    return c.json({ categories: await listCategories(c.env) });
});
app.get("/tags", async (c) => {
    c.header("Cache-Control", CATALOG_CACHE_CONTROL);
    return c.json({ tags: await listTags(c.env) });
});
app.get("/meta", async (c) => {
    c.header("Cache-Control", CATALOG_CACHE_CONTROL);
    return c.json(await meta(c.env));
});

/**
 * GET /tools/search?q=...&limit=...
 *
 * Semantic search over final-catalog Vectorize rows followed by Voyage rerank.
 */
app.get("/search", async (c) => {
    const q = (c.req.query("q") || "").toLowerCase().trim();
    const limit = Math.max(1, Math.min(parseInt(c.req.query("limit") || "30", 10) || 30, 50));
    c.header("Cache-Control", SEARCH_CACHE_CONTROL);
    if (!q) {
        return c.json({ query: "", total: 0, servers: [] });
    }
    try {
        const [queryVector] = await embedTexts(c.env, [q], "query");
        if (!queryVector) {
            throw new Error("query embedding returned empty vector");
        }
        const vectorMatches = await c.env.EMBEDDINGS.query(queryVector, {
            topK: Math.max(limit, 50),
            returnMetadata: "all",
            filter: {
                origin: "tools",
                indexed: "final-catalog",
                status: { "$in": ["live", "credential_gated"] },
            },
        });
        const slugs = [...new Set((vectorMatches.matches || [])
            .map((match) => typeof match.metadata?.slug === "string" ? match.metadata.slug : match.id.replace(/^tools:/, ""))
            .filter((slug) => slug.length > 0))];
        if (slugs.length === 0) {
            return c.json({ query: q, total: 0, servers: [] });
        }
        const placeholders = slugs.map((_slug, index) => `?${index + 1}`).join(", ");
        const rowsRes = await c.env.CATALOG.prepare(
            `SELECT s.*
             FROM servers s
             JOIN metadata_reviews mr
               ON mr.server_slug = s.slug
              AND mr.card_version = s.card_version
             JOIN embedding_state es
               ON es.server_slug = s.slug
              AND es.card_version = s.card_version
             WHERE s.origin = 'tools'
               AND s.status IN ('live', 'credential_gated')
               AND s.slug IN (${placeholders})`,
        ).bind(...slugs).all<ServerRow>();
        const bySlug = new Map((rowsRes.results || []).map((row) => [row.slug, row]));
        const candidates = slugs.map((slug) => bySlug.get(slug)).filter((row): row is ServerRow => Boolean(row));
        const reranked = await rerankDocuments(
            c.env,
            q,
            candidates.map((s) => ({
                id: s.slug,
                text: `${s.name}\n${s.description}\n${parseTags(s.tags).join(", ")}`,
            })),
            limit,
        );
        const ranked = reranked.map((item) => bySlug.get(item.id)).filter((row): row is ServerRow => Boolean(row));
        const top = ranked.slice(0, limit).map((s) => ({
            slug: s.slug,
            origin: s.origin,
            name: s.name,
            namespace: s.namespace,
            description: s.description,
            tags: parseTags(s.tags),
            category: s.category,
            status: s.status,
            statefulness: s.statefulness,
            cardVersion: s.card_version,
            inspectedAt: s.inspected_at,
        }));
        return c.json({ query: q, total: candidates.length, servers: top });
    } catch (error) {
        return c.json({
            error: {
                code: "MCP_RUNTIME_UNAVAILABLE",
                message: error instanceof Error ? error.message : String(error),
                retryable: true,
            },
        }, 503);
    }
});

app.get("/:slug", async (c) => {
    const slug = await resolveServerSlug(c.env, c.req.param("slug"));
    c.header("Cache-Control", CATALOG_CACHE_CONTROL);
    if (!slug) return c.json({ error: { code: "MCP_CONFIG_NOT_FOUND", message: "server not found", retryable: false } }, 404);
    const server = await getServer(c.env, slug);
    if (!server) return c.json({ error: { code: "MCP_CONFIG_NOT_FOUND", message: "server not found", retryable: false } }, 404);
    const reviewed = isServedCatalogStatus(server.status)
        ? await hasReviewedCatalogEntry(c.env, slug)
        : false;
    if (!reviewed) {
        return c.json({ error: { code: "SERVER_QUARANTINED", message: "server is not in the final served catalog", retryable: false } }, 404);
    }
    const tools = reviewed ? await getTools(c.env, slug) : [];
    const credentials = await getCredentials(c.env, slug);

    return c.json({
        slug: server.slug,
        origin: server.origin,
        name: server.name,
        namespace: server.namespace,
        description: server.description,
        tags: parseTags(server.tags),
        category: server.category,
        repoUrl: server.repo_url,
        image: server.image,
        status: server.status,
        available: reviewed,
        statefulness: server.statefulness,
        cardVersion: server.card_version,
        compiledAt: server.compiled_at,
        inspectedAt: server.inspected_at,
        tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: parseJsonObject(t.input_schema),
        })),
        credentials: credentials.map((c2) => ({
            varName: c2.var_name,
            description: c2.description,
            obtainUrl: c2.obtain_url,
        })),
    });
});

// Tool listing consumed by runtime/src/connectors/client.ts:getServerTools
app.get("/:slug/tools", async (c) => {
    const out = await listServerTools(c.env, c.req.param("slug"));
    if (!out) return c.json({ error: { code: "MCP_CONFIG_NOT_FOUND", message: "server not found", retryable: false } }, 404);
    return c.json(out);
});

app.get("/:slug/spawn", async (c) => {
    const slug = await resolveServerSlug(c.env, c.req.param("slug"));
    if (!slug) return c.json({ error: { code: "MCP_CONFIG_NOT_FOUND", message: "server not found", retryable: false } }, 404);
    const server = await getServer(c.env, slug);
    if (!server || !isServedCatalogStatus(server.status) || !(await hasReviewedCatalogEntry(c.env, slug))) {
        return c.json({ error: { code: "SERVER_QUARANTINED", message: "server is not in the final served catalog", retryable: false } }, 404);
    }
    const configs = await getSpawnConfigs(c.env, slug);
    if (configs.length === 0) {
        return c.json({ error: { code: "MCP_CONFIG_NOT_FOUND", message: "no transports configured", retryable: false } }, 404);
    }
    return c.json(configs[0]);
});

app.post("/:slug/execute/:tool", requireInternalSecret, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
        args?: Record<string, unknown>;
        identity?: Record<string, string | undefined>;
        envProvided?: Record<string, string>;
        deadlineMs?: number;
    };
    const result = await callServerTool(
        c.env,
        c.req.param("slug"),
        c.req.param("tool"),
        {
            args: body.args || {},
            identity: body.identity || {},
            envProvided: body.envProvided,
            deadlineMs: body.deadlineMs,
        },
    );
    if (result.ok) {
        return c.json(result);
    }
    if (result.kind === "CREDENTIALS_REQUIRED") {
        // 200 with ok=false; the runtime client surfaces this as a typed
        // error and the LLM-loop circuit breaker leaves the tool retryable
        // once creds are supplied.
        return c.json(result);
    }
    const status = result.kind === "MCP_CONFIG_NOT_FOUND" ? 404
        : result.kind === "TOOL_VALIDATION" ? 400
            : result.kind === "RATE_LIMITED" ? 429
                : result.kind === "MCP_SPAWN_TIMEOUT" || result.kind === "DEADLINE_EXCEEDED" ? 504
                    : result.kind === "SERVER_QUARANTINED" || result.kind === "MCP_RUNTIME_UNAVAILABLE" ? 503
                        : 500;
    return c.json(result, status);
});

app.post("/:slug/inspect", requireInternalSecret, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
        candidates?: Array<{
            transport: "stdio" | "http" | "docker" | "npx";
            command?: string;
            args?: string[];
            env?: Record<string, string>;
            image?: string;
            remoteUrl?: string;
            protocol?: "sse" | "streamable-http";
            package?: string;
        }>;
        deadlineMs?: number;
    };
    const candidates = body.candidates || [];
    const slug = c.req.param("slug");
    const result = await runInspect(c.env, slug, candidates, { deadlineMs: body.deadlineMs });
    return c.json(result);
});

export default app;
