/**
 * Dynamic coordinator pool.
 *
 * Replaces the hard-coded list in workflow/agentic.ts (which is in the
 * deprecated workflow module). Reads the api's `/v1/models/all` route and
 * filters by `capabilities` containing "reasoning". The api owns the
 * canonical metadata; the runtime is a read-only consumer.
 *
 * Behavior is purely informational — the runtime returns ModelCard[]; whether
 * the cal interpreter or harness/registry actually selects one of these
 * models is a separate decision.
 */
import { requireApiInternalUrl, buildApiInternalHeaders } from "../../auth.js";

export interface CoordinatorModel {
    modelId: string;
    provider: string;
    name?: string;
    description?: string;
    contextWindow?: unknown;
    capabilities: string[];
}

interface RawModelEntry {
    modelId?: string;
    id?: string;
    provider?: string;
    name?: string;
    description?: string;
    contextWindow?: unknown;
    capabilities?: string[];
}

interface ModelsListResponse {
    data?: RawModelEntry[];
    models?: RawModelEntry[];
}

const COORDINATOR_CAPABILITIES = ["introspection", "agentic"];
const CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry {
    fetchedAt: number;
    models: CoordinatorModel[];
}

let cache: CacheEntry | null = null;

function normalizeEntry(entry: RawModelEntry): CoordinatorModel | null {
    const modelId = entry.modelId || entry.id;
    if (!modelId) return null;
    const capabilities = Array.isArray(entry.capabilities) ? entry.capabilities : [];
    return {
        modelId,
        provider: entry.provider ?? "",
        name: entry.name,
        description: entry.description,
        contextWindow: entry.contextWindow,
        capabilities,
    };
}

function isCoordinator(model: CoordinatorModel): boolean {
    return model.capabilities.some(capability => COORDINATOR_CAPABILITIES.includes(capability));
}

/**
 * Fetch the agentic-coordinator pool. Cached for 5 minutes. The api route is
 * the single source of truth. If the api is unreachable, the pool returns
 * empty and callers should handle that gracefully — never default to a
 * hard-coded fallback list.
 */
export async function listAgenticCoordinators(options: { force?: boolean } = {}): Promise<CoordinatorModel[]> {
    const now = Date.now();
    if (!options.force && cache && now - cache.fetchedAt < CACHE_TTL_MS) {
        return cache.models;
    }

    const url = `${requireApiInternalUrl()}/v1/models/all`;
    let response: Response;
    try {
        response = await fetch(url, {
            method: "GET",
            headers: {
                Accept: "application/json",
                ...buildApiInternalHeaders(),
            },
            signal: AbortSignal.timeout(8000),
        });
    } catch (error) {
        console.warn(`[harness:coordinators] api fetch failed: ${error instanceof Error ? error.message : error}`);
        if (cache) return cache.models;
        return [];
    }

    if (!response.ok) {
        console.warn(`[harness:coordinators] api returned ${response.status}`);
        if (cache) return cache.models;
        return [];
    }

    let body: ModelsListResponse;
    try {
        body = (await response.json()) as ModelsListResponse;
    } catch (error) {
        console.warn(`[harness:coordinators] api returned invalid JSON: ${error instanceof Error ? error.message : error}`);
        if (cache) return cache.models;
        return [];
    }

    const rawList = body.data ?? body.models ?? [];
    const normalized = rawList
        .map(normalizeEntry)
        .filter((m): m is CoordinatorModel => Boolean(m))
        .filter(isCoordinator);

    cache = { fetchedAt: now, models: normalized };
    return normalized;
}

export function isAgenticCoordinatorModel(modelId: string, pool?: CoordinatorModel[]): boolean {
    const list = pool ?? cache?.models ?? [];
    return list.some((m) => m.modelId === modelId);
}

export function clearCoordinatorCache(): void {
    cache = null;
}
