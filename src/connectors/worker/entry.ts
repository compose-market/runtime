/**
 * Connectors broker — Worker entry.
 *
 * URL layout (all 9000 servers as paths under one subdomain):
 *
 *   GET  /tools                       — list tool servers
 *   GET  /tools/categories            — distinct categories
 *   GET  /tools/tags                  — distinct tags
 *   GET  /tools/meta                  — counts by origin/status
 *   GET  /tools/:slug                 — server card
 *   GET  /tools/:slug/tools           — tool listing
 *   GET  /tools/:slug/spawn           — top-priority spawn config
 *   POST /tools/:slug/execute/:tool   — execute (Bearer-gated)
 *   POST /tools/:slug/inspect         — inspect candidate configs (Bearer-gated)
 *
 *   GET  /onchain                     — list onchain plugins + status
 *   GET  /onchain/:slug               — plugin card
 *   POST /onchain/:slug/execute/:tool — execute onchain tool (Bearer-gated)
 *
 *   POST /seed                        — run the seed workflow (Bearer-gated)
 *   POST /verify                      — run first-pass MCP screening (Bearer-gated)
 *   POST /metadata-agents/run         — run one model-backed metadata shard (Bearer-gated)
 *   POST /publish                     — publish agent artifacts to final catalog (Bearer-gated)
 *   POST /embed                       — run the embed workflow (Bearer-gated)
 *   POST /health                      — run the health rollup (Bearer-gated)
 *   POST /gc                          — run gc (Bearer-gated)
 *   GET  /                            — health check
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { Container } from "@cloudflare/containers";
import { WorkflowEntrypoint, type DurableObjectState } from "cloudflare:workers";
import type { Env, ScheduledController } from "./env.js";
import toolsRoute from "./routes/tools.js";
import onchainRoute from "./routes/onchain.js";
import { requireInternalSecret } from "./auth.js";
import { runSeed } from "../workflows/seed.js";
import { runEmbed } from "../workflows/embed.js";
import { runHealth } from "../workflows/health.js";
import { runGc } from "../workflows/gc.js";
import { runVerifyShard } from "../workflows/verify.js";
import { runMetadataAgent } from "../workflows/metadata/agents.js";
import { runPublish } from "../workflows/publish.js";
import { applyOutboundFetchDefaults } from "./outbound.js";
import {
    getConnectorCatalogPipelineStatus,
    runConnectorCatalogPipeline,
    startConnectorCatalogPipeline,
    type ConnectorCatalogPipelineInput,
} from "../workflows/pipeline/pipeline.js";

applyOutboundFetchDefaults();

export class McpRunnerContainer extends Container<Env> {
    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env, {
            defaultPort: 8080,
            sleepAfter: "10s",
            enableInternet: true,
        });
    }

    async onActivityExpired(): Promise<void> {
        console.log("[mcp-runner] activity expired; destroying container");
        await this.destroy();
    }
}

export class McpRunnerBasicContainer extends McpRunnerContainer {}
export class McpRunnerStandard1Container extends McpRunnerContainer {}
export class McpRunnerStandard2Container extends McpRunnerContainer {}

export class ConnectorCatalogPipelineWorkflow extends WorkflowEntrypoint<Env, ConnectorCatalogPipelineInput> {
    async run(
        event: Readonly<Parameters<typeof runConnectorCatalogPipeline>[1]>,
        step: Parameters<typeof runConnectorCatalogPipeline>[2],
    ): Promise<unknown> {
        return await runConnectorCatalogPipeline(this.env, event, step);
    }
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors({
    origin: (origin) => {
        if (!origin) return "*";
        if (origin.startsWith("http://localhost:")) return origin;
        if (origin === "https://compose.market") return origin;
        if (origin === "https://www.compose.market") return origin;
        if (/^https:\/\/[\w-]+\.compose\.market$/.test(origin)) return origin;
        return null;
    },
    allowHeaders: [
        "Content-Type",
        "Authorization",
        "X-Compose-Run-Id",
        "X-Idempotency-Key",
        "X-Session-User-Address",
        "X-Chain-Id",
    ],
    exposeHeaders: ["*", "PAYMENT-RESPONSE", "payment-response"],
    credentials: true,
    maxAge: 86400,
}));

app.get("/", (c) => c.json({
    service: "connectors",
    ok: true,
    timestamp: new Date().toISOString(),
}));
app.get("/health", (c) => c.json({
    service: "connectors",
    ok: true,
    timestamp: new Date().toISOString(),
}));

app.route("/tools", toolsRoute);
app.route("/onchain", onchainRoute);

app.post("/seed", requireInternalSecret, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { maxPages?: number; maxCandidates?: number; reset?: boolean };
    return c.json(await runSeed(c.env, { maxPages: body.maxPages, maxCandidates: body.maxCandidates, reset: body.reset }));
});
app.post("/compile", requireInternalSecret, async (c) => {
    return c.json({
        error: {
            code: "MCP_RUNTIME_UNAVAILABLE",
            message: "/compile no longer owns MCP metadata; use /metadata-agents/run and /publish",
            retryable: false,
        },
    }, 410);
});
app.post("/embed", requireInternalSecret, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { limit?: number };
    return c.json(await runEmbed(c.env, { limit: body.limit }));
});
app.post("/verify", requireInternalSecret, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { shardId?: number; shardCount?: number; limit?: number };
    return c.json(await runVerifyShard(c.env, { shardId: body.shardId, shardCount: body.shardCount, limit: body.limit }));
});
app.post("/metadata-agents/run", requireInternalSecret, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
        agentId?: number;
        laneId?: number;
        laneCount?: number;
        limit?: number;
        retryRecent?: boolean;
    };
    return c.json(await runMetadataAgent(c.env, {
        agentId: body.agentId ?? 0,
        laneId: body.laneId,
        laneCount: body.laneCount,
        limit: body.limit,
        retryRecent: body.retryRecent,
    }));
});
app.post("/publish", requireInternalSecret, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { limit?: number };
    return c.json(await runPublish(c.env, { limit: body.limit }));
});
app.post("/health", requireInternalSecret, async (c) => c.json(await runHealth(c.env)));
app.post("/gc", requireInternalSecret, async (c) => c.json(await runGc(c.env)));
app.post("/pipeline/run", requireInternalSecret, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as ConnectorCatalogPipelineInput & {
        id?: string;
        parentId?: string | null;
        rootId?: string;
    };
    return c.json(await startConnectorCatalogPipeline(c.env, body, {
        id: body.id,
        parentId: body.parentId,
        rootId: body.rootId,
        force: body.force === true,
    }));
});
app.get("/pipeline/status/:id", requireInternalSecret, async (c) => {
    return c.json(await getConnectorCatalogPipelineStatus(c.env, c.req.param("id")));
});

app.notFound((c) => c.json({ error: { code: "MCP_CONFIG_NOT_FOUND", message: "route not found", retryable: false } }, 404));
app.onError((err, c) => {
    return c.json({ error: { code: "MCP_RUNTIME_UNAVAILABLE", message: err.message, retryable: false } }, 500);
});

export default {
    async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
        return await app.fetch(request, env, ctx);
    },

    async scheduled(controller: ScheduledController, env: Env, ctx: any): Promise<void> {
        const cron = controller.cron;
        if (cron === "0 2 * * *") {
            const day = new Date(controller.scheduledTime).toISOString().slice(0, 10).replace(/-/g, "");
            ctx.waitUntil(startConnectorCatalogPipeline(env, { mode: "maintenance" }, { id: `connector-catalog-maintenance-${day}` }).then(() => undefined));
        }
    },
};
