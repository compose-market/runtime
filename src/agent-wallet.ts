/**
 * Agent Wallet Derivation
 * 
 * Derives deterministic wallets for each agent from their unique dnaHash.
 * The dnaHash is computed on-chain from (skills, chainId, modelId) and
 * stored in the AgentFactory contract.
 * 
 * This ensures each agent has a unique, reproducible wallet tied to its
 * on-chain identity without requiring a shared master mnemonic.
 */

import { keccak256, encodePacked } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createWalletClient, createPublicClient, http, type WalletClient, type PublicClient } from "viem";
import { avalanche, avalancheFuji } from "viem/chains";

const USE_MAINNET = process.env.USE_MAINNET === "true";
const RPC_URL = process.env.AVALANCHE_FUJI_RPC;

if (!RPC_URL) {
    console.warn("[agent-wallet] AVALANCHE_FUJI_RPC not set in environment");
}

export interface AgentWallet {
    agentId: bigint;
    dnaHash: `0x${string}`;
    address: `0x${string}`;
    account: PrivateKeyAccount;
    walletClient: WalletClient;
    publicClient: PublicClient;
}

/**
 * Derive a unique wallet for an agent from dnaHash + timestamp
 * 
 * - dnaHash = keccak256(skills, chainId, model) - stored on-chain
 * - timestamp makes each wallet unique even for same skills/chain/model
 * 
 * IMPORTANT: This MUST match the frontend derivation in app/src/lib/contracts.ts
 * Formula: keccak256(dnaHash + timestamp + ":agent:wallet")
 * 
 * @param dnaHash - The agent's dnaHash from AgentFactory contract (bytes32)
 * @param timestamp - The timestamp used at mint time (stored in IPFS metadata)
 * @returns AgentWallet with address, account, and wallet client
 */
export function deriveAgentWallet(dnaHash: `0x${string}`, timestamp: number): AgentWallet {
    if (!dnaHash || !dnaHash.startsWith("0x") || dnaHash.length !== 66) {
        throw new Error(`Invalid dnaHash: ${dnaHash}. Expected 32-byte hex string.`);
    }

    // Derive private key from dnaHash + timestamp - MUST match frontend
    // Frontend: keccak256(encodePacked(["bytes32", "uint256", "string"], [dnaHash, timestamp, ":agent:wallet"]))
    const derivationSeed = keccak256(
        encodePacked(
            ["bytes32", "uint256", "string"],
            [dnaHash, BigInt(timestamp), ":agent:wallet"]
        )
    );

    // The derived hash is a valid 32-byte private key
    const privateKey = derivationSeed as `0x${string}`;
    const account = privateKeyToAccount(privateKey);

    const chain = USE_MAINNET ? avalanche : avalancheFuji;

    const walletClient = createWalletClient({
        account,
        chain,
        transport: http(RPC_URL),
    });

    const publicClient = createPublicClient({
        chain,
        transport: http(RPC_URL),
    });

    console.log(`[agent-wallet] Derived wallet from dnaHash+timestamp: ${account.address}`);

    return {
        agentId: BigInt(0),
        dnaHash,
        address: account.address,
        account,
        walletClient,
        publicClient,
    };
}

/**
 * Check if an agent wallet has sufficient funds for gas
 * @param wallet - The agent wallet to check
 * @param minBalance - Minimum balance in wei (default 0.01 AVAX)
 */
export async function hasGasFunds(
    wallet: AgentWallet,
    minBalance: bigint = BigInt(10000000000000000) // 0.01 AVAX
): Promise<boolean> {
    try {
        const balance = await wallet.publicClient.getBalance({ address: wallet.address });
        return balance >= minBalance;
    } catch (error) {
        console.error(`[agent-wallet] Failed to check balance for ${wallet.address}:`, error);
        return false;
    }
}

/**
 * Get agent wallet balance
 */
export async function getWalletBalance(wallet: AgentWallet): Promise<bigint> {
    return wallet.publicClient.getBalance({ address: wallet.address });
}
