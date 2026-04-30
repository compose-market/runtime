import { mergeMemoryMongoFilters } from "./filters.js";
import type { LayeredSearchParams } from "./types.js";

export function asString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function asNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

export function assertObject(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

export function normalizeMemoryMode(value: unknown): "global" | "local" | undefined {
    return value === "global" || value === "local" ? value : undefined;
}

export function clampInteger(value: unknown, fallback: number, max: number): number {
    const raw = asNumber(value);
    if (!raw) {
        return fallback;
    }
    return Math.max(1, Math.min(max, Math.floor(raw)));
}

export function measureMemoryChars(value: string | null | undefined): number {
    if (!value) {
        return 0;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return 0;
    }
    return trimmed.length;
}

export function buildThreadSessionId(scope: {
    agentWallet: string;
    threadId?: string;
    mode?: "global" | "local";
    haiId?: string;
}): string {
    const scopeKey = scope.mode === "local"
        ? `local:${scope.haiId || scope.agentWallet}`
        : `global:${scope.agentWallet}`;
    return `session:${scopeKey}:${scope.threadId || "main"}`;
}

export function buildScopedMemoryFilter(
    params: Pick<LayeredSearchParams, "agentWallet" | "userAddress" | "threadId" | "mode" | "haiId" | "filters">,
    options: { durable?: boolean; activeOnly?: boolean } = {},
): Record<string, unknown> {
    return buildOptionalScopedMemoryFilter(params, options);
}

export function buildOptionalScopedMemoryFilter(
    params: {
        agentWallet?: string;
        userAddress?: string;
        threadId?: string;
        mode?: "global" | "local";
        haiId?: string;
        filters?: Record<string, unknown>;
    },
    options: { durable?: boolean; activeOnly?: boolean } = {},
): Record<string, unknown> {
    const filter: Record<string, unknown> = {};
    if (params.agentWallet) {
        filter.agentWallet = params.agentWallet;
    }
    if (params.userAddress) {
        filter.userAddress = params.userAddress;
    }
    if (!options.durable && params.threadId) {
        filter.threadId = params.threadId;
    }
    if (params.mode) {
        filter.mode = params.mode;
    }
    if (params.haiId) {
        filter.haiId = params.haiId;
    }
    if (options.activeOnly) {
        filter["metadata.status"] = { $nin: ["deleted", "superseded"] };
    }
    return mergeMemoryMongoFilters(filter, params.filters);
}

export function queryTermScore(query: string, text: string | undefined): number {
    if (!text) {
        return 0;
    }
    const queryTerms = Array.from(new Set(query.toLowerCase().split(/\s+/).filter((term) => term.length > 2)));
    if (queryTerms.length === 0) {
        return 0;
    }
    const lower = text.toLowerCase();
    const hits = queryTerms.reduce((count, term) => count + (lower.includes(term) ? 1 : 0), 0);
    return hits / queryTerms.length;
}

export function recencyScore(createdAt: unknown, halfLifeDays = 30): number {
    const timestamp = asNumber(createdAt);
    if (!timestamp) {
        return 0;
    }
    const ageInDays = Math.max(0, Date.now() - timestamp) / (24 * 60 * 60 * 1000);
    return Math.pow(0.5, ageInDays / Math.max(1, halfLifeDays));
}

export function mergeMemoryMetadata(
    existing: Record<string, unknown> | undefined,
    ...updates: Array<Record<string, unknown> | undefined>
): Record<string, unknown> {
    return updates.reduce<Record<string, unknown>>((merged, update) => ({
        ...merged,
        ...(update || {}),
    }), { ...(existing || {}) });
}
