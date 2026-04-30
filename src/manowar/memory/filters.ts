type FilterPrimitive = string | number | boolean | null;

interface NormalizedFilter {
    path: string;
    value: FilterPrimitive | FilterPrimitive[];
}

const FILTER_PATH_ALIASES: Record<string, string> = {
    appId: "metadata.app_id",
    app_id: "metadata.app_id",
    hai_id: "haiId",
    user_id: "userAddress",
    thread_id: "threadId",
};

const TOP_LEVEL_FILTER_PATHS = new Set([
    "agentWallet",
    "userAddress",
    "threadId",
    "mode",
    "haiId",
    "scopeKind",
    "scopeId",
    "source",
]);

function isPrimitive(value: unknown): value is FilterPrimitive {
    return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function normalizeFilterPath(key: string): string | null {
    const mapped = FILTER_PATH_ALIASES[key] || key;
    if (TOP_LEVEL_FILTER_PATHS.has(mapped)) {
        return mapped;
    }
    if (mapped.startsWith("metadata.") || mapped.startsWith("workingMemory.state.") || mapped.startsWith("workingMemory.entities.")) {
        return mapped;
    }
    return null;
}

export function normalizeMemoryFilters(filters?: Record<string, unknown>): NormalizedFilter[] {
    if (!filters || typeof filters !== "object") {
        return [];
    }

    const normalized: NormalizedFilter[] = [];
    for (const [key, value] of Object.entries(filters)) {
        const path = normalizeFilterPath(key);
        if (!path) {
            continue;
        }
        if (isPrimitive(value)) {
            normalized.push({ path, value });
            continue;
        }
        if (Array.isArray(value) && value.every(isPrimitive)) {
            normalized.push({ path, value });
        }
    }
    return normalized;
}

export function mergeMemoryMongoFilters(
    base: Record<string, unknown>,
    filters?: Record<string, unknown>,
): Record<string, unknown> {
    const normalized = normalizeMemoryFilters(filters);
    if (normalized.length === 0) {
        return base;
    }

    const merged: Record<string, unknown> = { ...base };
    for (const filter of normalized) {
        const condition = Array.isArray(filter.value) ? { $in: filter.value } : filter.value;
        if (merged[filter.path] === undefined) {
            merged[filter.path] = condition;
        }
    }
    return merged;
}

function getByPath(value: unknown, path: string): unknown {
    let current = value as Record<string, unknown> | undefined;
    for (const segment of path.split(".")) {
        if (!current || typeof current !== "object") {
            return undefined;
        }
        current = current[segment] as Record<string, unknown> | undefined;
    }
    return current;
}

export function matchesMemoryFilters(item: unknown, filters?: Record<string, unknown>): boolean {
    const normalized = normalizeMemoryFilters(filters);
    if (normalized.length === 0) {
        return true;
    }

    return normalized.every((filter) => {
        const actual = getByPath(item, filter.path);
        if (Array.isArray(filter.value)) {
            return filter.value.includes(actual as FilterPrimitive);
        }
        return actual === filter.value;
    });
}
