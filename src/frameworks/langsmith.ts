import { Client as LangSmithClient } from "langsmith";
import type { Run, Feedback as LangSmithFeedback } from "langsmith/schemas";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";
import type { Serialized } from "@langchain/core/load/serializable";
import { extractTokens, type ExtractedTokens } from "../workflow/langsmith.js";

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

export { extractTokens, type ExtractedTokens };

export function resolveAuthoritativeTokens(
    response: unknown,
    tracked?: Pick<ExtractedTokens, "inputTokens" | "outputTokens" | "reasoningTokens" | "totalTokens"> | null,
): ExtractedTokens {
    if (tracked && tracked.totalTokens > 0) {
        return {
            inputTokens: tracked.inputTokens,
            outputTokens: tracked.outputTokens,
            reasoningTokens: tracked.reasoningTokens,
            totalTokens: tracked.totalTokens,
            source: "langsmith_callback",
        };
    }

    const candidates: unknown[] = [];

    if (response && typeof response === "object") {
        const messages = (response as { messages?: unknown[] }).messages;
        if (Array.isArray(messages) && messages.length > 0) {
            candidates.push(...messages.slice().reverse());
        }
    }

    candidates.push(response);

    let lastError: unknown;
    for (const candidate of candidates) {
        try {
            return extractTokens(candidate);
        } catch (error) {
            lastError = error;
        }
    }

    throw (lastError instanceof Error ? lastError : new Error("authoritative usage is required"));
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
        let tokens: ExtractedTokens;
        try {
            tokens = extractTokens(output);
        } catch (error) {
            console.warn("[AgentLangSmith] No authoritative usage found in LLM callback output:", error);
            return;
        }

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
