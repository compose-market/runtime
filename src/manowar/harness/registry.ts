/**
 * Registered-agent validation for cal `task` / `delegate` steps.
 *
 * Compose's thesis: agent-only swarms at every depth. Each layer of an
 * a2a swarm is a real on-chain agent with identity, memory, reputation,
 * and an x402 envelope. Raw model ids are NOT swarm participants — they
 * stay accessible as TOOLS (image gen, embeddings, transcription, etc.)
 * via the agent's plugin tool surface, never as `task` / `delegate`
 * targets.
 *
 * This validator hits `GET ${API_URL}/agent/${wallet}` and checks for a
 * 200. Cached for 5 minutes so a high-fan-out plan doesn't repeatedly
 * hammer the agents endpoint. On lookup failure (network error, 404, or
 * non-EVM-shaped wallet), the cal step fails fast with a helpful error
 * message naming the unregistered identity.
 *
 * The canonical lookup shape lives in
 * `packages/sdk/.speakeasy/a2a.arazzo.yaml` so SDK consumers see it
 * declaratively.
 */
import { requireApiInternalUrl, buildApiInternalHeaders } from "../../auth.js";

const REGISTRY_CACHE_TTL_MS = 5 * 60_000;
const REGISTRY_LOOKUP_TIMEOUT_MS = 4_000;
const EVM_WALLET_RE = /^0x[a-fA-F0-9]{40}$/;

interface CacheEntry {
    registered: boolean;
    fetchedAt: number;
}

const registryCache = new Map<string, CacheEntry>();

function fromCache(wallet: string): boolean | null {
    const entry = registryCache.get(wallet.toLowerCase());
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > REGISTRY_CACHE_TTL_MS) {
        registryCache.delete(wallet.toLowerCase());
        return null;
    }
    return entry.registered;
}

function toCache(wallet: string, registered: boolean): void {
    registryCache.set(wallet.toLowerCase(), { registered, fetchedAt: Date.now() });
}

/**
 * Reset the cache (useful for tests). Production code never calls this.
 */
export function clearAgentRegistryCache(): void {
    registryCache.clear();
}

/**
 * Returns true when `wallet` resolves to a registered agent on the
 * `(api).compose.market/agent/:wallet` endpoint, false otherwise.
 *
 * On network error, returns null — caller decides whether to fail
 * closed (cal-step rejection) or fail open (allow execution and log).
 * The cal interpreter currently fails closed for safety.
 */
export async function isRegisteredAgent(wallet: string): Promise<boolean | null> {
    if (!wallet || !EVM_WALLET_RE.test(wallet)) return false;
    const cached = fromCache(wallet);
    if (cached !== null) return cached;

    const url = `${requireApiInternalUrl()}/agent/${wallet.toLowerCase()}`;
    let response: Response;
    try {
        response = await fetch(url, {
            method: "GET",
            headers: {
                Accept: "application/json",
                ...buildApiInternalHeaders(),
            },
            signal: AbortSignal.timeout(REGISTRY_LOOKUP_TIMEOUT_MS),
        });
    } catch (error) {
        // Network error / timeout. Don't cache (transient); return null
        // so caller can decide.
        console.warn(
            `[harness:registry] lookup failed for ${wallet}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
    }

    if (response.status === 200) {
        toCache(wallet, true);
        return true;
    }
    if (response.status === 404) {
        toCache(wallet, false);
        return false;
    }
    // Treat 5xx and unexpected statuses as transient — don't cache.
    console.warn(`[harness:registry] unexpected status ${response.status} for ${wallet}`);
    return null;
}

export class UnregisteredAgentError extends Error {
    readonly statusCode = 400;
    constructor(public readonly stepKind: "task" | "delegate", public readonly wallet: string) {
        super(
            `cal ${stepKind} step targets unregistered agent ${wallet}. ` +
                `task/delegate require a registered agent (call GET /agent/:wallet to verify). ` +
                `Raw model ids are not allowed in swarms — use the agent's tool surface ` +
                `(image, audio, embeddings, etc.) for single-purpose model calls.`,
        );
        this.name = "UnregisteredAgentError";
    }
}

/**
 * Throws `UnregisteredAgentError` if the wallet is missing, malformed,
 * or doesn't resolve to a registered agent. On transient network failure
 * the validator fails CLOSED — better to surface "registry unreachable"
 * than to silently downgrade a swarm to a raw-model call.
 */
export async function ensureRegisteredAgent(stepKind: "task" | "delegate", wallet: string | undefined): Promise<void> {
    if (!wallet || wallet.length === 0) {
        throw new UnregisteredAgentError(stepKind, "<missing>");
    }
    const ok = await isRegisteredAgent(wallet);
    if (ok === true) return;
    throw new UnregisteredAgentError(stepKind, wallet);
}
