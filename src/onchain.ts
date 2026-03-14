/**
 * On-Chain Data Fetching
 * 
 * Reads Workflow and Agent data from deployed contracts on supported chains.
 * Uses viem for contract interaction.
 */
import { type Address } from "viem";
import type { WorkflowStep } from "./workflow/types.js";
import { registerAgent, hasAgent } from "./frameworks/runtime.js";
import { buildPinataGatewayIpfsUrl } from "./auth.js";
import { getPublicClient } from "./chains.js";

// =============================================================================
// Configuration
// =============================================================================

// Universal Contract Addresses from environment
const AGENT_FACTORY_CONTRACT = (process.env.AGENT_FACTORY_CONTRACT || "") as Address;
const WORKFLOW_CONTRACT = (process.env.WORKFLOW_CONTRACT || "") as Address;

// =============================================================================
// ABIs (Minimal)
// =============================================================================

const AgentFactoryABI = [
    {
        name: "getAgentData",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "agentId", type: "uint256" }],
        outputs: [{
            name: "data",
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
    {
        name: "totalAgents",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "total", type: "uint256" }],
    },
] as const;

const WorkflowABI = [
    {
        name: "getWorkflowData",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "workflowId", type: "uint256" }],
        outputs: [{
            name: "data",
            type: "tuple",
            components: [
                { name: "title", type: "string" },
                { name: "description", type: "string" },
                { name: "banner", type: "string" },
                { name: "workflowCardUri", type: "string" },
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
        inputs: [{ name: "workflowId", type: "uint256" }],
        outputs: [{ name: "agentIds", type: "uint256[]" }],
    },
    {
        name: "totalWorkflows",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "total", type: "uint256" }],
    },
    {
        name: "tokenURI",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [{ name: "uri", type: "string" }],
    },
] as const;

// =============================================================================
// Types
// =============================================================================

interface WorkflowData {
    walletAddress: string;
    dnaHash: string;
    title: string;
    description: string;
    banner: string;
    workflowCardUri: string;
    hasCoordinator: boolean;
    coordinatorModel: string;
    agentWalletAddresses: string[];
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
    framework?: "langchain" | "openclaw" | "eliza";
}

// =============================================================================
// Fetch Functions
// =============================================================================

/**
 * Fetch Workflow on-chain data
 */
export async function fetchWorkflowOnchain(chainId: number, workflowId: number): Promise<WorkflowData | null> {
    try {
        const client = getPublicClient(chainId);
        const data = await client.readContract({
            address: WORKFLOW_CONTRACT,
            abi: WorkflowABI,
            functionName: "getWorkflowData",
            args: [BigInt(workflowId)],
        });

        // Fetch tokenURI to get walletAddress and dnaHash from IPFS metadata
        const tokenUri = await client.readContract({
            address: WORKFLOW_CONTRACT,
            abi: WorkflowABI,
            functionName: "tokenURI",
            args: [BigInt(workflowId)],
        });

        let walletAddress = "0x0000000000000000000000000000000000000000";
        let dnaHash = "0x0000000000000000000000000000000000000000000000000000000000000000";
        if (tokenUri) {
            const metadata = await fetchIpfsMetadata<{ walletAddress: string; dnaHash: string }>(tokenUri);
            if (metadata) {
                walletAddress = metadata.walletAddress || walletAddress;
                dnaHash = metadata.dnaHash || dnaHash;
            }
        }

        // Fetch agent IDs and resolve their wallet addresses
        const agentIds = await fetchWorkflowAgentIds(chainId, workflowId);
        const agentWalletAddresses: string[] = [];
        for (const agentId of agentIds) {
            const agentData = await fetchAgentOnchain(chainId, agentId);
            if (agentData) {
                const metadata = await fetchIpfsMetadata<{ walletAddress: string }>(agentData.agentCardUri);
                if (metadata?.walletAddress) {
                    agentWalletAddresses.push(metadata.walletAddress);
                }
            }
        }

        const [
            title,
            description,
            banner,
            workflowCardUri,
            totalPrice,
            units,
            unitsMinted,
            creator,
            leaseEnabled,
            leaseDuration,
            leasePercent,
            hasCoordinator,
            coordinatorModel,
            hasActiveRfa,
            rfaId
        ] = data as any;

        return {
            walletAddress,
            dnaHash,
            title,
            description,
            banner,
            workflowCardUri,
            hasCoordinator,
            coordinatorModel,
            agentWalletAddresses,
        };
    } catch (error) {
        console.error(`[onchain][chain:${chainId}] Failed to fetch workflow ${workflowId}:`, error);
        return null;
    }
}

/**
 * Fetch agent IDs for a workflow
 */
export async function fetchWorkflowAgentIds(chainId: number, workflowId: number): Promise<number[]> {
    try {
        const client = getPublicClient(chainId);
        const agentIds = await client.readContract({
            address: WORKFLOW_CONTRACT,
            abi: WorkflowABI,
            functionName: "getAgents",
            args: [BigInt(workflowId)],
        });

        return agentIds.map((id: bigint) => Number(id));
    } catch (error) {
        console.error(`[onchain][chain:${chainId}] Failed to fetch agents for workflow ${workflowId}:`, error);
        return [];
    }
}

/**
 * Fetch agent on-chain data
 */
export async function fetchAgentOnchain(chainId: number, agentId: number): Promise<AgentData | null> {
    try {
        const client = getPublicClient(chainId);
        const data = await client.readContract({
            address: AGENT_FACTORY_CONTRACT,
            abi: AgentFactoryABI,
            functionName: "getAgentData",
            args: [BigInt(agentId)],
        });

        const [
            dnaHash,
            licenses,
            licensesMinted,
            licensePrice,
            creator,
            cloneable,
            isClone,
            parentAgentId,
            agentCardUri
        ] = data as any;

        return {
            id: agentId,
            dnaHash,
            agentCardUri,
        };
    } catch (error) {
        console.error(`[onchain][chain:${chainId}] Failed to fetch agent ${agentId}:`, error);
        return null;
    }
}

/**
 * Fetch metadata from IPFS
 */
async function fetchIpfsMetadata<T>(ipfsUri: string): Promise<T | null> {
    if (!ipfsUri || !ipfsUri.startsWith("ipfs://")) return null;

    try {
        const cid = ipfsUri.replace("ipfs://", "");
        if (!cid.startsWith("Qm") && !cid.startsWith("baf")) return null;

        const url = buildPinataGatewayIpfsUrl(cid);

        const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) return null;

        return await response.json() as T;
    } catch (error) {
        console.error(`[onchain] Failed to fetch IPFS metadata from ${ipfsUri}:`, error);
        return null;
    }
}

interface WorkflowMetadata {
    schemaVersion: string;
    title: string;
    description: string;
    walletAddress?: string;
    dnaHash?: string;
}

/**
 * Fetch total number of workflows
 */
async function fetchTotalWorkflows(chainId: number): Promise<number> {
    try {
        const client = getPublicClient(chainId);
        const total = await client.readContract({
            address: WORKFLOW_CONTRACT,
            abi: WorkflowABI,
            functionName: "totalWorkflows",
            args: [],
        });
        return Number(total);
    } catch (error) {
        console.error(`[onchain][chain:${chainId}] Failed to fetch total workflows:`, error);
        return 0;
    }
}

/**
 * Find workflow by wallet address
 */
export async function fetchWorkflowByWalletAddress(chainId: number, walletAddress: string): Promise<{ workflowId: number; data: WorkflowData } | null> {
    const total = await fetchTotalWorkflows(chainId);
    const normalizedSearch = walletAddress.toLowerCase();
    const client = getPublicClient(chainId);

    // Search in reverse (most recent first)
    for (let i = total; i >= 1; i--) {
        const workflowData = await fetchWorkflowOnchain(chainId, i);
        if (!workflowData) continue;

        try {
            const tokenUri = await client.readContract({
                address: WORKFLOW_CONTRACT,
                abi: WorkflowABI,
                functionName: "tokenURI",
                args: [BigInt(i)],
            });

            if (tokenUri) {
                const metadata = await fetchIpfsMetadata<WorkflowMetadata>(tokenUri);
                if (metadata?.walletAddress && metadata.walletAddress.toLowerCase() === normalizedSearch) {
                    return { workflowId: i, data: workflowData };
                }
            }
        } catch (err) {
            console.warn(`[onchain][chain:${chainId}] Failed to fetch tokenURI/metadata for workflow ${i}:`, err);
        }
    }

    return null;
}

/**
 * Resolve workflow identifier (supports both wallet address and numeric ID)
 */
export async function resolveWorkflowIdentifier(chainId: number, identifier: string): Promise<{ workflowId: number; data: WorkflowData } | null> {
    // Check if it's a wallet address
    if (identifier.startsWith("0x") && identifier.length === 42) {
        return fetchWorkflowByWalletAddress(chainId, identifier);
    }

    // Otherwise treat as numeric ID
    const numericId = parseInt(identifier);
    if (isNaN(numericId)) return null;

    const data = await fetchWorkflowOnchain(chainId, numericId);
    if (!data) return null;

    return { workflowId: numericId, data };
}

/**
 * Build workflow steps from workflow on-chain data
 */
export async function buildWorkflowWorkflow(chainId: number, workflowId: number): Promise<{
    id: string;
    name: string;
    description: string;
    steps: WorkflowStep[];
} | null> {
    console.log(`[onchain][chain:${chainId}] Building workflow for workflow ${workflowId}...`);

    // 1. Fetch workflow data
    const workflowData = await fetchWorkflowOnchain(chainId, workflowId);
    if (!workflowData) {
        console.error(`[onchain][chain:${chainId}] Workflow ${workflowId} not found`);
        return null;
    }

    // 2. Fetch agent IDs
    const agentIds = await fetchWorkflowAgentIds(chainId, workflowId);
    console.log(`[onchain][chain:${chainId}] Workflow ${workflowId} has ${agentIds.length} agents: [${agentIds.join(", ")}]`);

    // 3. Build workflow steps from agents
    const steps: WorkflowStep[] = [];

    for (const agentId of agentIds) {
        const agentData = await fetchAgentOnchain(chainId, agentId);
        if (!agentData) continue;

        // Fetch metadata for plugins/tools
        const metadata = await fetchIpfsMetadata<AgentMetadata>(agentData.agentCardUri);

        // Auto-register the agent if not already registered
        if (metadata?.walletAddress && !hasAgent(metadata.walletAddress)) {
            try {
                console.log(`[onchain][chain:${chainId}] Auto-registering agent ${metadata.name || agentId} (${metadata.walletAddress})...`);

                if (!metadata.model) {
                    throw new Error(`Agent ${metadata.name || agentId} has no model specified in metadata`);
                }

                await registerAgent({
                    chainId: chainId,
                    dnaHash: agentData.dnaHash as `0x${string}`,
                    walletAddress: metadata.walletAddress,
                    name: metadata.name || `Agent #${agentId}`,
                    description: metadata.description || "",
                    agentCardUri: agentData.agentCardUri,
                    creator: "0x0000000000000000000000000000000000000000",
                    model: metadata.model,
                    framework: metadata.framework || "langchain",
                    plugins: metadata.plugins?.map((p: any) => p.registryId || p.name || p) || [],
                    systemPrompt: (metadata as any).systemPrompt,
                });
                console.log(`[onchain][chain:${chainId}] Successfully registered agent ${metadata.walletAddress}`);
            } catch (err) {
                console.warn(`[onchain][chain:${chainId}] Agent registration skipped: ${err instanceof Error ? err.message : err}`);
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

        console.log(`[onchain][chain:${chainId}] Added agent step: ${metadata?.name || `Agent #${agentId}`}`);
    }

    return {
        id: `workflow-${workflowId}`,
        name: workflowData.title || `Workflow #${workflowId}`,
        description: workflowData.description || "",
        steps,
    };
}
