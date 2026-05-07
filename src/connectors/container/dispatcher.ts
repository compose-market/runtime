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
import type { RunnerProfile } from "../workflows/attempts.js";

export interface RunnerTool {
    name: string;
    description?: string | null;
    inputSchema?: Record<string, unknown>;
}

export interface RunnerServerMetadata {
    name?: string;
    slug?: string;
    title?: string;
    version?: string;
    [key: string]: unknown;
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

function runnerBinding(env: Env, profile: RunnerProfile): { binding: unknown; instances: number } | null {
    if (profile === "lite" && env.MCP_RUNNER) {
        return { binding: env.MCP_RUNNER, instances: parseRunnerInstances(env.MCP_RUNNER_INSTANCES, 32) };
    }
    if (profile === "basic" && env.MCP_RUNNER_BASIC) {
        return { binding: env.MCP_RUNNER_BASIC, instances: parseRunnerInstances(env.MCP_RUNNER_BASIC_INSTANCES, 16) };
    }
    if (profile === "standard-1" && env.MCP_RUNNER_STANDARD_1) {
        return { binding: env.MCP_RUNNER_STANDARD_1, instances: parseRunnerInstances(env.MCP_RUNNER_STANDARD_1_INSTANCES, 8) };
    }
    if (profile === "standard-2" && env.MCP_RUNNER_STANDARD_2) {
        return { binding: env.MCP_RUNNER_STANDARD_2, instances: parseRunnerInstances(env.MCP_RUNNER_STANDARD_2_INSTANCES, 4) };
    }
    return null;
}

function parseRunnerInstances(value: string | undefined, fallback: number): number {
    return Math.max(1, Math.min(parseInt(value || String(fallback), 10) || fallback, 256));
}

function requestedProfile(body: Record<string, unknown>): RunnerProfile {
    const value = String(body.runnerProfile || "lite");
    return value === "basic" || value === "standard-1" || value === "standard-2" ? value : "lite";
}

async function fetchRunner(env: Env, path: "/inspect" | "/call", body: Record<string, unknown>): Promise<unknown> {
    const deadlineMs = Math.max(5_000, Math.min(Number(body.deadlineMs || 60_000), 120_000));
    const runnerProfile = requestedProfile(body);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs + 5_000);
    const init: RequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
    };
    const request = new Request(`https://mcp-runner.internal${path}`, init);
    let shutdown: (() => Promise<void>) | null = null;

    try {
        let response: Response;
        const binding = runnerBinding(env, runnerProfile);
        if (binding) {
            const stub = await getRandom(binding.binding as any, binding.instances);
            if (env.MCP_RUNNER_SHUTDOWN_AFTER_REQUEST !== "false") {
                shutdown = () => requestShutdown(stub, "https://mcp-runner.internal");
            }
            response = await stub.fetch(request);
        } else if (env.MCP_RUNNER_URL) {
            const base = env.MCP_RUNNER_URL.replace(/\/+$/, "");
            if (env.MCP_RUNNER_SHUTDOWN_AFTER_REQUEST === "true") {
                shutdown = () => requestShutdown({ fetch }, base);
            }
            response = await fetch(`${base}${path}`, init);
        } else {
            throw new RunnerDispatchError({
                code: "MCP_RUNTIME_UNAVAILABLE",
                message: `MCP runner profile ${runnerProfile} is not configured`,
                retryable: false,
            });
        }

        const text = await response.text();
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
        if (shutdown) await shutdown();
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
    input: { envProvided?: Record<string, string>; deadlineMs?: number; runnerProfile?: string | null } = {},
): Promise<{ tools: RunnerTool[]; transportUsed: string; credentialVars: string[]; serverInfo?: RunnerServerMetadata | null }> {
    return unwrapRunner(await fetchRunner(env, "/inspect", {
        serverId,
        config,
        envProvided: input.envProvided || {},
        deadlineMs: input.deadlineMs,
        runnerProfile: input.runnerProfile,
    }));
}

export async function callToolViaRunner(
    env: Env,
    serverId: string,
    config: ServerSpawnConfig,
    toolName: string,
    args: Record<string, unknown>,
    input: { envProvided?: Record<string, string>; deadlineMs?: number; runnerProfile?: string | null } = {},
): Promise<unknown> {
    const out = unwrapRunner<{ result: unknown }>(await fetchRunner(env, "/call", {
        serverId,
        config,
        toolName,
        args,
        envProvided: input.envProvided || {},
        deadlineMs: input.deadlineMs,
        runnerProfile: input.runnerProfile,
    }));
    return out.result;
}
