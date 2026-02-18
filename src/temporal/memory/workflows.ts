import {
    ApplicationFailure,
    defineQuery,
    defineSignal,
    proxyActivities,
    setHandler,
    workflowInfo,
    continueAsNew,
    sleep,
} from "@temporalio/workflow";
import {
    MEMORY_ACTIVITY_TASK_QUEUE,
    MEMORY_WORKFLOW_ID_PREFIX,
    QUERY_GET_MEMORY_WORKFLOW_STATE,
    SIGNAL_PAUSE_MEMORY_WORKFLOW,
    SIGNAL_RESUME_MEMORY_WORKFLOW,
} from "./constants.js";
import type {
    MemoryConsolidationInput,
    PatternExtractionInput,
    ArchiveCreationInput,
    DecayUpdateInput,
    SkillPromotionInput,
    MemoryCleanupInput,
    MemoryWorkflowResult,
    MemoryWorkflowState,
} from "./types.js";

const MAX_BATCH_SIZE = 50;
const MAX_CONTINUOUS_ITERATIONS = 100;
const BATCH_DELAY_MS = 1000;

const memoryWorkflowStateQuery = defineQuery<MemoryWorkflowState>(QUERY_GET_MEMORY_WORKFLOW_STATE);
const pauseMemoryWorkflowSignal = defineSignal(SIGNAL_PAUSE_MEMORY_WORKFLOW);
const resumeMemoryWorkflowSignal = defineSignal(SIGNAL_RESUME_MEMORY_WORKFLOW);

const memoryActivities = proxyActivities<typeof import("./memory-activities.js")>({
    taskQueue: MEMORY_ACTIVITY_TASK_QUEUE,
    startToCloseTimeout: "30m",
    heartbeatTimeout: "60s",
    retry: {
        initialInterval: "2s",
        backoffCoefficient: 2,
        maximumInterval: "120s",
        maximumAttempts: 5,
        nonRetryableErrorTypes: [
            "ValidationError",
            "MemoryNonRetryableError",
            "ArchiveNonRetryableError",
        ],
    },
});

export async function memoryConsolidationWorkflow(
    input: MemoryConsolidationInput
): Promise<MemoryWorkflowResult> {
    const info = workflowInfo();
    const now = Date.now();
    const iterationCount = (input as any)._iterationCount || 0;

    const state: MemoryWorkflowState = {
        workflowId: info.workflowId,
        status: "running",
        startedAt: now,
        updatedAt: now,
        processed: 0,
        errors: [],
        paused: false,
    };

    setHandler(memoryWorkflowStateQuery, () => state);
    setHandler(pauseMemoryWorkflowSignal, () => {
        state.paused = true;
        state.updatedAt = Date.now();
        state.status = "paused";
    });
    setHandler(resumeMemoryWorkflowSignal, () => {
        state.paused = false;
        state.updatedAt = Date.now();
        state.status = "running";
    });

    const agentWallets = input.agentWallets || [];
    const totalAgents = agentWallets.length;
    let processedCount = 0;
    const errors: string[] = [];

    try {
        for (let i = 0; i < totalAgents; i += MAX_BATCH_SIZE) {
            while (state.paused) {
                await sleep(5000);
            }

            const batch = agentWallets.slice(i, i + MAX_BATCH_SIZE);
            
            const batchResult = await memoryActivities.consolidateAgentMemories({
                agentWallets: batch,
                options: input.options,
            });

            processedCount += batchResult.processed;
            if (batchResult.errors) {
                errors.push(...batchResult.errors);
            }

            state.processed = processedCount;
            state.updatedAt = Date.now();

            if (i + MAX_BATCH_SIZE < totalAgents) {
                await sleep(BATCH_DELAY_MS);
            }

            if (iterationCount + Math.floor(i / MAX_BATCH_SIZE) >= MAX_CONTINUOUS_ITERATIONS || info.continueAsNewSuggested) {
                await continueAsNew<typeof memoryConsolidationWorkflow>({
                    ...input,
                    agentWallets: agentWallets.slice(i + MAX_BATCH_SIZE),
                    _iterationCount: 0,
                });
            }
        }

        state.status = "completed";
        state.updatedAt = Date.now();

        return {
            success: errors.length === 0,
            processed: processedCount,
            errors: errors.length > 0 ? errors : undefined,
        };
    } catch (error) {
        state.status = "failed";
        state.updatedAt = Date.now();
        const errorMessage = error instanceof Error ? error.message : String(error);
        state.errors = [errorMessage];

        throw ApplicationFailure.create({
            message: errorMessage,
            nonRetryable: false,
            type: "MemoryConsolidationError",
        });
    }
}

export async function patternExtractionWorkflow(
    input: PatternExtractionInput
): Promise<MemoryWorkflowResult> {
    const info = workflowInfo();
    const now = Date.now();

    const state: MemoryWorkflowState = {
        workflowId: info.workflowId,
        status: "running",
        startedAt: now,
        updatedAt: now,
        processed: 0,
        errors: [],
        paused: false,
    };

    setHandler(memoryWorkflowStateQuery, () => state);
    setHandler(pauseMemoryWorkflowSignal, () => {
        state.paused = true;
        state.updatedAt = Date.now();
        state.status = "paused";
    });
    setHandler(resumeMemoryWorkflowSignal, () => {
        state.paused = false;
        state.updatedAt = Date.now();
        state.status = "running";
    });

    try {
        const result = await memoryActivities.extractExecutionPatterns({
            agentWallet: input.agentWallet,
            timeRange: input.timeRange,
            options: input.options,
        });

        state.processed = result.processed;
        state.status = "completed";
        state.updatedAt = Date.now();

        return {
            success: result.success,
            processed: result.processed,
            errors: result.errors,
        };
    } catch (error) {
        state.status = "failed";
        state.updatedAt = Date.now();
        const errorMessage = error instanceof Error ? error.message : String(error);
        state.errors = [errorMessage];

        throw ApplicationFailure.create({
            message: errorMessage,
            nonRetryable: false,
            type: "PatternExtractionError",
        });
    }
}

export async function archiveCreationWorkflow(
    input: ArchiveCreationInput
): Promise<MemoryWorkflowResult> {
    const info = workflowInfo();
    const now = Date.now();

    const state: MemoryWorkflowState = {
        workflowId: info.workflowId,
        status: "running",
        startedAt: now,
        updatedAt: now,
        processed: 0,
        errors: [],
        paused: false,
    };

    setHandler(memoryWorkflowStateQuery, () => state);
    setHandler(pauseMemoryWorkflowSignal, () => {
        state.paused = true;
        state.updatedAt = Date.now();
        state.status = "paused";
    });
    setHandler(resumeMemoryWorkflowSignal, () => {
        state.paused = false;
        state.updatedAt = Date.now();
        state.status = "running";
    });

    try {
        const result = await memoryActivities.createMemoryArchive({
            agentWallet: input.agentWallet,
            dateRange: input.dateRange,
            options: input.options,
        });

        state.processed = result.processed;
        state.status = "completed";
        state.updatedAt = Date.now();

        return {
            success: result.success,
            processed: result.processed,
            errors: result.errors,
        };
    } catch (error) {
        state.status = "failed";
        state.updatedAt = Date.now();
        const errorMessage = error instanceof Error ? error.message : String(error);
        state.errors = [errorMessage];

        throw ApplicationFailure.create({
            message: errorMessage,
            nonRetryable: false,
            type: "ArchiveCreationError",
        });
    }
}

export async function decayUpdateWorkflow(
    input: DecayUpdateInput
): Promise<MemoryWorkflowResult> {
    const info = workflowInfo();
    const now = Date.now();
    const iterationCount = (input as any)._iterationCount || 0;

    const state: MemoryWorkflowState = {
        workflowId: info.workflowId,
        status: "running",
        startedAt: now,
        updatedAt: now,
        processed: 0,
        errors: [],
        paused: false,
    };

    setHandler(memoryWorkflowStateQuery, () => state);
    setHandler(pauseMemoryWorkflowSignal, () => {
        state.paused = true;
        state.updatedAt = Date.now();
        state.status = "paused";
    });
    setHandler(resumeMemoryWorkflowSignal, () => {
        state.paused = false;
        state.updatedAt = Date.now();
        state.status = "running";
    });

    try {
        const result = await memoryActivities.updateDecayScores({
            halfLifeDays: input.halfLifeDays,
            options: input.options,
        });

        state.processed = result.processed;
        state.updatedAt = Date.now();

        if (iterationCount >= MAX_CONTINUOUS_ITERATIONS || info.continueAsNewSuggested) {
            await continueAsNew<typeof decayUpdateWorkflow>({
                ...input,
                _iterationCount: 0,
            });
        }

        state.status = "completed";

        return {
            success: result.success,
            processed: result.processed,
            errors: result.errors,
        };
    } catch (error) {
        state.status = "failed";
        state.updatedAt = Date.now();
        const errorMessage = error instanceof Error ? error.message : String(error);
        state.errors = [errorMessage];

        throw ApplicationFailure.create({
            message: errorMessage,
            nonRetryable: false,
            type: "DecayUpdateError",
        });
    }
}

export async function skillPromotionWorkflow(
    input: SkillPromotionInput
): Promise<MemoryWorkflowResult> {
    const info = workflowInfo();
    const now = Date.now();

    const state: MemoryWorkflowState = {
        workflowId: info.workflowId,
        status: "running",
        startedAt: now,
        updatedAt: now,
        processed: 0,
        errors: [],
        paused: false,
    };

    setHandler(memoryWorkflowStateQuery, () => state);
    setHandler(pauseMemoryWorkflowSignal, () => {
        state.paused = true;
        state.updatedAt = Date.now();
        state.status = "paused";
    });
    setHandler(resumeMemoryWorkflowSignal, () => {
        state.paused = false;
        state.updatedAt = Date.now();
        state.status = "running";
    });

    try {
        const validationResult = await memoryActivities.validateExtractedPattern({
            patternId: input.patternId,
            options: input.options,
        });

        if (!validationResult.success || !validationResult.data) {
            state.status = "failed";
            state.errors = [validationResult.error || "Pattern validation failed"];
            return {
                success: false,
                processed: 0,
                errors: state.errors,
            };
        }

        const promotionResult = await memoryActivities.promotePatternToSkill({
            patternId: input.patternId,
            skillName: input.skillName,
            validationData: validationResult.data,
            options: input.options,
        });

        state.processed = 1;
        state.status = "completed";
        state.updatedAt = Date.now();

        return {
            success: promotionResult.success,
            processed: 1,
            errors: promotionResult.error ? [promotionResult.error] : undefined,
        };
    } catch (error) {
        state.status = "failed";
        state.updatedAt = Date.now();
        const errorMessage = error instanceof Error ? error.message : String(error);
        state.errors = [errorMessage];

        throw ApplicationFailure.create({
            message: errorMessage,
            nonRetryable: false,
            type: "SkillPromotionError",
        });
    }
}

export async function memoryCleanupWorkflow(
    input: MemoryCleanupInput
): Promise<MemoryWorkflowResult> {
    const info = workflowInfo();
    const now = Date.now();
    const iterationCount = (input as any)._iterationCount || 0;

    const state: MemoryWorkflowState = {
        workflowId: info.workflowId,
        status: "running",
        startedAt: now,
        updatedAt: now,
        processed: 0,
        errors: [],
        paused: false,
    };

    setHandler(memoryWorkflowStateQuery, () => state);
    setHandler(pauseMemoryWorkflowSignal, () => {
        state.paused = true;
        state.updatedAt = Date.now();
        state.status = "paused";
    });
    setHandler(resumeMemoryWorkflowSignal, () => {
        state.paused = false;
        state.updatedAt = Date.now();
        state.status = "running";
    });

    try {
        const result = await memoryActivities.cleanupExpiredMemories({
            olderThanDays: input.olderThanDays,
            options: input.options,
        });

        state.processed = result.processed;
        state.updatedAt = Date.now();

        if (iterationCount >= MAX_CONTINUOUS_ITERATIONS || info.continueAsNewSuggested) {
            await continueAsNew<typeof memoryCleanupWorkflow>({
                ...input,
                _iterationCount: 0,
            });
        }

        state.status = "completed";

        return {
            success: result.success,
            processed: result.processed,
            errors: result.errors,
        };
    } catch (error) {
        state.status = "failed";
        state.updatedAt = Date.now();
        const errorMessage = error instanceof Error ? error.message : String(error);
        state.errors = [errorMessage];

        throw ApplicationFailure.create({
            message: errorMessage,
            nonRetryable: false,
            type: "MemoryCleanupError",
        });
    }
}

export { memoryWorkflowStateQuery as getMemoryWorkflowStateQuery };
export { pauseMemoryWorkflowSignal, resumeMemoryWorkflowSignal };