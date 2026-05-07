/**
 * Discovery helpers for the cal interpreter and tool surface.
 *
 *   - searchTools(q)  → connectors `/tools/search` (Cloudflare Vectorize index
 *                       compose-tools, already populated by the connectors
 *                       pipeline at runtime/src/connectors/workflows/embed.ts).
 *   - searchAgents(q) → api `/agents/search` (HTTP, api-side route; the
 *                       runtime never indexes agents itself).
 *   - searchModels(q) → Cloudflare Vectorize index "compose-models" populated
 *                       by the GitHub Action that re-uploads models.json on
 *                       every sync.
 *
 * All three are read-only HTTP calls. None of them touch billing.
 *
 * The runtime calls connectors and api over their existing internal-secret
 * Bearer auth (RUNTIME_INTERNAL_SECRET). Vectorize is hit through Cloudflare's
 * REST API with CF_API_TOKEN.
 */

import { requireApiInternalUrl, requireApiInternalToken } from "../../auth.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolSearchHit {
    slug: string;
    name: string;
    description?: string;
    category?: string;
    tags: string[];
    score?: number;
    /** Convenience: the connector binding string (e.g. "tools:notion"). */
    bindingId: string;
}

export interface AgentSearchHit {
    walletAddress: string;
    name: string;
    description?: string;
    skills: string[];
    plugins: string[];
    score?: number;
}

export interface ModelSearchHit {
    modelId: string;
    provider: string;
    name?: string;
    type?: string | string[];
    contextWindow?: unknown;
    capabilities?: string[];
    description?: string;
    score?: number;
}

// ---------------------------------------------------------------------------
// Tool search — connectors broker
// ---------------------------------------------------------------------------

function requireConnectorsUrl(): string {
    const raw = process.env.CONNECTORS_URL;
    if (!raw) throw new Error("CONNECTORS_URL is required for searchTools");
    return raw.replace(/\/+$/, "");
}

function requireInternalSecret(): string {
    const raw = process.env.RUNTIME_INTERNAL_SECRET;
    if (!raw) throw new Error("RUNTIME_INTERNAL_SECRET is required");
    return raw;
}

export async function searchTools(query: string, topK = 12): Promise<ToolSearchHit[]> {
    const q = query.trim();
    if (!q) return [];
    const url = `${requireConnectorsUrl()}/tools/search?q=${encodeURIComponent(q)}&limit=${topK}`;
    const response = await fetch(url, {
        method: "GET",
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${requireInternalSecret()}`,
        },
        signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
        throw new Error(`searchTools failed (${response.status}): ${await response.text().catch(() => "")}`);
    }
    const body = (await response.json()) as {
        servers?: Array<{
            slug: string;
            name: string;
            description?: string;
            tags?: string[];
            category?: string;
        }>;
    };
    return (body.servers ?? []).map((s) => ({
        slug: s.slug,
        name: s.name,
        description: s.description,
        category: s.category,
        tags: Array.isArray(s.tags) ? s.tags : [],
        bindingId: `tools:${s.slug}`,
    }));
}

// ---------------------------------------------------------------------------
// Agent search — api route (https://api.compose.market/agents/search)
// ---------------------------------------------------------------------------
//
// The api side owns agent indexing. We call the documented endpoint without
// caring about its internal storage. If the endpoint shape evolves, only this
// wrapper changes.
export async function searchAgents(query: string, topK = 8): Promise<AgentSearchHit[]> {
    const q = query.trim();
    if (!q) return [];
    const url = `${requireApiInternalUrl()}/agents/search?q=${encodeURIComponent(q)}&limit=${topK}`;
    const response = await fetch(url, {
        method: "GET",
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${requireApiInternalToken()}`,
        },
        signal: AbortSignal.timeout(8000),
    });
    if (response.status === 404) {
        // Endpoint not deployed yet — graceful degrade so the cal interpreter
        // keeps working with stale agent lists.
        return [];
    }
    if (!response.ok) {
        throw new Error(`searchAgents failed (${response.status}): ${await response.text().catch(() => "")}`);
    }
    const body = (await response.json()) as {
        agents?: Array<{
            walletAddress: string;
            name: string;
            description?: string;
            skills?: string[];
            plugins?: Array<string | { registryId?: string; name?: string }>;
            score?: number;
        }>;
    };
    return (body.agents ?? []).map((a) => ({
        walletAddress: a.walletAddress,
        name: a.name,
        description: a.description,
        skills: Array.isArray(a.skills) ? a.skills : [],
        plugins: (a.plugins ?? []).map((p) => (typeof p === "string" ? p : p.registryId ?? p.name ?? "")).filter(Boolean) as string[],
        score: a.score,
    }));
}

// ---------------------------------------------------------------------------
// Model search — Cloudflare Vectorize (index compose-models)
// ---------------------------------------------------------------------------

interface VectorizeQueryResponse {
    success?: boolean;
    result?: {
        matches?: Array<{
            id: string;
            score: number;
            metadata?: Record<string, unknown>;
        }>;
    };
    errors?: Array<{ message?: string; code?: number }>;
}

interface VoyageEmbeddingResponse {
    object: string;
    data: Array<{ object: string; embedding: number[]; index: number }>;
    model: string;
}

function requireMongoVoyageKey(): string {
    const value = process.env.MONGO_DB_API_KEY;
    if (!value) throw new Error("MONGO_DB_API_KEY required for model embedding");
    return value;
}

function requireCfAccountId(): string {
    const value = process.env.CF_ACCOUNT_ID;
    if (!value) throw new Error("CF_ACCOUNT_ID required for Vectorize model search");
    return value;
}

function requireCfApiToken(): string {
    // Vectorize needs a token with Vectorize:Edit scope. Production
    // typically uses CF_GLOBAL_TOKEN; CF_API_TOKEN may be a narrower-scope
    // token meant for other Cloudflare APIs. Try in order of expected
    // privilege so the function works in dev and prod without per-host env
    // tweaks.
    const value = process.env.CF_VECTORIZE_TOKEN
        || process.env.CF_GLOBAL_TOKEN
        || process.env.CF_API_TOKEN;
    if (!value) throw new Error("CF_VECTORIZE_TOKEN, CF_GLOBAL_TOKEN, or CF_API_TOKEN required for Vectorize model search");
    return value;
}

const MODEL_INDEX_NAME = process.env.COMPOSE_MODELS_INDEX || "compose-models";

async function embedQueryVoyage(text: string): Promise<number[]> {
    const apiKey = requireMongoVoyageKey();
    const base = (process.env.MONGO_DB_EMBEDDING_API_BASE_URL || "https://ai.mongodb.com/v1").replace(/\/+$/, "");
    const response = await fetch(`${base}/embeddings`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: process.env.MEMORY_EMBEDDING_MODEL || "voyage-4-large",
            input: text,
            input_type: "query",
            output_dimension: 1024,
        }),
        signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
        throw new Error(`Voyage embed failed (${response.status}): ${await response.text().catch(() => "")}`);
    }
    const parsed = (await response.json()) as VoyageEmbeddingResponse;
    const vec = parsed.data?.[0]?.embedding;
    if (!Array.isArray(vec)) throw new Error("Voyage returned no embedding");
    return vec;
}

export async function searchModels(
    query: string,
    options: { topK?: number; capability?: string } = {},
): Promise<ModelSearchHit[]> {
    const q = query.trim();
    if (!q) return [];
    const topK = options.topK ?? 12;

    let queryVector: number[];
    try {
        queryVector = await embedQueryVoyage(q);
    } catch (error) {
        // If Voyage is down, return empty so the cal interpreter does not
        // hard-fail the plan — the agent can still call delegate / tools.
        console.warn(`[harness:discovery] embed for searchModels failed: ${error instanceof Error ? error.message : error}`);
        return [];
    }

    const accountId = requireCfAccountId();
    const apiToken = requireCfApiToken();
    // Vectorize metadata indexes only support string/number/boolean (no
    // arrays), so the sync script flattens each capability to a per-cap
    // boolean flag `cap_<name>: true`. We filter by $eq against that flag.
    const filter = options.capability
        ? { [`cap_${options.capability.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`]: { $eq: true } }
        : undefined;

    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/vectorize/v2/indexes/${encodeURIComponent(MODEL_INDEX_NAME)}/query`;
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiToken}`,
        },
        body: JSON.stringify({
            vector: queryVector,
            topK,
            returnMetadata: "all",
            ...(filter ? { filter } : {}),
        }),
        signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Vectorize compose-models query failed (${response.status}): ${body.slice(0, 300)}`);
    }
    const parsed = (await response.json()) as VectorizeQueryResponse;
    if (parsed.success === false) {
        const message = parsed.errors?.[0]?.message ?? "vectorize query failed";
        throw new Error(`Vectorize compose-models error: ${message}`);
    }
    const matches = parsed.result?.matches ?? [];
    return matches.map((m) => {
        const meta = (m.metadata ?? {}) as {
            modelId?: string;
            provider?: string;
            name?: string;
            type?: string | string[];
            contextWindow?: unknown;
            capabilities?: string[];
            description?: string;
        };
        return {
            modelId: typeof meta.modelId === "string" ? meta.modelId : m.id,
            provider: typeof meta.provider === "string" ? meta.provider : "",
            name: typeof meta.name === "string" ? meta.name : undefined,
            type: meta.type,
            contextWindow: meta.contextWindow,
            capabilities: Array.isArray(meta.capabilities) ? meta.capabilities : undefined,
            description: typeof meta.description === "string" ? meta.description : undefined,
            score: m.score,
        };
    });
}
