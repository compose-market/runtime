import { Context } from "@temporalio/activity";
import {
    DEFAULT_MEMORY_HALF_LIFE_DAYS,
    DEFAULT_MEMORY_BATCH_SIZE,
    DEFAULT_PATTERN_CONFIDENCE_THRESHOLD,
} from "./constants.js";
import type {
    MemoryActivityOptions,
    ConsolidationActivityResult,
    PatternExtractionActivityResult,
    ArchiveCreationActivityResult,
    DecayUpdateActivityResult,
    PatternValidationResult,
    SkillPromotionResult,
    MemoryCleanupActivityResult,
    SyncToPinataResult,
} from "./types.js";

const LAMBDA_API_URL = process.env.LAMBDA_API_URL || "https://api.compose.market";
const MANOWAR_INTERNAL_SECRET = process.env.MANOWAR_INTERNAL_SECRET || "";
const ACTIVITY_HEARTBEAT_INTERVAL_MS = 30000;

interface LambdaResponse<T> {
    success: boolean;
    data?: T;
    error?: string;
    processed?: number;
}

function startPeriodicHeartbeat(details: Record<string, unknown>): NodeJS.Timeout {
    return setInterval(() => {
        try {
            Context.current().heartbeat(details);
        } catch {
            // Ignore heartbeat errors
        }
    }, ACTIVITY_HEARTBEAT_INTERVAL_MS);
}

async function lambdaFetch<T>(
    endpoint: string,
    method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
    body?: object
): Promise<LambdaResponse<T>> {
    const options: RequestInit = {
        method,
        headers: {
            "Content-Type": "application/json",
            "x-manowar-internal": MANOWAR_INTERNAL_SECRET,
        },
    };

    if (body && method !== "GET") {
        options.body = JSON.stringify(body);
    }

    const response = await fetch(`${LAMBDA_API_URL}${endpoint}`, options);

    if (!response.ok) {
        const errorText = await response.text();
        return {
            success: false,
            error: `Lambda request failed: ${response.status} - ${errorText}`,
        };
    }

    return await response.json() as LambdaResponse<T>;
}

export async function consolidateAgentMemories(input: {
    agentWallets: string[];
    options?: MemoryActivityOptions;
}): Promise<ConsolidationActivityResult> {
    const heartbeatInterval = startPeriodicHeartbeat({
        activity: "consolidateAgentMemories",
        agentCount: input.agentWallets.length,
    });

    try {
        const batchSize = input.options?.batchSize || DEFAULT_MEMORY_BATCH_SIZE;
        let totalProcessed = 0;
        const errors: string[] = [];

        for (let i = 0; i < input.agentWallets.length; i += batchSize) {
            const batch = input.agentWallets.slice(i, i + batchSize);

            const response = await lambdaFetch<{ consolidated: number }>("/internal/memory/consolidate", "POST", {
                agentWallets: batch,
                options: input.options,
            });

            if (response.success && response.data) {
                totalProcessed += response.data.consolidated;
            } else if (response.error) {
                errors.push(response.error);
            }

            Context.current().heartbeat({
                processed: totalProcessed,
                batch: Math.floor(i / batchSize) + 1,
                totalBatches: Math.ceil(input.agentWallets.length / batchSize),
            });
        }

        return {
            success: errors.length === 0,
            processed: totalProcessed,
            errors: errors.length > 0 ? errors : undefined,
        };
    } finally {
        clearInterval(heartbeatInterval);
    }
}

export async function extractExecutionPatterns(input: {
    agentWallet: string;
    timeRange: { start: number; end: number };
    options?: MemoryActivityOptions;
}): Promise<PatternExtractionActivityResult> {
    const heartbeatInterval = startPeriodicHeartbeat({
        activity: "extractExecutionPatterns",
        agentWallet: input.agentWallet,
    });

    try {
        const confidenceThreshold = input.options?.confidenceThreshold || DEFAULT_PATTERN_CONFIDENCE_THRESHOLD;

        const response = await lambdaFetch<{ patterns: number; extracted: number }>("/internal/memory/patterns/extract", "POST", {
            agentWallet: input.agentWallet,
            timeRange: input.timeRange,
            confidenceThreshold,
            options: input.options,
        });

        Context.current().heartbeat({
            processed: response.data?.extracted || 0,
            patterns: response.data?.patterns || 0,
        });

        return {
            success: response.success,
            processed: response.data?.extracted || 0,
            errors: response.error ? [response.error] : undefined,
        };
    } finally {
        clearInterval(heartbeatInterval);
    }
}

export async function createMemoryArchive(input: {
    agentWallet: string;
    dateRange: { start: number; end: number };
    options?: MemoryActivityOptions;
}): Promise<ArchiveCreationActivityResult> {
    const heartbeatInterval = startPeriodicHeartbeat({
        activity: "createMemoryArchive",
        agentWallet: input.agentWallet,
    });

    try {
        const response = await lambdaFetch<{ archiveId: string; memoriesArchived: number; compressedSize: number }>("/internal/memory/archive/create", "POST", {
            agentWallet: input.agentWallet,
            dateRange: input.dateRange,
            options: input.options,
        });

        if (response.success && response.data) {
            const syncResult = await syncToPinata({
                archiveId: response.data.archiveId,
                agentWallet: input.agentWallet,
            });

            Context.current().heartbeat({
                archiveId: response.data.archiveId,
                archived: response.data.memoriesArchived,
                syncedToPinata: syncResult.success,
            });

            return {
                success: response.success && syncResult.success,
                processed: response.data.memoriesArchived,
                archiveId: response.data.archiveId,
                ipfsHash: syncResult.ipfsHash,
                errors: syncResult.error ? [syncResult.error] : undefined,
            };
        }

        return {
            success: false,
            processed: 0,
            errors: response.error ? [response.error] : undefined,
        };
    } finally {
        clearInterval(heartbeatInterval);
    }
}

export async function updateDecayScores(input: {
    halfLifeDays?: number;
    options?: MemoryActivityOptions;
}): Promise<DecayUpdateActivityResult> {
    const heartbeatInterval = startPeriodicHeartbeat({
        activity: "updateDecayScores",
        halfLifeDays: input.halfLifeDays,
    });

    try {
        const halfLifeDays = input.halfLifeDays || DEFAULT_MEMORY_HALF_LIFE_DAYS;

        const response = await lambdaFetch<{ updated: number; avgDecayScore: number }>("/internal/memory/decay/update", "POST", {
            halfLifeDays,
            options: input.options,
        });

        Context.current().heartbeat({
            processed: response.data?.updated || 0,
            avgDecayScore: response.data?.avgDecayScore,
        });

        return {
            success: response.success,
            processed: response.data?.updated || 0,
            errors: response.error ? [response.error] : undefined,
        };
    } finally {
        clearInterval(heartbeatInterval);
    }
}

export async function validateExtractedPattern(input: {
    patternId: string;
    options?: MemoryActivityOptions;
}): Promise<PatternValidationResult> {
    const heartbeatInterval = startPeriodicHeartbeat({
        activity: "validateExtractedPattern",
        patternId: input.patternId,
    });

    try {
        const response = await lambdaFetch<{
            valid: boolean;
            confidence: number;
            occurrences: number;
            successRate: number;
            toolSequence: string[];
        }>("/internal/memory/patterns/validate", "POST", {
            patternId: input.patternId,
            options: input.options,
        });

        Context.current().heartbeat({
            patternId: input.patternId,
            valid: response.data?.valid,
        });

        if (response.success && response.data) {
            return {
                success: response.data.valid,
                data: response.data,
            };
        }

        return {
            success: false,
            error: response.error || "Pattern validation failed",
        };
    } finally {
        clearInterval(heartbeatInterval);
    }
}

export async function promotePatternToSkill(input: {
    patternId: string;
    skillName: string;
    validationData: {
        valid: boolean;
        confidence: number;
        occurrences: number;
        successRate: number;
        toolSequence: string[];
    };
    options?: MemoryActivityOptions;
}): Promise<SkillPromotionResult> {
    const heartbeatInterval = startPeriodicHeartbeat({
        activity: "promotePatternToSkill",
        patternId: input.patternId,
        skillName: input.skillName,
    });

    try {
        const response = await lambdaFetch<{
            skillId: string;
            promoted: boolean;
        }>("/internal/memory/patterns/promote", "POST", {
            patternId: input.patternId,
            skillName: input.skillName,
            validationData: input.validationData,
            options: input.options,
        });

        Context.current().heartbeat({
            patternId: input.patternId,
            skillId: response.data?.skillId,
            promoted: response.data?.promoted,
        });

        return {
            success: response.success && (response.data?.promoted || false),
            skillId: response.data?.skillId,
            error: response.error,
        };
    } finally {
        clearInterval(heartbeatInterval);
    }
}

export async function cleanupExpiredMemories(input: {
    olderThanDays?: number;
    options?: MemoryActivityOptions;
}): Promise<MemoryCleanupActivityResult> {
    const heartbeatInterval = startPeriodicHeartbeat({
        activity: "cleanupExpiredMemories",
        olderThanDays: input.olderThanDays,
    });

    try {
        const response = await lambdaFetch<{ deleted: number; freedBytes: number }>("/internal/memory/cleanup", "POST", {
            olderThanDays: input.olderThanDays,
            options: input.options,
        });

        Context.current().heartbeat({
            processed: response.data?.deleted || 0,
            freedBytes: response.data?.freedBytes,
        });

        return {
            success: response.success,
            processed: response.data?.deleted || 0,
            errors: response.error ? [response.error] : undefined,
        };
    } finally {
        clearInterval(heartbeatInterval);
    }
}

export async function syncToPinata(input: {
    archiveId: string;
    agentWallet: string;
}): Promise<SyncToPinataResult> {
    const heartbeatInterval = startPeriodicHeartbeat({
        activity: "syncToPinata",
        archiveId: input.archiveId,
    });

    try {
        const response = await lambdaFetch<{
            ipfsHash: string;
            pinned: boolean;
        }>("/internal/memory/archive/sync-pinata", "POST", {
            archiveId: input.archiveId,
            agentWallet: input.agentWallet,
        });

        Context.current().heartbeat({
            archiveId: input.archiveId,
            ipfsHash: response.data?.ipfsHash,
        });

        return {
            success: response.success && (response.data?.pinned || false),
            ipfsHash: response.data?.ipfsHash,
            error: response.error,
        };
    } finally {
        clearInterval(heartbeatInterval);
    }
}