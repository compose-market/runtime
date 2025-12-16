/**
 * Manowar Registry
 *
 * Stores and manages deployed Manowar workflow configurations.
 * Links on-chain Manowar NFTs to their backend runtime instances.
 * 
 * Key features:
 * - Uses wallet address as primary identifier (not progressive IDs)
 * - O(1) lookup by wallet address (matching agent pattern)
 * - Caches workflow metadata from IPFS
 */

// =============================================================================
// Types
// =============================================================================

export interface RegisteredManowar {
    /** On-chain manowar ID (ERC721 NFT ID) */
    manowarId: number;
    /** Derived wallet address (PRIMARY IDENTIFIER) */
    walletAddress: string;
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
    /** Coordinator model */
    coordinatorModel?: string;
    /** Total price in USDC (formatted) */
    totalPrice?: string;
    /** Registration timestamp */
    createdAt: Date;
    /** Last execution timestamp */
    lastExecutedAt?: Date;
}

export interface RegisterManowarParams {
    manowarId: number;
    walletAddress: string;
    dnaHash?: string;
    title: string;
    description: string;
    banner?: string;
    creator: string;
    hasCoordinator?: boolean;
    coordinatorModel?: string;
    totalPrice?: string;
}

// =============================================================================
// Storage (in-memory)
// =============================================================================

/** Registered manowars by wallet address */
const registeredManowars = new Map<string, RegisteredManowar>();

/** Manowar ID to wallet address mapping (for backward compatibility) */
const manowarIdToWallet = new Map<string, string>();

// =============================================================================
// Registration
// =============================================================================

/**
 * Register a manowar workflow
 * 
 * walletAddress is the primary identifier (from IPFS metadata)
 */
export function registerManowar(params: RegisterManowarParams): RegisteredManowar {
    const walletAddress = params.walletAddress;
    if (!walletAddress || !walletAddress.startsWith("0x") || walletAddress.length !== 42) {
        throw new Error(`Invalid walletAddress: ${walletAddress}. Must be a valid Ethereum address.`);
    }

    // Check if already registered by wallet address
    if (registeredManowars.has(walletAddress)) {
        // Update existing registration
        const existing = registeredManowars.get(walletAddress)!;
        console.log(`[manowar-registry] Already registered: ${params.title} (${walletAddress})`);
        return existing;
    }

    const registered: RegisteredManowar = {
        manowarId: params.manowarId,
        walletAddress,
        dnaHash: params.dnaHash,
        title: params.title,
        description: params.description,
        banner: params.banner,
        creator: params.creator,
        hasCoordinator: params.hasCoordinator,
        coordinatorModel: params.coordinatorModel,
        totalPrice: params.totalPrice,
        createdAt: new Date(),
    };

    registeredManowars.set(walletAddress, registered);
    manowarIdToWallet.set(params.manowarId.toString(), walletAddress);

    console.log(`[manowar-registry] Registered manowar: ${params.title}`);
    console.log(`[manowar-registry]   Wallet: ${walletAddress}`);
    console.log(`[manowar-registry]   ID: ${params.manowarId}`);
    console.log(`[manowar-registry]   Coordinator: ${params.coordinatorModel || "none"}`);

    return registered;
}

// =============================================================================
// Lookup Functions
// =============================================================================

/**
 * Get registered manowar by wallet address (preferred)
 */
export function getManowarByWallet(walletAddress: string): RegisteredManowar | undefined {
    return registeredManowars.get(walletAddress);
}

/**
 * Get registered manowar by ID (backward compatibility)
 */
export function getManowarById(manowarId: number | string): RegisteredManowar | undefined {
    const key = manowarId.toString();
    const walletAddress = manowarIdToWallet.get(key);
    if (!walletAddress) return undefined;
    return registeredManowars.get(walletAddress);
}

/**
 * List all registered manowars
 */
export function listRegisteredManowars(): RegisteredManowar[] {
    return Array.from(registeredManowars.values());
}

/**
 * Check if wallet or manowar ID exists
 */
export function hasManowar(identifier: string): boolean {
    // Check if it's a wallet address
    if (identifier.startsWith("0x") && identifier.length === 42) {
        return registeredManowars.has(identifier);
    }
    // Otherwise treat as manowar ID
    return manowarIdToWallet.has(identifier);
}

/**
 * Resolve identifier (wallet or ID) to manowar
 */
export function resolveManowar(identifier: string): RegisteredManowar | undefined {
    // Check if it's a wallet address (0x + 40 hex chars)
    if (identifier.startsWith("0x") && identifier.length === 42) {
        return registeredManowars.get(identifier);
    }
    // Otherwise treat as manowar ID
    return getManowarById(identifier);
}

// =============================================================================
// State Updates
// =============================================================================

/**
 * Update manowar last executed timestamp
 */
export function markManowarExecuted(identifier: string): void {
    const manowar = resolveManowar(identifier);
    if (manowar) {
        manowar.lastExecutedAt = new Date();
    }
}

/**
 * Unregister a manowar
 */
export function unregisterManowar(identifier: string): boolean {
    const manowar = resolveManowar(identifier);
    if (!manowar) return false;

    manowarIdToWallet.delete(manowar.manowarId.toString());
    return registeredManowars.delete(manowar.walletAddress);
}

// =============================================================================
// Initialization
// =============================================================================

console.log("[manowar-registry] Manowar registry initialized");
