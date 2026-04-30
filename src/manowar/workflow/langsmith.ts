/**
 * LangSmith Observability Hub
 * 
 * Centralized observability for the Manowar framework:
 * - Token extraction from LLM responses (usage_metadata)
 * - LangSmith client for run tracking and feedback
 * - Feedback/annotations for checkpoints
 * - Dataset integration for execution learnings
 * 
 * All observability flows through this module:
 * - orchestrator.ts → uses LangSmithTokenTracker
 * - run-tracker.ts → uses client functions
 * - checkpoint.ts → uses feedback functions
 * - planner.ts → uses dataset functions
 */

import { Client as LangSmithClient } from "langsmith";
import type { Run, Feedback as LangSmithFeedback } from "langsmith/schemas";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";
import type { Serialized } from "@langchain/core/load/serializable";
import type { TokenCheckpoint } from "./context.js";

// =============================================================================
// Environment Configuration
// =============================================================================

const LANGSMITH_API_KEY = process.env.LANGSMITH_API_KEY;
const LANGSMITH_PROJECT = process.env.LANGSMITH_PROJECT || "manowar";
const LANGSMITH_ENDPOINT = process.env.LANGSMITH_ENDPOINT || "https://api.smith.langchain.com";

// Bridge LANGSMITH_* to LANGCHAIN_* for SDK auto-tracing.
// If credentials exist, tracing must be enabled with no secondary toggle.
if (LANGSMITH_API_KEY) {
    process.env.LANGSMITH_TRACING = "true";
    process.env.LANGCHAIN_TRACING_V2 = "true";
    process.env.LANGCHAIN_API_KEY = LANGSMITH_API_KEY;
    process.env.LANGCHAIN_ENDPOINT = LANGSMITH_ENDPOINT;
    process.env.LANGCHAIN_PROJECT = LANGSMITH_PROJECT;
    console.log(`[LangSmith] ✅ TRACING ENABLED for project: ${LANGSMITH_PROJECT}`);
    console.log(`[LangSmith] Cost tracking: ls_provider and ls_model_name metadata enabled`);
} else {
    console.log(`[LangSmith] ❌ LANGSMITH_API_KEY not set - tracing disabled`);
}

// =============================================================================
// Token Extraction Types
// =============================================================================

export interface ExtractedTokens {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;  // For thinking models
    totalTokens: number;
    source: "usage_metadata" | "llmOutput" | "response_metadata" | "direct_fields" | "langsmith_callback";
}

// =============================================================================
// Token Extraction Logic (Dec 2025 Standard)
// =============================================================================

/**
 * Unified token extraction from any LLM response format.
 * 
 * Handles:
 * - LangChain LLMResult (from callbacks)
 * - usage_metadata (Dec 2025 standard)
 * - response_metadata.token_usage (thinking models)
 * - OpenAI compatible responses
 * - Anthropic format (input_tokens/output_tokens)
 * - Google GenAI format (usageMetadata)
 * 
 * @throws Error if no token data is found
 */
function asRecord(value: unknown): Record<string, any> | null {
    return value && typeof value === "object" ? value as Record<string, any> : null;
}

function readNonNegativeInteger(record: Record<string, any>, keys: string[]): number | undefined {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
            return value;
        }
    }
    return undefined;
}

function readReasoningTokens(record: Record<string, any>): number | undefined {
    const direct = readNonNegativeInteger(record, ["reasoning_tokens", "reasoningTokens"]);
    if (direct !== undefined) {
        return direct;
    }

    for (const key of ["output_token_details", "output_tokens_details", "completion_tokens_details"]) {
        const details = asRecord(record[key]);
        if (!details) {
            continue;
        }

        const nested = readNonNegativeInteger(details, ["reasoning", "reasoning_tokens"]);
        if (nested !== undefined) {
            return nested;
        }
    }

    return undefined;
}

export function extractTokens(response: any): ExtractedTokens {
    const record = asRecord(response);
    if (!record) {
        throw new Error("[LangSmith] Token extraction failed - response payload is required.");
    }

    const outputs = asRecord(record.outputs);
    if (outputs) {
        try {
            return extractTokens(outputs);
        } catch {
            // Continue through normalized payload shapes.
        }
    }

    const generation = record.generations?.[0]?.[0];
    const message = generation?.message ?? response;
    const messageRecord = asRecord(message);
    if (!messageRecord) {
        throw new Error(
            "[LangSmith] Token extraction failed - no usage data found. " +
            "Checked: usage_metadata, response_metadata, llmOutput.tokenUsage, usage, usageMetadata, direct fields."
        );
    }

    if (messageRecord.usage_metadata) {
        const usage = asRecord(messageRecord.usage_metadata)!;
        const inputTokens = readNonNegativeInteger(usage, ["input_tokens", "prompt_tokens"]) ?? 0;
        const outputTokens = readNonNegativeInteger(usage, ["output_tokens", "completion_tokens"]) ?? 0;
        const reasoningTokens = readReasoningTokens(usage) ?? 0;
        const totalTokens = readNonNegativeInteger(usage, ["total_tokens"]) ?? (inputTokens + outputTokens);
        if (inputTokens > 0 || outputTokens > 0 || totalTokens > 0) {
            return {
                inputTokens,
                outputTokens,
                reasoningTokens,
                totalTokens,
                source: "usage_metadata",
            };
        }
    }

    const responseMetadata = asRecord(messageRecord.response_metadata) ?? asRecord(messageRecord.responseMetadata);
    const tokenUsage = asRecord(responseMetadata?.token_usage) ?? asRecord(responseMetadata?.tokenUsage);
    if (tokenUsage && typeof tokenUsage === "object") {
        const usage = asRecord(tokenUsage)!;
        const inputTokens = readNonNegativeInteger(usage, ["prompt_tokens", "promptTokens", "input_tokens", "inputTokens"]) ?? 0;
        const outputTokens = readNonNegativeInteger(usage, ["completion_tokens", "completionTokens", "output_tokens", "outputTokens"]) ?? 0;
        const reasoningTokens = readReasoningTokens(usage) ?? 0;
        const totalTokens = readNonNegativeInteger(usage, ["total_tokens", "totalTokens"]) ?? (inputTokens + outputTokens);
        if (inputTokens > 0 || outputTokens > 0 || totalTokens > 0) {
            return {
                inputTokens,
                outputTokens,
                reasoningTokens,
                totalTokens,
                source: "response_metadata",
            };
        }
    }

    const llmTokenUsage = asRecord(asRecord(record.llmOutput)?.tokenUsage);
    if (llmTokenUsage) {
        const inputTokens = readNonNegativeInteger(llmTokenUsage, ["promptTokens", "prompt_tokens", "input_tokens"]) ?? 0;
        const outputTokens = readNonNegativeInteger(llmTokenUsage, ["completionTokens", "completion_tokens", "output_tokens"]) ?? 0;
        const reasoningTokens = readReasoningTokens(llmTokenUsage) ?? 0;
        const totalTokens = readNonNegativeInteger(llmTokenUsage, ["totalTokens", "total_tokens"]) ?? (inputTokens + outputTokens);
        if (inputTokens > 0 || outputTokens > 0 || totalTokens > 0) {
            return {
                inputTokens,
                outputTokens,
                reasoningTokens,
                totalTokens,
                source: "llmOutput",
            };
        }
    }

    const usage = asRecord(record.usage);
    if (usage) {
        const inputTokens = readNonNegativeInteger(usage, ["prompt_tokens", "promptTokens", "input_tokens", "inputTokens"]) ?? 0;
        const outputTokens = readNonNegativeInteger(usage, ["completion_tokens", "completionTokens", "output_tokens", "outputTokens"]) ?? 0;
        const reasoningTokens = readReasoningTokens(usage) ?? 0;
        const totalTokens = readNonNegativeInteger(usage, ["total_tokens", "totalTokens"]) ?? (inputTokens + outputTokens);
        if (inputTokens > 0 || outputTokens > 0 || totalTokens > 0) {
            return {
                inputTokens,
                outputTokens,
                reasoningTokens,
                totalTokens,
                source: "usage_metadata",
            };
        }
    }

    const googleUsage = asRecord(record.usageMetadata);
    if (googleUsage) {
        const inputTokens = readNonNegativeInteger(googleUsage, ["promptTokenCount"]) ?? 0;
        const candidateTokens = readNonNegativeInteger(googleUsage, ["candidatesTokenCount"]) ?? 0;
        const reasoningTokens = readNonNegativeInteger(googleUsage, ["thoughtsTokenCount"]) ?? 0;
        const outputTokens = candidateTokens + reasoningTokens;
        const totalTokens = readNonNegativeInteger(googleUsage, ["totalTokenCount"]) ?? (inputTokens + outputTokens);
        if (inputTokens > 0 || outputTokens > 0 || totalTokens > 0) {
            return {
                inputTokens,
                outputTokens,
                reasoningTokens,
                totalTokens,
                source: "usage_metadata",
            };
        }
    }

    const inputTokens = readNonNegativeInteger(messageRecord, ["prompt_tokens", "promptTokens", "input_tokens", "inputTokens"]);
    const outputTokens = readNonNegativeInteger(messageRecord, ["completion_tokens", "completionTokens", "output_tokens", "outputTokens"]);
    const reasoningTokens = readReasoningTokens(messageRecord) ?? 0;
    const totalTokens = readNonNegativeInteger(messageRecord, ["total_tokens", "totalTokens"]);
    if (inputTokens !== undefined && outputTokens !== undefined) {
        return {
            inputTokens,
            outputTokens,
            reasoningTokens,
            totalTokens: totalTokens ?? (inputTokens + outputTokens),
            source: "direct_fields",
        };
    }

    throw new Error(
        "[LangSmith] Token extraction failed - no usage data found. " +
        "Checked: usage_metadata, response_metadata, llmOutput.tokenUsage, usage, usageMetadata, direct fields."
    );
}

/**
 * @deprecated Use extractTokens() instead
 */
export const extractTokensFromResult = extractTokens;

/**
 * @deprecated Use extractTokens() instead
 */
export function extractTokenUsage(response: any): ExtractedTokens & { estimated: boolean } {
    const tokens = extractTokens(response);
    return { ...tokens, estimated: false };
}

// =============================================================================
// LangSmith Token Tracker Callback Handler
// =============================================================================

export interface TokenLedgerInterface {
    recordCheckpoint(checkpoint: TokenCheckpoint): void;
    getCumulativeTotal(): number;
}

/**
 * LangSmith callback handler that tracks token usage per-agent, per-action.
 * Integrates with the TokenLedger for context window management.
 */
export class LangSmithTokenTracker extends BaseCallbackHandler {
    name = "langsmith_token_tracker";

    private workflowId: string;
    private runId: string;
    private ledger: TokenLedgerInterface;

    private currentAgentId: string = "coordinator";
    private currentAction: string = "generate";
    private currentModelId: string = "";

    constructor(
        workflowId: string,
        runId: string,
        ledger: TokenLedgerInterface
    ) {
        super();
        this.workflowId = workflowId;
        this.runId = runId;
        this.ledger = ledger;
    }

    /**
     * Set the current agent context for token attribution
     */
    setCurrentAgent(agentId: string, action: string = "generate") {
        this.currentAgentId = agentId;
        this.currentAction = action;
    }

    /**
     * Set the current model for provider tracking
     */
    setCurrentModel(modelId: string) {
        this.currentModelId = modelId;
    }

    /**
     * Handle LLM generation end - extract and record tokens
     */
    async handleLLMEnd(output: LLMResult, runId: string): Promise<void> {
        const tokens = extractTokens(output);

        if (tokens.totalTokens > 0) {
            const checkpoint: TokenCheckpoint = {
                agentId: this.currentAgentId,
                modelId: this.currentModelId,
                action: this.currentAction,
                inputTokens: tokens.inputTokens,
                outputTokens: tokens.outputTokens,
                timestamp: Date.now(),
            };

            this.ledger.recordCheckpoint(checkpoint);

            console.log(
                `[LangSmith] Token checkpoint: agent=${checkpoint.agentId} ` +
                `action=${checkpoint.action} in=${tokens.inputTokens} ` +
                `out=${tokens.outputTokens} reasoning=${tokens.reasoningTokens} ` +
                `total=${tokens.totalTokens} source=${tokens.source}`
            );
        }
    }

    /**
     * Handle tool start - track tool execution context
     */
    async handleToolStart(
        tool: Serialized,
        input: string,
        runId: string,
        parentRunId?: string
    ): Promise<void> {
        const toolName = (tool as any)?.name || "unknown";
        this.currentAction = `tool:${toolName}`;
    }

    /**
     * Handle tool end - reset action to generate
     */
    async handleToolEnd(output: string, runId: string): Promise<void> {
        this.currentAction = "generate";
    }

    /**
     * Handle chain start - capture high-level operation context
     */
    async handleChainStart(
        chain: Serialized,
        inputs: Record<string, unknown>,
        runId: string
    ): Promise<void> {
        const chainName = (chain as any)?.name || "";
        if (chainName.includes("agent") || chainName.includes("Agent")) {
            this.currentAction = "agent_loop";
        }
    }

    /**
     * Handle LLM start - capture model info
     */
    async handleLLMStart(
        llm: Serialized,
        prompts: string[],
        runId: string
    ): Promise<void> {
        const modelName = (llm as any)?.kwargs?.modelName ||
            (llm as any)?.kwargs?.model ||
            "";
        if (modelName) {
            this.currentModelId = modelName;
        }
    }
}

// ExtractedUsage is now deprecated - use ExtractedTokens instead
/** @deprecated Use ExtractedTokens instead */
export type ExtractedUsage = ExtractedTokens & { estimated: boolean };



/**
 * Calculate USD cost from token counts and pricing
 * @deprecated Cost calculation should use real LangSmith data, not estimates
 * Pricing is in USD per million tokens
 */
export function estimateCost(
    inputTokens: number,
    outputTokens: number,
    pricing: { input: number; output: number }
): number {
    return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

// =============================================================================
// LangSmith Configuration
// =============================================================================

/**
 * Create LangSmith configuration for graph invocation
 * 
 * Note: Model metadata (contextWindow) is now fetched by context.ts via fetchModelContextWindow()
 */
export async function createLangSmithConfig(
    workflowId: string,
    runId: string,
    modelName?: string
): Promise<Record<string, unknown>> {
    if (!LANGSMITH_API_KEY) {
        console.warn("[LangSmith] LANGSMITH_API_KEY not configured - tracing disabled");
        return {};
    }

    return {
        configurable: {
            thread_id: `workflow-${workflowId}`,
        },
        runName: `workflow-${workflowId}`,
        projectName: LANGSMITH_PROJECT,
        tags: ["compose", "workflow", workflowId],
        metadata: {
            workflow_id: workflowId,
            run_id: runId,
            environment: process.env.NODE_ENV || "development",
            ls_model_name: modelName,
        },
    };
}

/**
 * Check if LangSmith is configured
 */
export function isLangSmithEnabled(): boolean {
    return !!LANGSMITH_API_KEY;
}

// =============================================================================
// LangSmith SDK Client (Centralized)
// =============================================================================

let langsmithClient: LangSmithClient | null = null;

/**
 * Get the singleton LangSmith client.
 * Used by run-tracker.ts and checkpoint.ts.
 */
export function getLangSmithClient(): LangSmithClient | null {
    if (!LANGSMITH_API_KEY) return null;

    if (!langsmithClient) {
        langsmithClient = new LangSmithClient({
            apiKey: LANGSMITH_API_KEY,
            apiUrl: LANGSMITH_ENDPOINT,
        });
    }
    return langsmithClient;
}

// Re-export Run type for run-tracker.ts
export type { Run, LangSmithFeedback };

// =============================================================================
// Run Tracking (moved from run-tracker.ts direct SDK usage)
// =============================================================================

/**
 * Fetch runs from LangSmith for a project
 */
export async function fetchLangSmithRuns(params: {
    limit?: number;
    projectName?: string;
    filter?: string;
    isRoot?: boolean;
}): Promise<Run[]> {
    const client = getLangSmithClient();
    if (!client) return [];

    try {
        const runs: Run[] = [];
        const iterator = client.listRuns({
            projectName: params.projectName || LANGSMITH_PROJECT,
            limit: params.limit || 50,
            filter: params.filter,
            isRoot: params.isRoot,
        });

        for await (const run of iterator) {
            runs.push(run);
            if (runs.length >= (params.limit || 50)) break;
        }

        return runs;
    } catch (error) {
        console.error("[LangSmith] Failed to fetch runs:", error);
        return [];
    }
}

/**
 * Get LangSmith run details by ID
 */
export async function getLangSmithRun(runId: string): Promise<Run | null> {
    const client = getLangSmithClient();
    if (!client) return null;

    try {
        return await client.readRun(runId);
    } catch (error) {
        console.error("[LangSmith] Failed to get run:", error);
        return null;
    }
}

// =============================================================================
// Feedback/Annotations (replaces checkpoint.ts persistence)
// =============================================================================

export interface FeedbackOptions {
    score?: number;
    value?: string;
    comment?: string;
    correction?: Record<string, unknown>;
}

/**
 * Record feedback on a LangSmith run.
 * Use for checkpoint annotations, quality scores, and learnings.
 */
export async function recordFeedback(
    runId: string,
    key: string,
    options: FeedbackOptions = {}
): Promise<string | null> {
    const client = getLangSmithClient();
    if (!client) {
        console.warn("[LangSmith] No client available for feedback");
        return null;
    }

    try {
        const result = await client.createFeedback(runId, key, {
            score: options.score,
            value: options.value,
            comment: options.comment,
            correction: options.correction,
        });
        console.log(`[LangSmith] Recorded feedback: ${key} on run ${runId}`);
        return result.id;
    } catch (error) {
        console.error("[LangSmith] Failed to record feedback:", error);
        return null;
    }
}

/**
 * Get all feedback for a run
 */
export async function getRunFeedback(runId: string): Promise<LangSmithFeedback[]> {
    const client = getLangSmithClient();
    if (!client) return [];

    try {
        const feedback: LangSmithFeedback[] = [];
        const iterator = client.listFeedback({ runIds: [runId] });

        for await (const fb of iterator) {
            feedback.push(fb);
        }

        return feedback;
    } catch (error) {
        console.error("[LangSmith] Failed to get feedback:", error);
        return [];
    }
}

// =============================================================================
// Checkpoint Annotations (high-level convenience)
// =============================================================================

/**
 * Record insight from a workflow step.
 * Stores as feedback with key "insight".
 */
export async function recordInsightFeedback(
    runId: string,
    insight: string,
    agentId: string
): Promise<string | null> {
    return recordFeedback(runId, "insight", {
        value: insight,
        comment: `Agent: ${agentId}`,
    });
}

/**
 * Record decision from a workflow step.
 * Stores as feedback with key "decision".
 */
export async function recordDecisionFeedback(
    runId: string,
    decision: string,
    reasoning?: string
): Promise<string | null> {
    return recordFeedback(runId, "decision", {
        value: decision,
        comment: reasoning,
    });
}

/**
 * Record quality score for a workflow step.
 * Score from 0-1.
 */
export async function recordQualityScore(
    runId: string,
    score: number,
    comment?: string
): Promise<string | null> {
    return recordFeedback(runId, "quality", {
        score: Math.max(0, Math.min(1, score)),
        comment,
    });
}

/**
 * Record error annotation for a workflow step.
 */
export async function recordErrorFeedback(
    runId: string,
    error: string,
    agentId: string
): Promise<string | null> {
    return recordFeedback(runId, "error", {
        value: error,
        comment: `Agent: ${agentId}`,
        score: 0,
    });
}

// =============================================================================
// Dataset Integration (for execution learnings)
// =============================================================================

/**
 * Record an execution learning to a LangSmith dataset.
 * Used for multi-run improvement in planner.ts.
 */
export async function recordLearning(
    datasetName: string,
    input: Record<string, unknown>,
    output: Record<string, unknown>,
    metadata?: Record<string, unknown>
): Promise<string | null> {
    const client = getLangSmithClient();
    if (!client) {
        console.warn("[LangSmith] No client available for dataset write");
        return null;
    }

    try {
        // Get or create dataset
        let dataset;
        try {
            dataset = await client.readDataset({ datasetName });
        } catch {
            dataset = await client.createDataset(datasetName, {
                description: "Execution learnings for multi-run improvement",
            });
        }

        // Create example
        const example = await client.createExample(input, output, {
            datasetId: dataset.id,
            metadata,
        });

        console.log(`[LangSmith] Recorded learning to dataset ${datasetName}`);
        return example.id;
    } catch (error) {
        console.error("[LangSmith] Failed to record learning:", error);
        return null;
    }
}

/**
 * Get relevant learnings from a dataset.
 * Used by planner.ts for ReviewerSuggestions.
 */
export async function getRelevantLearnings(
    datasetName: string,
    limit: number = 10
): Promise<Array<{ inputs: Record<string, unknown>; outputs: Record<string, unknown> }>> {
    const client = getLangSmithClient();
    if (!client) return [];

    try {
        const examples: Array<{ inputs: Record<string, unknown>; outputs: Record<string, unknown> }> = [];
        const iterator = client.listExamples({ datasetName, limit });

        for await (const ex of iterator) {
            examples.push({
                inputs: ex.inputs as Record<string, unknown>,
                outputs: ex.outputs as Record<string, unknown>,
            });
            if (examples.length >= limit) break;
        }

        return examples;
    } catch (error) {
        console.error("[LangSmith] Failed to get learnings:", error);
        return [];
    }
}
