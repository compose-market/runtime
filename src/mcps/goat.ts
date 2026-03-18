/**
 * GOAT Runtime - Blockchain Tools
 * 
 * Full GOAT SDK implementation with dynamic plugin loading.
 * Manages wallet initialization, plugin discovery, and tool execution.
 * 
 * This file consolidates the original goat.ts with the GoatRuntime class wrapper.
 */

import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji, avalanche } from "viem/chains";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ComposeTool } from "../types.js";

// =============================================================================
// Configuration
// =============================================================================

const TREASURY_PRIVATE_KEY = (
    process.env.TREASURY_WALLET_PRIVATE ||
    process.env.TREASURY_SERVER_WALLET_PRIVATE ||
    process.env.SERVER_PRIVATE_KEY
) as `0x${string}` | undefined;

const RPC_URL = process.env.AVALANCHE_FUJI_RPC;
const USE_MAINNET = process.env.USE_MAINNET === "true";

// API Keys for various plugins
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY || "";
const ONEINCH_API_KEY = process.env.ONEINCH_API_KEY || "";
const ZEROX_API_KEY = process.env.ZEROX_API_KEY || "";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";
const NANSEN_API_KEY = process.env.NANSEN_API_KEY || "";
const ALLORA_API_KEY = process.env.ALLORA_API_KEY || "";
const OPENSEA_API_KEY = process.env.OPENSEA_API_KEY || "";
const FARCASTER_API_KEY = process.env.FARCASTER_API_KEY || "";
const DEXSCREENER_API_KEY = process.env.DEXSCREENER_API_KEY || "";
const POLYMARKET_API_KEY = process.env.POLYMARKET_API_KEY || "";

// =============================================================================
// Types
// =============================================================================

export interface ToolSchema {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
    pluginId: string;
}

export interface PluginInfo {
    id: string;
    name: string;
    description: string;
    toolCount: number;
    tools: ToolSchema[];
    requiresApiKey?: boolean;
    apiKeyConfigured?: boolean;
}

export interface RuntimeStatus {
    initialized: boolean;
    walletAddress: string | null;
    chain: string;
    chainId: number;
    rpcUrl: string | null;
    error: string | null;
    plugins: PluginInfo[];
    totalTools: number;
}

export interface ToolExecutionResult {
    success: boolean;
    result?: unknown;
    error?: string;
    txHash?: string;
    gasUsed?: string;
}

export interface GoatRuntimeConfig {
    // No custom wallet needed - uses treasury wallet from env
}

// =============================================================================
// State
// =============================================================================

let walletClient: ReturnType<typeof createWalletClient> | null = null;
let walletAddress: string | null = null;
let goatTools: Map<string, { tool: any; pluginId: string }> = new Map();
let pluginRegistry: Map<string, PluginInfo> = new Map();
let initError: string | null = null;
let initPromise: Promise<void> | null = null;

// =============================================================================
// Dynamic Plugin Loading
// =============================================================================

/**
 * Convert Zod schema to JSON Schema for API exposure
 */
function zodToJson(schema: unknown): Record<string, unknown> {
    try {
        return zodToJsonSchema(schema as any, { errorMessages: true }) as Record<string, unknown>;
    } catch {
        return { type: "object", properties: {} };
    }
}

/**
 * Try to dynamically import a plugin
 */
async function tryImportPlugin(packageName: string): Promise<any | null> {
    try {
        return await import(packageName);
    } catch {
        return null;
    }
}

/**
 * Initialize the GOAT runtime with ALL available plugins
 */
async function initializeRuntime(): Promise<void> {
    if (initPromise) return initPromise;
    if (goatTools.size > 0) return;

    initPromise = doInitialize();
    return initPromise;
}

async function doInitialize(): Promise<void> {
    if (!TREASURY_PRIVATE_KEY) {
        initError = "TREASURY_WALLET_PRIVATE not configured";
        console.error("[GOAT Runtime] " + initError);
        return;
    }

    try {
        const chain = USE_MAINNET ? avalanche : avalancheFuji;
        const account = privateKeyToAccount(TREASURY_PRIVATE_KEY);
        walletAddress = account.address;

        walletClient = createWalletClient({
            account,
            chain,
            transport: http(RPC_URL),
        }).extend(publicActions);

        console.log(`[GOAT Runtime] Wallet initialized on ${chain.name}: ${account.address}`);

        // Import GOAT SDK core
        const { getOnChainTools } = await import("@goat-sdk/adapter-vercel-ai");
        const { viem } = await import("@goat-sdk/wallet-viem");
        const goatWallet = viem(walletClient as any);

        // Dynamically load ALL installed plugins
        const plugins: any[] = [];
        const pluginConfigs: Array<{ id: string; name: string; description: string; requiresApiKey?: boolean; apiKey?: string }> = [];

        // ERC20 - Core token operations
        const erc20Module = await tryImportPlugin("@goat-sdk/plugin-erc20");
        if (erc20Module && erc20Module.erc20) {
            plugins.push(erc20Module.erc20({ tokens: [] }) as any);
            pluginConfigs.push({ id: "erc20", name: "ERC20 Tokens", description: "Transfer, approve, and query ERC20 tokens" });
        }

        // CoinGecko - Market data
        const coingeckoModule = await tryImportPlugin("@goat-sdk/plugin-coingecko");
        if (coingeckoModule && coingeckoModule.coingecko) {
            plugins.push(coingeckoModule.coingecko({ apiKey: COINGECKO_API_KEY }) as any);
            pluginConfigs.push({ id: "coingecko", name: "CoinGecko", description: "Cryptocurrency market data and prices", apiKey: COINGECKO_API_KEY });
        }

        // 1inch - DEX aggregator
        const oneInchModule = await tryImportPlugin("@goat-sdk/plugin-1inch");
        if (oneInchModule && oneInchModule.oneInch && ONEINCH_API_KEY) {
            plugins.push(oneInchModule.oneInch({ apiKey: ONEINCH_API_KEY }) as any);
            pluginConfigs.push({ id: "1inch", name: "1inch", description: "DEX aggregator for token swaps", requiresApiKey: true, apiKey: ONEINCH_API_KEY });
        }

        // 0x - DEX aggregator
        const zeroXModule = await tryImportPlugin("@goat-sdk/plugin-0x");
        if (zeroXModule && zeroXModule.zeroEx) {
            plugins.push(zeroXModule.zeroEx({ apiKey: ZEROX_API_KEY }) as any);
            pluginConfigs.push({ id: "0x", name: "0x Protocol", description: "DEX aggregator and swap quotes", requiresApiKey: true, apiKey: ZEROX_API_KEY });
        }

        // Uniswap - DEX
        const uniswapModule = await tryImportPlugin("@goat-sdk/plugin-uniswap");
        if (uniswapModule && uniswapModule.uniswap) {
            plugins.push(uniswapModule.uniswap({}) as any);
            pluginConfigs.push({ id: "uniswap", name: "Uniswap", description: "Swap tokens on Uniswap" });
        }

        // ENS - Name resolution
        const ensModule = await tryImportPlugin("@goat-sdk/plugin-ens");
        if (ensModule && ensModule.ens && USE_MAINNET) {
            try {
                plugins.push(ensModule.ens({ provider: http("https://eth.drpc.org"), chainId: 1 }) as any);
                pluginConfigs.push({ id: "ens", name: "ENS", description: "Resolve ENS names to addresses" });
            } catch { /* ENS only on mainnet */ }
        }

        // DexScreener - Token analytics
        const dexscreenerModule = await tryImportPlugin("@goat-sdk/plugin-dexscreener");
        if (dexscreenerModule && dexscreenerModule.dexscreener) {
            plugins.push(dexscreenerModule.dexscreener() as any);
            pluginConfigs.push({ id: "dexscreener", name: "DexScreener", description: "Token pair analytics and charts" });
        }

        // Etherscan - Blockchain explorer
        const etherscanModule = await tryImportPlugin("@goat-sdk/plugin-etherscan");
        if (etherscanModule && etherscanModule.etherscan && ETHERSCAN_API_KEY) {
            plugins.push(etherscanModule.etherscan({ apiKey: ETHERSCAN_API_KEY }) as any);
            pluginConfigs.push({ id: "etherscan", name: "Etherscan", description: "Blockchain explorer and transaction data", requiresApiKey: true, apiKey: ETHERSCAN_API_KEY });
        }

        // ERC721 - NFT operations
        const erc721Module = await tryImportPlugin("@goat-sdk/plugin-erc721");
        if (erc721Module && erc721Module.erc721) {
            plugins.push(erc721Module.erc721({ tokens: [] }) as any);
            pluginConfigs.push({ id: "erc721", name: "ERC721 NFTs", description: "Transfer and query NFTs" });
        }

        // ERC1155 - Multi-token operations
        const erc1155Module = await tryImportPlugin("@goat-sdk/plugin-erc1155");
        if (erc1155Module && erc1155Module.erc1155) {
            plugins.push(erc1155Module.erc1155({ tokens: [] }) as any);
            pluginConfigs.push({ id: "erc1155", name: "ERC1155", description: "Multi-token standard operations" });
        }

        // Polymarket - Prediction markets
        const polymarketModule = await tryImportPlugin("@goat-sdk/plugin-polymarket");
        if (polymarketModule && polymarketModule.polymarket && POLYMARKET_API_KEY) {
            plugins.push(polymarketModule.polymarket({ credentials: { key: POLYMARKET_API_KEY, secret: "", passphrase: "" } }) as any);
            pluginConfigs.push({ id: "polymarket", name: "Polymarket", description: "Prediction market trading", requiresApiKey: true, apiKey: POLYMARKET_API_KEY });
        }

        // JSON RPC - Custom RPC calls
        const jsonrpcModule = await tryImportPlugin("@goat-sdk/plugin-jsonrpc");
        if (jsonrpcModule && jsonrpcModule.jsonrpc) {
            plugins.push(jsonrpcModule.jsonrpc({ endpoint: RPC_URL }) as any);
            pluginConfigs.push({ id: "jsonrpc", name: "JSON-RPC", description: "Custom blockchain RPC calls" });
        }

        // DeBridge - Cross-chain bridging
        const debridgeModule = await tryImportPlugin("@goat-sdk/plugin-debridge");
        if (debridgeModule && debridgeModule.debridge) {
            plugins.push(debridgeModule.debridge() as any);
            pluginConfigs.push({ id: "debridge", name: "DeBridge", description: "Cross-chain token bridging" });
        }

        // LiFi - Cross-chain aggregator
        const lifiModule = await tryImportPlugin("@goat-sdk/plugin-lifi");
        if (lifiModule && lifiModule.lifi) {
            plugins.push(lifiModule.lifi({}) as any);
            pluginConfigs.push({ id: "lifi", name: "LI.FI", description: "Cross-chain swap and bridge aggregator" });
        }

        // Nansen - Blockchain analytics
        const nansenModule = await tryImportPlugin("@goat-sdk/plugin-nansen");
        if (nansenModule && nansenModule.nansen && NANSEN_API_KEY) {
            plugins.push(nansenModule.nansen({ apiKey: NANSEN_API_KEY }) as any);
            pluginConfigs.push({ id: "nansen", name: "Nansen", description: "Blockchain analytics and wallet labels", requiresApiKey: true, apiKey: NANSEN_API_KEY });
        }

        // Allora - Price predictions
        const alloraModule = await tryImportPlugin("@goat-sdk/plugin-allora");
        if (alloraModule && alloraModule.allora) {
            plugins.push(alloraModule.allora({ apiKey: ALLORA_API_KEY }) as any);
            pluginConfigs.push({ id: "allora", name: "Allora", description: "AI-powered price predictions", apiKey: ALLORA_API_KEY });
        }

        // Superfluid - Token streaming
        const superfluidModule = await tryImportPlugin("@goat-sdk/plugin-superfluid");
        if (superfluidModule && superfluidModule.superfluid) {
            plugins.push(superfluidModule.superfluid() as any);
            pluginConfigs.push({ id: "superfluid", name: "Superfluid", description: "Real-time token streaming" });
        }

        // Farcaster - Social protocol
        const farcasterModule = await tryImportPlugin("@goat-sdk/plugin-farcaster");
        if (farcasterModule && farcasterModule.farcasterPlugin && FARCASTER_API_KEY) {
            plugins.push(farcasterModule.farcasterPlugin({ neynarApiKey: FARCASTER_API_KEY }) as any);
            pluginConfigs.push({ id: "farcaster", name: "Farcaster", description: "Decentralized social protocol", requiresApiKey: true, apiKey: FARCASTER_API_KEY });
        }

        // OpenSea - NFT marketplace
        const openseaModule = await tryImportPlugin("@goat-sdk/plugin-opensea");
        if (openseaModule && openseaModule.opensea && OPENSEA_API_KEY) {
            plugins.push(openseaModule.opensea(OPENSEA_API_KEY) as any);
            pluginConfigs.push({ id: "opensea", name: "OpenSea", description: "NFT marketplace data", requiresApiKey: true, apiKey: OPENSEA_API_KEY });
        }

        console.log(`[GOAT Runtime] Loading ${plugins.length} plugins...`);

        // Get all tools from GOAT SDK
        const tools = await getOnChainTools({
            wallet: goatWallet,
            plugins,
        });

        // Process tools and build registry
        const toolsRecord = tools as Record<string, any>;
        let totalTools = 0;

        for (const [toolName, tool] of Object.entries(toolsRecord)) {
            // Determine which plugin this tool belongs to
            let pluginId = "wallet";
            const lowerName = toolName.toLowerCase();

            for (const config of pluginConfigs) {
                if (lowerName.includes(config.id.toLowerCase()) ||
                    lowerName.includes(config.id.replace("-", "").toLowerCase())) {
                    pluginId = config.id;
                    break;
                }
            }

            // Special case mappings
            if (lowerName.includes("coingecko")) pluginId = "coingecko";
            if (lowerName.includes("inch") || lowerName.includes("1inch")) pluginId = "1inch";
            if (lowerName.includes("0x") || lowerName.includes("zerox")) pluginId = "0x";
            if (lowerName.includes("uniswap") || lowerName.includes("swap")) pluginId = "uniswap";
            if (lowerName.includes("ens") || lowerName.includes("resolve")) pluginId = "ens";
            if (lowerName.includes("nft") || lowerName.includes("erc721")) pluginId = "erc721";
            if (lowerName.includes("erc1155")) pluginId = "erc1155";
            if (lowerName.includes("erc20") || lowerName.includes("token") || lowerName.includes("balance") || lowerName.includes("allowance") || lowerName.includes("transfer") || lowerName.includes("approve")) pluginId = "erc20";
            if (lowerName.includes("polymarket") || lowerName.includes("prediction")) pluginId = "polymarket";
            if (lowerName.includes("bridge") || lowerName.includes("debridge")) pluginId = "debridge";
            if (lowerName.includes("lifi") || lowerName.includes("cross")) pluginId = "lifi";
            if (lowerName.includes("nansen")) pluginId = "nansen";
            if (lowerName.includes("allora")) pluginId = "allora";
            if (lowerName.includes("superfluid") || lowerName.includes("stream")) pluginId = "superfluid";
            if (lowerName.includes("farcaster") || lowerName.includes("cast")) pluginId = "farcaster";
            if (lowerName.includes("opensea") || lowerName.includes("listing")) pluginId = "opensea";
            if (lowerName.includes("dex") || lowerName.includes("screener")) pluginId = "dexscreener";
            if (lowerName.includes("etherscan") || lowerName.includes("explorer")) pluginId = "etherscan";
            if (lowerName.includes("rpc") || lowerName.includes("jsonrpc")) pluginId = "jsonrpc";

            // Store tool
            goatTools.set(toolName, { tool, pluginId });

            // Build schema
            const schema: ToolSchema = {
                name: toolName,
                description: tool.description || `Execute ${toolName}`,
                parameters: tool.parameters ? zodToJson(tool.parameters) : { type: "object", properties: {} },
                pluginId,
            };

            // Add to plugin registry
            if (!pluginRegistry.has(pluginId)) {
                const config = pluginConfigs.find(c => c.id === pluginId);
                pluginRegistry.set(pluginId, {
                    id: pluginId,
                    name: config?.name || pluginId,
                    description: config?.description || `${pluginId} plugin`,
                    toolCount: 0,
                    tools: [],
                    requiresApiKey: config?.requiresApiKey,
                    apiKeyConfigured: config?.apiKey ? config.apiKey.length > 0 : undefined,
                });
            }

            const plugin = pluginRegistry.get(pluginId)!;
            plugin.tools.push(schema);
            plugin.toolCount++;
            totalTools++;
        }

        // Add wallet plugin if there are wallet tools
        if (!pluginRegistry.has("wallet")) {
            const walletTools = Array.from(goatTools.entries())
                .filter(([_, v]) => v.pluginId === "wallet")
                .map(([name, v]) => ({
                    name,
                    description: v.tool.description || `Execute ${name}`,
                    parameters: v.tool.parameters ? zodToJson(v.tool.parameters) : { type: "object", properties: {} },
                    pluginId: "wallet",
                }));

            if (walletTools.length > 0) {
                pluginRegistry.set("wallet", {
                    id: "wallet",
                    name: "EVM Wallet",
                    description: "Core wallet operations (send, sign, balance)",
                    toolCount: walletTools.length,
                    tools: walletTools,
                });
            }
        }

        console.log(`[GOAT Runtime] Loaded ${totalTools} tools from ${pluginRegistry.size} plugins`);
        for (const [id, plugin] of pluginRegistry) {
            console.log(`[GOAT Runtime]   - ${id}: ${plugin.toolCount} tools`);
        }
    } catch (err) {
        initError = err instanceof Error ? err.message : String(err);
        console.error("[GOAT Runtime] Failed to initialize:", initError);
    }
}

// =============================================================================
// GoatRuntime Class (Compose Runtime Interface)
// =============================================================================

export class GoatRuntime {
    private config: GoatRuntimeConfig;
    private initialized = false;

    constructor(config: GoatRuntimeConfig = {}) {
        this.config = config;
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;
        await initializeRuntime();
        this.initialized = true;
    }

    async loadTools(pluginIds: string[]): Promise<ComposeTool[]> {
        if (!pluginIds || pluginIds.length === 0) return [];

        await this.initialize();

        const tools: ComposeTool[] = [];

        // Normalize plugin IDs (remove goat: or goat- prefix)
        const normalizeId = (id: string): string => {
            let normalized = id;
            while (normalized.match(/^goat[-:]/)) {
                normalized = normalized.replace(/^goat[-:]/, "");
            }
            return normalized;
        };

        const normalized = pluginIds.map(normalizeId);

        for (const pluginId of normalized) {
            try {
                const pluginTools = await getPluginTools(pluginId);
                if (!pluginTools || pluginTools.length === 0) {
                    console.warn(`[GOAT Runtime] No tools found for ${pluginId}`);
                    continue;
                }

                for (const toolSchema of pluginTools) {
                    tools.push({
                        name: toolSchema.name,
                        description: toolSchema.description || `GOAT tool: ${toolSchema.name}`,
                        source: 'goat',
                        inputSchema: toolSchema.parameters,
                        execute: async (args) => {
                            const result = await executeGoatTool(pluginId, toolSchema.name, args);
                            if (!result.success) {
                                throw new Error(result.error || 'GOAT tool execution failed');
                            }
                            return result.result;
                        },
                    });
                }
            } catch (error) {
                console.error(`[GOAT Runtime] Failed to load ${pluginId}:`, error);
            }
        }

        console.log(`[GOAT Runtime] Loaded ${tools.length} tools from ${pluginIds.length} plugins`);
        return tools;
    }

    async cleanup(): Promise<void> {
        this.initialized = false;
    }
}

// =============================================================================
// Public API (Backward Compatibility)
// =============================================================================

export async function getRuntimeStatus(): Promise<RuntimeStatus> {
    await initializeRuntime();

    const chain = USE_MAINNET ? avalanche : avalancheFuji;

    return {
        initialized: goatTools.size > 0,
        walletAddress,
        chain: chain.name,
        chainId: chain.id,
        rpcUrl: RPC_URL || null,
        error: initError,
        plugins: Array.from(pluginRegistry.values()),
        totalTools: goatTools.size,
    };
}

export async function listPlugins(): Promise<PluginInfo[]> {
    await initializeRuntime();
    return Array.from(pluginRegistry.values());
}

export async function getPlugin(pluginId: string): Promise<PluginInfo | null> {
    await initializeRuntime();
    return pluginRegistry.get(pluginId) || null;
}

export async function getPluginTools(pluginId: string): Promise<ToolSchema[]> {
    await initializeRuntime();
    const plugin = pluginRegistry.get(pluginId);
    return plugin?.tools || [];
}

export async function listAllTools(): Promise<ToolSchema[]> {
    await initializeRuntime();
    const allTools: ToolSchema[] = [];
    for (const plugin of pluginRegistry.values()) {
        allTools.push(...plugin.tools);
    }
    return allTools;
}

export async function getTool(toolName: string): Promise<ToolSchema | null> {
    await initializeRuntime();
    const entry = goatTools.get(toolName);
    if (!entry) return null;

    return {
        name: toolName,
        description: entry.tool.description || `Execute ${toolName}`,
        parameters: entry.tool.parameters ? zodToJson(entry.tool.parameters) : { type: "object", properties: {} },
        pluginId: entry.pluginId,
    };
}

export async function hasTool(toolName: string): Promise<boolean> {
    await initializeRuntime();
    return goatTools.has(toolName);
}

export async function executeGoatTool(
    pluginId: string,
    toolName: string,
    args: Record<string, unknown>
): Promise<ToolExecutionResult> {
    await initializeRuntime();

    if (initError) {
        return { success: false, error: `Runtime not available: ${initError}` };
    }

    const entry = goatTools.get(toolName);
    if (!entry) {
        const availableTools = Array.from(goatTools.keys());
        return {
            success: false,
            error: `Tool "${toolName}" not found. Available: ${availableTools.slice(0, 20).join(", ")}${availableTools.length > 20 ? "..." : ""}`,
        };
    }

    if (entry.pluginId !== pluginId && pluginId !== "any") {
        console.warn(`[GOAT Runtime] Tool ${toolName} belongs to plugin ${entry.pluginId}, not ${pluginId}`);
    }

    const tool = entry.tool;
    if (!tool || typeof tool.execute !== "function") {
        return { success: false, error: `Tool "${toolName}" is not executable` };
    }

    try {
        console.log(`[GOAT Runtime] Executing ${toolName} with args:`, JSON.stringify(args));
        const result = await tool.execute(args);

        let txHash: string | undefined;
        let gasUsed: string | undefined;

        if (result && typeof result === "object") {
            if ("hash" in result) txHash = String(result.hash);
            if ("transactionHash" in result) txHash = String(result.transactionHash);
            if ("gasUsed" in result) gasUsed = String(result.gasUsed);
        }

        console.log(`[GOAT Runtime] ${toolName} completed`);
        if (txHash) console.log(`[GOAT Runtime] TX: ${txHash}`);

        return { success: true, result, txHash, gasUsed };
    } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[GOAT Runtime] ${toolName} failed:`, errorMsg);
        return { success: false, error: errorMsg };
    }
}

export function getWalletAddress(): string | null {
    return walletAddress;
}

export async function getPluginIds(): Promise<string[]> {
    await initializeRuntime();
    return Array.from(pluginRegistry.keys());
}

// Initialize on module load
initializeRuntime().catch(console.error);
