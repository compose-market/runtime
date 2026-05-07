/**
 * Broker — unified tool-execution entry point.
 *
 * Resolves a server slug, picks the highest-priority working transport,
 * checks credentials, executes the tool, returns a typed CallResponse.
 *
 * Transports handled here:
 *   - http (remote SSE / streamable-HTTP) → container/transports/http.ts
 *   - stdio / npx / docker → not yet wired to Containers in this commit
 *     (tracked: container/dispatch.ts becomes the gateway). Without a
 *     Container DO, we surface MCP_RUNTIME_UNAVAILABLE so callers see a
 *     real error instead of a silent fail.
 *
 * GOAT (origin = "onchain") is delegated to the goat module.
 */

import type { Env } from "./env.js";
import {
    getServer,
    getTools,
    getCredentials,
    hasReviewedCatalogEntry,
    resolveServerSlug,
    parseStringArray,
    parseJsonObject,
} from "../catalog/d1.js";
import { getSpawnConfigs, type ServerSpawnConfig } from "../catalog/spawn.js";
import { callToolHttp } from "../container/transports/http.js";
import { callToolViaRunner, RunnerDispatchError } from "../container/dispatcher.js";
import { detectFromJsonRpc, detectFromStderr } from "./credentials.js";
import { runGoatTool, listGoatPlugins, getGoatPlugin } from "./goat.js";
import { isServedCatalogStatus } from "../workflows/candidates.js";

// ─── Public response shapes (mirror runtime/src/connectors/types.ts) ─────

export type ConnectorsErrorCode =
    | "MCP_CONFIG_NOT_FOUND"
    | "MCP_SPAWN_TIMEOUT"
    | "MCP_SPAWN_FAILED"
    | "MCP_SESSION_NOT_FOUND"
    | "MCP_SESSION_INVALID"
    | "MCP_TOOL_FAILED"
    | "MCP_RUNTIME_UNAVAILABLE"
    | "CREDENTIALS_REQUIRED"
    | "TOOL_VALIDATION"
    | "SERVER_QUARANTINED"
    | "RATE_LIMITED"
    | "DEADLINE_EXCEEDED";

export interface ConnectorsIdentity {
    agentWallet?: string;
    composeRunId?: string;
    threadId?: string;
    userAddress?: string;
    workflowWallet?: string;
    haiId?: string;
    mode?: "global" | "local";
}

export interface CallEnvelope {
    args: Record<string, unknown>;
    identity?: ConnectorsIdentity;
    envProvided?: Record<string, string>;
    deadlineMs?: number;
}

export type CallResponse =
    | { ok: true; result: unknown; transportUsed: string; latencyMs: number }
    | { ok: false; kind: "CREDENTIALS_REQUIRED"; serverId: string; missing: Array<{ varName: string; description?: string; obtainUrl?: string }> }
    | { ok: false; kind: Exclude<ConnectorsErrorCode, "CREDENTIALS_REQUIRED">; message: string; retryable: boolean; transport?: string; retriesAttempted?: number };

export interface ToolListResponse {
    serverId: string;
    sessionId: string;
    cached: boolean;
    toolCount: number;
    tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
}

// ─── Catalog reads exposed via /tools/:slug ──────────────────────────────

export async function listServerTools(env: Env, slugOrId: string): Promise<ToolListResponse | null> {
    const slug = await resolveServerSlug(env, slugOrId);
    if (!slug) return null;
    const server = await getServer(env, slug);
    if (!server) return null;
    if (!isServedCatalogStatus(server.status) || !(await hasReviewedCatalogEntry(env, slug))) {
        // Only agent-reviewed, promoted catalog rows expose tools to agents.
        return {
            serverId: slug,
            sessionId: `${server.status}:${slug}`,
            cached: false,
            toolCount: 0,
            tools: [],
        };
    }
    const tools = await getTools(env, slug);
    return {
        serverId: slug,
        sessionId: `catalog:${slug}:${server.card_version || "v0"}`,
        cached: true,
        toolCount: tools.length,
        tools: tools.map((t) => ({
            name: t.name,
            description: t.description ?? undefined,
            inputSchema: parseJsonObject(t.input_schema),
        })),
    };
}

// ─── Credentials gate ────────────────────────────────────────────────────

async function checkCredentials(
    env: Env,
    slug: string,
    envProvided: Record<string, string> | undefined,
): Promise<{ ok: true } | { ok: false; missing: Array<{ varName: string; description?: string; obtainUrl?: string }> }> {
    const required = await getCredentials(env, slug);
    if (required.length === 0) return { ok: true };
    const provided = envProvided || {};
    const missing = required
        .filter((r) => !provided[r.var_name])
        .map((r) => ({
            varName: r.var_name,
            description: r.description ?? undefined,
            obtainUrl: r.obtain_url ?? undefined,
        }));
    if (missing.length === 0) return { ok: true };
    return { ok: false, missing };
}

// ─── Tool execution dispatcher ───────────────────────────────────────────

export async function callServerTool(
    env: Env,
    slugOrId: string,
    toolName: string,
    envelope: CallEnvelope,
): Promise<CallResponse> {
    const slug = await resolveServerSlug(env, slugOrId);
    if (!slug) {
        return { ok: false, kind: "MCP_CONFIG_NOT_FOUND", message: `unknown server: ${slugOrId}`, retryable: false };
    }
    const server = await getServer(env, slug);
    if (!server) {
        return { ok: false, kind: "MCP_CONFIG_NOT_FOUND", message: `unknown server: ${slug}`, retryable: false };
    }
    if (!isServedCatalogStatus(server.status) || !(await hasReviewedCatalogEntry(env, slug))) {
        return { ok: false, kind: "SERVER_QUARANTINED", message: `server ${slug} is not in the served catalog (${server.status})`, retryable: false };
    }

    const credCheck = await checkCredentials(env, slug, envelope.envProvided);
    if (!credCheck.ok) {
        return { ok: false, kind: "CREDENTIALS_REQUIRED", serverId: slug, missing: credCheck.missing };
    }

    if (server.origin === "onchain") {
        return await runGoatTool(env, slug, toolName, envelope);
    }

    const configs = await getSpawnConfigs(env, slug);
    if (configs.length === 0) {
        return {
            ok: false, kind: "MCP_RUNTIME_UNAVAILABLE",
            message: `no transports configured for ${slug}`,
            retryable: false,
        };
    }

    let lastError: { kind: Exclude<ConnectorsErrorCode, "CREDENTIALS_REQUIRED">; message: string; retryable: boolean; transport: string } | null = null;
    for (const cfg of configs) {
        const start = Date.now();
        try {
            const result = await dispatchOnce(env, slug, cfg, toolName, envelope);
            await recordCallOutcome(env, slug, cfg.transport, "ok", Date.now() - start, envelope);
            return { ok: true, result, transportUsed: cfg.transport, latencyMs: Date.now() - start };
        } catch (error) {
            const transport = cfg.transport;
            const message = error instanceof Error ? error.message : String(error);
            const code = classifyError(message);
            // Inspect the error for inline credential signals; if a server
            // reports a missing var via JSON-RPC -32602 mid-call, surface
            // it the same way the credentials gate would.
            const fromJsonRpc = detectFromJsonRpc(safeJsonParse(message));
            const fromStderr = detectFromStderr(message);
            const detected = [...new Set([...fromJsonRpc, ...fromStderr])];
            if (detected.length > 0) {
                await recordCallOutcome(env, slug, transport, "fail_creds", Date.now() - start, envelope, message);
                return {
                    ok: false, kind: "CREDENTIALS_REQUIRED", serverId: slug,
                    missing: detected.map((v) => ({ varName: v })),
                };
            }
            lastError = { kind: code, message, retryable: isRetryable(code, message), transport };
            await recordCallOutcome(env, slug, transport, code === "MCP_SPAWN_TIMEOUT" ? "fail_timeout" : "fail_tool", Date.now() - start, envelope, message);
            // If the failure was unambiguously fatal (validation / quarantine), bail.
            if (code === "TOOL_VALIDATION" || code === "SERVER_QUARANTINED" || code === "DEADLINE_EXCEEDED") {
                break;
            }
        }
    }
    if (!lastError) {
        return { ok: false, kind: "MCP_RUNTIME_UNAVAILABLE", message: "no transports succeeded", retryable: true };
    }
    return {
        ok: false,
        kind: lastError.kind,
        message: lastError.message,
        retryable: lastError.retryable,
        transport: lastError.transport,
        retriesAttempted: configs.length,
    };
}

async function recordCallOutcome(
    env: Env,
    slug: string,
    transport: string,
    outcome: "ok" | "fail_transport" | "fail_creds" | "fail_tool" | "fail_timeout",
    latencyMs: number,
    envelope: CallEnvelope,
    error?: string,
): Promise<void> {
    const bucketAt = new Date(Math.floor(Date.now() / 300_000) * 300_000).toISOString();
    await env.CATALOG.batch([
        env.CATALOG.prepare(
            `INSERT INTO health (server_slug, transport_kind, bucket_at, outcome, latency_ms, count)
             VALUES (?1, ?2, ?3, ?4, ?5, 1)
             ON CONFLICT(server_slug, transport_kind, bucket_at, outcome) DO UPDATE SET
                count = count + 1,
                latency_ms = (latency_ms + excluded.latency_ms) / 2`,
        ).bind(slug, transport, bucketAt, outcome, latencyMs),
        env.CATALOG.prepare(
            `INSERT INTO runs (id, server_slug, started_at, ended_at, transport_kind, outcome, error_envelope, agent_wallet, user_address, compose_run_id, thread_id, workflow_wallet, mode, hai_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
        ).bind(
            crypto.randomUUID(),
            slug,
            new Date(Date.now() - latencyMs).toISOString(),
            new Date().toISOString(),
            transport,
            outcome,
            error || null,
            envelope.identity?.agentWallet || null,
            envelope.identity?.userAddress || null,
            envelope.identity?.composeRunId || null,
            envelope.identity?.threadId || null,
            envelope.identity?.workflowWallet || null,
            envelope.identity?.mode || null,
            envelope.identity?.haiId || null,
        ),
    ]);
}

async function dispatchOnce(
    env: Env,
    slug: string,
    cfg: ServerSpawnConfig,
    toolName: string,
    envelope: CallEnvelope,
): Promise<unknown> {
    if (cfg.transport === "http") {
        if (!cfg.remoteUrl) throw new Error("http transport missing remoteUrl");
        const result = await callToolHttp(
            {
                url: cfg.remoteUrl,
                requiredCredentialVars: cfg.envRequired,
                envProvided: envelope.envProvided,
            },
            toolName,
            envelope.args,
        );
        if (result.isError) {
            const text = result.content.find((c) => c.type === "text")?.text || "tool reported error";
            throw new Error(text);
        }
        const text = result.content.find((c) => c.type === "text")?.text;
        if (text === undefined) return result.content;
        try { return JSON.parse(text); } catch { return text; }
    }

    try {
        return await callToolViaRunner(
            env,
            slug,
            cfg,
            toolName,
            envelope.args,
            {
                envProvided: envelope.envProvided,
                deadlineMs: envelope.deadlineMs ?? cfg.deadlineMs ?? undefined,
                runnerProfile: cfg.runnerProfile,
            },
        );
    } catch (error) {
        if (error instanceof RunnerDispatchError && error.credentialVars.length > 0) {
            throw new Error(`credentials required: ${error.credentialVars.join(", ")}`);
        }
        throw error;
    }
}

function classifyError(message: string): Exclude<ConnectorsErrorCode, "CREDENTIALS_REQUIRED"> {
    const lower = message.toLowerCase();
    if (lower.includes("timeout") || lower.includes("timed out")) return "MCP_SPAWN_TIMEOUT";
    if (lower.includes("rate limit") || lower.includes("429")) return "RATE_LIMITED";
    if (lower.includes("deadline")) return "DEADLINE_EXCEEDED";
    if (lower.includes("validation") || lower.includes("invalid arguments")) return "TOOL_VALIDATION";
    if (lower.includes("quarantine")) return "SERVER_QUARANTINED";
    if (lower.includes("connection closed") || lower.includes("transport closed")) return "MCP_SESSION_INVALID";
    return "MCP_TOOL_FAILED";
}

function isRetryable(code: ConnectorsErrorCode, message: string): boolean {
    if (code === "MCP_SPAWN_TIMEOUT" || code === "RATE_LIMITED") return true;
    if (code === "MCP_SESSION_INVALID") return true;
    if (code === "TOOL_VALIDATION" || code === "SERVER_QUARANTINED" || code === "CREDENTIALS_REQUIRED") return false;
    const lower = message.toLowerCase();
    return lower.includes("temporarily unavailable") || lower.includes("network");
}

function safeJsonParse(s: string): unknown {
    try { return JSON.parse(s); } catch { return null; }
}

// ─── Re-exports for the GOAT path ────────────────────────────────────────

export { listGoatPlugins, getGoatPlugin };
