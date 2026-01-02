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
} from "./types.js";

// Import LangChain callback base for production token tracking
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";

// Import agentic model definitions for provider context
import { AGENTIC_COORDINATOR_MODELS, getAgenticModel } from "./agentic.js";

// Import dynamic model metadata from langsmith (centralized, uses Lambda API)
import {
    getModelMetadataCached,
    extractTokenUsage,
    estimateTokens,
    estimateCost,
    type ExtractedUsage
} from "./langsmith.js";

// Re-export for backwards compatibility
export { ExtractedUsage, extractTokenUsage, estimateTokens, estimateCost };

// Default context fallback (only used when Lambda API fails)
const DEFAULT_CONTEXT_LENGTH = 128000;

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

// Context fetches from Lambda API via getModelMetadataCached

/**
 * WindowTracker: Get model context spec from registry
 * Uses centralized getModelMetadataCached from langsmith.ts (Lambda API with 2700+ models)
 */
export async function getModelContextSpec(modelId: string): Promise<ModelContextSpec> {
    // Use centralized model metadata cache (fetches from Lambda API)
    const metadata = await getModelMetadataCached(modelId);
    const contextLength = metadata.contextLength || DEFAULT_CONTEXT_LENGTH;

    return {
        modelId,
        contextLength,
        effectiveWindow: contextLength * 0.70,
        source: metadata.source,
    };
}

/**
 * Synchronous version using defaults (for when async is not possible)
 */
export function getModelContextSpecSync(modelId: string): ModelContextSpec {

    const contextLength = DEFAULT_CONTEXT_LENGTH;

    // Infer source from model ID for sync version (can't call async API)
    const parts = modelId.split("/");
    const source = parts.length >= 2 ? parts[0].toLowerCase() : "unknown";

    return {
        modelId,
        contextLength,
        effectiveWindow: contextLength * 0.70,
        source,
    };
}

// =============================================================================
// API Usage Extraction (Imported from langsmith.ts)
// =============================================================================

// Token extraction utilities are now centralized in langsmith.ts
// extractTokenUsage, ExtractedUsage, estimateTokens, estimateCost are re-exported above

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
        this.maxTokens = options?.maxTokens || DEFAULT_CONTEXT_LENGTH;
        this.cleanupThreshold = options?.cleanupThreshold || DEFAULT_CONTEXT_LENGTH;
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
                agent_id: workflowId, // workflowId already contains "manowar-" prefix
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
                agent_id: workflowId, // workflowId already contains "manowar-" prefix
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

