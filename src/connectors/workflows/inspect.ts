/**
 * Inspect workflow — runs candidate spawn configs once, captures
 * stdout/stderr, and persists tools or a typed failure.
 *
 * Container-based spawn (stdio/npx/docker) is not yet implemented; HTTP
 * remote inspect works fully here. The Container DO that wraps the
 * supergateway-published GHCR images is the next building block — until
 * it lands, stdio/npx/docker candidates are reported as unavailable with
 * a precise typed error.
 */

import type { Env } from "../worker/env.js";
import { listToolsHttp } from "../container/transports/http.js";
import { listToolsViaRunner, RunnerDispatchError } from "../container/dispatcher.js";
import { detectFromStderr, detectFromJsonRpc } from "../worker/credentials.js";
import { resolveServerSlug } from "../catalog/d1.js";

interface Candidate {
    transport: "stdio" | "http" | "docker" | "npx";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    envRequired?: string[];
    envOptional?: string[];
    image?: string;
    remoteUrl?: string;
    protocol?: "sse" | "streamable-http";
    package?: string;
}

export interface InspectError {
    transport: string;
    code: string;
    message: string;
    retryable: boolean;
    statusCode?: number;
}

export interface InspectSuccess {
    ok: true;
    serverId: string;
    transportUsed: string;
    toolCount: number;
    tools: Array<{ name: string; description?: string }>;
}

export interface InspectFailure {
    ok: false;
    serverId: string;
    errors: InspectError[];
}

export type InspectResult = InspectSuccess | InspectFailure;

function nowKey(): string {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

async function recordInspectOutcome(
    env: Env,
    slug: string,
    input: { ok: boolean; transport: string; latencyMs: number; reason?: string },
): Promise<void> {
    const bucketAt = new Date(Math.floor(Date.now() / 300_000) * 300_000).toISOString();
    const outcome = input.ok ? "ok" : input.reason === "creds" ? "fail_creds" : "fail_transport";
    await env.CATALOG.batch([
        env.CATALOG.prepare(
            `INSERT INTO health (server_slug, transport_kind, bucket_at, outcome, latency_ms, count)
             VALUES (?1, ?2, ?3, ?4, ?5, 1)
             ON CONFLICT(server_slug, transport_kind, bucket_at, outcome) DO UPDATE SET
                count = count + 1,
                latency_ms = (latency_ms + excluded.latency_ms) / 2`,
        ).bind(slug, input.transport, bucketAt, outcome, input.latencyMs),
        env.CATALOG.prepare(
            `INSERT INTO runs (id, server_slug, started_at, ended_at, transport_kind, outcome, error_envelope)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        ).bind(
            crypto.randomUUID(),
            slug,
            new Date(Date.now() - input.latencyMs).toISOString(),
            new Date().toISOString(),
            input.transport,
            outcome,
            input.reason || null,
        ),
    ]);
}

export async function runInspect(
    env: Env,
    serverIdOrSlug: string,
    candidates: Candidate[],
    options: { deadlineMs?: number } = {},
): Promise<InspectResult> {
    const slug = (await resolveServerSlug(env, serverIdOrSlug)) || serverIdOrSlug;
    const errors: InspectError[] = [];
    const deadlineMs = Math.max(5_000, Math.min(options.deadlineMs ?? 90_000, 120_000));

    if (candidates.length === 0) {
        return { ok: false, serverId: slug, errors: [{ transport: "none", code: "TOOL_VALIDATION", message: "no candidates supplied", retryable: false }] };
    }

    for (const candidate of candidates) {
        const t = candidate.transport;
        const started = Date.now();
        try {
            if (t === "http") {
                if (!candidate.remoteUrl) {
                    errors.push({ transport: t, code: "TOOL_VALIDATION", message: "remoteUrl required", retryable: false });
                    continue;
                }
                const listing = await listToolsHttp({
                    url: candidate.remoteUrl,
                    requiredCredentialVars: candidate.envRequired,
                    envProvided: candidate.env,
                });
                const tools = (listing.tools || []).map((tool) => ({
                    name: String(tool.name),
                    description: typeof tool.description === "string" ? tool.description : undefined,
                }));
                await recordInspectOutcome(env, slug, { ok: true, transport: "http", latencyMs: Date.now() - started });
                return {
                    ok: true,
                    serverId: slug,
                    transportUsed: "http",
                    toolCount: tools.length,
                    tools,
                };
            }

            const listing = await listToolsViaRunner(env, slug, candidate, { deadlineMs });
            const tools = (listing.tools || []).map((tool) => ({
                name: String(tool.name),
                description: typeof tool.description === "string" ? tool.description : undefined,
            }));
            await recordInspectOutcome(env, slug, { ok: true, transport: t, latencyMs: Date.now() - started });
            return {
                ok: true,
                serverId: slug,
                transportUsed: listing.transportUsed || t,
                toolCount: tools.length,
                tools,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // Try to extract credentials evidence from the error message and persist.
            const fromStderr = detectFromStderr(message);
            const fromJsonRpc = detectFromJsonRpc(safeJsonParse(message));
            const runnerVars = error instanceof RunnerDispatchError ? error.credentialVars : [];
            const detected = [...new Set([...fromStderr, ...fromJsonRpc, ...runnerVars])];
            if (detected.length > 0) {
                const evidenceKey = `inspect/${slug}/${nowKey()}.txt`;
                await env.SNAPSHOTS.put(evidenceKey, message, { httpMetadata: { contentType: "text/plain" } });
                await recordInspectOutcome(env, slug, { ok: false, transport: t, latencyMs: Date.now() - started, reason: "creds" });
                errors.push({
                    transport: t,
                    code: "CREDENTIALS_REQUIRED",
                    message: `credentials required: ${detected.join(", ")}`,
                    retryable: false,
                });
                continue;
            }
            errors.push({
                transport: t,
                code: "MCP_SPAWN_FAILED",
                message,
                retryable: true,
            });
            await recordInspectOutcome(env, slug, { ok: false, transport: t, latencyMs: Date.now() - started, reason: message.slice(0, 500) });
        }
    }

    return { ok: false, serverId: slug, errors };
}

function safeJsonParse(s: string): unknown {
    try { return JSON.parse(s); } catch { return null; }
}
