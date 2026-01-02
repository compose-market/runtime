/**
 * Manowar Card Registry
 * 
 * Fetches and caches manowarCard metadata from IPFS via Pinata gateway.
 * Uses canonical AgentCard/ManowarCard from types.ts.
 * 
 * Key features:
 * - Uses PINATA_GATEWAY from environment
 * - Caches cards by manowarWallet
 * - Does not duplicate agentCards (they're already in manowarCard)
 * - Builds static system prompt from card metadata
 */

import type { AgentCard, ManowarCard } from "./types.js";

// Re-export for consumers that import from registry
export type { AgentCard, ManowarCard };



// =============================================================================
// Configuration
// =============================================================================

const PINATA_GATEWAY = process.env.PINATA_GATEWAY || "compose.mypinata.cloud";
const CARD_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// =============================================================================
// Cache
// =============================================================================

interface CachedCard {
    card: ManowarCard;
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
    return `https://${PINATA_GATEWAY}/ipfs/${cid}`;
}

// =============================================================================
// Registry Functions
// =============================================================================

/**
 * Fetch manowarCard from IPFS via Pinata gateway
 * 
 * @param manowarCardUri - IPFS URI (ipfs://...) or wallet address
 */
export async function fetchManowarCard(manowarCardUri: string): Promise<ManowarCard | null> {
    if (!manowarCardUri) return null;

    // Check cache first
    const cached = cardCache.get(manowarCardUri);
    if (cached && Date.now() - cached.fetchedAt < CARD_CACHE_TTL) {
        return cached.card;
    }

    try {
        const gatewayUrl = buildGatewayUrl(manowarCardUri);
        console.log(`[registry] Fetching manowarCard from: ${gatewayUrl}`);

        const response = await fetch(gatewayUrl, {
            headers: { Accept: "application/json" },
        });

        if (!response.ok) {
            console.warn(`[registry] Failed to fetch manowarCard: HTTP ${response.status}`);
            return null;
        }

        const card = await response.json() as ManowarCard;

        // Cache the result
        cardCache.set(manowarCardUri, { card, fetchedAt: Date.now() });
        console.log(`[registry] ✅ Fetched manowarCard: ${card.title} with ${card.agents?.length || 0} agents`);

        return card;
    } catch (error) {
        console.error("[registry] Error fetching manowarCard:", error);
        return null;
    }
}

/**
 * Get agent card from manowarCard's embedded agents
 * No separate IPFS calls - uses agents already in manowarCard
 */
export function getAgentCard(manowarCard: ManowarCard, agentWallet: string): AgentCard | undefined {
    return manowarCard.agents?.find(
        (a: AgentCard) => a.walletAddress?.toLowerCase() === agentWallet.toLowerCase()
    );
}

/**
 * Build static system prompt from manowarCard
 * 
 * This prompt is built ONCE at initialization and remains constant
 * to maximize KV-cache efficiency.
 */
export function buildSystemPromptFromCard(card: ManowarCard): string {
    const agentList = card.agents?.map((a: AgentCard, i: number) =>
        `${i + 1}. **${a.name}** (${a.walletAddress?.slice(0, 8)}...)\n` +
        `   Model: ${a.model || "default"}\n` +
        `   Skills: ${a.skills?.join(", ") || "general"}\n` +
        `   Plugins: ${a.plugins?.map(p => p.name).join(", ") || "none"}`
    ).join("\n") || "No agents available";

    return `# Manowar Orchestrator: ${card.title}

## Description
${card.description || "Multi-agent workflow orchestrator"}

## Available Agents
${agentList}

## Your Role
You are the COORDINATOR for this workflow. Your job is to:
1. Understand user requests
2. Create execution plans
3. Delegate tasks to the appropriate agents
4. Synthesize results into coherent responses

## Rules
- Each agent call is via HTTP - you delegate, they execute
- Use agents' specific skills for relevant tasks
- Respect agent autonomy - they handle their own tool use
- Track progress and report to user`;
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

/**
 * Get cache stats (for debugging)
 */
export function getCacheStats(): { size: number; keys: string[] } {
    return {
        size: cardCache.size,
        keys: Array.from(cardCache.keys()),
    };
}