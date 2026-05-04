/**
 * GOAT runtime — Worker-side.
 *
 * Treasury wallet private key is a Worker secret (`SERVER_PRIVATE_KEY`).
 * Plugin imports are STATIC because Cloudflare Workers can't dynamically
 * resolve npm packages at runtime; wrangler's bundler needs them at
 * build time. Each plugin construction is guarded with try/catch so
 * partial failures (missing API key, network plugin requiring extra
 * config) don't break the whole runtime.
 */

import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji, avalanche } from "viem/chains";
import { zodToJsonSchema } from "zod-to-json-schema";

import { getOnChainTools } from "@goat-sdk/adapter-vercel-ai";
import { viem as viemAdapter } from "@goat-sdk/wallet-viem";

import { erc20 } from "@goat-sdk/plugin-erc20";
import { coingecko } from "@goat-sdk/plugin-coingecko";
import { oneInch } from "@goat-sdk/plugin-1inch";
import { zeroEx } from "@goat-sdk/plugin-0x";
import { uniswap } from "@goat-sdk/plugin-uniswap";
import { dexscreener } from "@goat-sdk/plugin-dexscreener";
import { etherscan } from "@goat-sdk/plugin-etherscan";
import { erc721 } from "@goat-sdk/plugin-erc721";
import { erc1155 } from "@goat-sdk/plugin-erc1155";
import { polymarket } from "@goat-sdk/plugin-polymarket";
import { debridge } from "@goat-sdk/plugin-debridge";
import { lifi } from "@goat-sdk/plugin-lifi";

import type { Env } from "./env.js";
import type { CallEnvelope, CallResponse, ConnectorsErrorCode } from "./broker.js";

interface ToolEntry { tool: any; pluginId: string }
interface PluginEntry {
    id: string;
    name: string;
    description: string;
    requiresApiKey?: boolean;
    apiKeyConfigured?: boolean;
}

interface State {
    walletAddress: string | null;
    tools: Map<string, ToolEntry>;
    plugins: Map<string, PluginEntry>;
    initError: string | null;
    initPromise: Promise<void> | null;
    keyHash: string;
}

const state: State = {
    walletAddress: null,
    tools: new Map(),
    plugins: new Map(),
    initError: null,
    initPromise: null,
    keyHash: "",
};

function zodToJson(schema: unknown): Record<string, unknown> {
    try {
        return zodToJsonSchema(schema as any, { errorMessages: true }) as Record<string, unknown>;
    } catch {
        return { type: "object", properties: {} };
    }
}

function envSecret(env: Env, name: string): string | undefined {
    return (env as unknown as Record<string, string | undefined>)[name];
}

function tryConstruct(label: string, fn: () => any, errors: Array<{ id: string; reason: string }>): any | null {
    try { return fn(); } catch (err) {
        errors.push({ id: label, reason: err instanceof Error ? err.message : String(err) });
        return null;
    }
}

function secretFingerprint(value: string | undefined): string {
    if (!value) return "0:";
    return `${value.length}:${value.slice(-6)}`;
}

async function ensureInitialized(env: Env): Promise<void> {
    const treasuryKey = envSecret(env, "SERVER_PRIVATE_KEY")
        || envSecret(env, "TREASURY_WALLET_PRIVATE")
        || envSecret(env, "TREASURY_SERVER_WALLET_PRIVATE");
    const useMainnetValue = envSecret(env, "USE_MAINNET") || "";
    const rpcUrl = envSecret(env, "AVALANCHE_FUJI_RPC") || "";
    const cgKey = envSecret(env, "COINGECKO_API_KEY") || "";
    const oneInchKey = envSecret(env, "ONEINCH_API_KEY") || "";
    const zeroXKey = envSecret(env, "ZEROX_API_KEY") || "";
    const etherscanKey = envSecret(env, "ETHERSCAN_API_KEY") || "";
    const polymarketKey = envSecret(env, "POLYMARKET_API_KEY") || "";
    const uniswapKey = envSecret(env, "UNISWAP_API_KEY") || "";
    const uniswapBaseUrl = envSecret(env, "UNISWAP_BASE_URL") || "https://api.uniswap.org";
    const keyHash = [
        `treasury:${secretFingerprint(treasuryKey)}`,
        `mainnet:${useMainnetValue}`,
        `rpc:${secretFingerprint(rpcUrl)}`,
        `coingecko:${secretFingerprint(cgKey)}`,
        `oneinch:${secretFingerprint(oneInchKey)}`,
        `zerox:${secretFingerprint(zeroXKey)}`,
        `etherscan:${secretFingerprint(etherscanKey)}`,
        `polymarket:${secretFingerprint(polymarketKey)}`,
        `uniswap:${secretFingerprint(uniswapKey)}`,
        `uniswapBase:${uniswapBaseUrl}`,
    ].join("|");

    if (state.initPromise && state.keyHash === keyHash) return state.initPromise;
    if (state.tools.size > 0 && state.keyHash === keyHash) return;

    state.tools.clear();
    state.plugins.clear();
    state.initError = null;
    state.walletAddress = null;
    state.keyHash = keyHash;

    const promise = (async () => {
        if (!treasuryKey) {
            state.initError = "treasury wallet private key not configured";
            return;
        }
        try {
            const useMainnet = useMainnetValue === "true";
            const chain = useMainnet ? avalanche : avalancheFuji;
            const normalized = (treasuryKey.startsWith("0x") ? treasuryKey : `0x${treasuryKey}`) as `0x${string}`;
            const account = privateKeyToAccount(normalized);
            state.walletAddress = account.address;
            const walletClient = createWalletClient({
                account, chain, transport: http(rpcUrl),
            }).extend(publicActions);

            const goatWallet = viemAdapter(walletClient as any);
            const plugins: any[] = [];
            const constructionErrors: Array<{ id: string; reason: string }> = [];
            const declare = (id: string, name: string, description: string, requiresApiKey: boolean, apiKey?: string) => {
                state.plugins.set(id, {
                    id, name, description,
                    requiresApiKey,
                    apiKeyConfigured: requiresApiKey ? Boolean(apiKey && apiKey.length > 0) : undefined,
                });
            };

            const p1 = tryConstruct("erc20", () => erc20({ tokens: [] }), constructionErrors);
            if (p1) { plugins.push(p1); declare("erc20", "ERC20 Tokens", "Transfer, approve, and query ERC20 tokens", false); }

            const p2 = tryConstruct("coingecko", () => coingecko({ apiKey: cgKey }), constructionErrors);
            if (p2) { plugins.push(p2); declare("coingecko", "CoinGecko", "Cryptocurrency market data and prices", true, cgKey); }

            if (oneInchKey) {
                const p = tryConstruct("1inch", () => oneInch({ apiKey: oneInchKey }), constructionErrors);
                if (p) { plugins.push(p); declare("1inch", "1inch", "DEX aggregator for token swaps", true, oneInchKey); }
            }

            const p4 = tryConstruct("0x", () => zeroEx({ apiKey: zeroXKey }), constructionErrors);
            if (p4) { plugins.push(p4); declare("0x", "0x Protocol", "DEX aggregator and swap quotes", true, zeroXKey); }

            if (uniswapKey) {
                const p = tryConstruct("uniswap", () => uniswap({ apiKey: uniswapKey, baseUrl: uniswapBaseUrl }), constructionErrors);
                if (p) { plugins.push(p); declare("uniswap", "Uniswap", "Swap tokens on Uniswap", true, uniswapKey); }
            }

            const p6 = tryConstruct("dexscreener", () => dexscreener(), constructionErrors);
            if (p6) { plugins.push(p6); declare("dexscreener", "DexScreener", "Token pair analytics and charts", false); }

            if (etherscanKey) {
                const p = tryConstruct("etherscan", () => etherscan({ apiKey: etherscanKey }), constructionErrors);
                if (p) { plugins.push(p); declare("etherscan", "Etherscan", "Blockchain explorer and transaction data", true, etherscanKey); }
            }

            const p8 = tryConstruct("erc721", () => erc721({ tokens: [] }), constructionErrors);
            if (p8) { plugins.push(p8); declare("erc721", "ERC721 NFTs", "Transfer and query NFTs", false); }

            const p9 = tryConstruct("erc1155", () => erc1155({ tokens: [] }), constructionErrors);
            if (p9) { plugins.push(p9); declare("erc1155", "ERC1155", "Multi-token standard operations", false); }

            if (polymarketKey) {
                const p = tryConstruct(
                    "polymarket",
                    () => polymarket({ credentials: { key: polymarketKey, secret: "", passphrase: "" } }),
                    constructionErrors,
                );
                if (p) { plugins.push(p); declare("polymarket", "Polymarket", "Prediction market trading", true, polymarketKey); }
            }

            const p11 = tryConstruct("debridge", () => debridge(), constructionErrors);
            if (p11) { plugins.push(p11); declare("debridge", "DeBridge", "Cross-chain token bridging", false); }

            const p12 = tryConstruct("lifi", () => lifi({}), constructionErrors);
            if (p12) { plugins.push(p12); declare("lifi", "LI.FI", "Cross-chain swap and bridge aggregator", false); }

            if (constructionErrors.length > 0) {
                console.warn("[goat] plugin constructor failures:", constructionErrors);
            }

            const onChainTools = await getOnChainTools({ wallet: goatWallet, plugins });
            const toolsRecord = onChainTools as Record<string, any>;

            for (const [toolName, tool] of Object.entries(toolsRecord)) {
                let pluginId = "wallet";
                for (const id of state.plugins.keys()) {
                    if (toolName.toLowerCase().includes(id.toLowerCase())) {
                        pluginId = id;
                        break;
                    }
                }
                state.tools.set(toolName, { tool, pluginId });
            }

            if (!state.plugins.has("wallet")) {
                let count = 0;
                for (const [, v] of state.tools) {
                    if (v.pluginId === "wallet") count++;
                }
                if (count > 0) {
                    state.plugins.set("wallet", {
                        id: "wallet", name: "EVM Wallet",
                        description: "Core wallet operations (send, sign, balance)",
                    });
                }
            }
        } catch (err) {
            state.initError = err instanceof Error ? err.message : String(err);
        }
    })();

    state.initPromise = promise;
    await promise;
}

export interface GoatPluginInfo {
    id: string;
    name: string;
    description: string;
    toolCount: number;
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown>; pluginId: string }>;
    requiresApiKey?: boolean;
    apiKeyConfigured?: boolean;
}

export async function listGoatPlugins(env: Env): Promise<{ plugins: GoatPluginInfo[]; status: { initialized: boolean; walletAddress: string | null; chain: string; chainId: number; rpcUrl: string | null; error: string | null; totalTools: number } }> {
    await ensureInitialized(env);
    const result: GoatPluginInfo[] = [];
    for (const [pid, info] of state.plugins) {
        const tools: GoatPluginInfo["tools"] = [];
        for (const [name, entry] of state.tools) {
            if (entry.pluginId === pid) {
                tools.push({
                    name,
                    description: entry.tool.description || `Execute ${name}`,
                    parameters: entry.tool.parameters ? zodToJson(entry.tool.parameters) : { type: "object", properties: {} },
                    pluginId: pid,
                });
            }
        }
        result.push({
            id: info.id,
            name: info.name,
            description: info.description,
            toolCount: tools.length,
            tools,
            requiresApiKey: info.requiresApiKey,
            apiKeyConfigured: info.apiKeyConfigured,
        });
    }
    const useMainnet = envSecret(env, "USE_MAINNET") === "true";
    return {
        plugins: result,
        status: {
            initialized: state.tools.size > 0,
            walletAddress: state.walletAddress,
            chain: useMainnet ? "Avalanche" : "Avalanche Fuji",
            chainId: useMainnet ? 43114 : 43113,
            rpcUrl: envSecret(env, "AVALANCHE_FUJI_RPC") || null,
            error: state.initError,
            totalTools: state.tools.size,
        },
    };
}

export async function getGoatPlugin(env: Env, pluginId: string): Promise<GoatPluginInfo | null> {
    const all = await listGoatPlugins(env);
    return all.plugins.find((p) => p.id === pluginId) || null;
}

export async function runGoatTool(
    env: Env,
    pluginId: string,
    toolName: string,
    envelope: CallEnvelope,
): Promise<CallResponse> {
    await ensureInitialized(env);
    if (state.initError) {
        return { ok: false, kind: "MCP_RUNTIME_UNAVAILABLE", message: state.initError, retryable: false };
    }
    const entry = state.tools.get(toolName);
    if (!entry) {
        return { ok: false, kind: "MCP_CONFIG_NOT_FOUND", message: `tool not found: ${toolName}`, retryable: false };
    }
    if (entry.pluginId !== pluginId && pluginId !== "any") {
        // Keep execution permissive for tools that are read-only or simulate.
        // since the tool exists.
    }
    const tool = entry.tool;
    if (!tool || typeof tool.execute !== "function") {
        return { ok: false, kind: "TOOL_VALIDATION", message: `tool ${toolName} is not executable`, retryable: false };
    }
    const start = Date.now();
    try {
        const raw = await tool.execute(envelope.args);
        let txHash: string | undefined;
        let gasUsed: string | undefined;
        if (raw && typeof raw === "object") {
            if ("hash" in raw) txHash = String((raw as { hash: unknown }).hash);
            if ("transactionHash" in raw) txHash = String((raw as { transactionHash: unknown }).transactionHash);
            if ("gasUsed" in raw) gasUsed = String((raw as { gasUsed: unknown }).gasUsed);
        }
        return {
            ok: true,
            result: { result: raw, txHash, gasUsed },
            transportUsed: "goat-plugin",
            latencyMs: Date.now() - start,
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code: ConnectorsErrorCode = msg.toLowerCase().includes("timeout") ? "MCP_SPAWN_TIMEOUT" : "MCP_TOOL_FAILED";
        return { ok: false, kind: code, message: msg, retryable: code === "MCP_SPAWN_TIMEOUT" };
    }
}

export function getGoatWalletAddress(): string | null {
    return state.walletAddress;
}
