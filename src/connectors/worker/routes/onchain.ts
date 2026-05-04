/**
 * /onchain — GOAT plugin catalog and execution.
 *
 * GET /onchain — list plugins + status
 * GET /onchain/:slug — plugin card
 * POST /onchain/:slug/execute/:tool — execute (Bearer-gated)
 */
import { Hono } from "hono";
import type { Env } from "../env.js";
import { requireInternalSecret } from "../auth.js";
import { listGoatPlugins, getGoatPlugin, runGoatTool } from "../goat.js";

const app = new Hono<{ Bindings: Env }>();

app.get("/", async (c) => c.json(await listGoatPlugins(c.env)));

app.get("/:slug", async (c) => {
    const plugin = await getGoatPlugin(c.env, c.req.param("slug"));
    if (!plugin) return c.json({ error: { code: "MCP_CONFIG_NOT_FOUND", message: "plugin not found", retryable: false } }, 404);
    return c.json(plugin);
});

app.get("/:slug/tools/:tool", async (c) => {
    const plugin = await getGoatPlugin(c.env, c.req.param("slug"));
    if (!plugin) return c.json({ error: { code: "MCP_CONFIG_NOT_FOUND", message: "plugin not found", retryable: false } }, 404);
    const tool = plugin.tools.find((entry) => entry.name === c.req.param("tool"));
    if (!tool) return c.json({ error: { code: "MCP_CONFIG_NOT_FOUND", message: "tool not found", retryable: false } }, 404);
    return c.json(tool);
});

app.post("/:slug/execute/:tool", requireInternalSecret, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
        args?: Record<string, unknown>;
        identity?: Record<string, string | undefined>;
        envProvided?: Record<string, string>;
        deadlineMs?: number;
    };
    const result = await runGoatTool(
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
    if (result.ok) return c.json(result);
    if (result.kind === "CREDENTIALS_REQUIRED") return c.json(result);
    const status = result.kind === "MCP_CONFIG_NOT_FOUND" ? 404
        : result.kind === "TOOL_VALIDATION" ? 400
            : result.kind === "MCP_RUNTIME_UNAVAILABLE" ? 503
                : 500;
    return c.json(result, status);
});

export default app;
