/**
 * Agent Tool Factories
 * 
 * Creates LangChain tools by calling MCP service via HTTP for tool execution.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { ComposeTool } from "../types.js";
import type { AgentWallet } from "../agent-wallet.js";

const LAMBDA_API_URL = process.env.LAMBDA_API_URL || "https://api.compose.market";
const MCP_SERVICE_URL = process.env.MCP_SERVICE_URL || "https://mcp.compose.market";

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

// =============================================================================
// Tool Creation from MCP Service
// =============================================================================

/**
 * Create tools for agent from plugin IDs by calling MCP service
 * 
 * @param pluginIds Plugin IDs to load (e.g. ["goat:coingecko", "mcp:github"])
 * @param agentWallet Agent wallet context
 * @param sessionContext Session context for payment headers
 * @returns Array of LangChain DynamicStructuredTool instances
 */
export async function createAgentTools(
    pluginIds: string[],
    agentWallet?: AgentWallet,
    sessionContext?: { sessionActive: boolean; sessionBudgetRemaining: number }
): Promise<DynamicStructuredTool[]> {
    if (!pluginIds || pluginIds.length === 0) return [];

    const tools: DynamicStructuredTool[] = [];

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
                // Fetch GOAT plugin tools from MCP service
                const response = await fetch(`${MCP_SERVICE_URL}/goat/plugins/${id}`);
                if (!response.ok) {
                    console.warn(`[createAgentTools] GOAT plugin ${id} not found`);
                    continue;
                }

                const pluginData = await response.json();
                const pluginTools = pluginData.tools || [];

                // Create a LangChain tool for each GOAT tool
                for (const toolDef of pluginTools) {
                    const tool = new DynamicStructuredTool({
                        name: toolDef.name,
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

                            // Add internal bypass header (user already paid for this conversation)
                            const MANOWAR_INTERNAL_SECRET = process.env.MANOWAR_INTERNAL_SECRET || "manowar-internal-v1-secret";
                            headers["x-manowar-internal"] = MANOWAR_INTERNAL_SECRET;

                            // Phase 1: Add pricing metadata for usage tracking
                            headers["x-tool-price"] = "1000"; // $0.001 default

                            const execResponse = await fetch(
                                `${MCP_SERVICE_URL}/goat/plugins/${id}/tools/${toolDef.name}`,
                                {
                                    method: "POST",
                                    headers,
                                    body: JSON.stringify({ args }),
                                }
                            );

                            if (!execResponse.ok) {
                                const error = await execResponse.text();
                                throw new Error(`Tool execution failed: ${error}`);
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
                    response = await fetch(`${MCP_SERVICE_URL}/mcp/servers/${id}/tools`, {
                        signal: controller.signal
                    });
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

                        // Check if this tool is marked as failed - don't waste cycles retrying
                        const failCheck = isToolFailed(toolKey);
                        if (failCheck.failed) {
                            return JSON.stringify({
                                error: true,
                                status: "TOOL_UNAVAILABLE",
                                message: `Tool "${input.tool}" is temporarily unavailable: ${failCheck.reason}`,
                                retryable: false,
                                suggestion: "Use an alternative approach or inform the user this capability is unavailable."
                            });
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

                        console.log(`[MCP Executor] ${mcpExecutorName} -> ${input.tool}(${JSON.stringify(input.args)})`);

                        try {
                            const execResponse = await fetch(
                                `${MCP_SERVICE_URL}/mcp/servers/${id}/tools/${input.tool}`,
                                {
                                    method: "POST",
                                    headers,
                                    body: JSON.stringify({ args: input.args }),
                                }
                            );

                            if (!execResponse.ok) {
                                const error = await execResponse.text();

                                if (error.includes("temporarily unavailable") ||
                                    error.includes("spawn") ||
                                    error.includes("Failed to get tools") ||
                                    execResponse.status === 503) {
                                    markToolFailed(toolKey, "server unavailable");
                                    return JSON.stringify({
                                        error: true,
                                        status: "SERVER_UNAVAILABLE",
                                        message: `Tool "${input.tool}" failed: MCP server unavailable`,
                                        retryable: false,
                                        suggestion: "Do NOT retry this tool. Use alternative tools or inform the user."
                                    });
                                }

                                // For other errors (bad input), don't mark as failed
                                return `Tool "${input.tool}" failed: ${error}. Check arguments and try again.`;
                            }

                            const result = await execResponse.json();
                            return JSON.stringify(result.result);
                        } catch (err: any) {
                            // Network/timeout errors - mark as failed
                            markToolFailed(toolKey, err.message || "network error");
                            return JSON.stringify({
                                error: true,
                                status: "NETWORK_ERROR",
                                message: `Tool "${input.tool}" failed: ${err.message || "network error"}`,
                                retryable: false,
                                suggestion: "Do NOT retry. Use alternative approach or inform the user."
                            });
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
    // Search Knowledge with Graph Memory
    const searchKnowledge = new DynamicStructuredTool({
        name: "search_memory",
        description: "Search your long-term memory/knowledge base for past interactions or learned facts. Uses graph memory for better relation-based retrieval.",
        schema: z.object({ query: z.string().describe("Search query") }),
        func: async ({ query }: { query: string }) => {
            const filters: Record<string, unknown> = {};
            if (manowarWallet) filters.manowar_wallet = manowarWallet;

            // Use graph-enabled search with reranking
            const response = await fetch(`${LAMBDA_API_URL}/api/memory/search`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-tool-price": "500", // $0.0005 per memory search
                },
                body: JSON.stringify({
                    query,
                    agent_id: agentId,
                    user_id: userId,
                    limit: 8,
                    enable_graph: true, // Enable graph memory for relations
                    rerank: true, // Enable reranking for relevance
                    filters
                }),
            });
            if (!response.ok) return "Memory search unavailable.";
            const items = await response.json();
            if (!items.length) return "No relevant memories found.";
            return items.map((i: MemoryItem) => `[Memory]: ${i.memory}`).join("\n\n");
        },
    });

    // Store Knowledge with Graph Extraction
    const storeKnowledge = new DynamicStructuredTool({
        name: "save_memory",
        description: "Explicitly save an important fact or user preference to your long-term memory. Entities and relations are automatically extracted.",
        schema: z.object({ content: z.string().describe("Fact to remember") }),
        func: async ({ content }: { content: string }) => {
            const response = await fetch(`${LAMBDA_API_URL}/api/memory/add`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-tool-price": "1000", // $0.001 per memory save (includes graph extraction)
                },
                body: JSON.stringify({
                    messages: [{ role: "user", content }],
                    agent_id: agentId,
                    user_id: userId,
                    enable_graph: true, // Enable graph extraction
                    metadata: {
                        type: "explicit_save",
                        manowar_wallet: manowarWallet
                    }
                }),
            });
            if (!response.ok) return "Failed to save memory.";
            return "Memory saved with graph extraction.";
        },
    });

    return [searchKnowledge, storeKnowledge];
}
