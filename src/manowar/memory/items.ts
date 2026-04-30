import { invalidateMemoryScope } from "./cache.js";
import { getEmbedding } from "./embedding.js";
import { getMemoryVectorsCollection } from "./mongo.js";
import type { MemoryVector } from "./types.js";
import {
    buildOptionalScopedMemoryFilter,
    mergeMemoryMetadata,
} from "./utils.js";

function nowMs(): number {
    return Date.now();
}

function buildMemoryItemFilter(input: {
    id?: string;
    agentWallet?: string;
    userAddress?: string;
    threadId?: string;
    filters?: Record<string, unknown>;
}): Record<string, unknown> {
    const filter = buildOptionalScopedMemoryFilter({
        agentWallet: input.agentWallet,
        userAddress: input.userAddress,
        threadId: input.threadId,
        filters: input.filters,
    }, { activeOnly: true });
    if (input.id) {
        filter.vectorId = input.id;
    }
    return filter;
}

export async function getMemoryItem(input: {
    id: string;
    agentWallet?: string;
    userAddress?: string;
    threadId?: string;
    filters?: Record<string, unknown>;
}): Promise<MemoryVector | null> {
    const vectors = await getMemoryVectorsCollection();
    return vectors.findOne(buildMemoryItemFilter(input));
}

export async function updateMemoryItem(input: {
    id: string;
    agentWallet?: string;
    userAddress?: string;
    threadId?: string;
    content?: string;
    metadata?: Record<string, unknown>;
    retention?: string;
    confidence?: number;
    status?: "active" | "superseded" | "archived";
    filters?: Record<string, unknown>;
}): Promise<{ updated: boolean; item: MemoryVector | null }> {
    const vectors = await getMemoryVectorsCollection();
    const existing = await vectors.findOne(buildMemoryItemFilter(input));
    if (!existing) {
        return { updated: false, item: null };
    }

    const now = nowMs();
    const set: Record<string, unknown> = {
        updatedAt: now,
        metadata: mergeMemoryMetadata(existing.metadata, input.metadata),
    };

    if (input.content && input.content.trim() !== existing.content) {
        const embedding = await getEmbedding(input.content);
        set.content = input.content.trim();
        set.embedding = embedding.embedding;
        set.metadata = mergeMemoryMetadata(set.metadata as Record<string, unknown>, {
            embedding_provider: embedding.provider,
            embedding_dimensions: embedding.dimensions,
            embedding_cached: embedding.cached,
        });
    }
    if (input.retention) {
        (set.metadata as Record<string, unknown>).retention = input.retention;
    }
    if (typeof input.confidence === "number") {
        (set.metadata as Record<string, unknown>).confidence = input.confidence;
    }
    if (input.status) {
        (set.metadata as Record<string, unknown>).status = input.status;
    }

    await vectors.updateOne({ vectorId: existing.vectorId }, { $set: set });
    await invalidateMemoryScope({
        agentWallet: existing.agentWallet,
        userAddress: existing.userAddress,
        threadId: existing.threadId,
        mode: existing.mode,
        haiId: existing.haiId,
    });

    return {
        updated: true,
        item: await vectors.findOne({ vectorId: existing.vectorId }),
    };
}

export async function deleteMemoryItem(input: {
    id: string;
    agentWallet?: string;
    userAddress?: string;
    hardDelete?: boolean;
    filters?: Record<string, unknown>;
}): Promise<{ deleted: boolean; hardDeleted: boolean }> {
    const vectors = await getMemoryVectorsCollection();
    const existing = await vectors.findOne(buildMemoryItemFilter(input));
    if (!existing) {
        return { deleted: false, hardDeleted: Boolean(input.hardDelete) };
    }

    if (input.hardDelete) {
        await vectors.deleteOne({ vectorId: existing.vectorId });
    } else {
        await vectors.updateOne(
            { vectorId: existing.vectorId },
            {
                $set: {
                    decayScore: 0,
                    updatedAt: nowMs(),
                    metadata: mergeMemoryMetadata(existing.metadata, {
                        status: "deleted",
                        deletedAt: nowMs(),
                    }),
                },
            },
        );
    }

    await invalidateMemoryScope({
        agentWallet: existing.agentWallet,
        userAddress: existing.userAddress,
        threadId: existing.threadId,
        mode: existing.mode,
        haiId: existing.haiId,
    });

    return { deleted: true, hardDeleted: Boolean(input.hardDelete) };
}

export async function resolveMemoryConflict(input: {
    memoryId: string;
    agentWallet?: string;
    resolution: "supersede" | "keep" | "merge" | "ignore";
    winningMemoryId?: string;
    reason?: string;
}): Promise<{ resolved: boolean; memoryId: string }> {
    const metadata = {
        conflictResolution: input.resolution,
        conflictResolvedAt: nowMs(),
        ...(input.winningMemoryId ? { winningMemoryId: input.winningMemoryId } : {}),
        ...(input.reason ? { conflictReason: input.reason } : {}),
    };
    const status = input.resolution === "supersede" ? "superseded" : "active";
    const result = await updateMemoryItem({
        id: input.memoryId,
        agentWallet: input.agentWallet,
        metadata,
        status,
    });
    return { resolved: result.updated, memoryId: input.memoryId };
}
