/**
 * Workflow Card Registry
 * 
 * Fetches and caches workflowCard metadata from IPFS via Pinata gateway.
 * Uses canonical AgentCard/WorkflowCard from types.ts.
 * 
 * Key features:
 * - Uses PINATA_GATEWAY_URL from environment
 * - Caches cards by workflowWallet
 * - Does not duplicate agentCards (they're already in workflowCard)
 * - Builds static system prompt from card metadata
 */

import { buildPinataGatewayIpfsUrl } from "../../auth.js";
import type { AgentCard, WorkflowCard } from "./types.js";

// Re-export for consumers that import from registry
export type { AgentCard, WorkflowCard };

// =============================================================================
// Validation & Normalization
// =============================================================================

export function normalizeWorkflowCard(card: WorkflowCard): WorkflowCard {
    return {
        ...card,
        agents: (card.agents || []).map(agent => ({
            ...agent,
            plugins: agent.plugins || [],
            protocols: agent.protocols || [],
        })),
        edges: card.edges || [],
    };
}

export function assertWorkflowCard(card: WorkflowCard): void {
    const issues: string[] = [];
    if (!card.walletAddress) issues.push("workflowCard.walletAddress is required");
    if (!Array.isArray(card.agents) || card.agents.length === 0) {
        issues.push("workflowCard.agents must be a non-empty array");
    }
    for (const agent of card.agents || []) {
        if (!agent.name) issues.push("agent.name is required");
        if (!agent.walletAddress) issues.push(`agent.walletAddress missing for ${agent.name || "unknown agent"}`);
        if (!agent.model) issues.push(`agent.model missing for ${agent.name || agent.walletAddress || "unknown agent"}`);
        if (!Array.isArray(agent.plugins)) issues.push(`agent.plugins must be an array for ${agent.name || agent.walletAddress || "unknown agent"}`);
        if (!Array.isArray(agent.protocols)) issues.push(`agent.protocols must be an array for ${agent.name || agent.walletAddress || "unknown agent"}`);
    }
    if (issues.length > 0) {
        throw new Error(`[registry] Invalid workflowCard: ${issues.join("; ")}`);
    }
}



// =============================================================================
// Configuration
// =============================================================================

const CARD_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// =============================================================================
// Cache
// =============================================================================

interface CachedCard {
    card: WorkflowCard;
    fetchedAt: number;
}

const cardCache = new Map<string, CachedCard>();

// =============================================================================
// IPFS Helpers
// =============================================================================

/**
 * Extract CID from IPFS URI
 */
function extractCid(uri: string): string | null {
    if (uri.startsWith("ipfs://")) {
        return uri.replace("ipfs://", "");
    }
    // Handle gateway URLs
    const match = uri.match(/\/ipfs\/([a-zA-Z0-9]+)/);
    return match?.[1] || null;
}

/**
 * Build gateway URL from IPFS URI
 */
function buildGatewayUrl(uri: string): string {
    const cid = extractCid(uri);
    if (!cid) return uri;
    return buildPinataGatewayIpfsUrl(cid);
}

// =============================================================================
// Registry Functions
// =============================================================================

/**
 * Fetch workflowCard from IPFS via Pinata gateway
 * 
 * @param workflowCardUri - IPFS URI (ipfs://...) or wallet address
 */
export async function fetchWorkflowCard(workflowCardUri: string): Promise<WorkflowCard | null> {
    if (!workflowCardUri) return null;

    // Check cache first
    const cached = cardCache.get(workflowCardUri);
    if (cached && Date.now() - cached.fetchedAt < CARD_CACHE_TTL) {
        return cached.card;
    }

    try {
        const gatewayUrl = buildGatewayUrl(workflowCardUri);
        console.log(`[registry] Fetching workflowCard from: ${gatewayUrl}`);

        const response = await fetch(gatewayUrl, {
            headers: { Accept: "application/json" },
        });

        if (!response.ok) {
            console.warn(`[registry] Failed to fetch workflowCard: HTTP ${response.status}`);
            return null;
        }

        const card = await response.json() as WorkflowCard;

        // Cache the result
        cardCache.set(workflowCardUri, { card, fetchedAt: Date.now() });
        console.log(`[registry] ✅ Fetched workflowCard: ${card.title} with ${card.agents?.length || 0} agents`);

        return card;
    } catch (error) {
        console.error("[registry] Error fetching workflowCard:", error);
        return null;
    }
}

/**
 * Get agent card from workflowCard's embedded agents
 * No separate IPFS calls - uses agents already in workflowCard
 */
export function getAgentCard(workflowCard: WorkflowCard, agentWallet: string): AgentCard | undefined {
    return workflowCard.agents?.find(
        (a: AgentCard) => a.walletAddress?.toLowerCase() === agentWallet.toLowerCase()
    );
}

/**
 * Build static system prompt from workflowCard
 * 
 * This prompt is built ONCE at initialization and remains constant
 * to maximize KV-cache efficiency.
 */
export function buildSystemPromptFromCard(card: WorkflowCard): string {
    const cardJson = JSON.stringify(card, null, 2);

    return `# WORKFLOW_CARD (authoritative metadata)
${cardJson}

# COORDINATOR ROLE
You coordinate agents without altering their configuration.

# RULES
- Do NOT modify any agent's model, tools, or metadata
- Do NOT execute tools on behalf of agents
- Delegate tasks to agents; they execute with their own tools
- Keep coordination concise and efficient`;
}

/**
 * Clear cached card by URI
 */
export function clearCardCache(uri?: string): void {
    if (uri) {
        cardCache.delete(uri);
    } else {
        cardCache.clear();
    }
}

export function getCacheStats(): { size: number; keys: string[] } {
    return {
        size: cardCache.size,
        keys: Array.from(cardCache.keys()),
    };
}

// =============================================================================
// Tool Self-Discovery (via Connector Service)
// =============================================================================

const CONNECTOR_URL = process.env.CONNECTOR_URL;
const TOOL_DISCOVERY_MODE = process.env.WORKFLOW_TOOL_DISCOVERY_MODE || "registry";
const TOOL_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

interface CachedTools {
    tools: DiscoveredTool[];
    fetchedAt: number;
}

const toolCache = new Map<string, CachedTools>();

/**
 * Tool schema from connector service
 */
export interface DiscoveredTool {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
}

/**
 * Discover tools for an agent's plugins via connector service.
 * 
 * Uses the connector's self-discovery endpoint which spawns MCP servers
 * on-demand and returns their tool schemas. This allows the planner
 * to understand what tools each agent can use.
 * 
 * @param agentCard - Agent card with plugins array
 * @returns Array of discovered tools (limited to top 10 per agent to save tokens)
 */
export async function discoverAgentTools(
    agentCard: AgentCard,
    mode: "registry" | "runtime" | "auto" = (TOOL_DISCOVERY_MODE as "registry" | "runtime" | "auto")
): Promise<DiscoveredTool[]> {
    if (!agentCard.plugins?.length || !CONNECTOR_URL) {
        return [];
    }

    const allTools: DiscoveredTool[] = [];

    for (const plugin of agentCard.plugins) {
        if (!plugin.registryId) continue;

        const cached = toolCache.get(plugin.registryId);
        if (cached && Date.now() - cached.fetchedAt < TOOL_CACHE_TTL) {
            allTools.push(...cached.tools);
            continue;
        }

        let tools: DiscoveredTool[] = [];

        // Preferred: read-only registry lookup (no server spawn)
        if (mode === "registry" || mode === "auto") {
            try {
                const response = await fetch(
                    `${CONNECTOR_URL}/registry/servers/${encodeURIComponent(plugin.registryId)}`,
                    {
                        headers: { Accept: "application/json" },
                        signal: AbortSignal.timeout(5000),
                    }
                );

                if (response.ok) {
                    const data = await response.json();
                    if (Array.isArray(data?.tools)) {
                        tools = data.tools.map((tool: any) => ({
                            name: tool.name,
                            description: tool.description,
                            inputSchema: tool.inputSchema,
                        }));
                    }
                } else if (mode === "registry") {
                    console.warn(`[registry] Registry lookup failed for ${plugin.registryId}: HTTP ${response.status}`);
                }
            } catch (error) {
                if (mode === "registry") {
                    console.warn(`[registry] Registry lookup error for ${plugin.registryId}:`, error);
                }
            }
        }

        // Fallback: runtime tool listing (may spawn MCP servers)
        if (tools.length === 0 && (mode === "runtime" || mode === "auto")) {
            try {
                const response = await fetch(
                    `${CONNECTOR_URL}/mcp/servers/${encodeURIComponent(plugin.registryId)}/tools`,
                    {
                        headers: { Accept: "application/json" },
                        signal: AbortSignal.timeout(5000),
                    }
                );

                if (response.ok) {
                    const data = await response.json();
                    if (data.tools && Array.isArray(data.tools)) {
                        tools = data.tools.map((tool: any) => ({
                            name: tool.name,
                            description: tool.description,
                            inputSchema: tool.inputSchema,
                        }));
                    }
                } else {
                    console.warn(`[registry] Runtime tool discovery failed for ${plugin.name}: HTTP ${response.status}`);
                }
            } catch (error) {
                console.warn(`[registry] Runtime tool discovery error for ${plugin.name}:`, error);
            }
        }

        toolCache.set(plugin.registryId, { tools, fetchedAt: Date.now() });
        allTools.push(...tools);
    }

    return allTools.slice(0, 10);
}
