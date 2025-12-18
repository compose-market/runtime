/**
 * On-Chain Data Fetching
 * 
 * Reads Manowar and Agent data from deployed contracts on Avalanche Fuji.
 * Uses viem for contract interaction.
 */
import { createPublicClient, http, type Address } from "viem";
import { avalancheFuji } from "viem/chains";
import type { WorkflowStep } from "./manowar/types.js";
import { registerAgent, hasAgent } from "./agent-registry.js";

// =============================================================================
// Configuration
// =============================================================================

const RPC_URL = process.env.AVALANCHE_FUJI_RPC;
const USE_MAINNET = process.env.USE_MAINNET === "true";

// Contract Addresses from environment (with testnet defaults from env)
const CONTRACT_ADDRESSES = {
    AgentFactory: (process.env.AGENT_FACTORY_CONTRACT_ADDRESS || "") as Address,
    Manowar: (process.env.MANOWAR_CONTRACT_ADDRESS || "") as Address,
};

// =============================================================================
// ABIs (Minimal)
// =============================================================================

const ManowarABI = [
    {
        name: "getManowarData",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "manowarId", type: "uint256" }],
        outputs: [{
            type: "tuple",
            components: [
                { name: "title", type: "string" },
                { name: "description", type: "string" },
                { name: "banner", type: "string" },
                { name: "manowarCardUri", type: "string" },
                { name: "totalPrice", type: "uint256" },
                { name: "units", type: "uint256" },
                { name: "unitsMinted", type: "uint256" },
                { name: "creator", type: "address" },
                { name: "leaseEnabled", type: "bool" },
                { name: "leaseDuration", type: "uint256" },
                { name: "leasePercent", type: "uint8" },
                { name: "hasCoordinator", type: "bool" },
                { name: "coordinatorModel", type: "string" },
                { name: "hasActiveRfa", type: "bool" },
                { name: "rfaId", type: "uint256" },
            ],
        }],
    },
    {
        name: "getAgents",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "manowarId", type: "uint256" }],
        outputs: [{ name: "agentIds", type: "uint256[]" }],
    },
] as const;

const AgentFactoryABI = [
    {
        name: "getAgentData",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "agentId", type: "uint256" }],
        outputs: [{
            type: "tuple",
            components: [
                { name: "dnaHash", type: "bytes32" },
                { name: "licenses", type: "uint256" },
                { name: "licensesMinted", type: "uint256" },
                { name: "licensePrice", type: "uint256" },
                { name: "creator", type: "address" },
                { name: "cloneable", type: "bool" },
                { name: "isClone", type: "bool" },
                { name: "parentAgentId", type: "uint256" },
                { name: "agentCardUri", type: "string" },
            ],
        }],
    },
] as const;

// =============================================================================
// Types
// =============================================================================

interface ManowarData {
    title: string;
    description: string;
    banner: string;
    manowarCardUri: string;
    hasCoordinator: boolean;
    coordinatorModel: string;
}

interface AgentData {
    id: number;
    dnaHash: string;
    agentCardUri: string;
}

interface AgentMetadata {
    name: string;
    description: string;
    walletAddress?: string;
    plugins?: Array<{ registryId: string; name: string; origin: string }>;
    skills?: string[];
    model?: string;
}

// =============================================================================
// Client
// =============================================================================

const publicClient = createPublicClient({
    chain: avalancheFuji,
    transport: http(RPC_URL),
});

// =============================================================================
// Fetch Functions
// =============================================================================

/**
 * Fetch Manowar on-chain data
 */
export async function fetchManowarOnchain(manowarId: number): Promise<ManowarData | null> {
    try {
        const data = await publicClient.readContract({
            address: CONTRACT_ADDRESSES.Manowar,
            abi: ManowarABI,
            functionName: "getManowarData",
            args: [BigInt(manowarId)],
        });

        return {
            title: data.title,
            description: data.description,
            banner: data.banner,
            manowarCardUri: data.manowarCardUri,
            hasCoordinator: data.hasCoordinator,
            coordinatorModel: data.coordinatorModel,
        };
    } catch (error) {
        console.error(`[onchain] Failed to fetch manowar ${manowarId}:`, error);
        return null;
    }
}

/**
 * Fetch agent IDs for a manowar
 */
export async function fetchManowarAgentIds(manowarId: number): Promise<number[]> {
    try {
        const agentIds = await publicClient.readContract({
            address: CONTRACT_ADDRESSES.Manowar,
            abi: ManowarABI,
            functionName: "getAgents",
            args: [BigInt(manowarId)],
        });

        return agentIds.map((id: bigint) => Number(id));
    } catch (error) {
        console.error(`[onchain] Failed to fetch agents for manowar ${manowarId}:`, error);
        return [];
    }
}

/**
 * Fetch agent on-chain data
 */
export async function fetchAgentOnchain(agentId: number): Promise<AgentData | null> {
    try {
        const data = await publicClient.readContract({
            address: CONTRACT_ADDRESSES.AgentFactory,
            abi: AgentFactoryABI,
            functionName: "getAgentData",
            args: [BigInt(agentId)],
        });

        return {
            id: agentId,
            dnaHash: data.dnaHash,
            agentCardUri: data.agentCardUri,
        };
    } catch (error) {
        console.error(`[onchain] Failed to fetch agent ${agentId}:`, error);
        return null;
    }
}

/**
 * Fetch agent metadata from IPFS
 */
async function fetchAgentMetadata(ipfsUri: string): Promise<AgentMetadata | null> {
    if (!ipfsUri || !ipfsUri.startsWith("ipfs://")) return null;

    try {
        const cid = ipfsUri.replace("ipfs://", "");
        // Skip invalid CIDs
        if (!cid.startsWith("Qm") && !cid.startsWith("baf")) return null;

        const gateway = process.env.PINATA_GATEWAY || "compose.mypinata.cloud";
        const url = `https://${gateway}/ipfs/${cid}`;

        const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) return null;

        return await response.json() as AgentMetadata;
    } catch (error) {
        console.error(`[onchain] Failed to fetch metadata from ${ipfsUri}:`, error);
        return null;
    }
}

interface ManowarMetadata {
    schemaVersion: string;
    title: string;
    description: string;
    walletAddress?: string;
    dnaHash?: string;
}

/**
 * Fetch manowar metadata via tokenURI (standard ERC721)
 */
async function fetchManowarMetadataFromTokenUri(manowarId: number): Promise<ManowarMetadata | null> {
    try {
        // Add tokenURI to the ABI for this call
        const tokenUri = await publicClient.readContract({
            address: CONTRACT_ADDRESSES.Manowar,
            abi: [...ManowarABI, {
                name: "tokenURI",
                type: "function",
                stateMutability: "view",
                inputs: [{ name: "tokenId", type: "uint256" }],
                outputs: [{ name: "uri", type: "string" }],
            }] as const,
            functionName: "tokenURI",
            args: [BigInt(manowarId)],
        }) as string;

        if (!tokenUri) return null;

        // Handle IPFS URIs
        let metadataUrl = tokenUri;
        if (tokenUri.startsWith("ipfs://")) {
            const cid = tokenUri.replace("ipfs://", "");
            const gateway = process.env.PINATA_GATEWAY || "compose.mypinata.cloud";
            metadataUrl = `https://${gateway}/ipfs/${cid}`;
        }

        const response = await fetch(metadataUrl, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) return null;

        return await response.json() as ManowarMetadata;
    } catch (error) {
        console.error(`[onchain] Failed to fetch manowar metadata for ID ${manowarId}:`, error);
        return null;
    }
}

/**
 * Fetch total number of manowars
 */
async function fetchTotalManowars(): Promise<number> {
    try {
        const total = await publicClient.readContract({
            address: CONTRACT_ADDRESSES.Manowar,
            abi: [...ManowarABI, {
                name: "totalManowars",
                type: "function",
                stateMutability: "view",
                inputs: [],
                outputs: [{ name: "total", type: "uint256" }],
            }] as const,
            functionName: "totalManowars",
            args: [],
        });
        return Number(total);
    } catch (error) {
        console.error(`[onchain] Failed to fetch total manowars:`, error);
        return 0;
    }
}

/**
 * Find manowar by wallet address (iterates all manowars and checks metadata)
 */
export async function fetchManowarByWalletAddress(walletAddress: string): Promise<{ manowarId: number; data: ManowarData } | null> {
    const total = await fetchTotalManowars();
    const normalizedSearch = walletAddress.toLowerCase();

    // Search in reverse (most recent first)
    for (let i = total; i >= 1; i--) {
        const manowarData = await fetchManowarOnchain(i);
        if (!manowarData) continue;

        // Fetch metadata via tokenURI to get wallet address
        const metadata = await fetchManowarMetadataFromTokenUri(i);
        if (metadata?.walletAddress && metadata.walletAddress.toLowerCase() === normalizedSearch) {
            return { manowarId: i, data: manowarData };
        }
    }

    return null;
}

/**
 * Resolve manowar identifier (supports both wallet address and numeric ID)
 */
export async function resolveManowarIdentifier(identifier: string): Promise<{ manowarId: number; data: ManowarData } | null> {
    // Check if it's a wallet address (0x + 40 hex chars)
    if (identifier.startsWith("0x") && identifier.length === 42) {
        return fetchManowarByWalletAddress(identifier);
    }

    // Otherwise treat as numeric ID
    const numericId = parseInt(identifier);
    if (isNaN(numericId)) return null;

    const data = await fetchManowarOnchain(numericId);
    if (!data) return null;

    return { manowarId: numericId, data };
}

/**
 * Build workflow steps from manowar on-chain data
 * 
 * Fetches:
 * 1. Manowar data from contract
 * 2. Agent IDs from manowar
 * 3. Each agent's on-chain data
 * 4. Each agent's IPFS metadata (for plugins/tools)
 * 
 * Returns workflow steps representing each agent in the manowar
 */
export async function buildManowarWorkflow(manowarId: number): Promise<{
    id: string;
    name: string;
    description: string;
    steps: WorkflowStep[];
} | null> {
    console.log(`[onchain] Building workflow for manowar ${manowarId}...`);

    // 1. Fetch manowar data
    const manowarData = await fetchManowarOnchain(manowarId);
    if (!manowarData) {
        console.error(`[onchain] Manowar ${manowarId} not found`);
        return null;
    }

    // 2. Fetch agent IDs
    const agentIds = await fetchManowarAgentIds(manowarId);
    console.log(`[onchain] Manowar ${manowarId} has ${agentIds.length} agents: [${agentIds.join(", ")}]`);

    // 3. Build workflow steps from agents
    const steps: WorkflowStep[] = [];

    for (const agentId of agentIds) {
        const agentData = await fetchAgentOnchain(agentId);
        if (!agentData) continue;

        // Fetch metadata for plugins/tools
        const metadata = await fetchAgentMetadata(agentData.agentCardUri);

        // Auto-register the agent if not already registered
        // This ensures agents are available when manowar delegates to them
        if (metadata?.walletAddress && !hasAgent(metadata.walletAddress)) {
            try {
                console.log(`[onchain] Auto-registering agent ${metadata.name || agentId} (${metadata.walletAddress})...`);

                // Model comes from blockchain metadata
                if (!metadata.model) {
                    throw new Error(`Agent ${metadata.name || agentId} has no model specified in blockchain metadata`);
                }

                await registerAgent({
                    dnaHash: agentData.dnaHash as `0x${string}`,
                    walletAddress: metadata.walletAddress,
                    name: metadata.name || `Agent #${agentId}`,
                    description: metadata.description || "",
                    agentCardUri: agentData.agentCardUri,
                    creator: "0x0000000000000000000000000000000000000000", // Unknown creator
                    model: metadata.model,
                    plugins: metadata.plugins?.map((p: any) => p.registryId || p.name || p) || [],
                    systemPrompt: (metadata as any).systemPrompt,
                });
                console.log(`[onchain] Successfully registered agent ${metadata.walletAddress}`);
            } catch (err) {
                // Agent might already be registered (race condition), that's OK
                console.warn(`[onchain] Agent registration skipped (may already exist): ${err instanceof Error ? err.message : err}`);
            }
        }

        // Create agent step
        steps.push({
            id: `agent-${agentId}`,
            name: metadata?.name || `Agent #${agentId}`,
            type: "agent",
            agentId: agentId,
            agentAddress: metadata?.walletAddress,
            inputTemplate: {
                agentId: agentId,
                walletAddress: metadata?.walletAddress,
                skills: metadata?.skills || [],
                plugins: metadata?.plugins || [],
                model: metadata?.model,
            },
            saveAs: `agent_${agentId}_output`,
        });

        console.log(`[onchain] Added agent step: ${metadata?.name || `Agent #${agentId}`} with ${metadata?.plugins?.length || 0} plugins`);
    }

    return {
        id: `manowar-${manowarId}`,
        name: manowarData.title || `Manowar #${manowarId}`,
        description: manowarData.description || "",
        steps,
    };
}
