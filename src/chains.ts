/**
 * Chain Configuration and Client Management
 * 
 * Supports multiple EVM chains with dynamic public client creation.
 */
import { createPublicClient, http, type PublicClient } from "viem";
import {
    avalancheFuji,
    avalanche,
    cronosTestnet,
    cronos,
    arbitrumSepolia,
    arbitrum,
    bscTestnet,
    bsc
} from "viem/chains";

export const CHAIN_IDS = {
    // Avalanche
    avalancheFuji: 43113,
    avalanche: 43114,
    // Cronos
    cronosTestnet: 338,
    cronos: 25,
    // Arbitrum
    arbitrumSepolia: 421614,
    arbitrum: 42161,
    // BSC
    bscTestnet: 97,
    bsc: 56,
} as const;

export type ChainId = typeof CHAIN_IDS[keyof typeof CHAIN_IDS];

const CHAIN_MAP: Record<number, any> = {
    [CHAIN_IDS.avalancheFuji]: avalancheFuji,
    [CHAIN_IDS.avalanche]: avalanche,
    [CHAIN_IDS.cronosTestnet]: cronosTestnet,
    [CHAIN_IDS.cronos]: cronos,
    [CHAIN_IDS.arbitrumSepolia]: arbitrumSepolia,
    [CHAIN_IDS.arbitrum]: arbitrum,
    [CHAIN_IDS.bscTestnet]: bscTestnet,
    [CHAIN_IDS.bsc]: bsc,
};

const RPC_ENV_MAP: Record<number, string> = {
    [CHAIN_IDS.avalancheFuji]: "AVALANCHE_FUJI_RPC",
    [CHAIN_IDS.avalanche]: "AVALANCHE_MAINNET_RPC",
    [CHAIN_IDS.cronosTestnet]: "CRONOS_TESTNET_RPC",
    [CHAIN_IDS.cronos]: "CRONOS_MAINNET_RPC",
    [CHAIN_IDS.arbitrumSepolia]: "ARBITRUM_SEPOLIA_RPC",
    [CHAIN_IDS.arbitrum]: "ARBITRUM_MAINNET_RPC",
    [CHAIN_IDS.bscTestnet]: "BSC_TESTNET_RPC",
    [CHAIN_IDS.bsc]: "BSC_MAINNET_RPC",
};

/**
 * Cache for public clients to avoid repeated creation
 */
const clientCache = new Map<number, any>();

/**
 * Get a viem PublicClient for a specific chain.
 * RPC URL is pulled from environment variables.
 * NO FALLBACKS - throws if chain or RPC is missing.
 */
export function getPublicClient(chainId: number): PublicClient {
    const cached = clientCache.get(chainId);
    if (cached) return cached as PublicClient;

    const chain = CHAIN_MAP[chainId];
    if (!chain) {
        throw new Error(`Chain ID ${chainId} is not supported by Runtime backend.`);
    }

    const rpcEnvVar = RPC_ENV_MAP[chainId];
    const rpcUrl = rpcEnvVar ? process.env[rpcEnvVar] : null;

    if (!rpcUrl) {
        throw new Error(`RPC URL for chain ${chainId} (${rpcEnvVar}) is missing in .env`);
    }

    const client = createPublicClient({
        chain,
        transport: http(rpcUrl),
    });

    clientCache.set(chainId, client);
    return client as PublicClient;
}
