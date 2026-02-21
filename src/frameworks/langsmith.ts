import { Client as LangSmithClient } from "langsmith";
import type { Run, Feedback as LangSmithFeedback } from "langsmith/schemas";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";
import type { Serialized } from "@langchain/core/load/serializable";

const LANGSMITH_API_KEY = process.env.LANGSMITH_API_KEY;
const LANGSMITH_PROJECT = process.env.LANGSMITH_PROJECT || "manowar-agents";

let langsmithClient: LangSmithClient | null = null;

export function getAgentLangSmithClient(): LangSmithClient | null {
    if (!LANGSMITH_API_KEY) return null;
    if (!langsmithClient) {
        langsmithClient = new LangSmithClient({
            apiKey: LANGSMITH_API_KEY,
        });
    }
    return langsmithClient;
}

export interface ExtractedTokens {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    source: "usage_metadata" | "llmOutput" | "response_metadata" | "estimated";
}

export function extractTokens(response: any): ExtractedTokens {
    const generation = response?.generations?.[0]?.[0];
    const message = generation?.message ?? response;

    if (message?.usage_metadata) {
        const usage = message.usage_metadata;
        return {
            inputTokens: usage.input_tokens || 0,
            outputTokens: usage.output_tokens || 0,
            reasoningTokens: 0,
            totalTokens: usage.total_tokens || (usage.input_tokens || 0) + (usage.output_tokens || 0),
            source: "usage_metadata",
        };
    }

    if (message?.response_metadata?.token_usage) {
        const usage = message.response_metadata.token_usage;
        return {
            inputTokens: usage.prompt_tokens || usage.input_tokens || 0,
            outputTokens: usage.completion_tokens || usage.output_tokens || 0,
            reasoningTokens: usage.reasoning_tokens || 0,
            totalTokens: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0) + (usage.reasoning_tokens || 0),
            source: "response_metadata",
        };
    }

    if (response?.llmOutput?.tokenUsage) {
        const usage = response.llmOutput.tokenUsage;
        return {
            inputTokens: usage.promptTokens || usage.prompt_tokens || 0,
            outputTokens: usage.completionTokens || usage.completion_tokens || 0,
            reasoningTokens: 0,
            totalTokens: usage.totalTokens || usage.total_tokens || 0,
            source: "llmOutput",
        };
    }

    if (response?.usage?.prompt_tokens !== undefined) {
        const usage = response.usage;
        return {
            inputTokens: usage.prompt_tokens || 0,
            outputTokens: usage.completion_tokens || 0,
            reasoningTokens: 0,
            totalTokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
            source: "usage_metadata",
        };
    }

    return {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        source: "estimated",
    };
}

export interface MemoryRetrievalMetrics {
    queryLength: number;
    resultCount: number;
    provider: string;
    cachedEmbedding: boolean;
    latencyMs: number;
    topScore: number;
    decayApplied: boolean;
    mmrApplied: boolean;
}

export interface ContextWindowMetrics {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    memoryTokens: number;
    systemPromptTokens: number;
    pressureRatio: number; // used / context window
    modelName: string;
}

export class AgentMemoryTracker extends BaseCallbackHandler {
    name = "agent_memory_tracker";

    private agentWallet: string;
    private threadId?: string;
    private modelName: string = "unknown";
    private memoryRetrievals: MemoryRetrievalMetrics[] = [];
    private contextMetrics: ContextWindowMetrics | null = null;
    private currentMemoryHit: boolean = false;
    private currentCacheHit: boolean = false;
    private embeddingProvider: string = "unknown";

    constructor(agentWallet: string, threadId?: string) {
        super();
        this.agentWallet = agentWallet;
        this.threadId = threadId;
    }

    setModel(modelName: string) {
        this.modelName = modelName;
    }

    setMemoryHit(hit: boolean) {
        this.currentMemoryHit = hit;
    }

    setCacheHit(hit: boolean) {
        this.currentCacheHit = hit;
    }

    setEmbeddingProvider(provider: string) {
        this.embeddingProvider = provider;
    }

    recordMemoryRetrieval(metrics: MemoryRetrievalMetrics) {
        this.memoryRetrievals.push(metrics);
    }

    async handleLLMEnd(output: LLMResult, runId: string): Promise<void> {
        const tokens = extractTokens(output);

        this.contextMetrics = {
            totalTokens: tokens.totalTokens,
            inputTokens: tokens.inputTokens,
            outputTokens: tokens.outputTokens,
            memoryTokens: this.memoryRetrievals.reduce((sum, m) => sum + m.resultCount * 50, 0),
            systemPromptTokens: 0,
            pressureRatio: 0,
            modelName: this.modelName,
        };

        const client = getAgentLangSmithClient();
        if (!client) return;

        try {
            await client.createFeedback(runId, "memory_retrievals", {
                score: this.memoryRetrievals.length,
                comment: `Cache hits: ${this.memoryRetrievals.filter(m => m.cachedEmbedding).length}, retrievals: ${JSON.stringify(this.memoryRetrievals.slice(0, 3))}`,
            });

            await client.createFeedback(runId, "context_tokens", {
                score: tokens.totalTokens,
                comment: `input: ${tokens.inputTokens}, output: ${tokens.outputTokens}, model: ${this.modelName}`,
            });
        } catch (error) {
            console.error("[AgentLangSmith] Failed to record feedback:", error);
        }
    }

    async handleLLMStart(llm: Serialized, prompts: string[], runId: string): Promise<void> {
        const modelName = (llm as any)?.kwargs?.modelName || (llm as any)?.kwargs?.model || "unknown";
        this.setModel(modelName);

        const totalPromptTokens = prompts.reduce((sum, p) => sum + Math.ceil(p.length / 4), 0);

        const client = getAgentLangSmithClient();
        if (!client) return;

        try {
            await client.createFeedback(runId, "prompt_tokens_estimate", {
                score: totalPromptTokens,
                comment: `prompts: ${prompts.length}, model: ${this.modelName}`,
            });
        } catch {
            // Silent fail
        }
    }

    getMetrics(): {
        memoryRetrievals: MemoryRetrievalMetrics[];
        contextMetrics: ContextWindowMetrics | null;
    } {
        return {
            memoryRetrievals: this.memoryRetrievals,
            contextMetrics: this.contextMetrics,
        };
    }
}

export async function recordMemoryRetrieval(
    runId: string,
    metrics: MemoryRetrievalMetrics
): Promise<void> {
    const client = getAgentLangSmithClient();
    if (!client) return;

    try {
        await client.createFeedback(runId, "memory_retrieval", {
            score: metrics.topScore,
            comment: `results: ${metrics.resultCount}, provider: ${metrics.provider}, cached: ${metrics.cachedEmbedding}`,
        });
    } catch {
        // Silent fail
    }
}

export async function createContextWindowFeedback(
    runId: string,
    metrics: ContextWindowMetrics
): Promise<void> {
    const client = getAgentLangSmithClient();
    if (!client) return;

    try {
        await client.createFeedback(runId, "context_window", {
            score: metrics.pressureRatio,
            comment: `tokens: ${metrics.totalTokens}, model: ${metrics.modelName}`,
        });
    } catch {
        // Silent fail
    }
}

export function isLangSmithEnabled(): boolean {
    return !!LANGSMITH_API_KEY;
}

export { LANGSMITH_PROJECT };