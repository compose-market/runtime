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
            case "object": zodType = z.record(z.string(), z.any()).describe(prop.description || key); break;
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
                // Make single request - MCP server and connector handle flexible resolution
                console.log(`[createAgentTools] Fetching tools for MCP server "${id}"`);

                const response = await fetch(`${MCP_SERVICE_URL}/mcp/servers/${id}/tools`);
                if (!response.ok) {
                    console.warn(`[createAgentTools] ✗ MCP server "${id}" returned ${response.status}`);
                    continue;
                }

                const serverData = await response.json();
                console.log(`[createAgentTools] ✓ Found MCP server "${id}" with ${serverData.tools?.length || 0} tools`);
                const serverTools = serverData.tools || [];

                // Create a LangChain tool for each MCP tool
                for (const toolDef of serverTools) {
                    const tool = new DynamicStructuredTool({
                        name: toolDef.name,
                        description: toolDef.description || `Execute ${toolDef.name} on ${id}`,
                        schema: toolDef.inputSchema ? createZodSchema(toolDef.inputSchema) : z.object({}),
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
                                `${MCP_SERVICE_URL}/mcp/servers/${id}/tools/${toolDef.name}`,
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

export function createMem0Tools(agentId: string, userId?: string, manowarId?: string): DynamicStructuredTool[] {
    // Search Knowledge
    const searchKnowledge = new DynamicStructuredTool({
        name: "search_memory",
        description: "Search your long-term memory/knowledge base for past interactions or learned facts.",
        schema: z.object({ query: z.string().describe("Search query") }),
        func: async ({ query }: { query: string }) => {
            const filters: Record<string, unknown> = {};
            if (manowarId) filters.manowar_id = manowarId;

            const items = await searchMemory({
                query,
                agent_id: agentId,
                user_id: userId,
                limit: 5,
                filters
            });
            if (!items.length) return "No relevant memories found.";
            return items.map((i: MemoryItem) => `[Memory]: ${i.memory}`).join("\n\n");
        },
    });

    // Store Knowledge (Explicit)
    const storeKnowledge = new DynamicStructuredTool({
        name: "save_memory",
        description: "Explicitly save an important fact or user preference to your long-term memory.",
        schema: z.object({ content: z.string().describe("Fact to remember") }),
        func: async ({ content }: { content: string }) => {
            await addMemory({
                messages: [{ role: "user", content }],
                agent_id: agentId,
                user_id: userId,
                metadata: {
                    type: "explicit_save",
                    manowar_id: manowarId
                }
            });
            return "Memory saved.";
        },
    });

    return [searchKnowledge, storeKnowledge];
}
