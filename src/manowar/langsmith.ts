/**
 * LangSmith Integration for Production Token Tracking
 * 
 * Uses LangSmith callbacks to extract accurate token usage from
 * usage_metadata in LLM responses (Dec 2025 standard).
 * 
 * Key features:
 * - Extracts usage_metadata (input_tokens, output_tokens)
 * - Handles reasoning_tokens for thinking models (Kimi K2, DeepSeek)
 * - Per-agent, per-action token tracking
 * - Integration with TokenLedger for context window management
 */

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

// Bridge LANGSMITH_* to LANGCHAIN_* for SDK auto-tracing
// LangChain SDK requires LANGCHAIN_TRACING_V2=true to enable tracing
if (LANGSMITH_API_KEY && process.env.LANGSMITH_TRACING === "true") {
    process.env.LANGCHAIN_TRACING_V2 = "true";
    process.env.LANGCHAIN_API_KEY = LANGSMITH_API_KEY;
    console.log(`[LangSmith] ✅ TRACING ENABLED for project: ${LANGSMITH_PROJECT}`);
    console.log(`[LangSmith] Cost tracking: ls_provider and ls_model_name metadata enabled`);
} else if (LANGSMITH_API_KEY) {
    console.warn(`[LangSmith] ⚠️ API key set but LANGSMITH_TRACING !== "true" - tracing disabled`);
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
    source: "usage_metadata" | "llmOutput" | "response_metadata" | "estimated";
}

// =============================================================================
// Token Extraction Logic (Dec 2025 Standard)
// =============================================================================

/**
 * Extract tokens from LLMResult using usage_metadata
 */
export function extractTokensFromResult(output: LLMResult): ExtractedTokens {
    // Get the last generation's message (may be nested in different ways)
    const lastGeneration = output.generations?.[0]?.[0] as any;

    // Check for message in generation (ChatGeneration type)
    const message = lastGeneration?.message;

    // 1. Check usage_metadata (Dec 2025 primary standard)
    if (message?.usage_metadata) {
        const usage = message.usage_metadata;
        return {
            inputTokens: usage.input_tokens || 0,
            outputTokens: usage.output_tokens || 0,
            reasoningTokens: 0, // Not in usage_metadata, check response_metadata
            totalTokens: usage.total_tokens ||
                (usage.input_tokens || 0) + (usage.output_tokens || 0),
            source: "usage_metadata",
        };
    }

    // 2. Check response_metadata.token_usage (includes reasoning_tokens for thinking models)
    if (message?.response_metadata?.token_usage) {
        const usage = message.response_metadata.token_usage;
        const inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
        const outputTokens = usage.completion_tokens || usage.output_tokens || 0;
        const reasoningTokens = usage.reasoning_tokens || 0;
        return {
            inputTokens,
            outputTokens,
            reasoningTokens,
            totalTokens: inputTokens + outputTokens + reasoningTokens,
            source: "response_metadata",
        };
    }

    // 3. Legacy: llmOutput.tokenUsage
    if (output.llmOutput?.tokenUsage) {
        const usage = output.llmOutput.tokenUsage;
        return {
            inputTokens: usage.promptTokens || usage.prompt_tokens || 0,
            outputTokens: usage.completionTokens || usage.completion_tokens || 0,
            reasoningTokens: 0,
            totalTokens: usage.totalTokens || usage.total_tokens || 0,
            source: "llmOutput",
        };
    }

    // LangSmith provides token data - if we reach here, the LLM response is malformed
    throw new Error(
        `[LangSmith] Token extraction failed - no usage data in LLM response. ` +
        `Expected usage_metadata, response_metadata.token_usage, or llmOutput.tokenUsage.`
    );
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
        const tokens = extractTokensFromResult(output);

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

// =============================================================================
// Token Extraction & Cost Estimation (Centralized Utilities)
// =============================================================================

/**
 * Extracted token usage from any LLM response format
 */
export interface ExtractedUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimated: boolean;
    source: string;
}

/**
 * Extract token usage from LangChain LLMResult or raw API response
 * 
 * WORKS FOR ALL 2700+ MODELS because:
 * 1. All coordinator models (nvidia, minimax, moonshotai, nex-agi, allenai, arcee-ai)
 *    are accessed via OpenRouter which uses OpenAI-compatible response format
 * 2. LangChain's ChatOpenAI wrapper normalizes all OpenRouter responses to llmOutput.tokenUsage
 * 3. This function handles both LangChain LLMResult AND raw OpenRouter API responses
 */
export function extractTokenUsage(response: any, modelId?: string): ExtractedUsage {
    // 1. LangChain LLMResult format (from handleLLMEnd callback)
    if (response?.llmOutput?.tokenUsage) {
        const usage = response.llmOutput.tokenUsage;
        return {
            inputTokens: usage.promptTokens || usage.prompt_tokens || 0,
            outputTokens: usage.completionTokens || usage.completion_tokens || 0,
            totalTokens: usage.totalTokens || usage.total_tokens ||
                ((usage.promptTokens || 0) + (usage.completionTokens || 0)),
            estimated: false,
            source: "langchain",
        };
    }

    // 2. LangChain AIMessage with response_metadata
    if (response?.response_metadata?.tokenUsage) {
        const usage = response.response_metadata.tokenUsage;
        return {
            inputTokens: usage.promptTokens || 0,
            outputTokens: usage.completionTokens || 0,
            totalTokens: usage.totalTokens || 0,
            estimated: false,
            source: "langchain-metadata",
        };
    }

    // 3. OpenRouter / OpenAI-compatible format
    if (response?.usage?.prompt_tokens !== undefined || response?.usage?.promptTokens !== undefined) {
        const usage = response.usage;
        return {
            inputTokens: usage.prompt_tokens || usage.promptTokens || 0,
            outputTokens: usage.completion_tokens || usage.completionTokens || 0,
            totalTokens: usage.total_tokens || usage.totalTokens ||
                ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0)),
            estimated: false,
            source: "openrouter",
        };
    }

    // 4. Anthropic format (input_tokens / output_tokens)
    if (response?.usage?.input_tokens !== undefined) {
        return {
            inputTokens: response.usage.input_tokens || 0,
            outputTokens: response.usage.output_tokens || 0,
            totalTokens: (response.usage.input_tokens + response.usage.output_tokens) || 0,
            estimated: false,
            source: "anthropic",
        };
    }

    // 5. Google GenAI format (usageMetadata)
    if (response?.usageMetadata?.promptTokenCount !== undefined) {
        return {
            inputTokens: response.usageMetadata.promptTokenCount || 0,
            outputTokens: response.usageMetadata.candidatesTokenCount || 0,
            totalTokens: response.usageMetadata.totalTokenCount ||
                (response.usageMetadata.promptTokenCount + response.usageMetadata.candidatesTokenCount) || 0,
            estimated: false,
            source: "google",
        };
    }

    // 6. Direct tokenUsage object (some LangChain versions)
    if (response?.tokenUsage) {
        const usage = response.tokenUsage;
        return {
            inputTokens: usage.promptTokens || usage.prompt_tokens || 0,
            outputTokens: usage.completionTokens || usage.completion_tokens || 0,
            totalTokens: usage.totalTokens || usage.total_tokens || 0,
            estimated: false,
            source: "direct",
        };
    }

    // Token data is available from LangChain/LangSmith callbacks
    throw new Error(
        `[LangSmith] Token extraction failed. Response lacks token data. ` +
        `Checked: llmOutput.tokenUsage, response_metadata.tokenUsage, ` +
        `usage (OpenAI/Anthropic), usageMetadata (Google), tokenUsage.`
    );
}

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
            thread_id: `manowar-${workflowId}`,
        },
        runName: `manowar-${workflowId}`,
        projectName: LANGSMITH_PROJECT,
        tags: ["manowar", "workflow", workflowId],
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
