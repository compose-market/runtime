/**
 * Connectors HTTP client (runtime side).
 *
 * Auth: Authorization: Bearer ${RUNTIME_INTERNAL_SECRET} on every request.
 */

import {
    ConnectorsError,
    type CallRequest,
    type CallResponse,
    type ConnectorsEnvProvided,
    type ConnectorsIdentity,
    type ConnectorsToolListing,
    type InspectResult,
    type PluginInfo,
    type RuntimeStatus,
    type ServerSpawnConfig,
    type ToolExecutionResult,
    type ToolSchema,
} from "./types.js";
import { normalizeConnectorBinding } from "./bindings.js";
import { getAgentExecutionContext } from "../manowar/agent/context.js";
import { privateKeyToAccount } from "viem/accounts";

const REQUEST_TIMEOUT_MS = 60_000;
const DISCOVERY_TIMEOUT_MS = 10_000;

function requireConnectorsUrl(): string {
    const raw = process.env.CONNECTORS_URL;
    if (!raw) {
        throw new ConnectorsError(
            "MCP_RUNTIME_UNAVAILABLE",
            "CONNECTORS_URL environment variable is required",
            false,
            500,
        );
    }
    return raw.replace(/\/+$/, "");
}

function requireInternalSecret(): string {
    const value = process.env.RUNTIME_INTERNAL_SECRET;
    if (!value) {
        throw new ConnectorsError(
            "MCP_RUNTIME_UNAVAILABLE",
            "RUNTIME_INTERNAL_SECRET environment variable is required",
            false,
            500,
        );
    }
    return value;
}

interface BrokerErrorBody {
    error?: { code?: string; message?: string; retryable?: boolean };
    code?: string;
    message?: string;
    retryable?: boolean;
}

const ERROR_CODES = new Set<string>([
    "MCP_CONFIG_NOT_FOUND",
    "MCP_SPAWN_TIMEOUT",
    "MCP_SPAWN_FAILED",
    "MCP_SESSION_NOT_FOUND",
    "MCP_SESSION_INVALID",
    "MCP_TOOL_FAILED",
    "MCP_RUNTIME_UNAVAILABLE",
    "CREDENTIALS_REQUIRED",
    "TOOL_VALIDATION",
    "SERVER_QUARANTINED",
    "RATE_LIMITED",
    "DEADLINE_EXCEEDED",
]);

function classifyHttpFailure(status: number, body: BrokerErrorBody): ConnectorsError {
    const envelope = body.error || body;
    const candidate = typeof envelope.code === "string" ? envelope.code : "";
    const code = ERROR_CODES.has(candidate)
        ? (candidate as ConnectorsError["code"])
        : status === 404 ? "MCP_CONFIG_NOT_FOUND"
            : status === 408 ? "MCP_SPAWN_TIMEOUT"
                : status === 401 || status === 403 ? "MCP_RUNTIME_UNAVAILABLE"
                    : status === 503 ? "MCP_RUNTIME_UNAVAILABLE"
                        : status >= 500 ? "MCP_SPAWN_FAILED"
                            : "MCP_TOOL_FAILED";
    const message = typeof envelope.message === "string" && envelope.message.length > 0
        ? envelope.message
        : `connectors broker returned status ${status}`;
    const retryable = typeof envelope.retryable === "boolean"
        ? envelope.retryable
        : (status === 429 || status === 503 || status === 504 || status === 408);
    return new ConnectorsError(code, message, retryable, status);
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new ConnectorsError(
                "MCP_SPAWN_TIMEOUT",
                `${label} timed out after ${ms}ms`,
                true,
                504,
            ));
        }, ms);
        p.then((v) => { clearTimeout(timer); resolve(v); })
            .catch((e) => { clearTimeout(timer); reject(e); });
    });
}

async function request<T>(
    method: "GET" | "POST",
    pathname: string,
    body: unknown | undefined,
    timeoutMs: number,
): Promise<T> {
    const base = requireConnectorsUrl();
    const secret = requireInternalSecret();
    const init: RequestInit = {
        method,
        headers: {
            "Accept": "application/json",
            "Authorization": `Bearer ${secret}`,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    };

    let response: Response;
    try {
        response = await withTimeout(
            fetch(`${base}${pathname}`, init),
            timeoutMs,
            `${method} ${pathname}`,
        );
    } catch (error) {
        if (error instanceof ConnectorsError) throw error;
        throw new ConnectorsError(
            "MCP_RUNTIME_UNAVAILABLE",
            `connectors network error on ${method} ${pathname}: ${error instanceof Error ? error.message : String(error)}`,
            true,
            503,
        );
    }

    const text = await response.text();
    let parsed: unknown;
    if (text.length === 0) {
        parsed = {};
    } else {
        try {
            parsed = JSON.parse(text);
        } catch {
            if (!response.ok) {
                throw new ConnectorsError(
                    "MCP_SPAWN_FAILED",
                    `connectors returned non-JSON status ${response.status}: ${text.slice(0, 200)}`,
                    response.status >= 500,
                    response.status,
                );
            }
            throw new ConnectorsError(
                "MCP_TOOL_FAILED",
                `connectors returned non-JSON success body on ${pathname}`,
                false,
                502,
            );
        }
    }

    if (!response.ok) {
        throw classifyHttpFailure(response.status, parsed as BrokerErrorBody);
    }
    return parsed as T;
}

function readIdentityFromContext(): ConnectorsIdentity {
    const ctx = getAgentExecutionContext();
    if (!ctx) return {};
    return {
        mode: ctx.mode,
        composeRunId: ctx.composeRunId,
        threadId: ctx.threadId,
        agentWallet: ctx.agentWallet,
        userAddress: ctx.userAddress,
        workflowWallet: ctx.workflowWallet,
        haiId: ctx.haiId,
    };
}

// ─── Tools catalog surface ────────────────────────────────────────────────

/**
 * List the tools exposed by a tools connector.
 */
export async function getServerTools(serverId: string): Promise<ConnectorsToolListing> {
    const binding = normalizeConnectorBinding(serverId, { defaultOrigin: "tools" });
    return await request<ConnectorsToolListing>(
        "GET",
        `/tools/${encodeURIComponent(binding.slug)}/tools`,
        undefined,
        DISCOVERY_TIMEOUT_MS,
    );
}

/**
 * Execute a tools connector tool.
 *
 * The result is the unwrapped tool output; on credentials-required, throws a
 * ConnectorsError with code CREDENTIALS_REQUIRED whose message starts with
 * "MCP credentials required:" so the LLM-loop circuit breaker
 * (tools.ts:506-517 isRetryableToolFailure) does not blacklist the tool.
 */
export async function executeServerTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    options: { envProvided?: ConnectorsEnvProvided; identity?: ConnectorsIdentity; deadlineMs?: number } = {},
): Promise<unknown> {
    const binding = normalizeConnectorBinding(serverId, { defaultOrigin: "tools" });
    const identity = options.identity || readIdentityFromContext();
    const body: CallRequest = {
        args,
        identity,
        envProvided: options.envProvided,
        deadlineMs: options.deadlineMs,
    };
    const response = await request<CallResponse>(
        "POST",
        `/tools/${encodeURIComponent(binding.slug)}/execute/${encodeURIComponent(toolName)}`,
        body,
        REQUEST_TIMEOUT_MS,
    );
    if (response.ok) return response.result;
    if (response.kind === "CREDENTIALS_REQUIRED") {
        const vars = response.missing.map((m) => m.varName).join(", ");
        throw new ConnectorsError(
            "CREDENTIALS_REQUIRED",
            `MCP credentials required: ${vars}. Ask the user to add these credentials in Backpack before retrying.`,
            false,
            401,
            { missing: response.missing, serverId: response.serverId },
        );
    }
    throw new ConnectorsError(
        response.kind,
        response.message,
        response.retryable,
        500,
        { transport: response.transport, retriesAttempted: response.retriesAttempted },
    );
}

/**
 * Inspect candidate spawn configs once and report which transport works.
 */
export async function inspectServer(
    serverId: string,
    candidates: ServerSpawnConfig[],
): Promise<InspectResult> {
    const binding = normalizeConnectorBinding(serverId, { defaultOrigin: "tools" });
    return await request<InspectResult>(
        "POST",
        `/tools/${encodeURIComponent(binding.slug)}/inspect`,
        { candidates },
        REQUEST_TIMEOUT_MS,
    );
}

// ─── Onchain public surface ───────────────────────────────────────────────

export async function getRuntimeStatus(): Promise<RuntimeStatus> {
    const data = await request<{ plugins: PluginInfo[]; status: RuntimeStatus }>(
        "GET",
        "/onchain",
        undefined,
        REQUEST_TIMEOUT_MS,
    );
    return data.status;
}

/**
 * Cheap synchronous-style snapshot for /status health probe in
 * runtime/src/server.ts:779. Locally derived from env, no network call.
 */
export function peekRuntimeStatus(): RuntimeStatus {
    const walletAddress = getWalletAddress();
    const useMainnet = process.env.USE_MAINNET === "true";
    const broker = process.env.CONNECTORS_URL;
    return {
        initialized: Boolean(broker),
        walletAddress,
        chain: useMainnet ? "Avalanche" : "Avalanche Fuji",
        chainId: useMainnet ? 43114 : 43113,
        rpcUrl: process.env.AVALANCHE_FUJI_RPC || null,
        error: broker ? null : "CONNECTORS_URL not configured",
        plugins: [],
        totalTools: 0,
    };
}

export async function listPlugins(): Promise<PluginInfo[]> {
    const data = await request<{ plugins: PluginInfo[]; status: RuntimeStatus }>(
        "GET",
        "/onchain",
        undefined,
        REQUEST_TIMEOUT_MS,
    );
    return data.plugins || [];
}

export async function getPlugin(pluginId: string): Promise<PluginInfo | null> {
    const binding = normalizeConnectorBinding(pluginId, { defaultOrigin: "onchain" });
    try {
        return await request<PluginInfo>(
            "GET",
            `/onchain/${encodeURIComponent(binding.slug)}`,
            undefined,
            REQUEST_TIMEOUT_MS,
        );
    } catch (error) {
        if (error instanceof ConnectorsError && error.code === "MCP_CONFIG_NOT_FOUND") {
            return null;
        }
        throw error;
    }
}

export async function getPluginTools(pluginId: string): Promise<ToolSchema[]> {
    const plugin = await getPlugin(pluginId);
    return plugin?.tools || [];
}

export async function listAllTools(): Promise<ToolSchema[]> {
    const plugins = await listPlugins();
    const out: ToolSchema[] = [];
    for (const p of plugins) {
        for (const t of p.tools || []) out.push(t);
    }
    return out;
}

export async function getTool(toolName: string): Promise<ToolSchema | null> {
    const plugins = await listPlugins();
    for (const p of plugins) {
        const t = (p.tools || []).find((x) => x.name === toolName);
        if (t) return t;
    }
    return null;
}

export async function hasTool(toolName: string): Promise<boolean> {
    return (await getTool(toolName)) !== null;
}

export async function executeGoatTool(
    pluginId: string,
    toolName: string,
    args: Record<string, unknown>,
    options: { envProvided?: ConnectorsEnvProvided; identity?: ConnectorsIdentity; deadlineMs?: number } = {},
): Promise<ToolExecutionResult> {
    const binding = normalizeConnectorBinding(pluginId, { defaultOrigin: "onchain" });
    const identity = options.identity || readIdentityFromContext();
    const body: CallRequest = {
        args,
        identity,
        envProvided: options.envProvided,
        deadlineMs: options.deadlineMs,
    };
    try {
        const response = await request<CallResponse>(
            "POST",
            `/onchain/${encodeURIComponent(binding.slug)}/execute/${encodeURIComponent(toolName)}`,
            body,
            REQUEST_TIMEOUT_MS,
        );
        if (response.ok) {
            const result = response.result as { result?: unknown; txHash?: string; gasUsed?: string } | unknown;
            if (result && typeof result === "object" && "result" in result) {
                const wrapped = result as { result?: unknown; txHash?: string; gasUsed?: string };
                return {
                    success: true,
                    result: wrapped.result,
                    txHash: wrapped.txHash,
                    gasUsed: wrapped.gasUsed,
                };
            }
            return { success: true, result };
        }
        if (response.kind === "CREDENTIALS_REQUIRED") {
            const vars = response.missing.map((m) => m.varName).join(", ");
            return { success: false, error: `Onchain credentials required: ${vars}` };
        }
        return { success: false, error: response.message };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Returns the public address of the treasury signing wallet.
 * Address derivation is local from runtime/.env keys; the private key
 * remains on the runtime side for response fields.
 */
export function getWalletAddress(): string | null {
    const key = (
        process.env.TREASURY_WALLET_PRIVATE ||
        process.env.TREASURY_SERVER_WALLET_PRIVATE ||
        process.env.SERVER_PRIVATE_KEY
    );
    if (!key) return cachedWalletAddress;
    if (cachedWalletKey === key && cachedWalletAddress) return cachedWalletAddress;
    try {
        const normalized = (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`;
        const account = privateKeyToAccount(normalized);
        cachedWalletKey = key;
        cachedWalletAddress = account.address;
        return cachedWalletAddress;
    } catch {
        return null;
    }
}

let cachedWalletKey: string | null = null;
let cachedWalletAddress: string | null = null;

export async function getPluginIds(): Promise<string[]> {
    const plugins = await listPlugins();
    return plugins.map((p) => p.id);
}

export type {
    ConnectorsToolDescriptor,
    ConnectorsToolListing,
    ConnectorsIdentity,
    ConnectorsEnvProvided,
    ServerSpawnConfig,
    InspectResult,
    PluginInfo,
    RuntimeStatus,
    ToolSchema,
    ToolExecutionResult,
} from "./types.js";

export { ConnectorsError } from "./types.js";
export type { ConnectorsErrorCode } from "./types.js";
