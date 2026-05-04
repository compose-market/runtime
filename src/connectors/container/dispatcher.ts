/**
 * Supergateway runner dispatcher.
 *
 * Plain Workers cannot spawn arbitrary stdio/npx MCP servers. The Worker
 * calls a Cloudflare Container (or MCP_RUNNER_URL in dev) that runs Node +
 * Supergateway and exposes a small HTTP contract.
 */

import { getRandom } from "@cloudflare/containers";
import type { Env } from "../worker/env.js";
import type { ServerSpawnConfig } from "../catalog/spawn.js";

export interface RunnerTool {
    name: string;
    description?: string | null;
    inputSchema?: Record<string, unknown>;
}

type RunnerResponse<T> =
    | ({ ok: true } & T)
    | {
        ok: false;
        code: string;
        message: string;
        credentialVars?: string[];
        retryable?: boolean;
    };

export class RunnerDispatchError extends Error {
    code: string;
    credentialVars: string[];
    retryable: boolean;

    constructor(input: { code: string; message: string; credentialVars?: string[]; retryable?: boolean }) {
        super(input.message);
        this.name = "RunnerDispatchError";
        this.code = input.code;
        this.credentialVars = input.credentialVars || [];
        this.retryable = input.retryable ?? true;
    }
}

async function requestShutdown(fetcher: { fetch(input: Request | string, init?: RequestInit): Promise<Response> }, baseUrl: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    try {
        await fetcher.fetch(`${baseUrl}/shutdown`, {
            method: "POST",
            signal: controller.signal,
        });
    } catch {
        // Best-effort shutdown; sleepAfter remains the safety net.
    } finally {
        clearTimeout(timer);
    }
}

async function fetchRunner(env: Env, path: "/inspect" | "/call", body: Record<string, unknown>): Promise<unknown> {
    const deadlineMs = Math.max(5_000, Math.min(Number(body.deadlineMs || 60_000), 120_000));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs + 5_000);
    const init: RequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
    };
    const request = new Request(`https://mcp-runner.internal${path}`, init);

    try {
        let response: Response;
        let shutdown: (() => Promise<void>) | null = null;
        if (env.MCP_RUNNER) {
            const instances = Math.max(1, Math.min(parseInt(env.MCP_RUNNER_INSTANCES || "32", 10) || 32, 256));
            const stub = await getRandom(env.MCP_RUNNER as any, instances);
            response = await stub.fetch(request);
            if (env.MCP_RUNNER_SHUTDOWN_AFTER_REQUEST !== "false") {
                shutdown = () => requestShutdown(stub, "https://mcp-runner.internal");
            }
        } else if (env.MCP_RUNNER_URL) {
            const base = env.MCP_RUNNER_URL.replace(/\/+$/, "");
            response = await fetch(`${base}${path}`, init);
            if (env.MCP_RUNNER_SHUTDOWN_AFTER_REQUEST === "true") {
                shutdown = () => requestShutdown({ fetch }, base);
            }
        } else {
            throw new RunnerDispatchError({
                code: "MCP_RUNTIME_UNAVAILABLE",
                message: "MCP runner is not configured; set MCP_RUNNER container binding or MCP_RUNNER_URL",
                retryable: false,
            });
        }

        const text = await response.text();
        if (shutdown) await shutdown();
        let parsed: unknown = {};
        if (text) {
            try {
                parsed = JSON.parse(text);
            } catch {
                throw new RunnerDispatchError({
                    code: "MCP_RUNTIME_UNAVAILABLE",
                    message: `MCP runner returned non-JSON ${response.status}: ${text.slice(0, 300)}`,
                    retryable: response.status >= 500,
                });
            }
        }

        if (!response.ok) {
            const data = parsed as Partial<Extract<RunnerResponse<unknown>, { ok: false }>>;
            throw new RunnerDispatchError({
                code: data.code || "MCP_RUNTIME_UNAVAILABLE",
                message: data.message || `MCP runner returned ${response.status}`,
                credentialVars: data.credentialVars,
                retryable: data.retryable ?? response.status >= 500,
            });
        }
        return parsed;
    } catch (error) {
        if (error instanceof RunnerDispatchError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new RunnerDispatchError({
            code: "MCP_SPAWN_TIMEOUT",
            message: /abort/i.test(message) ? `MCP runner timed out after ${deadlineMs}ms` : message,
            retryable: true,
        });
    } finally {
        clearTimeout(timer);
    }
}

function unwrapRunner<T>(payload: unknown): T {
    const response = payload as { ok?: boolean };
    if (response && response.ok === true) return response as T;
    const failure = payload as Partial<{
        code: string;
        message: string;
        credentialVars: string[];
        retryable: boolean;
    }>;
    throw new RunnerDispatchError({
        code: failure?.code || "MCP_RUNTIME_UNAVAILABLE",
        message: failure?.message || "MCP runner failed",
        credentialVars: failure?.credentialVars,
        retryable: failure?.retryable,
    });
}

export async function listToolsViaRunner(
    env: Env,
    serverId: string,
    config: ServerSpawnConfig,
    input: { envProvided?: Record<string, string>; deadlineMs?: number } = {},
): Promise<{ tools: RunnerTool[]; transportUsed: string; credentialVars: string[] }> {
    return unwrapRunner(await fetchRunner(env, "/inspect", {
        serverId,
        config,
        envProvided: input.envProvided || {},
        deadlineMs: input.deadlineMs,
    }));
}

export async function callToolViaRunner(
    env: Env,
    serverId: string,
    config: ServerSpawnConfig,
    toolName: string,
    args: Record<string, unknown>,
    input: { envProvided?: Record<string, string>; deadlineMs?: number } = {},
): Promise<unknown> {
    const out = unwrapRunner<{ result: unknown }>(await fetchRunner(env, "/call", {
        serverId,
        config,
        toolName,
        args,
        envProvided: input.envProvided || {},
        deadlineMs: input.deadlineMs,
    }));
    return out.result;
}
