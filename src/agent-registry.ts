/**
 * Agent Registry
 *
 * Stores and manages deployed agent configurations.
 * Links on-chain AgentFactory agents to their backend runtime instances.
 * 
 * Key features:
 * - Derives unique wallet addresses from dnaHash
 * - Uses wallet address as primary identifier (not progressive IDs)
 * - Persists knowledge to Pinata IPFS for long-term storage
 * - Creates LangChain agents with selected plugins as tools
 */
import { createAgent, type AgentInstance } from "./frameworks/langchain.js";
import { deriveAgentWallet, type AgentWallet } from "./agent-wallet.js";

// =============================================================================
// Pinata Configuration (backend-side)
// =============================================================================

const PINATA_JWT = process.env.PINATA_JWT || "";
const PINATA_GATEWAY = process.env.PINATA_GATEWAY || "compose.mypinata.cloud";
const PINATA_API_URL = "https://api.pinata.cloud";

interface PinataUploadResponse {
    IpfsHash: string;
    PinSize: number;
    Timestamp: string;
}

/**
 * Upload JSON data to Pinata IPFS
 */
async function uploadJSONToPinata<T extends object>(
    data: T,
    name: string,
    keyvalues: Record<string, string>
): Promise<string> {
    if (!PINATA_JWT) {
        console.warn("[registry] Pinata not configured, using memory-only storage");
        return "";
    }

    const response = await fetch(`${PINATA_API_URL}/pinning/pinJSONToIPFS`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${PINATA_JWT}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            pinataContent: data,
            pinataMetadata: { name, keyvalues },
            pinataOptions: { cidVersion: 1 },
        }),
    });

    if (!response.ok) {
        const error = await response.text();
        console.error(`[registry] Pinata upload failed: ${error}`);
        return "";
    }

    const result: PinataUploadResponse = await response.json();
    return result.IpfsHash;
}

/**
 * Fetch JSON from Pinata IPFS
 */
async function fetchFromPinata<T = unknown>(cid: string): Promise<T | null> {
    if (!cid) return null;

    try {
        const response = await fetch(`https://${PINATA_GATEWAY}/ipfs/${cid}`);
        if (!response.ok) {
            console.error(`[registry] Failed to fetch from IPFS: ${response.statusText}`);
            return null;
        }
        return response.json();
    } catch (err) {
        console.error(`[registry] Error fetching from IPFS:`, err);
        return null;
    }
}

// =============================================================================
// Types
// =============================================================================

export interface RegisteredAgent {
    /** On-chain agent ID (ERC8004 NFT ID) */
    agentId: bigint;
    /** Agent's unique DNA hash from contract */
    dnaHash: `0x${string}`;
    /** LangChain runtime instance ID */
    instanceId: string;
    /** Agent name */
    name: string;
    /** Agent description */
    description: string;
    /** IPFS URI for agent card */
    agentCardUri: string;
    /** Creator wallet address */
    creator: string;
    /** LLM model to use */
    model: string;
    /** Plugin/capability IDs */
    plugins: string[];
    /** System prompt */
    systemPrompt?: string;
    /** Derived wallet address (PRIMARY IDENTIFIER) */
    walletAddress: string;
    /** Registration timestamp */
    createdAt: Date;
    /** Last execution timestamp */
    lastExecutedAt?: Date;
    /** Knowledge CID on Pinata (for persistence) */
    knowledgeCid?: string;
}

export interface RegisterAgentParams {
    agentId?: bigint | number | string; // Legacy
    dnaHash: `0x${string}`;
    walletAddress: string; // From IPFS metadata - single source of truth
    walletTimestamp?: number; // Optional - only needed if agent needs to sign transactions
    name: string;
    description: string;
    agentCardUri: string;
    creator: string;
    model?: string;
    plugins?: string[];
    systemPrompt?: string;
}

export interface KnowledgeItem {
    key: string;
    content: string;
    metadata?: Record<string, unknown>;
    uploadedAt: string;
}

interface AgentKnowledgeStore {
    walletAddress: string;
    items: KnowledgeItem[];
    lastUpdated: string;
}

// =============================================================================
// Storage (in-memory with Pinata persistence)
// =============================================================================

/** Registered agents by wallet address */
const registeredAgents = new Map<string, RegisteredAgent>();

/** LangChain runtime instances by wallet address */
const agentInstances = new Map<string, AgentInstance>();

/** Agent ID to wallet address mapping (for backward compatibility) */
const agentIdToWallet = new Map<string, string>();

/** In-memory knowledge cache */
const knowledgeCache = new Map<string, KnowledgeItem[]>();

// =============================================================================
// Registration
// =============================================================================

/**
 * Register a new agent from on-chain mint
 * 
 * walletAddress uses the IPFS metadata as the single source of truth
 * The backend does NOT derive the wallet address, it trusts the frontend/IPFS metadata
 * 
 * Wallet derivation (for signing transactions) is OPTIONAL:
 * - If walletTimestamp is provided, we derive and verify the wallet
 * - If not provided, agent works fine for chat (no signing capability)
 * - The wallet can be derived later when signing is actually needed
 */
export async function registerAgent(params: RegisterAgentParams): Promise<RegisteredAgent> {
    const agentId = params.agentId ? BigInt(params.agentId) : BigInt(0);

    const walletAddress = params.walletAddress;
    if (!walletAddress || !walletAddress.startsWith("0x") || walletAddress.length !== 42) {
        throw new Error(`Invalid walletAddress: ${walletAddress}. Must be provided from IPFS metadata.`);
    }

    // Check if already registered by wallet address
    if (registeredAgents.has(walletAddress)) {
        throw new Error(`Agent with wallet ${walletAddress} is already registered`);
    }

    // Wallet derivation is OPTIONAL - only needed if agent will sign transactions
    // For chat functionality, no wallet is required
    let wallet: AgentWallet | undefined;

    if (params.walletTimestamp) {
        try {
            // Derive wallet credentials from dnaHash + timestamp for agent to sign transactions
            wallet = deriveAgentWallet(params.dnaHash, params.walletTimestamp);

            // Verify the derived wallet matches the provided walletAddress
            if (wallet.address.toLowerCase() !== walletAddress.toLowerCase()) {
                console.warn(`[registry] Wallet mismatch! Provided: ${walletAddress}, Derived: ${wallet.address}`);
                console.warn(`[registry] Agent will work without signing capability.`);
                wallet = undefined; // Don't use mismatched wallet
            } else {
                console.log(`[registry] Wallet derived and verified: ${wallet.address}`);
            }
        } catch (err) {
            console.warn(`[registry] Wallet derivation failed:`, err);
            console.warn(`[registry] Agent will work without signing capability.`);
        }
    } else {
        console.log(`[registry] No walletTimestamp provided - agent will work without signing capability`);
    }

    // Build tool-aware system prompt
    const pluginNames = (params.plugins || []).map(p => {
        // Normalize plugin ID to human-readable name
        let name = p.replace(/^goat[-:]/, "").replace(/-/g, " ");
        return name.charAt(0).toUpperCase() + name.slice(1);
    });

    const toolInstructions = pluginNames.length > 0
        ? `\n\nYou have access to the following tools: ${pluginNames.join(", ")}. When a user asks a question that can be answered using one of these tools (e.g., current prices, market data, on-chain actions), you MUST use the appropriate tool to answer. Do not say you cannot access real-time information - you CAN via your tools.`
        : "";

    const basePrompt = params.systemPrompt || `You are ${params.name}. ${params.description}`;
    const enhancedPrompt = `${basePrompt}${toolInstructions}`;

    // Create LangChain runtime instance with selected plugins
    // Wallet is optional - chat works without it
    // Model comes from blockchain metadata
    if (!params.model) {
        throw new Error(`Model is required for agent ${params.name}`);
    }

    const config = {
        name: params.name,
        agentId,
        wallet, // May be undefined - that's OK for chat
        model: params.model,
        plugins: params.plugins || [],
        systemPrompt: enhancedPrompt,
        memory: true,
    };

    const instance = await createAgent(config);
    agentInstances.set(walletAddress, instance);

    const registered: RegisteredAgent = {
        agentId,
        dnaHash: params.dnaHash,
        instanceId: instance.id,
        name: params.name,
        description: params.description,
        agentCardUri: params.agentCardUri,
        creator: params.creator,
        model: config.model,
        plugins: config.plugins,
        systemPrompt: params.systemPrompt,
        walletAddress, // From params (IPFS metadata), not derived
        createdAt: new Date(),
    };

    registeredAgents.set(walletAddress, registered);
    agentIdToWallet.set(agentId.toString(), walletAddress);

    console.log(`[registry] Registered agent: ${params.name}`);
    console.log(`[registry]   Wallet: ${walletAddress}`);
    console.log(`[registry]   Has signing key: ${Boolean(wallet)}`);
    console.log(`[registry]   Plugins: ${config.plugins.join(", ") || "none"}`);

    return registered;
}

// =============================================================================
// Lookup Functions
// =============================================================================

/**
 * Get registered agent by wallet address (preferred)
 */
export function getRegisteredAgentByWallet(walletAddress: string): RegisteredAgent | undefined {
    return registeredAgents.get(walletAddress);
}

/**
 * Get registered agent by ID (backward compatibility)
 */
export function getRegisteredAgent(agentId: bigint | number | string): RegisteredAgent | undefined {
    try {
        const key = BigInt(agentId).toString();
        const walletAddress = agentIdToWallet.get(key);
        if (!walletAddress) return undefined;
        return registeredAgents.get(walletAddress);
    } catch {
        // Handle non-numeric IDs (e.g., from routing conflicts like /register)
        return undefined;
    }
}

/**
 * Get agent runtime instance by wallet address
 */
export function getAgentInstanceByWallet(walletAddress: string): AgentInstance | undefined {
    return agentInstances.get(walletAddress);
}

/**
 * Get agent runtime instance by ID (backward compatibility)
 */
export function getAgentInstance(agentId: bigint | number | string): AgentInstance | undefined {
    const key = BigInt(agentId).toString();
    const walletAddress = agentIdToWallet.get(key);
    if (!walletAddress) return undefined;
    return agentInstances.get(walletAddress);
}

/**
 * List all registered agents
 */
export function listRegisteredAgents(): RegisteredAgent[] {
    return Array.from(registeredAgents.values());
}

/**
 * Check if wallet or agent ID exists
 */
export function hasAgent(identifier: string): boolean {
    // Check if it's a wallet address
    if (identifier.startsWith("0x") && identifier.length === 42) {
        return registeredAgents.has(identifier);
    }
    // Otherwise treat as agent ID
    try {
        const walletAddress = agentIdToWallet.get(BigInt(identifier).toString());
        return walletAddress ? registeredAgents.has(walletAddress) : false;
    } catch {
        return false;
    }
}

/**
 * Resolve identifier (wallet or ID) to agent
 */
export function resolveAgent(identifier: string): RegisteredAgent | undefined {
    // Check if it's a wallet address (0x + 40 hex chars)
    if (identifier.startsWith("0x") && identifier.length === 42) {
        return registeredAgents.get(identifier);
    }
    // Otherwise treat as agent ID
    return getRegisteredAgent(identifier);
}

/**
 * Resolve identifier to instance
 */
export function resolveAgentInstance(identifier: string): AgentInstance | undefined {
    if (identifier.startsWith("0x") && identifier.length === 42) {
        return agentInstances.get(identifier);
    }
    return getAgentInstance(identifier);
}

// =============================================================================
// State Updates
// =============================================================================

/**
 * Update agent last executed timestamp
 */
export function markAgentExecuted(identifier: string): void {
    const agent = resolveAgent(identifier);
    if (agent) {
        agent.lastExecutedAt = new Date();
    }
}

/**
 * Unregister an agent
 */
export function unregisterAgent(identifier: string): boolean {
    const agent = resolveAgent(identifier);
    if (!agent) return false;

    agentInstances.delete(agent.walletAddress);
    agentIdToWallet.delete(agent.agentId.toString());
    knowledgeCache.delete(agent.walletAddress);
    return registeredAgents.delete(agent.walletAddress);
}

// =============================================================================
// Knowledge Management (Pinata Persistence)
// =============================================================================

/**
 * Upload knowledge item to agent's knowledge store
 * Persists to Pinata IPFS for long-term storage
 */
export async function uploadAgentKnowledge(
    identifier: string,
    key: string,
    content: string,
    metadata?: Record<string, unknown>
): Promise<boolean> {
    const agent = resolveAgent(identifier);
    if (!agent) {
        console.error(`[registry] Agent not found: ${identifier}`);
        return false;
    }

    const item: KnowledgeItem = {
        key,
        content,
        metadata,
        uploadedAt: new Date().toISOString(),
    };

    // Update in-memory cache
    const existing = knowledgeCache.get(agent.walletAddress) || [];
    const updated = existing.filter(i => i.key !== key); // Remove old version
    updated.push(item);
    knowledgeCache.set(agent.walletAddress, updated);

    // Persist to Pinata
    const store: AgentKnowledgeStore = {
        walletAddress: agent.walletAddress,
        items: updated,
        lastUpdated: new Date().toISOString(),
    };

    const cid = await uploadJSONToPinata(store, `${agent.name}-knowledge`, {
        type: "agent-knowledge",
        walletAddress: agent.walletAddress,
        agentId: agent.agentId.toString(),
    });

    if (cid) {
        agent.knowledgeCid = cid;
        console.log(`[registry] Knowledge saved to Pinata: ${cid}`);
    }

    return true;
}

/**
 * Get all knowledge items for an agent
 */
export async function getAgentKnowledge(identifier: string): Promise<KnowledgeItem[]> {
    const agent = resolveAgent(identifier);
    if (!agent) return [];

    // Check cache first
    const cached = knowledgeCache.get(agent.walletAddress);
    if (cached) return cached;

    // Try to load from Pinata
    if (agent.knowledgeCid) {
        const store = await fetchFromPinata<AgentKnowledgeStore>(agent.knowledgeCid);
        if (store?.items) {
            knowledgeCache.set(agent.walletAddress, store.items);
            return store.items;
        }
    }

    return [];
}

/**
 * List knowledge keys for an agent
 */
export async function listAgentKnowledgeKeys(identifier: string): Promise<string[]> {
    const items = await getAgentKnowledge(identifier);
    return items.map(i => i.key);
}

/**
 * Get specific knowledge item
 */
export async function getAgentKnowledgeItem(
    identifier: string,
    key: string
): Promise<KnowledgeItem | undefined> {
    const items = await getAgentKnowledge(identifier);
    return items.find(i => i.key === key);
}

// =============================================================================
// Initialization
// =============================================================================

console.log("[registry] Agent registry initialized");
console.log(`[registry] Pinata configured: ${Boolean(PINATA_JWT)}`);
