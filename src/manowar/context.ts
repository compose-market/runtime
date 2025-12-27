/**
 * Context Window Manager - Multi-Agent Context Management System
 * 
 * Implements the multi-agent context workflow with specialized sub-agents:
 * - NoteTaker: API usage extraction per-agent per-action
 * - WindowTracker: Dynamic model specs from models.ts
 * - Mem0GraphOptimizer: Entity extraction for graph memory
 * - MemoryWipe: Threshold detection and cleanup
 * - Summarizer: Workflow-scoped context compression
 * - ToolBoxer: Registry integration for tool recommendations
 * - Evaluator: End-of-loop performance evaluation (continuous-loop only)
 * - Reviewer: Start-of-loop improvement review (continuous-loop only)
 */

import {
    TokenUsage,
    ContextWindowState,
    WorkflowStateSummary,
    CONTEXT_WINDOW_DEFAULTS,
} from "./types.js";

// Import LangChain callback base for production token tracking
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";

// Import agentic model definitions for provider context
import { AGENTIC_COORDINATOR_MODELS, getAgenticModel } from "./agentic.js";

// =============================================================================
// WindowTracker Agent - Dynamic Model Context Window Specs
// =============================================================================

/**
 * Model context specification from the registry
 */
export interface ModelContextSpec {
    modelId: string;
    contextLength: number;
    effectiveWindow: number;  // MECW: 70% of advertised
    maxCompletionTokens?: number;
    source: string;
}

/**
 * Default context limits by provider (fallback when model not in registry)
 */
const PROVIDER_DEFAULTS: Record<string, number> = {
    "openai": 400000,      // GPT-5.2
    "anthropic": 200000,   // Claude 4.5
    "google": 1000000,     // Gemini 3 Pro
    "nvidia": 128000,      // Nemotron
    "minimax": 4000000,    // MiniMax M2.1
    "moonshotai": 256000,  // Kimi K2
    "nex-agi": 164000,     // DeepSeek Nex
    "allenai": 128000,     // OLMo
    "arcee-ai": 128000,    // Arcee Trinity
    "asi-cloud": 128000,
    "huggingface": 32768,
    "default": 128000,
};

/**
 * Infer provider from model ID
 */
function inferProvider(modelId: string): string {
    const parts = modelId.split("/");
    if (parts.length >= 2) {
        return parts[0].toLowerCase();
    }
    // Check common prefixes
    if (modelId.startsWith("gpt")) return "openai";
    if (modelId.startsWith("claude")) return "anthropic";
    if (modelId.startsWith("gemini")) return "google";
    return "default";
}

/**
 * WindowTracker: Get model context spec from registry or infer from provider
 * Uses dynamic lookup from models.ts when available
 */
export async function getModelContextSpec(modelId: string): Promise<ModelContextSpec> {
    try {
        // Try to fetch from the models API
        const LAMBDA_API_URL = process.env.LAMBDA_API_URL || "https://api.compose.market";
        const response = await fetch(`${LAMBDA_API_URL}/api/models/${encodeURIComponent(modelId)}`);

        if (response.ok) {
            const model = await response.json();
            return {
                modelId,
                contextLength: model.contextLength || PROVIDER_DEFAULTS[inferProvider(modelId)] || PROVIDER_DEFAULTS.default,
                effectiveWindow: (model.contextLength || PROVIDER_DEFAULTS.default) * 0.70,
                maxCompletionTokens: model.maxCompletionTokens,
                source: model.source || inferProvider(modelId),
            };
        }
    } catch {
        // Fallback to provider defaults
    }

    // Fallback: use provider defaults
    const provider = inferProvider(modelId);
    const contextLength = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.default;

    return {
        modelId,
        contextLength,
        effectiveWindow: contextLength * 0.70,
        source: provider,
    };
}

/**
 * Synchronous version using defaults (for when async is not possible)
 */
export function getModelContextSpecSync(modelId: string): ModelContextSpec {
    const provider = inferProvider(modelId);
    const contextLength = CONTEXT_WINDOW_DEFAULTS.MODEL_CONTEXT_SIZES[modelId] ||
        PROVIDER_DEFAULTS[provider] ||
        PROVIDER_DEFAULTS.default;

    return {
        modelId,
        contextLength,
        effectiveWindow: contextLength * 0.70,
        source: provider,
    };
}

// =============================================================================
// API Usage Extraction (NoteTaker Agent Logic)
// =============================================================================

/**
 * Extract token usage from API responses across all providers
 * This replaces character-based estimation with 100% accurate tracking
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
    // This is the PREFERRED source - LangChain normalizes all provider responses here
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

    // 2. LangChain AIMessage with response_metadata (from ChatOpenAI invoke)
    // ChatOpenAI stores token usage in response_metadata.usage or response_metadata.tokenUsage
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

    // 3. OpenRouter / OpenAI-compatible format (used by ALL coordinator models)
    // nvidia, minimax, moonshotai, nex-agi, allenai, arcee-ai ALL use this via OpenRouter
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

    // 7. FALLBACK: Character-based estimation (only if no usage data available)
    // This should rarely happen since OpenRouter includes usage in all responses
    const content = extractContentFromResponse(response);
    const estimatedTokens = Math.ceil(content.length / 4);
    console.warn(`[context] No token usage in response for model ${modelId || 'unknown'}, using estimation`);
    return {
        inputTokens: 0,
        outputTokens: estimatedTokens,
        totalTokens: estimatedTokens,
        estimated: true,
        source: "estimated",
    };
}

/**
 * Extract text content from various response formats
 */
function extractContentFromResponse(response: any): string {
    // LangChain AIMessage
    if (response?.content !== undefined) {
        if (typeof response.content === "string") return response.content;
        if (Array.isArray(response.content)) {
            return response.content.map((p: any) => p.text || p.content || "").join("");
        }
    }
    // OpenAI format
    if (response?.choices?.[0]?.message?.content) {
        return response.choices[0].message.content;
    }
    // Anthropic format
    if (response?.content?.[0]?.text) {
        return response.content[0].text;
    }
    // LangChain text attribute
    if (typeof response?.text === "string") {
        return response.text;
    }
    return "";
}

// =============================================================================
// Token Checkpoint (NoteTaker Agent Data Structure)
// =============================================================================

export interface TokenCheckpoint {
    agentId: string;
    modelId: string;
    action: string;
    inputTokens: number;
    outputTokens: number;
    timestamp: number;
    cumulativeTotal: number;
    estimated: boolean;
    provider: string;
}

/**
 * NoteTaker: Maintains a ledger of all token usage per-agent per-action
 */
export class TokenLedger {
    private checkpoints: TokenCheckpoint[] = [];
    private cumulativeTotal = 0;

    /**
     * Record a token checkpoint from an API response
     */
    recordFromResponse(
        agentId: string,
        modelId: string,
        action: string,
        response: any,
        provider?: string
    ): TokenCheckpoint {
        const usage = extractTokenUsage(response, provider);
        this.cumulativeTotal += usage.totalTokens;

        const checkpoint: TokenCheckpoint = {
            agentId,
            modelId,
            action,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            timestamp: Date.now(),
            cumulativeTotal: this.cumulativeTotal,
            estimated: usage.estimated,
            provider: usage.source,
        };

        this.checkpoints.push(checkpoint);
        return checkpoint;
    }

    /**
     * Get all checkpoints for a specific agent
     */
    getAgentCheckpoints(agentId: string): TokenCheckpoint[] {
        return this.checkpoints.filter(c => c.agentId === agentId);
    }

    /**
     * Get total tokens used by each agent
     */
    getAgentTotals(): Map<string, number> {
        const totals = new Map<string, number>();
        for (const cp of this.checkpoints) {
            const current = totals.get(cp.agentId) || 0;
            totals.set(cp.agentId, current + cp.inputTokens + cp.outputTokens);
        }
        return totals;
    }

    /**
     * Get cumulative total
     */
    getCumulativeTotal(): number {
        return this.cumulativeTotal;
    }

    /**
     * Clear all checkpoints (after memory wipe)
     */
    clear(): void {
        this.checkpoints = [];
        this.cumulativeTotal = 0;
    }

    /**
     * Record a pre-built checkpoint directly
     * Used by LangSmith callback handler
     */
    recordCheckpoint(checkpoint: TokenCheckpoint): void {
        this.cumulativeTotal += checkpoint.inputTokens + checkpoint.outputTokens;
        this.checkpoints.push({
            ...checkpoint,
            cumulativeTotal: this.cumulativeTotal,
        });
    }

    /**
     * Export checkpoints for persistence
     */
    export(): TokenCheckpoint[] {
        return [...this.checkpoints];
    }
}


// =============================================================================
// Context Window Manager
// =============================================================================

export class ContextWindowManager {
    private model: string;
    private maxTokens: number;
    private cleanupThreshold: number;
    private currentTokens: number = 0;
    private agentUsage: Map<string, TokenUsage> = new Map();
    private lastCleanup?: number;
    private tokenLedger: TokenLedger;

    constructor(
        model: string,
        options?: {
            maxTokens?: number;
            cleanupThreshold?: number;
        }
    ) {
        this.model = model;
        this.maxTokens = options?.maxTokens ||
            CONTEXT_WINDOW_DEFAULTS.MODEL_CONTEXT_SIZES[model] ||
            CONTEXT_WINDOW_DEFAULTS.MODEL_CONTEXT_SIZES.default;
        this.cleanupThreshold = options?.cleanupThreshold || CONTEXT_WINDOW_DEFAULTS.CLEANUP_THRESHOLD;
        this.tokenLedger = new TokenLedger();
    }

    /**
     * Record token usage from an agent or coordinator inference
     */
    recordUsage(usage: TokenUsage): void {
        // Update agent-specific tracking
        const existing = this.agentUsage.get(usage.agentId);
        if (existing) {
            existing.inputTokens += usage.inputTokens;
            existing.outputTokens += usage.outputTokens;
            existing.totalTokens += usage.totalTokens;
            existing.timestamp = usage.timestamp;
        } else {
            this.agentUsage.set(usage.agentId, { ...usage });
        }

        // Update total
        this.currentTokens += usage.totalTokens;
    }

    /**
     * Estimate and record tokens from a message
     */
    recordMessage(agentId: string, model: string, content: string, isOutput = false): TokenUsage {
        // Estimate tokens using character-based ratio (fallback for pre-response estimation)
        const tokens = Math.ceil(content.length / 4);
        const usage: TokenUsage = {
            agentId,
            model,
            inputTokens: isOutput ? 0 : tokens,
            outputTokens: isOutput ? tokens : 0,
            totalTokens: tokens,
            timestamp: Date.now(),
        };
        this.recordUsage(usage);
        return usage;
    }

    /**
     * Get current context window state
     */
    getState(): ContextWindowState {
        const usagePercent = (this.currentTokens / this.maxTokens) * 100;
        return {
            currentTokens: this.currentTokens,
            maxTokens: this.maxTokens,
            usagePercent,
            cleanupThreshold: this.cleanupThreshold,
            needsCleanup: usagePercent >= this.cleanupThreshold,
            agentUsage: new Map(this.agentUsage),
            lastCleanup: this.lastCleanup,
        };
    }

    /**
     * Check if cleanup is needed
     */
    needsCleanup(): boolean {
        return this.getState().needsCleanup;
    }

    /**
     * Reset token tracking after cleanup
     */
    markCleanupComplete(preservedTokens = 0): void {
        this.lastCleanup = Date.now();
        this.currentTokens = preservedTokens;
        this.agentUsage.clear();
    }

    /**
     * Get token budget remaining
     */
    getRemainingTokens(): number {
        return Math.max(0, this.maxTokens - this.currentTokens);
    }

    /**
     * Get safe token limit (before cleanup threshold)
     */
    getSafeTokenLimit(): number {
        return Math.floor(this.maxTokens * (this.cleanupThreshold / 100));
    }

    /**
     * Estimate if content will exceed threshold
     */
    willExceedThreshold(additionalContent: string): boolean {
        // Estimate tokens using character-based ratio
        const additionalTokens = Math.ceil(additionalContent.length / 4);
        const projectedTotal = this.currentTokens + additionalTokens;
        const projectedPercent = (projectedTotal / this.maxTokens) * 100;
        return projectedPercent >= this.cleanupThreshold;
    }
}

// =============================================================================
// Context Summarizer
// =============================================================================

const LAMBDA_API_URL = process.env.LAMBDA_API_URL || "https://api.compose.market";

/**
 * Summarize workflow context using the coordinator model
 */
export async function summarizeContext(
    workflowId: string,
    context: Record<string, unknown>,
    agentResults: Record<string, string>,
    options?: {
        model?: string;
        userId?: string;
        preserveKeys?: string[];
    }
): Promise<WorkflowStateSummary | null> {
    const { model = "asi1-mini", userId, preserveKeys = [] } = options || {};

    try {
        // Build summarization prompt
        const contextJson = JSON.stringify(context, null, 2);
        const agentSummariesJson = JSON.stringify(agentResults, null, 2);

        const prompt = `You are a context summarization agent. Your job is to compress workflow state for efficient resumption.

## Current Context
\`\`\`json
${contextJson}
\`\`\`

## Agent Results
\`\`\`json
${agentSummariesJson}
\`\`\`

## Instructions
1. Create a concise summary (2-3 sentences) of the workflow progress
2. Extract key facts as bullet points (max 10)
3. Summarize each agent's contribution in one sentence
4. Identify any results that MUST be preserved for workflow continuation

Respond in JSON format:
{
  "summary": "...",
  "keyFacts": ["...", "..."],
  "agentSummaries": { "agent_id": "summary", ... },
  "preserveKeys": ["key1", "key2"]
}`;

        // Call inference API
        const response = await fetch(`${LAMBDA_API_URL}/api/inference`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model,
                messages: [
                    { role: "system", content: "You are a precise context summarization agent." },
                    { role: "user", content: prompt },
                ],
            }),
        });

        if (!response.ok) {
            console.error("[context-manager] Summarization failed:", response.status);
            return null;
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || data.content;

        // Parse JSON response
        let parsed: {
            summary: string;
            keyFacts: string[];
            agentSummaries: Record<string, string>;
            preserveKeys: string[];
        };

        try {
            // Extract JSON from possible markdown code block
            const jsonMatch = content.match(/```json?\s*([\s\S]*?)\s*```/) || [null, content];
            parsed = JSON.parse(jsonMatch[1] || content);
        } catch {
            console.error("[context-manager] Failed to parse summary JSON");
            return null;
        }

        // Build preserved results
        const allPreserveKeys = [...new Set([...preserveKeys, ...(parsed.preserveKeys || [])])];
        const preservedResults: Record<string, unknown> = {};
        for (const key of allPreserveKeys) {
            if (context[key] !== undefined) {
                preservedResults[key] = context[key];
            }
        }

        const summary: WorkflowStateSummary = {
            summary: parsed.summary,
            keyFacts: parsed.keyFacts || [],
            agentSummaries: parsed.agentSummaries || {},
            preservedResults,
            createdAt: Date.now(),
        };

        // Store in mem0 for retrieval
        await storeContextSummary(workflowId, summary, userId);

        return summary;
    } catch (error) {
        console.error("[context-manager] Summarization error:", error);
        return null;
    }
}

/**
 * Store context summary in mem0 for later retrieval
 */
async function storeContextSummary(
    workflowId: string,
    summary: WorkflowStateSummary,
    userId?: string
): Promise<string | null> {
    try {
        const response = await fetch(`${LAMBDA_API_URL}/api/memory/add`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                messages: [
                    {
                        role: "system",
                        content: `Workflow ${workflowId} context summary at ${new Date(summary.createdAt).toISOString()}`,
                    },
                    {
                        role: "assistant",
                        content: `Summary: ${summary.summary}\n\nKey Facts:\n${summary.keyFacts.map((f: string) => `- ${f}`).join("\n")}`,
                    },
                ],
                agent_id: `manowar-${workflowId}`,
                user_id: userId,
                metadata: {
                    type: "context_summary",
                    workflow_id: workflowId,
                    created_at: summary.createdAt,
                    key_facts_count: summary.keyFacts.length,
                },
            }),
        });

        if (!response.ok) {
            console.error("[context-manager] Failed to store summary in mem0");
            return null;
        }

        const data = await response.json();
        return data.memory_id || data.id || null;
    } catch (error) {
        console.error("[context-manager] mem0 storage error:", error);
        return null;
    }
}

/**
 * Retrieve context summary from mem0
 */
export async function retrieveContextSummary(
    workflowId: string,
    userId?: string
): Promise<WorkflowStateSummary | null> {
    try {
        const response = await fetch(`${LAMBDA_API_URL}/api/memory/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                query: `workflow ${workflowId} context summary`,
                agent_id: `manowar-${workflowId}`,
                user_id: userId,
                limit: 1,
                rerank: true,
            }),
        });

        if (!response.ok) {
            return null;
        }

        const data = await response.json();
        const memories = data.memories || data.results || [];

        if (memories.length === 0) {
            return null;
        }

        // Parse the most recent summary
        const memory = memories[0];
        // The summary was stored in a specific format, reconstruct it
        // This is a simplified version - full implementation would store structured data
        return {
            summary: memory.memory || memory.content || "",
            keyFacts: [],
            agentSummaries: {},
            preservedResults: {},
            createdAt: memory.created_at || Date.now(),
            memoryId: memory.id,
        };
    } catch (error) {
        console.error("[context-manager] Failed to retrieve summary:", error);
        return null;
    }
}

// =============================================================================
// ToolBoxer Agent - Registry Access for Orchestration Optimization
// =============================================================================

/**
 * NOTES:
 * - This is the EXTRINSIC (orchestration) layer, not the workflow execution layer
 * - ToolBoxer helps the COORDINATOR optimize workflow execution behind the scenes
 * - Specialized agents in the workflow do NOT get extra tool access through this
 * - This is for meta-level decisions: which tools to recommend, how to batch, etc.
 */

const CONNECTOR_SERVICE_URL = process.env.CONNECTOR_SERVICE_URL || "https://services.compose.market/connector";

/**
 * Tool capability record from the registry
 */
export interface ToolCapability {
    registryId: string;
    name: string;
    namespace: string;
    description: string;
    category?: string;
    tags: string[];
    executable: boolean;
    transport?: "stdio" | "http" | "docker";
    origin: "mcp" | "goat" | "eliza" | "internal";
}

/**
 * ToolBoxer: Search registry for tools matching a query
 * Used by orchestration layer to provide optimization hints
 */
export async function searchRegistryTools(
    query: string,
    options?: { limit?: number; executableOnly?: boolean }
): Promise<ToolCapability[]> {
    const { limit = 20, executableOnly = false } = options || {};

    try {
        const response = await fetch(
            `${CONNECTOR_SERVICE_URL}/registry/search?q=${encodeURIComponent(query)}&limit=${limit}`
        );

        if (!response.ok) {
            console.warn(`[ToolBoxer] Registry search failed: ${response.status}`);
            return [];
        }

        const results = await response.json();

        // Map to simplified capability format
        const capabilities: ToolCapability[] = (results.servers || results || [])
            .filter((s: any) => !executableOnly || s.executable)
            .slice(0, limit)
            .map((s: any) => ({
                registryId: s.registryId,
                name: s.name,
                namespace: s.namespace,
                description: s.description || "",
                category: s.category,
                tags: s.tags || [],
                executable: s.executable || false,
                transport: s.transport,
                origin: s.origin,
            }));

        return capabilities;
    } catch (error) {
        console.error("[ToolBoxer] Failed to search registry:", error);
        return [];
    }
}

/**
 * ToolBoxer: Get registry metadata for optimization decisions
 */
export async function getRegistryStats(): Promise<{
    totalTools: number;
    executableTools: number;
    byOrigin: Record<string, number>;
}> {
    try {
        const response = await fetch(`${CONNECTOR_SERVICE_URL}/registry/meta`);

        if (!response.ok) {
            return { totalTools: 0, executableTools: 0, byOrigin: {} };
        }

        const meta = await response.json();
        return {
            totalTools: meta.totalServers || 0,
            executableTools: meta.executableServers || 0,
            byOrigin: {
                mcp: meta.mcpServers || 0,
                goat: meta.goatServers || 0,
                eliza: meta.elizaServers || 0,
                internal: meta.internalServers || 0,
            },
        };
    } catch (error) {
        console.error("[ToolBoxer] Failed to get registry stats:", error);
        return { totalTools: 0, executableTools: 0, byOrigin: {} };
    }
}

/**
 * ToolBoxer: Inspect a specific tool's capabilities
 * Used by orchestration to understand what a tool can do before recommending
 */
export async function inspectToolCapability(
    registryId: string
): Promise<{
    id: string;
    name: string;
    description: string;
    tools: Array<{ name: string; description: string; inputSchema?: any }>;
    spawnConfig?: any;
} | null> {
    try {
        // First get the server metadata
        const response = await fetch(
            `${CONNECTOR_SERVICE_URL}/registry/server/${encodeURIComponent(registryId)}`
        );

        if (!response.ok) {
            return null;
        }

        const server = await response.json();

        // Try to get tool list if the server is spawnable
        let tools: any[] = [];
        if (server.executable) {
            try {
                const toolsResponse = await fetch(
                    `${CONNECTOR_SERVICE_URL}/registry/server/${encodeURIComponent(registryId)}/tools`
                );
                if (toolsResponse.ok) {
                    const toolsData = await toolsResponse.json();
                    tools = toolsData.tools || [];
                }
            } catch {
                // Tools endpoint may not exist for all servers
            }
        }

        return {
            id: server.registryId,
            name: server.name,
            description: server.description || "",
            tools: tools.map((t: any) => ({
                name: t.name,
                description: t.description || "",
                inputSchema: t.inputSchema || t.parameters,
            })),
            spawnConfig: server.executable ? {
                transport: server.transport,
                image: server.image,
                remoteUrl: server.remoteUrl,
            } : undefined,
        };
    } catch (error) {
        console.error("[ToolBoxer] Failed to inspect tool:", error);
        return null;
    }
}

/**
 * ToolBoxer: Suggest tools based on task context
 * Meta-optimization: recommends which tools might help specialized agents
 */
export async function suggestToolsForTask(
    taskDescription: string,
    currentAgentPlugins: string[]
): Promise<{
    suggestions: ToolCapability[];
    reasoning: string;
}> {
    // Extract keywords from task
    const keywords = taskDescription
        .toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 3);

    // Search for relevant tools
    const searchResults = await searchRegistryTools(
        keywords.slice(0, 5).join(" "),
        { limit: 10, executableOnly: true }
    );

    // Filter out tools already available to the agent
    const suggestions = searchResults.filter(
        tool => !currentAgentPlugins.some(
            p => p.includes(tool.registryId) || p.includes(tool.name.toLowerCase())
        )
    );

    return {
        suggestions: suggestions.slice(0, 5),
        reasoning: suggestions.length > 0
            ? `Found ${suggestions.length} tools that might enhance this task: ${suggestions.map(s => s.name).join(", ")}`
            : "No additional tools found that would benefit this task",
    };
}

// =============================================================================
// Exports are inline - TokenLedger, extractTokenUsage, ContextWindowManager,
// summarizeContext, retrieveContextSummary, ToolBoxer functions all exported
// =============================================================================

