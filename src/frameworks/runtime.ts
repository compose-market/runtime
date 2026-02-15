/**
 * Unified Runtime Manager
 *
 * Consolidated runtime management for Agents and Manowars.
 * Previously split across agent-registry.ts and manowar-registry.ts.
 * 
 * Key features:
 * - Agent: LangChain runtime instances, wallet derivation, knowledge persistence
 * - Manowar: Workflow metadata, agent coordination
 * - Uses wallet address as primary identifier
 * - Persists knowledge to Pinata IPFS
 */
import { createAgent, type AgentConfig, type AgentInstance } from "./langchain.js";
import { deriveAgentWallet, type AgentWallet } from "../agent-wallet.js";

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
        console.warn("[runtime] Pinata not configured, using memory-only storage");
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
        console.error(`[runtime] Pinata upload failed: ${error}`);
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
            console.error(`[runtime] Failed to fetch from IPFS: ${response.statusText}`);
            return null;
        }
        return response.json();
    } catch (err) {
        console.error(`[runtime] Error fetching from IPFS:`, err);
        return null;
    }
}

/**
 * Upload base64-encoded media to Pinata IPFS
 * Returns the full HTTPS gateway URL for immediate display
 */
export async function uploadBase64ToPinata(
    base64: string,
    type: "image" | "audio" | "video",
    agentWallet?: string
): Promise<string | null> {
    if (!PINATA_JWT) {
        console.warn("[runtime] Pinata not configured for base64 upload");
        return null;
    }

    const mimeTypes = {
        image: "image/png",
        audio: "audio/wav",
        video: "video/mp4",
    };
    const extensions = {
        image: "png",
        audio: "wav",
        video: "mp4",
    };

    try {
        // Convert base64 to binary Buffer
        const binaryData = Buffer.from(base64, "base64");
        const blob = new Blob([binaryData], { type: mimeTypes[type] });
        const filename = `${type}-${Date.now()}.${extensions[type]}`;

        const formData = new FormData();
        formData.append("file", blob, filename);
        formData.append("pinataMetadata", JSON.stringify({
            name: filename,
            keyvalues: {
                type,
                agentWallet: agentWallet || "unknown",
                source: "manowar-multimodal",
            },
        }));
        formData.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));

        const response = await fetch(`${PINATA_API_URL}/pinning/pinFileToIPFS`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${PINATA_JWT}`,
            },
            body: formData,
        });

        if (!response.ok) {
            const error = await response.text();
            console.error(`[runtime] Pinata base64 upload failed: ${error}`);
            return null;
        }

        const result: PinataUploadResponse = await response.json();
        const url = `https://${PINATA_GATEWAY}/ipfs/${result.IpfsHash}`;
        console.log(`[runtime] Uploaded ${type} to IPFS: ${url}`);
        return url;
    } catch (err) {
        console.error(`[runtime] Error uploading base64 to Pinata:`, err);
        return null;
    }
}

// =============================================================================
// Agent Types
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
// Manowar Types
// =============================================================================

export interface RegisteredManowar {
    /** Derived wallet address (PRIMARY IDENTIFIER - used for all lookups) */
    walletAddress: string;
    /** On-chain manowar ID (ERC721 NFT ID) - stored for on-chain reference only */
    onchainTokenId: number;
    /** IPFS URI to manowarCard */
    manowarCardUri?: string;
    /** DNA hash from contract */
    dnaHash?: string;
    /** Manowar title */
    title: string;
    /** Manowar description */
    description: string;
    /** Banner image URI */
    banner?: string;
    /** Creator wallet address */
    creator: string;
    /** Has coordinator */
    hasCoordinator?: boolean;
    /** Coordinator model (user-selected at mint time) */
    coordinatorModel?: string;
    /** Total price in USDC (formatted) */
    totalPrice?: string;
    /** Agent wallet addresses in this workflow */
    agentWalletAddresses?: string[];
    /** Registration timestamp */
    createdAt: Date;
    /** Last execution timestamp */
    lastExecutedAt?: Date;
}

export interface RegisterManowarParams {
    /** PRIMARY IDENTIFIER - wallet address derived from on-chain data */
    walletAddress: string;
    /** On-chain token ID (for display/on-chain reference only) */
    onchainTokenId: number;
    /** IPFS URI to manowarCard */
    manowarCardUri?: string;
    dnaHash?: string;
    title: string;
    description: string;
    banner?: string;
    creator: string;
    hasCoordinator?: boolean;
    coordinatorModel?: string;
    totalPrice?: string;
    agentWalletAddresses?: string[];
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

/** Registered manowars by wallet address (ONLY lookup method) */
const registeredManowars = new Map<string, RegisteredManowar>();

// =============================================================================
// Agent Registration
// =============================================================================

const agentRuntimeWarmups = new Map<string, Promise<AgentInstance>>();
const agentRuntimeWarmupErrors = new Map<string, string>();
const agentRuntimeConfigs = new Map<string, AgentConfig>();

export interface RegisterAgentOptions {
    waitForRuntime?: boolean;
}

export interface RegisterAgentWarmupResult {
    agent: RegisteredAgent;
    status: "ready" | "warming";
    warmupError?: string;
}

function isValidWalletAddress(walletAddress: string): boolean {
    return walletAddress.startsWith("0x") && walletAddress.length === 42;
}

async function validateAgentCardUri(agentCardUri: string, walletAddress: string): Promise<void> {
    if (!agentCardUri || !agentCardUri.startsWith("ipfs://")) {
        return;
    }

    const cid = agentCardUri.replace("ipfs://", "");
    if (!cid.startsWith("Qm") && !cid.startsWith("baf")) {
        console.warn(`[runtime] Invalid agentCardUri CID format: ${cid}. Continuing registration.`);
        return;
    }

    try {
        const metadata = await fetchFromPinata<{
            walletAddress?: string;
            name?: string;
            model?: string;
        }>(cid);

        if (!metadata) {
            console.warn(`[runtime] Could not fetch agentCardUri metadata from IPFS: ${agentCardUri}. Continuing registration.`);
            return;
        }

        if (metadata.walletAddress && metadata.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
            throw new Error(
                `Wallet address mismatch! IPFS metadata has ${metadata.walletAddress} but registration provided ${walletAddress}. Registration rejected.`,
            );
        }
        console.log(`[runtime] agentCardUri validated: ${agentCardUri}`);
    } catch (err) {
        if (err instanceof Error && err.message.includes("mismatch")) {
            throw err;
        }
        console.warn(`[runtime] Could not validate agentCardUri: ${err}. Continuing registration.`);
    }
}

function deriveSigningWallet(params: RegisterAgentParams, walletAddress: string): AgentWallet | undefined {
    if (!params.walletTimestamp) {
        return undefined;
    }

    try {
        const wallet = deriveAgentWallet(params.dnaHash, params.walletTimestamp);
        if (wallet.address.toLowerCase() !== walletAddress.toLowerCase()) {
            console.warn(`[runtime] Wallet mismatch! Provided: ${walletAddress}, Derived: ${wallet.address}. Signing disabled.`);
            return undefined;
        }
        return wallet;
    } catch (err) {
        console.warn("[runtime] Wallet derivation failed, signing disabled:", err);
        return undefined;
    }
}

function buildEnhancedPrompt(name: string, description: string, plugins: string[], systemPrompt?: string): string {
    const pluginNames = plugins.map((pluginId) => {
        const normalized = pluginId.replace(/^goat[-:]/, "").replace(/-/g, " ");
        return normalized.charAt(0).toUpperCase() + normalized.slice(1);
    });

    const toolInstructions = pluginNames.length > 0
        ? `\n\nYou have access to the following tools: ${pluginNames.join(", ")}. When a user asks a question that can be answered using one of these tools (e.g., current prices, market data, on-chain actions), you MUST use the appropriate tool to answer. Do not say you cannot access real-time information - you CAN via your tools.`
        : "";

    const basePrompt = systemPrompt || `You are ${name}. ${description}`;
    return `${basePrompt}${toolInstructions}`;
}

function buildRuntimeConfig(
    walletAddress: string,
    wallet: AgentWallet | undefined,
    params: RegisterAgentParams,
): AgentConfig {
    if (!params.model) {
        throw new Error(`Model is required for agent ${params.name}`);
    }

    const plugins = params.plugins || [];
    return {
        name: params.name,
        agentWallet: walletAddress,
        wallet,
        model: params.model,
        plugins,
        systemPrompt: buildEnhancedPrompt(params.name, params.description, plugins, params.systemPrompt),
        memory: true,
    };
}

function buildRuntimeConfigFromRegistered(agent: RegisteredAgent): AgentConfig {
    return {
        name: agent.name,
        agentWallet: agent.walletAddress,
        model: agent.model,
        plugins: agent.plugins || [],
        systemPrompt: buildEnhancedPrompt(agent.name, agent.description, agent.plugins || [], agent.systemPrompt),
        memory: true,
    };
}

async function ensureAgentRuntimeInternal(walletAddress: string, incomingConfig?: AgentConfig): Promise<AgentInstance> {
    const existing = agentInstances.get(walletAddress);
    if (existing) {
        return existing;
    }

    const inFlight = agentRuntimeWarmups.get(walletAddress);
    if (inFlight) {
        return inFlight;
    }

    const config =
        incomingConfig ||
        agentRuntimeConfigs.get(walletAddress) ||
        (registeredAgents.get(walletAddress) ? buildRuntimeConfigFromRegistered(registeredAgents.get(walletAddress)!) : undefined);

    if (!config) {
        throw new Error(`No runtime configuration available for agent ${walletAddress}`);
    }

    agentRuntimeConfigs.set(walletAddress, config);

    const warmupPromise = (async () => {
        try {
            const instance = await createAgent(config);
            agentInstances.set(walletAddress, instance);
            const registered = registeredAgents.get(walletAddress);
            if (registered) {
                registered.instanceId = instance.id;
            }
            agentRuntimeWarmupErrors.delete(walletAddress);
            return instance;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            agentRuntimeWarmupErrors.set(walletAddress, message);
            throw error;
        } finally {
            agentRuntimeWarmups.delete(walletAddress);
        }
    })();

    agentRuntimeWarmups.set(walletAddress, warmupPromise);
    void warmupPromise.catch(() => {
        // Suppress unhandled rejections for fire-and-forget warmups.
    });
    return warmupPromise;
}

export function isAgentRuntimeWarming(walletAddress: string): boolean {
    return agentRuntimeWarmups.has(walletAddress);
}

export function getAgentRuntimeWarmupError(walletAddress: string): string | undefined {
    return agentRuntimeWarmupErrors.get(walletAddress);
}

export async function ensureAgentRuntimeReady(walletAddress: string): Promise<AgentInstance> {
    return ensureAgentRuntimeInternal(walletAddress);
}

/**
 * Register a new agent from on-chain mint
 * walletAddress uses the IPFS metadata as the single source of truth
 */
export async function registerAgent(
    params: RegisterAgentParams,
    options: RegisterAgentOptions = {},
): Promise<RegisteredAgent> {
    const waitForRuntime = options.waitForRuntime !== false;
    const agentId = params.agentId ? BigInt(params.agentId) : BigInt(0);

    const walletAddress = params.walletAddress;
    if (!walletAddress || !isValidWalletAddress(walletAddress)) {
        throw new Error(`Invalid walletAddress: ${walletAddress}. Must be provided from IPFS metadata.`);
    }

    await validateAgentCardUri(params.agentCardUri, walletAddress);

    const existing = registeredAgents.get(walletAddress);
    if (existing) {
        if (waitForRuntime && !agentInstances.has(walletAddress)) {
            await ensureAgentRuntimeInternal(walletAddress);
        }
        return existing;
    }

    const wallet = deriveSigningWallet(params, walletAddress);
    const runtimeConfig = buildRuntimeConfig(walletAddress, wallet, params);
    agentRuntimeConfigs.set(walletAddress, runtimeConfig);

    const registered: RegisteredAgent = {
        agentId,
        dnaHash: params.dnaHash,
        instanceId: walletAddress,
        name: params.name,
        description: params.description,
        agentCardUri: params.agentCardUri,
        creator: params.creator,
        model: runtimeConfig.model || params.model || "unknown",
        plugins: runtimeConfig.plugins || [],
        systemPrompt: params.systemPrompt,
        walletAddress,
        createdAt: new Date(),
    };

    registeredAgents.set(walletAddress, registered);
    agentIdToWallet.set(agentId.toString(), walletAddress);

    const warmupPromise = ensureAgentRuntimeInternal(walletAddress, runtimeConfig);
    if (waitForRuntime) {
        await warmupPromise;
    }

    const readyInstance = agentInstances.get(walletAddress);
    if (readyInstance) {
        registered.instanceId = readyInstance.id;
    }

    return registeredAgents.get(walletAddress)!;
}

export async function registerAgentWithWarmup(params: RegisterAgentParams): Promise<RegisterAgentWarmupResult> {
    const agent = await registerAgent(params, { waitForRuntime: false });
    const ready = Boolean(agentInstances.get(agent.walletAddress));
    return {
        agent,
        status: ready ? "ready" : "warming",
        warmupError: getAgentRuntimeWarmupError(agent.walletAddress),
    };
}

// =============================================================================
// Agent Lookup Functions
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
// Agent State Updates
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
    agentRuntimeWarmups.delete(agent.walletAddress);
    agentRuntimeWarmupErrors.delete(agent.walletAddress);
    agentRuntimeConfigs.delete(agent.walletAddress);
    agentIdToWallet.delete(agent.agentId.toString());
    knowledgeCache.delete(agent.walletAddress);
    return registeredAgents.delete(agent.walletAddress);
}

// =============================================================================
// Agent Knowledge Management (Pinata Persistence)
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
        console.error(`[runtime] Agent not found: ${identifier}`);
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
        console.log(`[runtime] Knowledge saved to Pinata: ${cid}`);
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
// Manowar Registration
// =============================================================================

/**
 * Register a manowar workflow
 * 
 * walletAddress is the PRIMARY and ONLY identifier
 */
export async function registerManowar(params: RegisterManowarParams): Promise<RegisteredManowar> {
    const walletAddress = params.walletAddress;
    if (!walletAddress || !walletAddress.startsWith("0x") || walletAddress.length !== 42) {
        throw new Error(`Invalid walletAddress: ${walletAddress}. Must be a valid Ethereum address.`);
    }

    // Validate manowarCardUri
    if (params.manowarCardUri && params.manowarCardUri.startsWith("ipfs://")) {
        const cid = params.manowarCardUri.replace("ipfs://", "");
        // Validate CID format - proper IPFS CIDs start with 'Qm' (v0) or 'bafy/bafk' (v1)
        if (!cid.startsWith("Qm") && !cid.startsWith("baf")) {
            throw new Error(`Invalid manowarCardUri CID format: ${cid}. Must be a valid IPFS CID.`);
        }

        try {
            const gatewayUrl = `https://${PINATA_GATEWAY}/ipfs/${cid}`;
            const response = await fetch(gatewayUrl);

            if (response.ok) {
                const metadata = await response.json() as {
                    walletAddress?: string;
                    title?: string;
                };

                // Verify wallet address from IPFS matches provided wallet address
                if (metadata.walletAddress &&
                    metadata.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
                    throw new Error(
                        `Wallet address mismatch! IPFS metadata has ${metadata.walletAddress} ` +
                        `but registration provided ${walletAddress}. Registration rejected.`
                    );
                }

                console.log(`[runtime] ✅ manowarCardUri validated: ${params.manowarCardUri}`);
            } else {
                console.warn(`[runtime] ⚠️ Could not fetch manowarCardUri: HTTP ${response.status}`);
            }
        } catch (err) {
            if (err instanceof Error && err.message.includes("mismatch")) {
                throw err; // Re-throw validation errors
            }
            console.warn(`[runtime] ⚠️ Could not validate manowarCardUri: ${err}`);
            // Continue with registration - IPFS may be temporarily unavailable
        }
    }

    // Check if already registered by wallet address
    if (registeredManowars.has(walletAddress)) {
        const existing = registeredManowars.get(walletAddress)!;
        console.log(`[runtime] Already registered: ${params.title} (${walletAddress})`);
        return existing;
    }

    const registered: RegisteredManowar = {
        walletAddress,
        onchainTokenId: params.onchainTokenId,
        manowarCardUri: params.manowarCardUri,
        dnaHash: params.dnaHash,
        title: params.title,
        description: params.description,
        banner: params.banner,
        creator: params.creator,
        hasCoordinator: params.hasCoordinator,
        coordinatorModel: params.coordinatorModel,
        totalPrice: params.totalPrice,
        agentWalletAddresses: params.agentWalletAddresses,
        createdAt: new Date(),
    };

    registeredManowars.set(walletAddress, registered);

    console.log(`[runtime] Registered manowar: ${params.title}`);
    console.log(`[runtime]   Wallet: ${walletAddress}`);
    console.log(`[runtime]   CardURI: ${params.manowarCardUri || "none"}`);
    console.log(`[runtime]   Coordinator: ${params.coordinatorModel || "none"}`);
    console.log(`[runtime]   Agents: [${params.agentWalletAddresses?.join(", ") || "none"}]`);

    return registered;
}

// =============================================================================
// Manowar Lookup Functions
// =============================================================================

/**
 * Get registered manowar by wallet address
 */
export function getManowar(walletAddress: string): RegisteredManowar | undefined {
    return registeredManowars.get(walletAddress);
}

/**
 * List all registered manowars
 */
export function listRegisteredManowars(): RegisteredManowar[] {
    return Array.from(registeredManowars.values());
}

/**
 * Check if manowar exists by wallet address
 */
export function hasManowar(walletAddress: string): boolean {
    return registeredManowars.has(walletAddress);
}

// =============================================================================
// Manowar State Updates
// =============================================================================

/**
 * Update manowar last executed timestamp
 */
export function markManowarExecuted(walletAddress: string): void {
    const manowar = registeredManowars.get(walletAddress);
    if (manowar) {
        manowar.lastExecutedAt = new Date();
    }
}

/**
 * Unregister a manowar
 */
export function unregisterManowar(walletAddress: string): boolean {
    return registeredManowars.delete(walletAddress);
}

// =============================================================================
// Initialization
// =============================================================================

console.log("[runtime] Unified runtime manager initialized");
console.log(`[runtime] Pinata configured: ${Boolean(PINATA_JWT)}`);
