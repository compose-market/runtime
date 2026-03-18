import { Context } from "@temporalio/activity";
import {
    DEFAULT_MEMORY_HALF_LIFE_DAYS,
    DEFAULT_MEMORY_BATCH_SIZE,
    DEFAULT_PATTERN_CONFIDENCE_THRESHOLD,
} from "../constants.js";
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
} from "../types.js";
import {
    cleanupExpiredMemories as cleanupExpiredMemoriesStore,
    consolidateAgentMemories as consolidateAgentMemoriesStore,
    createMemoryArchive as createMemoryArchiveStore,
    extractExecutionPatterns as extractExecutionPatternsStore,
    promotePatternToSkill as promotePatternToSkillStore,
    syncArchiveToPinata,
    updateMemoryDecayScores,
    validateExtractedPattern as validateExtractedPatternStore,
} from "../../framework/memory/index.js";

const ACTIVITY_HEARTBEAT_INTERVAL_MS = 30000;

function startPeriodicHeartbeat(details: Record<string, unknown>): NodeJS.Timeout {
    return setInterval(() => {
        try {
            Context.current().heartbeat(details);
        } catch {
            // Ignore heartbeat errors.
        }
    }, ACTIVITY_HEARTBEAT_INTERVAL_MS);
}

export async function consolidateAgentMemoriesActivity(input: {
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

        for (let i = 0; i < input.agentWallets.length; i += batchSize) {
            const batch = input.agentWallets.slice(i, i + batchSize);
            const result = await consolidateAgentMemoriesStore({
                agentWallets: batch,
                batchSize,
            });

            totalProcessed += result.consolidated;

            Context.current().heartbeat({
                processed: totalProcessed,
                batch: Math.floor(i / batchSize) + 1,
                totalBatches: Math.ceil(input.agentWallets.length / batchSize),
            });
        }

        return {
            success: true,
            processed: totalProcessed,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            success: false,
            processed: 0,
            errors: [message],
        };
    } finally {
        clearInterval(heartbeatInterval);
    }
}

export async function extractExecutionPatternsActivity(input: {
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
        const result = await extractExecutionPatternsStore({
            agentWallet: input.agentWallet,
            timeRange: input.timeRange,
            confidenceThreshold,
        });

        Context.current().heartbeat({
            processed: result.extracted,
            patterns: result.patterns,
        });

        return {
            success: true,
            processed: result.extracted,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            success: false,
            processed: 0,
            errors: [message],
        };
    } finally {
        clearInterval(heartbeatInterval);
    }
}

export async function createMemoryArchiveActivity(input: {
    agentWallet: string;
    dateRange: { start: number; end: number };
    options?: MemoryActivityOptions;
}): Promise<ArchiveCreationActivityResult> {
    const heartbeatInterval = startPeriodicHeartbeat({
        activity: "createMemoryArchive",
        agentWallet: input.agentWallet,
    });

    try {
        const archive = await createMemoryArchiveStore({
            agentWallet: input.agentWallet,
            dateRange: input.dateRange,
            compress: input.options?.compress,
        });

        let ipfsHash: string | undefined;
        if (input.options?.syncToIpfs !== false) {
            const sync = await syncToPinataActivity({
                archiveId: archive.archiveId,
                agentWallet: input.agentWallet,
            });
            if (sync.success) {
                ipfsHash = sync.ipfsHash;
            }
        }

        Context.current().heartbeat({
            archiveId: archive.archiveId,
            archived: archive.memoriesArchived,
            ipfsHash,
        });

        return {
            success: true,
            processed: archive.memoriesArchived,
            archiveId: archive.archiveId,
            ipfsHash,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            success: false,
            processed: 0,
            errors: [message],
        };
    } finally {
        clearInterval(heartbeatInterval);
    }
}

export async function updateDecayScoresActivity(input: {
    halfLifeDays?: number;
    options?: MemoryActivityOptions;
}): Promise<DecayUpdateActivityResult> {
    const heartbeatInterval = startPeriodicHeartbeat({
        activity: "updateDecayScores",
        halfLifeDays: input.halfLifeDays,
    });

    try {
        const result = await updateMemoryDecayScores({
            halfLifeDays: input.halfLifeDays || DEFAULT_MEMORY_HALF_LIFE_DAYS,
        });

        Context.current().heartbeat({
            processed: result.updated,
            avgDecayScore: result.avgDecayScore,
        });

        return {
            success: true,
            processed: result.updated,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            success: false,
            processed: 0,
            errors: [message],
        };
    } finally {
        clearInterval(heartbeatInterval);
    }
}

export async function validateExtractedPatternActivity(input: {
    patternId: string;
    options?: MemoryActivityOptions;
}): Promise<PatternValidationResult> {
    const heartbeatInterval = startPeriodicHeartbeat({
        activity: "validateExtractedPattern",
        patternId: input.patternId,
    });

    try {
        const result = await validateExtractedPatternStore({
            patternId: input.patternId,
        });

        Context.current().heartbeat({
            patternId: input.patternId,
            valid: result.valid,
            confidence: result.confidence,
        });

        return {
            success: result.valid,
            data: result,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            success: false,
            error: message,
        };
    } finally {
        clearInterval(heartbeatInterval);
    }
}

export async function promotePatternToSkillActivity(input: {
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
        const result = await promotePatternToSkillStore({
            patternId: input.patternId,
            skillName: input.skillName,
            validationData: input.validationData,
        });

        Context.current().heartbeat({
            patternId: input.patternId,
            promoted: result.promoted,
            skillId: result.skillId,
        });

        return {
            success: result.promoted,
            skillId: result.skillId,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            success: false,
            error: message,
        };
    } finally {
        clearInterval(heartbeatInterval);
    }
}

export async function cleanupExpiredMemoriesActivity(input: {
    olderThanDays?: number;
    options?: MemoryActivityOptions;
}): Promise<MemoryCleanupActivityResult> {
    const heartbeatInterval = startPeriodicHeartbeat({
        activity: "cleanupExpiredMemories",
        olderThanDays: input.olderThanDays,
    });

    try {
        const result = await cleanupExpiredMemoriesStore({
            olderThanDays: input.olderThanDays || 90,
        });

        Context.current().heartbeat({
            processed: result.deleted,
            freedBytes: result.freedBytes,
        });

        return {
            success: true,
            processed: result.deleted,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            success: false,
            processed: 0,
            errors: [message],
        };
    } finally {
        clearInterval(heartbeatInterval);
    }
}

export async function syncToPinataActivity(input: {
    archiveId: string;
    agentWallet: string;
}): Promise<SyncToPinataResult> {
    const heartbeatInterval = startPeriodicHeartbeat({
        activity: "syncToPinata",
        archiveId: input.archiveId,
    });

    try {
        const result = await syncArchiveToPinata({
            archiveId: input.archiveId,
            agentWallet: input.agentWallet,
        });

        Context.current().heartbeat({
            archiveId: input.archiveId,
            ipfsHash: result.ipfsHash,
        });

        return {
            success: result.pinned,
            ipfsHash: result.ipfsHash,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            success: false,
            error: message,
        };
    } finally {
        clearInterval(heartbeatInterval);
    }
}

// Backward-compatible activity export names used by workflows.
export {
    consolidateAgentMemoriesActivity as consolidateAgentMemories,
    extractExecutionPatternsActivity as extractExecutionPatterns,
    createMemoryArchiveActivity as createMemoryArchive,
    updateDecayScoresActivity as updateDecayScores,
    validateExtractedPatternActivity as validateExtractedPattern,
    promotePatternToSkillActivity as promotePatternToSkill,
    cleanupExpiredMemoriesActivity as cleanupExpiredMemories,
    syncToPinataActivity as syncToPinata,
};
