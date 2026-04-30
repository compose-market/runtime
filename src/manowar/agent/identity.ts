/**
 * Agent Identity — single source of truth for "who is this agent".
 *
 * Pattern mirrors mesh@native (tauri/src/lib.rs:build_local_agent_prompt + src/lib/local-agent.ts:buildLocalAgentSystemPrompt):
 * identity is HYDRATED ONCE from on-chain registration + IPFS agent-card metadata, cached
 * in memory, and rendered per turn as a tiny structured block. Token cost ~80–120.
 *
 * No prose. No model reasoning required. Identity is *stated*, not deduced.
 */
import { buildPinataGatewayIpfsUrl } from "../../auth.js";
import { resolveAgent } from "../runtime.js";

export interface AgentIdentity {
    name: string;
    description: string;
    walletAddress: string;
    model: string;
    skills: string[];
    plugins: string[];
    creator?: string;
    agentCardUri?: string;
}

interface AgentCardJson {
    name?: string;
    description?: string;
    walletAddress?: string;
    model?: string;
    skills?: unknown;
    plugins?: unknown;
    creator?: string;
}

const identityCache = new Map<string, AgentIdentity>();
const identityWarmups = new Map<string, Promise<AgentIdentity>>();

function ipfsUriToCid(uri: string): string | null {
    if (!uri || !uri.startsWith("ipfs://")) return null;
    const cid = uri.replace(/^ipfs:\/\//i, "").replace(/^\/+/, "").split("/")[0];
    if (!cid || (!cid.startsWith("Qm") && !cid.startsWith("baf"))) return null;
    return cid;
}

function normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
        if (typeof item === "string" && item.trim()) {
            out.push(item.trim());
        } else if (item && typeof item === "object") {
            const record = item as Record<string, unknown>;
            const label = (typeof record.name === "string" && record.name)
                || (typeof record.registryId === "string" && record.registryId)
                || (typeof record.id === "string" && record.id)
                || "";
            if (label) out.push(label);
        }
    }
    return [...new Set(out)];
}

async function fetchAgentCard(cid: string): Promise<AgentCardJson | null> {
    try {
        const response = await fetch(buildPinataGatewayIpfsUrl(cid), {
            signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) return null;
        return await response.json() as AgentCardJson;
    } catch (error) {
        console.warn(`[identity] Pinata fetch failed for ${cid}:`, error instanceof Error ? error.message : error);
        return null;
    }
}

async function hydrateIdentity(walletAddress: string): Promise<AgentIdentity> {
    const registered = resolveAgent(walletAddress);
    if (!registered) {
        throw new Error(`Agent ${walletAddress} not registered`);
    }

    const cid = registered.agentCardUri ? ipfsUriToCid(registered.agentCardUri) : null;
    const card = cid ? await fetchAgentCard(cid) : null;

    const identity: AgentIdentity = {
        name: card?.name?.trim() || registered.name,
        description: card?.description?.trim() || registered.description || "",
        walletAddress: registered.walletAddress,
        model: card?.model?.trim() || registered.model,
        skills: normalizeStringArray(card?.skills),
        plugins: normalizeStringArray(card?.plugins).length > 0
            ? normalizeStringArray(card?.plugins)
            : (registered.plugins || []),
        creator: registered.creator || card?.walletAddress || undefined,
        agentCardUri: registered.agentCardUri,
    };

    return identity;
}

export async function resolveAgentIdentity(walletAddress: string): Promise<AgentIdentity> {
    const cached = identityCache.get(walletAddress);
    if (cached) return cached;

    const inflight = identityWarmups.get(walletAddress);
    if (inflight) return inflight;

    const promise = hydrateIdentity(walletAddress)
        .then((identity) => {
            identityCache.set(walletAddress, identity);
            return identity;
        })
        .finally(() => {
            identityWarmups.delete(walletAddress);
        });
    identityWarmups.set(walletAddress, promise);
    return promise;
}

export function peekAgentIdentity(walletAddress: string): AgentIdentity | undefined {
    return identityCache.get(walletAddress);
}

export function invalidateAgentIdentity(walletAddress: string): void {
    identityCache.delete(walletAddress);
    identityWarmups.delete(walletAddress);
}

/**
 * Token-cheap identity block. Mirrors mesh@native pattern: identity is *stated*, not reasoned.
 * ~80-120 tokens. Injected as the FIRST line of every turn's system message.
 */
export function renderIdentitySection(identity: AgentIdentity): string {
    const lines = [
        `You are ${identity.name}. ${identity.description}`.trim(),
        `Wallet: ${identity.walletAddress}`,
    ];
    if (identity.skills.length > 0) {
        lines.push(`Skills: ${identity.skills.slice(0, 8).join(", ")}`);
    }
    return lines.join("\n");
}
