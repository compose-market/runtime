/**
 * Mem0 — durable extracted-fact graph layer.
 *
 * Single responsibility in our memory framework: take conversational pairs at
 * end-of-turn and let Mem0 v3 extract durable facts ("Alex prefers black
 * coffee", "Bob loves jazz"), with built-in hybrid retrieval at search time.
 *
 * Strict separation of concerns:
 *   - We do NOT pass `top_k` / `threshold` / `rerank` / `keyword_search` /
 *     `enable_graph` / `async_mode` from our framework. Mem0 v3 has its own
 *     defaults (top_k=10, threshold=0.1, hybrid retrieval always on, ADD-only
 *     pipeline) and we let it own that domain.
 *   - We pass the v3-required scope (`user_id` + `agent_id`) at the top
 *     level for `add`, and inside `filters` for `search` (v3 rejects
 *     top-level entity IDs on search).
 *   - We do NOT scope by `run_id` — that fragmented memories per-thread.
 *     Per-turn traceability stays in `metadata.run_id` (queryable, but not a
 *     partition key). Cross-thread recall for the same user is the whole
 *     point of Mem0 in our stack.
 *   - Our framework's CF rerank / temporal decay / MMR run on the Atlas
 *     vector layer, not on Mem0 — different layers, no overlap.
 *   - Local cache is namespace-tokened so memory writes always invalidate
 *     subsequent reads (handled by ./cache.ts).
 */

import {
    CACHE_TTL_SECONDS,
    getCachedJson,
    getGraphQueryCacheKey,
    invalidateMemoryScope,
    resolveScopedCacheKey,
    setCachedJson,
} from "./cache.js";
import type {
    KnowledgeAddParams,
    MemoryAddParams,
    MemoryItem,
    MemorySearchParams,
} from "./types.js";

const MEM0_API_KEY = process.env.MEM0_API_KEY;
const MEM0_API_BASE_URL = (process.env.MEM0_API_BASE_URL || "https://api.mem0.ai").replace(/\/+$/u, "");
const MEM0_REQUEST_TIMEOUT_MS = Number(process.env.MEMORY_MEM0_TIMEOUT_MS || 4000);

if (!MEM0_API_KEY) {
    console.warn("[memory:mem0] MEM0_API_KEY is not set; graph memory operations will be no-op.");
}

interface Mem0AddV3Response {
    message?: string;
    status?: "PENDING" | "SUCCEEDED" | "FAILED";
    event_id?: string;
    error?: string;
    details?: { message?: string };
}

interface Mem0SearchV3Response {
    results?: Array<{
        id?: string;
        memory?: string;
        score?: number;
        user_id?: string;
        agent_id?: string;
        run_id?: string;
        metadata?: Record<string, unknown> | null;
        categories?: string[];
        created_at?: string;
        updated_at?: string;
    }>;
    error?: string;
}

function normalizeMem0EntityId(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed.toLowerCase() : undefined;
}

function clampString(value: string, max: number): string {
    return value.length > max ? value.slice(0, max) : value;
}

function withTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
    const timeoutMs = Number.isFinite(MEM0_REQUEST_TIMEOUT_MS) ? Math.max(500, MEM0_REQUEST_TIMEOUT_MS) : 4000;
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
        operation.finally(() => { if (timer) clearTimeout(timer); }),
        new Promise<T>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
    ]);
}

async function mem0Fetch(path: string, body: unknown): Promise<Response> {
    if (!MEM0_API_KEY) {
        throw new Error("MEM0_API_KEY is not configured");
    }
    return fetch(`${MEM0_API_BASE_URL}${path}`, {
        method: "POST",
        headers: {
            Authorization: `Token ${MEM0_API_KEY}`,
            "Content-Type": "application/json",
            Accept: "application/json",
        },
        body: JSON.stringify(body),
    });
}

/**
 * Add an end-of-turn conversational pair. Mem0 v3 ADD-only pipeline extracts
 * durable facts asynchronously — we get back an `event_id` we don't need to
 * poll (search picks them up automatically once SUCCEEDED, typically <30s).
 *
 * We deliberately drop `enable_graph` and `async_mode` (gone from v3) and we
 * do NOT pass `run_id` as a scope key — see file header.
 */
export async function addMemory(params: MemoryAddParams): Promise<MemoryItem[]> {
    if (!MEM0_API_KEY) {
        return [];
    }

    const userId = normalizeMem0EntityId(params.user_id);
    const agentId = normalizeMem0EntityId(params.agent_id);
    const runId = normalizeMem0EntityId(params.run_id);

    if (!userId && !agentId) {
        // v3 requires at least one entity ID. Without user OR agent we can't
        // attribute the memory — drop silently.
        return [];
    }

    if (!Array.isArray(params.messages) || params.messages.length === 0) {
        return [];
    }

    const messages = params.messages
        .filter((m) => typeof m?.content === "string" && m.content.trim().length > 0)
        .map((m) => ({
            role: m.role === "user" || m.role === "assistant" || m.role === "system" ? m.role : "user",
            content: clampString(m.content.replace(/\s+/g, " ").trim(), 4_000),
        }));

    if (messages.length === 0) {
        return [];
    }

    const requestBody: Record<string, unknown> = { messages };
    if (userId) requestBody.user_id = userId;
    if (agentId) requestBody.agent_id = agentId;

    // Per-turn traceability: keep run_id in metadata only. Queryable via
    // `filters.metadata.run_id` at search time but does not partition the
    // memory itself.
    const metadata: Record<string, unknown> = { ...(params.metadata || {}) };
    if (runId) metadata.run_id = runId;
    if (Object.keys(metadata).length > 0) {
        requestBody.metadata = metadata;
    }

    try {
        const response = await withTimeout(mem0Fetch("/v3/memories/add/", requestBody), "Mem0 v3 add");
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            console.warn(`[memory:mem0] v3 add failed ${response.status}: ${body.slice(0, 300)}`);
            return [];
        }
        const data = (await response.json()) as Mem0AddV3Response | Mem0AddV3Response[];
        const event = Array.isArray(data) ? data[0] : data;
        if (event?.status === "FAILED") {
            console.warn(`[memory:mem0] v3 add returned FAILED for event=${event.event_id}`);
            return [];
        }

        await invalidateMemoryScope({
            agentWallet: agentId,
            userAddress: userId,
            threadId: runId,
            mode: params.mode,
            haiId: params.haiId,
        });

        // v3 add is asynchronous; we return an empty array since extracted
        // memories aren't available yet. Callers that need confirmation can
        // poll `/v1/event/{event_id}/`.
        return [];
    } catch (error) {
        console.warn(`[memory:mem0] v3 add error: ${error instanceof Error ? error.message : String(error)}`);
        return [];
    }
}

/**
 * Persist a knowledge document. Same v3 ADD pipeline — Mem0 will extract
 * facts from the doc body and tag them with `metadata.type=knowledge`.
 */
export async function addKnowledge(params: KnowledgeAddParams): Promise<MemoryItem[]> {
    return addMemory({
        messages: [
            { role: "user", content: `Knowledge document (${params.key || "untitled"}): ${params.content}` },
            { role: "assistant", content: "Stored." },
        ],
        agent_id: params.agent_id,
        user_id: params.user_id,
        metadata: {
            type: "knowledge",
            key: params.key,
            source: params.source || "paste",
            ...params.metadata,
        },
    });
}

/**
 * v3 search — entity IDs MUST be inside `filters`. We default to scoping by
 * (user_id, agent_id) so the agent recalls facts about a user across every
 * thread. Mem0 v3 hybrid retrieval (semantic + BM25 + entity matching)
 * handles ranking; we do NOT pass our own top_k/threshold/rerank.
 */
export async function searchMemory(params: MemorySearchParams): Promise<MemoryItem[]> {
    if (!MEM0_API_KEY) {
        return [];
    }

    const query = (params.query || "").trim();
    if (query.length === 0) {
        return [];
    }

    const userId = normalizeMem0EntityId(params.user_id);
    const agentId = normalizeMem0EntityId(params.agent_id);
    const runId = normalizeMem0EntityId(params.run_id);

    if (!userId && !agentId) {
        return [];
    }

    // v3 requires entity scoping inside `filters`. We default to AND of
    // (user_id, agent_id) — recall everything Mem0 has extracted about THIS
    // user in conversations with THIS agent, across all threads.
    // run_id, when present, becomes metadata.run_id wildcard so we can pull
    // back per-thread memories without losing cross-thread recall.
    const filterTerms: Array<Record<string, unknown>> = [];
    if (userId) filterTerms.push({ user_id: userId });
    if (agentId) filterTerms.push({ agent_id: agentId });
    if (runId) {
        // Allow caller to opt into thread-scoped recall by setting `run_id`,
        // but never REQUIRE the run match — fall back to `*` so a fact
        // extracted from another thread still surfaces.
        filterTerms.push({ run_id: { in: [runId, "*"] } });
    }

    const filtersBlock = filterTerms.length === 1
        ? filterTerms[0]
        : { AND: filterTerms };

    const requestBody: Record<string, unknown> = {
        query: clampString(query, 2_000),
        filters: filtersBlock,
    };

    const cacheKey = await resolveScopedCacheKey(getGraphQueryCacheKey({
        query,
        agentWallet: agentId || "_",
        userAddress: userId,
        threadId: runId,
        mode: params.mode,
        haiId: params.haiId,
        filters: typeof params.filters === "object" && params.filters ? params.filters : undefined,
    }), {
        agentWallet: agentId || "_",
        userAddress: userId,
        threadId: runId,
        mode: params.mode,
        haiId: params.haiId,
    });

    const cached = await getCachedJson<MemoryItem[]>(cacheKey);
    if (Array.isArray(cached)) {
        return cached;
    }

    try {
        const response = await withTimeout(mem0Fetch("/v3/memories/search/", requestBody), "Mem0 v3 search");
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            console.warn(`[memory:mem0] v3 search failed ${response.status}: ${body.slice(0, 300)}`);
            return [];
        }
        const data = (await response.json()) as Mem0SearchV3Response;
        const results = (data.results ?? []).map<MemoryItem>((r) => ({
            id: r.id ?? "",
            memory: r.memory ?? "",
            user_id: r.user_id,
            agent_id: r.agent_id,
            run_id: r.run_id,
            metadata: r.metadata ?? undefined,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }));

        await setCachedJson(cacheKey, results, CACHE_TTL_SECONDS.graphQuery);
        return results;
    } catch (error) {
        console.warn(`[memory:mem0] v3 search error: ${error instanceof Error ? error.message : String(error)}`);
        return [];
    }
}

/**
 * List all extracted memories for a scope. Used by diagnostics / admin
 * surfaces, not on the hot path. v2 list endpoint accepts entity IDs in
 * `filters` — we keep the same shape for consistency with `searchMemory`.
 */
export async function getAllMemories(options?: {
    user_id?: string;
    agent_id?: string;
    run_id?: string;
    limit?: number;
}): Promise<MemoryItem[]> {
    if (!MEM0_API_KEY) {
        return [];
    }

    const userId = normalizeMem0EntityId(options?.user_id);
    const agentId = normalizeMem0EntityId(options?.agent_id);
    const runId = normalizeMem0EntityId(options?.run_id);

    if (!userId && !agentId && !runId) {
        return [];
    }

    const filterTerms: Array<Record<string, unknown>> = [];
    if (userId) filterTerms.push({ user_id: userId });
    if (agentId) filterTerms.push({ agent_id: agentId });
    if (runId) filterTerms.push({ run_id: runId });

    const requestBody: Record<string, unknown> = {
        filters: filterTerms.length === 1 ? filterTerms[0] : { AND: filterTerms },
    };
    if (typeof options?.limit === "number" && options.limit > 0) {
        requestBody.page_size = Math.min(100, Math.floor(options.limit));
    }

    try {
        const response = await withTimeout(mem0Fetch("/v2/memories/", requestBody), "Mem0 v2 list");
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            console.warn(`[memory:mem0] v2 list failed ${response.status}: ${body.slice(0, 300)}`);
            return [];
        }
        const data = (await response.json()) as Array<{
            id?: string;
            memory?: string;
            user_id?: string;
            agent_id?: string;
            run_id?: string;
            metadata?: Record<string, unknown> | null;
            created_at?: string;
            updated_at?: string;
        }>;
        return (data || []).map<MemoryItem>((r) => ({
            id: r.id ?? "",
            memory: r.memory ?? "",
            user_id: r.user_id,
            agent_id: r.agent_id,
            run_id: r.run_id,
            metadata: r.metadata ?? undefined,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }));
    } catch (error) {
        console.warn(`[memory:mem0] v2 list error: ${error instanceof Error ? error.message : String(error)}`);
        return [];
    }
}
