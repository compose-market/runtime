/**
 * Agent Tool Factories
 * 
 * Creates LangChain tools by calling MCP service via HTTP for tool execution.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { ComposeTool } from "../types.js";
import type { AgentWallet } from "../agent-wallet.js";
import { createHash } from "crypto";
import { getAgentExecutionContext } from "./context.js";

const LAMBDA_API_URL = process.env.LAMBDA_API_URL || "https://api.compose.market";
const RUNTIME_SERVICE_URL = process.env.RUNTIME_SERVICE_URL || "https://runtime.compose.market";
const CONNECTOR_URL = process.env.CONNECTOR_URL || "https://services.compose.market/connector";

interface ToolExecutionContext {
    getComposeRunId?: () => string | undefined;
    getThreadId?: () => string | undefined;
}

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

function buildCorrelationHeaders(
    context: ToolExecutionContext | undefined,
    scope: string,
    payload?: unknown,
): Record<string, string> {
    const currentContext = getAgentExecutionContext();
    const composeRunId = context?.getComposeRunId?.() || currentContext?.composeRunId;
    if (!composeRunId) {
        return {};
    }

    const serialized = JSON.stringify(payload ?? {});
    const hash = createHash("sha256").update(serialized).digest("hex").slice(0, 20);
    const threadId = context?.getThreadId?.() || currentContext?.threadId || "thread";

    return {
        "x-compose-run-id": composeRunId,
        "x-idempotency-key": `${composeRunId}:${threadId}:${scope}:${hash}`,
    };
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

/**
 * Infer consent type needed from error message or tool semantics.
 * Agent proactively understands what permissions are needed.
 * No hardcoded server names - works with any of 8000+ MCP servers.
 */
function inferConsentFromError(errorText: string): string | null {
    const lowerError = errorText.toLowerCase();

    // Filesystem indicators
    if (lowerError.includes("eacces") ||
        lowerError.includes("permission denied") ||
        lowerError.includes("file") && (lowerError.includes("access") || lowerError.includes("read") || lowerError.includes("write")) ||
        lowerError.includes("directory") ||
        lowerError.includes("filesystem")) {
        return "filesystem";
    }

    // Camera indicators
    if (lowerError.includes("camera") ||
        lowerError.includes("video") && lowerError.includes("capture") ||
        lowerError.includes("notreadableerror") && lowerError.includes("video")) {
        return "camera";
    }

    // Microphone indicators
    if (lowerError.includes("microphone") ||
        lowerError.includes("audio") && lowerError.includes("recording") ||
        lowerError.includes("notreadableerror") && lowerError.includes("audio")) {
        return "microphone";
    }

    // Location indicators
    if (lowerError.includes("geolocation") ||
        lowerError.includes("location") && lowerError.includes("denied") ||
        lowerError.includes("gps")) {
        return "geolocation";
    }

    // Clipboard indicators
    if (lowerError.includes("clipboard") && lowerError.includes("denied")) {
        return "clipboard";
    }

    return null;
}

/**
 * Infer consent type from tool name/description (proactive check).
 * Agent can check this BEFORE execution to prompt user upfront.
 */
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
    sessionContext?: { sessionActive: boolean; sessionBudgetRemaining: number },
    executionContext?: ToolExecutionContext,
    chainId?: number,
): Promise<DynamicStructuredTool[]> {
    if (!pluginIds || pluginIds.length === 0) return [];

    const tools: DynamicStructuredTool[] = [];
    const usedToolNames = new Set<string>();

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
                const response = await fetchWithRetry(
                    `${RUNTIME_SERVICE_URL}/goat/plugins/${id}`,
                    {
                        method: "GET",
                        headers: {
                            ...buildCorrelationHeaders(executionContext, `goat:plugin:${id}`),
                            ...(chainId ? { "x-chain-id": chainId.toString() } : {}),
                        },
                    },
                );
                if (!response.ok) {
                    console.warn(`[createAgentTools] GOAT plugin ${id} not found`);
                    continue;
                }

                const pluginData = await response.json();
                const pluginTools = pluginData.tools || [];

                // Create a LangChain tool for each GOAT tool
                for (const toolDef of pluginTools) {
                    const toolName = reserveToolName(toolDef.name, usedToolNames);
                    const tool = new DynamicStructuredTool({
                        name: toolName,
                        description: toolDef.description || `Execute ${toolDef.name}`,
                        schema: toolDef.parameters ? createZodSchema(toolDef.parameters) : z.object({}),
                        func: async (args: Record<string, unknown>) => {
                            // Call MCP service to execute the tool
                            const headers: Record<string, string> = {
                                "Content-Type": "application/json"
                            };

                            // Forward session headers if available
                            if (sessionContext?.sessionActive) {
                                headers["x-session-active"] = "true";
                                headers["x-session-budget-remaining"] = sessionContext.sessionBudgetRemaining.toString();
                            }

                            // Pass chainId
                            if (chainId) {
                                headers["x-chain-id"] = chainId.toString();
                            }

                            // Add internal bypass header (user already paid for this conversation)
                            const MANOWAR_INTERNAL_SECRET = process.env.MANOWAR_INTERNAL_SECRET || "manowar-internal-v1-secret";
                            headers["x-manowar-internal"] = MANOWAR_INTERNAL_SECRET;

                            // Phase 1: Add pricing metadata for usage tracking
                            headers["x-tool-price"] = "1000"; // $0.001 default
                            Object.assign(
                                headers,
                                buildCorrelationHeaders(
                                    executionContext,
                                    `goat:tool:${id}:${toolDef.name}`,
                                    args,
                                ),
                            );

                            const execResponse = await fetchWithRetry(
                                `${RUNTIME_SERVICE_URL}/goat/plugins/${id}/tools/${toolDef.name}`,
                                {
                                    method: "POST",
                                    headers,
                                    body: JSON.stringify({ args }),
                                }
                            );

                            if (!execResponse.ok) {
                                const error = await execResponse.text();
                                throw new Error(
                                    `GOAT tool "${toolDef.name}" failed (${execResponse.status}): ${error || "unknown error"}`,
                                );
                            }

                            const result = await execResponse.json();
                            return JSON.stringify(result.result);
                        },
                    });
                    tools.push(tool);
                }
            } else if (source === "mcp") {
                // Proxy Executor Pattern: One tool per MCP server to prevent context bloat
                // Instead of binding 50+ individual tools, we bind ONE executor that routes to sub-tools
                console.log(`[createAgentTools] Fetching tools for MCP server "${id}"`);

                // Add timeout to prevent indefinite blocking on spawn failures
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

                let response: Response;
                try {
                    response = await fetchWithRetry(
                        `${RUNTIME_SERVICE_URL}/mcp/servers/${id}/tools`,
                        {
                            signal: controller.signal,
                            headers: buildCorrelationHeaders(executionContext, `mcp:tools:${id}`),
                        },
                    );
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

                if (!response.ok) {
                    console.warn(`[createAgentTools] ✗ MCP server "${id}" returned ${response.status}`);
                    continue;
                }

                const serverData = await response.json();
                const serverTools = serverData.tools || [];

                if (serverTools.length === 0) {
                    console.warn(`[createAgentTools] ✗ MCP server "${id}" has no tools, skipping`);
                    continue;
                }

                console.log(`[createAgentTools] ✓ Found MCP server "${id}" with ${serverTools.length} tools`);

                // Build tool list description for the model (compact format)
                const toolDescriptions = serverTools.map((t: any) =>
                    `${t.name}${t.description ? ` - ${t.description.slice(0, 80)}` : ""}`
                ).join("; ");

                // Create SINGLE Proxy Executor for this MCP server
                const mcpExecutorName = `mcp_${id.replace(/[^a-zA-Z0-9]/g, "_")}`;

                const mcpExecutor = new DynamicStructuredTool({
                    name: mcpExecutorName,
                    description: `Execute tools on MCP server "${id}". Available tools: ${toolDescriptions}`,
                    schema: z.object({
                        tool: z.string().describe("Name of the tool to execute (from the available tools list)"),
                        args: z.object({}).passthrough().describe("Arguments object to pass to the tool"),
                    }),
                    func: async (input: { tool: string; args: Record<string, unknown> }) => {
                        const toolKey = `${id}:${input.tool}`;

                        // Check if this tool is marked as failed - avoid repeated failing calls
                        const failCheck = isToolFailed(toolKey);
                        if (failCheck.failed) {
                            throw new Error(
                                `Tool "${input.tool}" is temporarily unavailable: ${failCheck.reason || "recent failures"}`,
                            );
                        }

                        // Route to MCP service for actual tool execution
                        const headers: Record<string, string> = {
                            "Content-Type": "application/json"
                        };

                        // Forward session headers if available
                        if (sessionContext?.sessionActive) {
                            headers["x-session-active"] = "true";
                            headers["x-session-budget-remaining"] = sessionContext.sessionBudgetRemaining.toString();
                        }

                        // Add internal bypass header (user already paid for this conversation)
                        const MANOWAR_INTERNAL_SECRET = process.env.MANOWAR_INTERNAL_SECRET || "manowar-internal-v1-secret";
                        headers["x-manowar-internal"] = MANOWAR_INTERNAL_SECRET;

                        // Phase 1: Add pricing metadata for usage tracking
                        headers["x-tool-price"] = "1000"; // $0.001 default
                        Object.assign(
                            headers,
                            buildCorrelationHeaders(
                                executionContext,
                                `mcp:tool:${id}:${input.tool}`,
                                input.args,
                            ),
                        );

                        console.log(`[MCP Executor] ${mcpExecutorName} -> ${input.tool}(${JSON.stringify(input.args)})`);

                        try {
                            const execResponse = await fetchWithRetry(
                                `${RUNTIME_SERVICE_URL}/mcp/servers/${id}/tools/${input.tool}`,
                                {
                                    method: "POST",
                                    headers,
                                    body: JSON.stringify({ args: input.args }),
                                }
                            );

                            if (!execResponse.ok) {
                                const error = await execResponse.text();
                                if (isRetryableToolFailure(execResponse.status, error)) {
                                    markToolFailed(toolKey, error || `status ${execResponse.status}`);
                                }
                                throw new Error(
                                    `MCP tool "${input.tool}" failed (${execResponse.status}): ${error || "unknown error"}`,
                                );
                            }

                            clearToolFailure(toolKey);
                            const result = await execResponse.json();
                            return JSON.stringify(result.result);
                        } catch (err: any) {
                            const errorMessage = err instanceof Error ? err.message : String(err);
                            if (isRetryableToolFailure(503, errorMessage)) {
                                markToolFailed(toolKey, errorMessage);
                            }
                            throw new Error(`MCP tool "${input.tool}" failed: ${errorMessage}`);
                        }
                    },
                });

                tools.push(mcpExecutor);
                console.log(`[createAgentTools] ✓ Created proxy executor "${mcpExecutorName}" for ${serverTools.length} tools`);
            }
        } catch (error) {
            console.error(`[createAgentTools] Failed to load plugin ${pluginId}:`, error);
        }
    }

    console.log(`[createAgentTools] Created ${tools.length} tools from ${pluginIds.length} plugins`);
    return tools;
}

// =============================================================================
// Mem0 / Built-in Tools
// =============================================================================

interface MemoryItem {
    id: string;
    memory: string;
    user_id?: string;
    agent_id?: string;
    run_id?: string;
    metadata?: Record<string, unknown>;
}

async function addMemory(params: {
    messages: Array<{ role: string; content: string }>;
    agent_id?: string;
    user_id?: string;
    run_id?: string;
    metadata?: Record<string, unknown>;
}): Promise<MemoryItem[]> {
    try {
        const response = await fetch(`${LAMBDA_API_URL}/api/memory/add`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params),
        });
        if (!response.ok) return [];
        return await response.json();
    } catch (error) {
        console.error("[mem0] Failed to add memory:", error);
        return [];
    }
}

async function searchMemory(params: {
    query: string;
    agent_id?: string;
    user_id?: string;
    run_id?: string;
    limit?: number;
    filters?: Record<string, unknown>;
}): Promise<MemoryItem[]> {
    try {
        const response = await fetch(`${LAMBDA_API_URL}/api/memory/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params),
        });
        if (!response.ok) return [];
        return await response.json();
    } catch (error) {
        console.error("[mem0] Failed to search memory:", error);
        return [];
    }
}

export function createMem0Tools(agentId: string, userId?: string, manowarWallet?: string): DynamicStructuredTool[] {
    const context = getAgentExecutionContext();

    const searchKnowledge = new DynamicStructuredTool({
        name: "search_memory",
        description: "Search your long-term memory/knowledge base for past interactions or learned facts. Uses graph memory for better relation-based retrieval.",
        schema: z.object({ query: z.string().describe("Search query") }),
        func: async ({ query }: { query: string }) => {
            const filters: Record<string, unknown> = {};
            if (manowarWallet) filters.manowar_wallet = manowarWallet;
            if (context?.composeRunId) filters.compose_run_id = context.composeRunId;

            const response = await fetch(`${LAMBDA_API_URL}/api/memory/search`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-tool-price": "500",
                },
                body: JSON.stringify({
                    query,
                    agent_id: agentId,
                    user_id: userId,
                    run_id: context?.threadId,
                    limit: 8,
                    enable_graph: true,
                    rerank: true,
                    filters
                }),
            });
            if (!response.ok) return "Memory search unavailable.";
            const items = await response.json();
            if (!items.length) return "No relevant memories found.";
            return items.map((i: MemoryItem) => `[Memory]: ${i.memory}`).join("\n\n");
        },
    });

    const storeKnowledge = new DynamicStructuredTool({
        name: "save_memory",
        description: "Explicitly save an important fact or user preference to your long-term memory. Entities and relations are automatically extracted.",
        schema: z.object({ content: z.string().describe("Fact to remember") }),
        func: async ({ content }: { content: string }) => {
            const response = await fetch(`${LAMBDA_API_URL}/api/memory/add`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-tool-price": "1000",
                },
                body: JSON.stringify({
                    messages: [{ role: "user", content }],
                    agent_id: agentId,
                    user_id: userId,
                    run_id: context?.threadId,
                    enable_graph: true,
                    metadata: {
                        type: "explicit_save",
                        manowar_wallet: manowarWallet,
                        compose_run_id: context?.composeRunId,
                    }
                }),
            });
            if (!response.ok) return "Failed to save memory.";
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
            const response = await fetch(`${LAMBDA_API_URL}/api/memory/layers/search`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-tool-price": "750",
                },
                body: JSON.stringify({
                    query,
                    agent_id: agentId,
                    user_id: userId,
                    manowar_wallet: manowarWallet,
                    layers: layers || ["working", "scene", "graph", "patterns", "archives"],
                    limit: 5,
                    compose_run_id: context?.composeRunId,
                    thread_id: context?.threadId,
                }),
            });
            if (!response.ok) return "Memory search unavailable.";
            const data = await response.json();
            return JSON.stringify(data);
        },
    });

    return [searchKnowledge, storeKnowledge, hybridSearch];
}

export interface EnhancedMemoryToolsConfig {
    agentId: string;
    userId?: string;
    manowarWallet?: string;
}

export function createEnhancedMemoryTools(config: EnhancedMemoryToolsConfig): DynamicStructuredTool[] {
    return createMem0Tools(config.agentId, config.userId, config.manowarWallet);
}
