/**
 * Manowar Registry
 *
 * Stores and manages deployed Manowar workflow configurations.
 * Links on-chain Manowar NFTs to their backend runtime instances.
 * 
 * Key features:
 * - Uses wallet address as PRIMARY and ONLY identifier
 * - O(1) lookup by wallet address (matching agent pattern)
 * - Caches workflow metadata from IPFS
 * - manowarId is stored for on-chain reference but NOT used for lookups
 */

// =============================================================================
// Types
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
// Storage (in-memory)
// =============================================================================

/** Registered manowars by wallet address (ONLY lookup method) */
const registeredManowars = new Map<string, RegisteredManowar>();

// =============================================================================
// Registration
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
            const gatewayUrl = `https://${process.env.PINATA_GATEWAY || "compose.mypinata.cloud"}/ipfs/${cid}`;
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

                console.log(`[manowar-registry] ✅ manowarCardUri validated: ${params.manowarCardUri}`);
            } else {
                console.warn(`[manowar-registry] ⚠️ Could not fetch manowarCardUri: HTTP ${response.status}`);
            }
        } catch (err) {
            if (err instanceof Error && err.message.includes("mismatch")) {
                throw err; // Re-throw validation errors
            }
            console.warn(`[manowar-registry] ⚠️ Could not validate manowarCardUri: ${err}`);
            // Continue with registration - IPFS may be temporarily unavailable
        }
    }

    // Check if already registered by wallet address
    if (registeredManowars.has(walletAddress)) {
        const existing = registeredManowars.get(walletAddress)!;
        console.log(`[manowar-registry] Already registered: ${params.title} (${walletAddress})`);
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

    console.log(`[manowar-registry] Registered manowar: ${params.title}`);
    console.log(`[manowar-registry]   Wallet: ${walletAddress}`);
    console.log(`[manowar-registry]   CardURI: ${params.manowarCardUri || "none"}`);
    console.log(`[manowar-registry]   Coordinator: ${params.coordinatorModel || "none"}`);
    console.log(`[manowar-registry]   Agents: [${params.agentWalletAddresses?.join(", ") || "none"}]`);

    return registered;
}

// =============================================================================
// Lookup Functions (wallet address ONLY)
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
// State Updates
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

console.log("[manowar-registry] Manowar registry initialized");
