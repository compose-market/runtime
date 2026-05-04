/**
 * Connectors — typed contracts.
 *
 * Identity primitives are imported from the existing manowar surface; this
 * module does NOT define new identity types. Tool-execution shapes mirror
 * what runtime/src/manowar/agent/tools.ts and runtime/src/temporal/activities.ts
 * already pass.
 */

import type { AgentExecutionContext } from "../manowar/agent/context.js";
import type { ResolvedMemoryScope } from "../manowar/agent/memory-scope.js";

export type ConnectorOrigin = "tools" | "onchain";

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

export class ConnectorsError extends Error {
    code: ConnectorsErrorCode;
    retryable: boolean;
    statusCode: number;
    details?: Record<string, unknown>;

    constructor(
        code: ConnectorsErrorCode,
        message: string,
        retryable: boolean,
        statusCode = 500,
        details?: Record<string, unknown>,
    ) {
        super(message);
        this.name = "ConnectorsError";
        this.code = code;
        this.retryable = retryable;
        this.statusCode = statusCode;
        this.details = details;
    }
}

export interface ServerSpawnConfig {
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

export interface ConnectorsToolDescriptor {
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
}

/**
 * Public response from /tools/:slug catalog reads and from the runtime's
 * getServerTools() adapter.
 */
export interface ConnectorsToolListing {
    serverId: string;
    sessionId: string;
    cached: boolean;
    toolCount: number;
    tools: ConnectorsToolDescriptor[];
}

/**
 * Identity envelope on every broker call. Reuses existing manowar fields
 * verbatim — no new identity is introduced.
 *
 * Sourced at runtime from getAgentExecutionContext()
 * (runtime/src/manowar/agent/context.ts) when present.
 */
export interface ConnectorsIdentity {
    agentWallet?: AgentExecutionContext["agentWallet"];
    composeRunId?: AgentExecutionContext["composeRunId"];
    threadId?: AgentExecutionContext["threadId"];
    userAddress?: AgentExecutionContext["userAddress"];
    workflowWallet?: AgentExecutionContext["workflowWallet"];
    haiId?: AgentExecutionContext["haiId"];
    mode?: AgentExecutionContext["mode"];
}

export type ConnectorsEnvProvided = Record<string, string>;

/** Body of POST /<group>/:slug/execute/:tool. Tool name is in the URL. */
export interface CallRequest {
    args: Record<string, unknown>;
    identity?: ConnectorsIdentity;
    envProvided?: ConnectorsEnvProvided;
    deadlineMs?: number;
}

export interface CallSuccess {
    ok: true;
    result: unknown;
    transportUsed: string;
    latencyMs: number;
}

export interface CallCredentialsRequired {
    ok: false;
    kind: "CREDENTIALS_REQUIRED";
    serverId: string;
    missing: Array<{ varName: string; description?: string; obtainUrl?: string }>;
    retryToken?: string;
}

export interface CallTypedFailure {
    ok: false;
    kind: Exclude<ConnectorsErrorCode, "CREDENTIALS_REQUIRED">;
    message: string;
    retryable: boolean;
    transport?: string;
    retriesAttempted?: number;
}

export type CallResponse = CallSuccess | CallCredentialsRequired | CallTypedFailure;

// ─── Onchain connector shapes ─────────────────────────────────────────────

export interface ToolSchema {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    pluginId: string;
}

export interface PluginInfo {
    id: string;
    name: string;
    description: string;
    toolCount: number;
    tools: ToolSchema[];
    requiresApiKey?: boolean;
    apiKeyConfigured?: boolean;
}

export interface RuntimeStatus {
    initialized: boolean;
    walletAddress: string | null;
    chain: string;
    chainId: number;
    rpcUrl: string | null;
    error: string | null;
    plugins: PluginInfo[];
    totalTools: number;
}

export interface ToolExecutionResult {
    success: boolean;
    result?: unknown;
    error?: string;
    txHash?: string;
    gasUsed?: string;
}

// Inspect endpoint shapes preserved from runtime/src/server.ts:961-1053.

export interface InspectCandidateError {
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
    errors: InspectCandidateError[];
}

export type InspectResult = InspectSuccess | InspectFailure;

// ─── Catalog rows (D1) ────────────────────────────────────────────────────

export interface CatalogServerRow {
    slug: string;
    origin: ConnectorOrigin;
    name: string;
    namespace: string;
    description: string;
    tags: string[];
    category: string | null;
    repoUrl: string | null;
    image: string | null;
    status: "live" | "credential_gated" | "inspecting" | "verified" | "metadata_reviewed" | "embedded" | "shadowed" | "quarantined" | "deprecated";
    statefulness: "stateless" | "stateful" | "unknown";
    cardVersion: string;
    compiledAt: string;
    inspectedAt: string | null;
}

export interface CatalogTransportRow {
    serverSlug: string;
    kind: "stdio" | "http" | "docker" | "npx" | "goat-plugin";
    package: string | null;
    image: string | null;
    remoteUrl: string | null;
    protocol: "sse" | "streamable-http" | null;
    portObserved: number | null;
    cmdArgs: string[];
    envRequired: string[];
    envOptional: string[];
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    failureStreak: number;
    medianLatencyMs: number | null;
    priority: number;
}

export interface CatalogToolRow {
    serverSlug: string;
    name: string;
    description: string | null;
    inputSchema: Record<string, unknown>;
    embeddingId: string | null;
    lastSeenAt: string;
    cardVersion: string;
}

export interface CatalogCredentialRow {
    serverSlug: string;
    varName: string;
    description: string | null;
    obtainUrl: string | null;
    evidenceKey: string | null;
}

export interface CatalogHealthRow {
    serverSlug: string;
    transportKind: string;
    bucketAt: string;
    outcome: "ok" | "fail_transport" | "fail_creds" | "fail_tool" | "fail_timeout";
    latencyMs: number;
}

export type { AgentExecutionContext, ResolvedMemoryScope };
