/**
 * Agent Tool Factories
 * 
 * Creates LangChain tools from the in-process GOAT and MCP runtimes.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { ComposeTool } from "../../types.js";
import type { AgentWallet } from "../../agent-wallet.js";
import { getAgentExecutionContext } from "./context.js";
import { searchKnowledge } from "../knowledge/index.js";
import { addMemory, searchMemory, searchMemoryLayers } from "../memory/index.js";
import { shouldEnforceCloudPermissions } from "../mode.js";
import { isLocalMeshPublicationAvailable, queueLocalMeshPublication } from "../../mesh/publication-queue.js";
import { resolveLocalBaseDir, writeLocalSkillDocument } from "../../mesh/workspace.js";
import { executeGoatTool, getPlugin } from "../../mcps/goat.js";
import { executeServerTool, getServerTools } from "../../mcps/mcp.js";
import {
    buildApiInternalHeaders,
    requireApiInternalUrl,
} from "../../auth.js";

interface ToolExecutionContext {
    getComposeRunId?: () => string | undefined;
    getThreadId?: () => string | undefined;
}

type CloudPermissionKey =
    | "filesystem"
    | "camera"
    | "microphone"
    | "geolocation"
    | "clipboard"
    | "notifications";

type BackpackConnectedAccount = {
    slug: string;
    name: string;
    connected: boolean;
    accountId?: string;
    status?: string;
};
type AgentSessionContext = {
    sessionActive: boolean;
    sessionBudgetRemaining: number;
    sessionGrants?: string[];
    cloudPermissions?: string[];
    backpackAccounts?: BackpackConnectedAccount[];
};
type SessionContextProvider = AgentSessionContext | (() => AgentSessionContext | undefined) | undefined;

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const TOOL_RETRY_MAX_ATTEMPTS = 3;
const TOOL_RETRY_INITIAL_MS = 300;
const TOOL_RETRY_MAX_MS = 2000;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeBackoffDelayMs(attempt: number): number {
    const exponential = Math.min(
        TOOL_RETRY_MAX_MS,
        TOOL_RETRY_INITIAL_MS * Math.pow(2, Math.max(0, attempt - 1)),
    );
    const jitter = Math.floor(Math.random() * 200);
    return exponential + jitter;
}

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= TOOL_RETRY_MAX_ATTEMPTS; attempt += 1) {
        try {
            const response = await fetch(url, init);
            if (!RETRYABLE_STATUSES.has(response.status) || attempt === TOOL_RETRY_MAX_ATTEMPTS) {
                return response;
            }
        } catch (error) {
            lastError = error;
            if (attempt === TOOL_RETRY_MAX_ATTEMPTS) {
                throw error;
            }
        }
        await sleep(computeBackoffDelayMs(attempt));
    }

    throw (lastError instanceof Error ? lastError : new Error("Tool request failed after retries"));
}

function resolveSessionContext(input: SessionContextProvider): AgentSessionContext | undefined {
    if (typeof input === "function") {
        return input();
    }
    return input;
}

function createKnowledgeTools(input: {
    agentWallet?: AgentWallet;
    userAddress?: string;
}): DynamicStructuredTool[] {
    if (!input.agentWallet) {
        return [];
    }

    return [
        new DynamicStructuredTool({
            name: "search_knowledge",
            description: "Search the agent identity knowledge from the creator and, when a user is present, the private workspace knowledge for this specific user-agent pair. This does not inject documents by default; use it only when you need reference material.",
            schema: z.object({
                query: z.string().min(1).describe("Knowledge question or retrieval query"),
                scope: z.enum(["identity", "workspace", "all"]).optional().describe("Limit search to creator identity knowledge, private workspace knowledge, or both"),
                limit: z.number().int().min(1).max(8).optional().describe("Maximum number of knowledge hits to return"),
            }),
            func: async ({ query, scope, limit }: {
                query: string;
                scope?: "identity" | "workspace" | "all";
                limit?: number;
            }) => {
                const results = await searchKnowledge({
                    agentWallet: input.agentWallet!.address,
                    userAddress: input.userAddress,
                    query,
                    scope,
                    limit,
                });
                if (results.length === 0) {
                    return "No relevant knowledge found.";
                }

                return results
                    .map((item) => `[Knowledge ${item.scope} | score=${item.score.toFixed(2)}]\n${item.content}`)
                    .join("\n\n");
            },
        }),
    ];
}

// =============================================================================
// Failed Tool Tracking
// =============================================================================

interface FailedTool {
    failures: number;
    lastFailure: Date;
    reason: string;
}

// Cache of tools that have failed - prevents LLM from repeatedly trying broken tools
const failedTools = new Map<string, FailedTool>();
const TOOL_FAILURE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_TOOL_FAILURES = 2;

function markToolFailed(toolKey: string, reason: string): void {
    const existing = failedTools.get(toolKey);
    const now = new Date();

    if (existing && (now.getTime() - existing.lastFailure.getTime() < TOOL_FAILURE_TTL_MS)) {
        failedTools.set(toolKey, { failures: existing.failures + 1, lastFailure: now, reason });
    } else {
        failedTools.set(toolKey, { failures: 1, lastFailure: now, reason });
    }
}

function isToolFailed(toolKey: string): { failed: boolean; reason?: string } {
    const entry = failedTools.get(toolKey);
    if (!entry) return { failed: false };

    // Clear stale entries
    if (Date.now() - entry.lastFailure.getTime() > TOOL_FAILURE_TTL_MS) {
        failedTools.delete(toolKey);
        return { failed: false };
    }

    if (entry.failures >= MAX_TOOL_FAILURES) {
        return { failed: true, reason: entry.reason };
    }
    return { failed: false };
}

function clearToolFailure(toolKey: string): void {
    if (failedTools.has(toolKey)) {
        failedTools.delete(toolKey);
    }
}

function normalizeGrantedPermissions(values: string[] | undefined): Set<string> {
    return new Set((values || []).map((value) => value.trim().toLowerCase()).filter(Boolean));
}

function isCloudPermissionKey(value: string): value is CloudPermissionKey {
    return value === "filesystem"
        || value === "camera"
        || value === "microphone"
        || value === "geolocation"
        || value === "clipboard"
        || value === "notifications";
}

function resolveToolPermissions(toolName: string, toolDescription?: string): CloudPermissionKey[] {
    const inferredConsent = inferConsentFromToolSemantics(toolName, toolDescription);
    if (inferredConsent && isCloudPermissionKey(inferredConsent)) {
        return [inferredConsent];
    }

    return [];
}

function buildConsentRequiredError(permission: CloudPermissionKey): Error {
    return new Error(JSON.stringify({
        code: "CONSENT_REQUIRED",
        consentType: permission,
        message: `Permission denied for ${permission} access. This feature requires your consent.`,
    }));
}

async function fetchBackpackPermissions(userAddress: string): Promise<CloudPermissionKey[]> {
    const response = await fetchWithRetry(
        `${requireApiInternalUrl()}/api/backpack/permissions?userAddress=${encodeURIComponent(userAddress)}`,
        {
            headers: buildApiInternalHeaders(),
        },
    );

    if (!response.ok) {
        throw new Error(`Failed to load Backpack permissions (${response.status})`);
    }

    const payload = await response.json() as {
        permissions?: Array<{ consentType?: string; granted?: boolean }>;
    };

    if (!Array.isArray(payload.permissions)) {
        return [];
    }

    return payload.permissions
        .filter((permission) => permission.granted && typeof permission.consentType === "string" && isCloudPermissionKey(permission.consentType))
        .map((permission) => permission.consentType as CloudPermissionKey);
}

async function enforceToolPermissions(input: {
    toolName: string;
    toolDescription?: string;
    cloudPermissions?: string[];
    userAddress?: string;
}): Promise<void> {
    if (!shouldEnforceCloudPermissions()) {
        return;
    }

    const required = resolveToolPermissions(input.toolName, input.toolDescription);
    if (required.length === 0) {
        return;
    }

    const availablePermissions = input.cloudPermissions || (input.userAddress ? await fetchBackpackPermissions(input.userAddress) : []);
    const grants = normalizeGrantedPermissions(availablePermissions);

    for (const permission of required) {
        if (!grants.has(permission)) {
            throw buildConsentRequiredError(permission);
        }
    }
}

function isRetryableToolFailure(status: number, errorText: string): boolean {
    if (RETRYABLE_STATUSES.has(status)) {
        return true;
    }
    const normalized = errorText.toLowerCase();
    return (
        normalized.includes("temporarily unavailable") ||
        normalized.includes("timeout") ||
        normalized.includes("network") ||
        normalized.includes("spawn")
    );
}

// =============================================================================
// Dynamic Consent Detection
// =============================================================================

function inferConsentFromError(errorText: string): string | null {
    const lowerError = errorText.toLowerCase();

    if (lowerError.includes("eacces") ||
        lowerError.includes("permission denied") ||
        lowerError.includes("file") && (lowerError.includes("access") || lowerError.includes("read") || lowerError.includes("write")) ||
        lowerError.includes("directory") ||
        lowerError.includes("filesystem")) {
        return "filesystem";
    }

    if (lowerError.includes("camera") ||
        lowerError.includes("video") && lowerError.includes("capture") ||
        lowerError.includes("notreadableerror") && lowerError.includes("video")) {
        return "camera";
    }

    if (lowerError.includes("microphone") ||
        lowerError.includes("audio") && lowerError.includes("recording") ||
        lowerError.includes("notreadableerror") && lowerError.includes("audio")) {
        return "microphone";
    }

    if (lowerError.includes("geolocation") ||
        lowerError.includes("location") && lowerError.includes("denied") ||
        lowerError.includes("gps")) {
        return "geolocation";
    }

    if (lowerError.includes("clipboard") && lowerError.includes("denied")) {
        return "clipboard";
    }

    return null;
}

function inferConsentFromToolSemantics(toolName: string, toolDescription?: string): string | null {
    const text = `${toolName} ${toolDescription || ""}`.toLowerCase();

    if (text.includes("file") || text.includes("directory") || text.includes("folder") || text.includes("read_") || text.includes("write_") || text.includes("list_dir")) {
        return "filesystem";
    }
    if (text.includes("camera") || text.includes("photo") || text.includes("video") && text.includes("capture")) {
        return "camera";
    }
    if (text.includes("microphone") || text.includes("record") && text.includes("audio") || text.includes("voice")) {
        return "microphone";
    }
    if (text.includes("location") || text.includes("gps") || text.includes("coordinates")) {
        return "geolocation";
    }
    if (text.includes("clipboard") && (text.includes("paste") || text.includes("copy"))) {
        return "clipboard";
    }
    if (text.includes("notification") || text.includes("notify") || text.includes("alert")) {
        return "notifications";
    }

    return null;
}


// =============================================================================
// Helper: Schema Conversion
// =============================================================================

function createZodSchema(jsonSchema: Record<string, unknown>): z.ZodObject<any> {
    const properties = (jsonSchema.properties || {}) as Record<string, any>;
    const required = (jsonSchema.required || []) as string[];
    const shape: Record<string, z.ZodTypeAny> = {};

    for (const [key, prop] of Object.entries(properties)) {
        let zodType: z.ZodTypeAny;
        switch (prop.type) {
            case "string": zodType = z.string().describe(prop.description || key); break;
            case "number": case "integer": zodType = z.number().describe(prop.description || key); break;
            case "boolean": zodType = z.boolean().describe(prop.description || key); break;
            case "array": zodType = z.array(z.any()).describe(prop.description || key); break;
            case "object": zodType = z.object({}).passthrough().describe(prop.description || key); break;
            default: zodType = z.any().describe(prop.description || key);
        }
        if (!required.includes(key)) zodType = zodType.optional();
        shape[key] = zodType;
    }
    return z.object(shape);
}

function sanitizeToolName(name: string): string {
    const sanitized = name.replace(/[^a-zA-Z0-9_]/g, "_");
    return sanitized.length > 0 ? sanitized : "tool";
}

function reserveToolName(baseName: string, usedNames: Set<string>): string {
    const candidate = sanitizeToolName(baseName);
    if (!usedNames.has(candidate)) {
        usedNames.add(candidate);
        return candidate;
    }

    let suffix = 2;
    while (usedNames.has(`${candidate}_${suffix}`)) {
        suffix += 1;
    }
    const unique = `${candidate}_${suffix}`;
    usedNames.add(unique);
    return unique;
}

// =============================================================================
// Tool Creation from MCP Service
// =============================================================================

/**
 * Create tools for agent from plugin IDs by calling MCP service
 * 
 * @param pluginIds Plugin IDs to load (e.g. ["goat:coingecko", "mcp:github"])
 * @param agentWallet Agent wallet context
 * @param sessionContext Session context for payment headers
 * @param executionContext Optional run context for correlation headers
 * @returns Array of LangChain DynamicStructuredTool instances
 */
export async function createAgentTools(
    pluginIds: string[],
    agentWallet?: AgentWallet,
    sessionContext?: SessionContextProvider,
    executionContext?: ToolExecutionContext,
    chainId?: number,
    userAddress?: string,
): Promise<DynamicStructuredTool[]> {
    const tools: DynamicStructuredTool[] = [];
    const usedToolNames = new Set<string>();

    for (const tool of createMeshPublicationTools({ agentWallet, sessionContext })) {
        tools.push(tool);
        usedToolNames.add(tool.name);
    }

    for (const tool of createKnowledgeTools({ agentWallet, userAddress })) {
        tools.push(tool);
        usedToolNames.add(tool.name);
    }

    for (const tool of createLocalSkillTools({ agentWallet, sessionContext })) {
        tools.push(tool);
        usedToolNames.add(tool.name);
    }

    if (userAddress) {
        for (const tool of createBackpackTools({ userAddress, sessionContext, executionContext })) {
            tools.push(tool);
            usedToolNames.add(tool.name);
        }
    }

    if (!pluginIds || pluginIds.length === 0) {
        return tools;
    }

    for (const pluginId of pluginIds) {
        try {
            // Normalize plugin ID to extract source and ID
            // Supports: "goat-coingecko", "goat:coingecko", "goat:goat-coingecko", "coingecko"
            //           "mcp-github", "mcp:github", "github"
            let source = "goat"; // Default source
            let id = pluginId;

            // Strip ALL goat/mcp prefixes (handles double-prefix edge cases like "goat:goat-coingecko")
            // Keep stripping until no more prefixes found
            while (id.startsWith("goat-") || id.startsWith("goat:") ||
                id.startsWith("mcp-") || id.startsWith("mcp:")) {
                if (id.startsWith("goat-") || id.startsWith("goat:")) {
                    source = "goat";
                    id = id.replace(/^goat[-:]/, "");
                } else if (id.startsWith("mcp-") || id.startsWith("mcp:")) {
                    source = "mcp";
                    id = id.replace(/^mcp[-:]/, "");
                }
            }

            console.log(`[createAgentTools] Normalized "${pluginId}" → source="${source}", id="${id}"`);

            if (source === "goat") {
                const pluginData = await getPlugin(id);
                if (!pluginData) {
                    console.warn(`[createAgentTools] GOAT plugin ${id} not found`);
                    continue;
                }

                const pluginTools = pluginData.tools || [];

                // Create a LangChain tool for each GOAT tool
                for (const toolDef of pluginTools) {
                    const toolName = reserveToolName(toolDef.name, usedToolNames);
                    const tool = new DynamicStructuredTool({
                        name: toolName,
                        description: toolDef.description || `Execute ${toolDef.name}`,
                        schema: toolDef.parameters ? createZodSchema(toolDef.parameters) : z.object({}),
                        func: async (args: Record<string, unknown>) => {
                            const activeSessionContext = resolveSessionContext(sessionContext);
                            await enforceToolPermissions({
                                toolName: toolDef.name,
                                toolDescription: toolDef.description,
                                cloudPermissions: activeSessionContext?.cloudPermissions,
                                userAddress,
                            });

                            const result = await executeGoatTool(id, toolDef.name, args);
                            if (!result.success) {
                                throw new Error(
                                    `GOAT tool "${toolDef.name}" failed: ${result.error || "unknown error"}`,
                                );
                            }
                            return JSON.stringify(result.result);
                        },
                    });
                    tools.push(tool);
                }
            } else if (source === "mcp") {
                console.log(`[createAgentTools] Fetching tools for MCP server "${id}"`);

                // Add timeout to prevent indefinite blocking on spawn failures
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

                let serverData: Awaited<ReturnType<typeof getServerTools>>;
                try {
                    serverData = await Promise.race([
                        getServerTools(id),
                        new Promise<never>((_, reject) => {
                            controller.signal.addEventListener("abort", () => {
                                const error = new Error("MCP tools fetch aborted");
                                error.name = "AbortError";
                                reject(error);
                            });
                        }),
                    ]);
                } catch (err: any) {
                    if (err.name === 'AbortError') {
                        console.warn(`[createAgentTools] ✗ MCP server "${id}" timed out after 10s, skipping`);
                    } else {
                        console.warn(`[createAgentTools] ✗ MCP server "${id}" fetch failed:`, err.message);
                    }
                    continue; // Skip this server, don't fail entire agent
                } finally {
                    clearTimeout(timeoutId);
                }
                const serverTools = serverData.tools || [];

                if (serverTools.length === 0) {
                    console.warn(`[createAgentTools] ✗ MCP server "${id}" has no tools, skipping`);
                    continue;
                }

                console.log(`[createAgentTools] ✓ Found MCP server "${id}" with ${serverTools.length} tools`);

                for (const toolDef of serverTools) {
                    const toolName = reserveToolName(toolDef.name, usedToolNames);
                    const tool = new DynamicStructuredTool({
                        name: toolName,
                        description: toolDef.description || `Execute ${toolDef.name} on MCP server ${id}`,
                        schema: toolDef.inputSchema ? createZodSchema(toolDef.inputSchema) : z.object({}),
                        func: async (args: Record<string, unknown>) => {
                            const activeSessionContext = resolveSessionContext(sessionContext);
                            await enforceToolPermissions({
                                toolName: toolDef.name,
                                toolDescription: toolDef.description || `MCP tool on server ${id}`,
                                cloudPermissions: activeSessionContext?.cloudPermissions,
                                userAddress,
                            });

                            const toolKey = `${id}:${toolDef.name}`;

                            const failCheck = isToolFailed(toolKey);
                            if (failCheck.failed) {
                                throw new Error(
                                    `Tool "${toolDef.name}" is temporarily unavailable: ${failCheck.reason || "recent failures"}`,
                                );
                            }

                            console.log(`[MCP Tool] ${toolName} -> ${toolDef.name}(${JSON.stringify(args)})`);

                            try {
                                const result = await executeServerTool(id, toolDef.name, args);
                                clearToolFailure(toolKey);
                                return JSON.stringify(result);
                            } catch (err: any) {
                                const errorMessage = err instanceof Error ? err.message : String(err);
                                if (isRetryableToolFailure(503, errorMessage)) {
                                    markToolFailed(toolKey, errorMessage);
                                }
                                throw new Error(`MCP tool "${toolDef.name}" failed: ${errorMessage}`);
                            }
                        },
                    });
                    tools.push(tool);
                }
            }
        } catch (error) {
            console.error(`[createAgentTools] Failed to load plugin ${pluginId}:`, error);
        }
    }

    console.log(`[createAgentTools] Created ${tools.length} tools from ${pluginIds.length} plugins`);
    return tools;
}

async function fetchBackpackConnections(userAddress: string): Promise<BackpackConnectedAccount[]> {
    const response = await fetchWithRetry(
        `${requireApiInternalUrl()}/api/backpack/connections?userAddress=${encodeURIComponent(userAddress)}`,
        {
            headers: buildApiInternalHeaders(),
        },
    );

    if (!response.ok) {
        throw new Error(`Failed to load Backpack accounts (${response.status})`);
    }

    const payload = await response.json() as { connections?: BackpackConnectedAccount[] };
    return Array.isArray(payload.connections) ? payload.connections : [];
}

async function fetchBackpackToolkitActions(toolkit: string, limit = 40): Promise<Array<{
    slug: string;
    name: string;
    description: string;
    toolkitSlug: string;
    toolkitName: string;
    noAuth: boolean;
    scopes: string[];
    inputParameters: Record<string, unknown>;
}>> {
    const response = await fetchWithRetry(
        `${requireApiInternalUrl()}/api/backpack/toolkits/${encodeURIComponent(toolkit)}/actions?limit=${limit}`,
        {
            headers: buildApiInternalHeaders(),
        },
    );

    if (!response.ok) {
        throw new Error(`Failed to load Backpack actions for ${toolkit} (${response.status})`);
    }

    const payload = await response.json() as {
        actions?: Array<{
            slug: string;
            name: string;
            description: string;
            toolkitSlug: string;
            toolkitName: string;
            noAuth: boolean;
            scopes: string[];
            inputParameters: Record<string, unknown>;
        }>;
    };
    return Array.isArray(payload.actions) ? payload.actions : [];
}

async function executeBackpackAction(input: {
    userAddress: string;
    toolkit: string;
    action: string;
    params?: Record<string, unknown>;
    text?: string;
}): Promise<unknown> {
    const response = await fetchWithRetry(
        `${requireApiInternalUrl()}/api/backpack/execute`,
        {
            method: "POST",
            headers: buildApiInternalHeaders({
                "Content-Type": "application/json",
            }),
            body: JSON.stringify(input),
        },
    );

    const payload = await response.json().catch(async () => ({
        success: false,
        error: await response.text(),
    })) as { success?: boolean; result?: unknown; error?: string };

    if (!response.ok || !payload.success) {
        throw new Error(payload.error || `Backpack action failed (${response.status})`);
    }

    return payload.result;
}

function createBackpackTools(input: {
    userAddress: string;
    sessionContext?: SessionContextProvider;
    executionContext?: ToolExecutionContext;
}): DynamicStructuredTool[] {
    const listAccounts = new DynamicStructuredTool({
        name: "backpack_list_accounts",
        description: "List the user's connected Backpack accounts. Backpack accounts are authenticated user accounts and are distinct from MCP servers and distinct from skills.",
        schema: z.object({}),
        func: async () => {
            const activeSessionContext = resolveSessionContext(input.sessionContext);
            await enforceToolPermissions({
                toolName: "backpack_list_accounts",
                toolDescription: "List connected Backpack accounts",
                cloudPermissions: activeSessionContext?.cloudPermissions,
                userAddress: input.userAddress,
            });

            const accounts = activeSessionContext?.backpackAccounts || await fetchBackpackConnections(input.userAddress);
            if (accounts.length === 0) {
                return "No Backpack accounts are connected for this user.";
            }
            return JSON.stringify(accounts);
        },
    });

    const listActions = new DynamicStructuredTool({
        name: "backpack_list_actions",
        description: "List the available Backpack actions for a connected toolkit, including the exact action slugs to use when executing through that account.",
        schema: z.object({
            toolkit: z.string().describe("Toolkit slug, for example gmail, github, notion, or slack"),
            limit: z.number().int().min(1).max(100).optional(),
        }),
        func: async ({ toolkit, limit }: { toolkit: string; limit?: number }) => {
            const activeSessionContext = resolveSessionContext(input.sessionContext);
            await enforceToolPermissions({
                toolName: "backpack_list_actions",
                toolDescription: `List Backpack actions for ${toolkit}`,
                cloudPermissions: activeSessionContext?.cloudPermissions,
                userAddress: input.userAddress,
            });

            const actions = await fetchBackpackToolkitActions(toolkit, limit || 40);
            if (actions.length === 0) {
                return `No Backpack actions were found for toolkit "${toolkit}".`;
            }
            return JSON.stringify(actions);
        },
    });

    const executeAction = new DynamicStructuredTool({
        name: "backpack_execute_action",
        description: "Execute a Backpack action through one of the user's connected accounts. First inspect connected accounts and available actions, then call the exact action slug with structured params.",
        schema: z.object({
            toolkit: z.string().describe("Toolkit slug bound to the user's connected account"),
            action: z.string().describe("Exact Backpack action slug to execute"),
            params: z.object({}).passthrough().optional().describe("Structured action arguments"),
            text: z.string().optional().describe("Optional natural-language instruction for Composio input generation"),
        }),
        func: async ({ toolkit, action, params, text }: {
            toolkit: string;
            action: string;
            params?: Record<string, unknown>;
            text?: string;
        }) => {
            const activeSessionContext = resolveSessionContext(input.sessionContext);
            await enforceToolPermissions({
                toolName: action,
                toolDescription: `Execute Backpack action on ${toolkit}`,
                cloudPermissions: activeSessionContext?.cloudPermissions,
                userAddress: input.userAddress,
            });

            const accounts = activeSessionContext?.backpackAccounts || await fetchBackpackConnections(input.userAddress);
            const account = accounts.find((item) => item.slug === toolkit && item.connected);
            if (!account) {
                throw new Error(`No connected Backpack account found for toolkit "${toolkit}"`);
            }

            const result = await executeBackpackAction({
                userAddress: input.userAddress,
                toolkit,
                action,
                params,
                text,
            });

            return JSON.stringify(result);
        },
    });

    return [listAccounts, listActions, executeAction];
}

// =============================================================================
// Mem0 / Built-in Tools
// =============================================================================

function createMeshPublicationTools(input: {
    agentWallet?: AgentWallet;
    sessionContext?: SessionContextProvider;
}): DynamicStructuredTool[] {
    if (!input.agentWallet || !isLocalMeshPublicationAvailable()) {
        return [];
    }

    return [
        new DynamicStructuredTool({
            name: "publish_mesh_state",
            description: "Anchor the current local agent state to the Compose Synapse collection and publish the refreshed mesh manifest to the libp2p network. Use this after meaningful local updates, before conclaves, or when a mesh skill instructs you to refresh your sovereign network state.",
            schema: z.object({
                reason: z.string().min(1).max(180).optional().describe("Short reason for this publish, for example startup, heartbeat, skill-update, memory-change, or conclave-entry"),
            }),
            func: async ({ reason }: { reason?: string }) => {
                const activeSessionContext = resolveSessionContext(input.sessionContext);
                await enforceToolPermissions({
                    toolName: "publish_mesh_state",
                    toolDescription: "Anchor current local state and publish updated mesh manifest",
                    cloudPermissions: activeSessionContext?.cloudPermissions,
                });

                const result = await queueLocalMeshPublication({
                    agentWallet: input.agentWallet!.address,
                    reason,
                });

                return JSON.stringify(result);
            },
        }),
    ];
}

function createLocalSkillTools(input: {
    agentWallet?: AgentWallet;
    sessionContext?: SessionContextProvider;
}): DynamicStructuredTool[] {
    const baseDir = resolveLocalBaseDir();
    if (!baseDir || !input.agentWallet) {
        return [];
    }
    const agentWallet = input.agentWallet.address;

    return [
        new DynamicStructuredTool({
            name: "save_local_skill",
            description: "Persist a reusable skill only in this agent's local workspace on the user's device.",
            schema: z.object({
                skillName: z.string().min(1).max(120).describe("Human-readable local skill name"),
                skillMarkdown: z.string().min(1).describe("SKILL.md content or skill body to persist locally"),
            }),
            func: async ({ skillName, skillMarkdown }: { skillName: string; skillMarkdown: string }) => {
                const activeSessionContext = resolveSessionContext(input.sessionContext);
                const grants = new Set(
                    (activeSessionContext?.sessionGrants || [])
                        .map((item) => item.trim().toLowerCase())
                        .filter(Boolean),
                );

                if (grants.size > 0 && !grants.has("*") && !grants.has("fs.write") && !grants.has("fs.edit")) {
                    throw new Error("Permission denied for local skill persistence");
                }

                const result = await writeLocalSkillDocument(baseDir, {
                    agentWallet,
                    skillName,
                    skillMarkdown,
                });

                return JSON.stringify(result);
            },
        }),
    ];
}

export function createMem0Tools(agentId: string, userAddress?: string, workflowWallet?: string): DynamicStructuredTool[] {
    const context = getAgentExecutionContext();

    const searchKnowledge = new DynamicStructuredTool({
        name: "search_memory",
        description: "Search your long-term memory/knowledge base for past interactions or learned facts. Uses graph memory for better relation-based retrieval.",
        schema: z.object({ query: z.string().describe("Search query") }),
        func: async ({ query }: { query: string }) => {
            const filters: Record<string, unknown> = {};
            if (workflowWallet) filters.workflow_wallet = workflowWallet;
            if (context?.composeRunId) filters.compose_run_id = context.composeRunId;

            const items = await searchMemory({
                query,
                agent_id: agentId,
                user_id: userAddress,
                run_id: context?.threadId,
                limit: 8,
                enable_graph: true,
                rerank: true,
                filters,
            });
            if (!items.length) return "No relevant memories found.";
            return items.map((item) => `[Memory]: ${item.memory}`).join("\n\n");
        },
    });

    const storeKnowledge = new DynamicStructuredTool({
        name: "save_memory",
        description: "Explicitly save an important fact or user preference to your long-term memory. Entities and relations are automatically extracted.",
        schema: z.object({ content: z.string().describe("Fact to remember") }),
        func: async ({ content }: { content: string }) => {
            const saved = await addMemory({
                messages: [{ role: "user", content }],
                agent_id: agentId,
                user_id: userAddress,
                run_id: context?.threadId,
                enable_graph: true,
                metadata: {
                    type: "explicit_save",
                    workflow_wallet: workflowWallet,
                    compose_run_id: context?.composeRunId,
                },
            });
            if (saved.length === 0) return "Failed to save memory.";
            return "Memory saved with graph extraction.";
        },
    });

    const hybridSearch = new DynamicStructuredTool({
        name: "search_all_memory",
        description: "Hybrid search across all memory layers including working, scene, graph, patterns, and archives.",
        schema: z.object({
            query: z.string().describe("Search query"),
            layers: z.array(z.enum(["working", "scene", "graph", "patterns", "archives"])).optional(),
        }),
        func: async ({ query, layers }: { query: string; layers?: string[] }) => {
            const results = await searchMemoryLayers({
                query,
                agentWallet: agentId,
                userAddress: userAddress,
                threadId: context?.threadId,
                layers: (layers as Array<"working" | "scene" | "graph" | "patterns" | "archives" | "vectors"> | undefined) || ["working", "scene", "graph", "patterns", "archives"],
                limit: 5,
            });
            return JSON.stringify(results);
        },
    });

    return [searchKnowledge, storeKnowledge, hybridSearch];
}

export interface EnhancedMemoryToolsConfig {
    agentId: string;
    userAddress?: string;
    workflowWallet?: string;
}

export function createEnhancedMemoryTools(config: EnhancedMemoryToolsConfig): DynamicStructuredTool[] {
    return createMem0Tools(config.agentId, config.userAddress, config.workflowWallet);
}
