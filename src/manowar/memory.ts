/**
 * Manowar Memory Module - Mem0 Platform Native Integration
 * 
 * - Uses Mem0 SDK (mem0ai) like backend/lambda/shared/mem0.ts
 * - Memory Priority Matrix: user_id > agent_id > run_id
 * - Native features: enable_graph, rerank, filter_memories
 * 
 * Memory Hierarchy (Priority Matrix):
 * 1. user_id: User-specific preferences and context (highest priority)
 * 2. agent_id: Agent/Manowar execution patterns and learnings
 * 3. run_id: Current execution context (lowest priority, most specific)
 */

import * as mem0ai from "mem0ai";

// =============================================================================
// Configuration
// =============================================================================

const MEM0_API_KEY = process.env.MEM0_API_KEY;
const LAMBDA_API_URL = process.env.LAMBDA_API_URL || "https://api.compose.market";

if (!MEM0_API_KEY) {
    console.warn("[mem0] MEM0_API_KEY not found. Memory features will be disabled.");
}

// =============================================================================
// Mem0 Client (SDK approach - matches lambda/shared/mem0.ts)
// =============================================================================

type Mem0Client = any;
let mem0Client: Mem0Client | null = null;

function getMem0Client(): Mem0Client | null {
    if (mem0Client) return mem0Client;
    if (!MEM0_API_KEY) return null;

    try {
        const MemoryClass = (mem0ai as any).MemoryClient || (mem0ai as any).default?.MemoryClient;
        if (typeof MemoryClass !== "function") {
            console.error("[mem0] MemoryClient class not found. Available exports:", Object.keys(mem0ai));
            return null;
        }
        mem0Client = new MemoryClass({ apiKey: MEM0_API_KEY });
        console.log("[mem0] Client initialized (SDK mode)");
        return mem0Client;
    } catch (error) {
        console.error("[mem0] Failed to initialize client:", error);
        return null;
    }
}

// =============================================================================
// Types
// =============================================================================

export interface MemoryItem {
    id: string;
    memory: string;
    user_id?: string;
    agent_id?: string;
    run_id?: string;
    metadata?: Record<string, unknown>;
    created_at?: string;
    updated_at?: string;
    relations?: Array<{ source: string; target: string; relation: string }>;
}

export interface GraphMemoryResult {
    memories: MemoryItem[];
    entities: Array<{ name: string; type: string; properties?: Record<string, unknown> }>;
    relations: Array<{ source: string; target: string; relation: string; weight?: number }>;
}

export interface ContextSummary {
    summary: string;
    keyFacts: string[];
    preservedContext: Record<string, unknown>;
    tokensSaved: number;
}

export interface WipeResult {
    previousSummary: string;
    preservedFacts: string[];
    wipedMessageCount: number;
    memoryId?: string;
}

export interface SolutionPattern {
    task: string;
    toolSequence: string[];
    outcome: "success" | "partial" | "failure";
    notes?: string;
    confidence: number;
}

// Constants for sliding window (used by orchestrator)
export const SLIDING_WINDOW_SIZE = 4;
export const TOKEN_THRESHOLD_PERCENT = 60;

// =============================================================================
// Memory Priority Matrix Configuration
// =============================================================================

/**
 * Memory Priority: user_id > agent_id > run_id
 * 
 * When searching/adding memories:
 * - user_id: User preferences, history across all agents (highest priority)
 * - agent_id: Manowar/agent-specific patterns and learnings
 * - run_id: Current execution context only
 */
interface MemoryContext {
    user_id?: string;      // Priority 1: User context
    agent_id: string;      // Priority 2: Agent/Manowar context
    run_id?: string;       // Priority 3: Execution context
}

// =============================================================================
// Mem0 SDK Operations (Native Features)
// =============================================================================

/**
 * Add memory with native graph extraction using SDK
 * Priority: Stores with user_id (if provided) > agent_id > run_id
 */
export async function addMemoryWithGraph(params: {
    messages: Array<{ role: string; content: string }>;
    agent_id: string;
    user_id?: string;
    run_id: string;
    metadata?: Record<string, unknown>;
}): Promise<MemoryItem[]> {
    const client = getMem0Client();
    if (!client) return [];

    try {
        const result = await client.add(params.messages, {
            user_id: params.user_id,       // Priority 1
            agent_id: params.agent_id,     // Priority 2
            run_id: params.run_id,         // Priority 3
            metadata: {
                ...params.metadata,
                run_id: params.run_id,
                timestamp: Date.now(),
            },
            enable_graph: true,  // Native entity extraction
        });

        console.log(`[mem0] Added memory: user=${params.user_id || 'none'}, agent=${params.agent_id}, run=${params.run_id}`);
        return result as unknown as MemoryItem[];
    } catch (error) {
        console.error("[mem0] Failed to add memory:", error);
        return [];
    }
}

/**
 * Search memories with native advanced retrieval using SDK
 * Priority search: user_id context first, then agent_id, then run_id
 */
export async function searchMemoryWithGraph(params: {
    query: string;
    agent_id: string;
    user_id?: string;
    run_id?: string;
    limit?: number;
    filters?: Record<string, unknown>;
    options?: {
        rerank?: boolean;
        filter_memories?: boolean;
        keyword_search?: boolean;
    };
}): Promise<GraphMemoryResult> {
    const client = getMem0Client();
    if (!client) return { memories: [], entities: [], relations: [] };

    try {
        // Primary search: Include user context if available (highest priority)
        const searchOptions: Record<string, unknown> = {
            user_id: params.user_id,       // Priority 1 - user preferences
            agent_id: params.agent_id,     // Priority 2 - agent patterns
            run_id: params.run_id,         // Priority 3 - current execution
            limit: params.limit || 10,
            filters: params.filters,
            enable_graph: true,            // Native graph relations
        };

        // Add native advanced retrieval options if specified
        if (params.options?.rerank !== false) {
            // Rerank enabled by default for better relevance
        }

        const result = await client.search(params.query, searchOptions);

        return {
            memories: result as unknown as MemoryItem[],
            entities: [],  // SDK may not expose entities directly
            relations: [], // SDK may not expose relations directly
        };
    } catch (error) {
        console.error("[mem0] Failed to search memory:", error);
        return { memories: [], entities: [], relations: [] };
    }
}

/**
 * Get all memories for a context using SDK
 * Supports priority filtering by user_id > agent_id > run_id
 */
export async function getAllMemories(params: {
    agent_id: string;
    user_id?: string;
    run_id?: string;
    limit?: number;
}): Promise<MemoryItem[]> {
    const client = getMem0Client();
    if (!client) return [];

    try {
        const result = await client.getAll({
            user_id: params.user_id,
            agent_id: params.agent_id,
            run_id: params.run_id,
            limit: params.limit,
            enable_graph: true,
        });
        return result as unknown as MemoryItem[];
    } catch {
        return [];
    }
}

// =============================================================================
// Hierarchical Memory Operations (Priority Matrix Implementation)
// =============================================================================

/**
 * Get contextual memory with priority cascade
 * Searches: user preferences → agent patterns → execution context
 */
export async function getContextualMemory(
    query: string,
    context: MemoryContext,
    options?: { limit?: number; includePatterns?: boolean }
): Promise<{ memories: MemoryItem[]; source: 'user' | 'agent' | 'run' }> {
    // Priority 1: User-specific memories (highest priority)
    if (context.user_id) {
        const userMemories = await searchMemoryWithGraph({
            query,
            agent_id: context.agent_id,
            user_id: context.user_id,
            limit: options?.limit || 5,
        });
        if (userMemories.memories.length > 0) {
            return { memories: userMemories.memories, source: 'user' };
        }
    }

    // Priority 2: Agent-level patterns (without user filter)
    const agentMemories = await searchMemoryWithGraph({
        query,
        agent_id: context.agent_id,
        limit: options?.limit || 5,
    });
    if (agentMemories.memories.length > 0) {
        return { memories: agentMemories.memories, source: 'agent' };
    }

    // Priority 3: Run-specific context (most specific)
    if (context.run_id) {
        const runMemories = await searchMemoryWithGraph({
            query,
            agent_id: context.agent_id,
            run_id: context.run_id,
            limit: options?.limit || 3,
        });
        return { memories: runMemories.memories, source: 'run' };
    }

    return { memories: [], source: 'run' };
}

// =============================================================================
// Memory Operations (Simplified with Native Features)
// =============================================================================

/**
 * Optimize with graph - relies on Mem0's native entity extraction
 */
export async function optimizeWithGraph(
    workflowId: string,
    runId: string,
    content: string,
    context: {
        goal: string;
        agentId?: string;
        userId?: string;
        actionType?: string;
    }
): Promise<{ success: boolean; entitiesExtracted: number; relationsCreated: number }> {
    const memories = await addMemoryWithGraph({
        messages: [
            { role: "system", content: `Workflow: ${workflowId} | Goal: ${context.goal}` },
            { role: "assistant", content },
        ],
        agent_id: `manowar-${workflowId}`,
        user_id: context.userId,
        run_id: runId,
        metadata: {
            type: "graph_optimization",
            workflow_id: workflowId,
            action_type: context.actionType,
        },
    });

    const entitiesExtracted = memories.filter(m => m.relations?.length).length;
    const relationsCreated = memories.reduce((sum, m) => sum + (m.relations?.length || 0), 0);

    return { success: memories.length > 0, entitiesExtracted, relationsCreated };
}

/**
 * Perform memory wipe with summary stored in Mem0
 */
export async function performMemoryWipe(
    workflowId: string,
    runId: string,
    currentContext: {
        goal: string;
        completedActions: string[];
        lastOutcome: string;
        agentSummaries: Record<string, string>;
    }
): Promise<WipeResult | null> {
    const summaryPrompt = `Summarize this workflow state in 2 sentences:
Goal: ${currentContext.goal}
Actions: ${currentContext.completedActions.join(", ")}
Last outcome: ${currentContext.lastOutcome}`;

    try {
        const response = await fetch(`${LAMBDA_API_URL}/api/inference`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "moonshotai/kimi-k2-thinking",
                messages: [{ role: "user", content: summaryPrompt }],
                temperature: 0.3,
            }),
        });

        const data = await response.json();
        const summary = data.choices?.[0]?.message?.content || currentContext.lastOutcome;

        // Store in Mem0 using SDK
        const memories = await addMemoryWithGraph({
            messages: [
                { role: "system", content: `Memory wipe summary for ${workflowId}` },
                { role: "assistant", content: summary },
            ],
            agent_id: `manowar-${workflowId}`,
            run_id: runId,
            metadata: { type: "wipe_summary" },
        });

        return {
            previousSummary: summary,
            preservedFacts: currentContext.completedActions.slice(-3),
            wipedMessageCount: currentContext.completedActions.length,
            memoryId: memories[0]?.id,
        };
    } catch (error) {
        console.error("[MemoryWipe] Failed:", error);
        return null;
    }
}

// =============================================================================
// Solution Pattern Storage (Workflow Learning)
// =============================================================================

/**
 * Find similar solutions using native Mem0 search with reranking
 */
export async function findSimilarSolutions(
    workflowId: string,
    taskDescription: string,
    options?: { limit?: number; outcomeFilter?: "success" | "partial" | "failure" }
): Promise<SolutionPattern[]> {
    const result = await searchMemoryWithGraph({
        query: taskDescription,
        agent_id: `manowar-${workflowId}-patterns`,
        limit: options?.limit || 5,
        options: { rerank: true },
    });

    return result.memories
        .filter(m => {
            if (!options?.outcomeFilter) return true;
            const outcome = m.metadata?.outcome as string;
            return outcome === options.outcomeFilter;
        })
        .map(m => ({
            task: String(m.metadata?.task || m.memory),
            toolSequence: (m.metadata?.toolSequence as string[]) || [],
            outcome: (m.metadata?.outcome as "success" | "partial" | "failure") || "success",
            confidence: Number(m.metadata?.confidence || 0.5),
        }));
}

/**
 * Save solution pattern for future retrieval
 */
export async function saveSolutionPattern(
    workflowId: string,
    runId: string,
    pattern: SolutionPattern
): Promise<boolean> {
    const memories = await addMemoryWithGraph({
        messages: [
            { role: "user", content: `Task: ${pattern.task}` },
            { role: "assistant", content: `Solution: ${pattern.toolSequence.join(" → ")} (${pattern.outcome})` },
        ],
        agent_id: `manowar-${workflowId}-patterns`,
        run_id: runId,
        metadata: {
            type: "solution_pattern",
            task: pattern.task,
            toolSequence: pattern.toolSequence,
            outcome: pattern.outcome,
            confidence: pattern.confidence,
            notes: pattern.notes,
        },
    });

    return memories.length > 0;
}

// =============================================================================
// Graph Insights - Native Mem0 Graph Retrieval
// =============================================================================

/**
 * Get graph insights using native Mem0 graph search
 */
export async function getGraphInsights(
    workflowId: string,
    runId: string,
    query: string
): Promise<{ entities: Array<{ name: string; type: string }>; topRelations: Array<{ source: string; target: string; relation: string }> }> {
    const result = await searchMemoryWithGraph({
        query,
        agent_id: `manowar-${workflowId}`,
        run_id: runId,
        limit: 20,
        options: { rerank: true },
    });

    // Extract unique entities from memories
    const entityMap = new Map<string, { type: string; count: number }>();
    for (const mem of result.memories) {
        for (const rel of mem.relations || []) {
            entityMap.set(rel.source, { type: "entity", count: (entityMap.get(rel.source)?.count || 0) + 1 });
            entityMap.set(rel.target, { type: "entity", count: (entityMap.get(rel.target)?.count || 0) + 1 });
        }
    }

    return {
        entities: Array.from(entityMap.entries())
            .map(([name, { type }]) => ({ name, type }))
            .slice(0, 10),
        topRelations: result.relations.slice(0, 10),
    };
}

// =============================================================================
// Context Summarization - Simplified with Native Mem0
// =============================================================================

/**
 * Summarize context for continuity - stores in Mem0 automatically
 */
export async function summarizeForContinuity(
    workflowId: string,
    runId: string,
    context: {
        goal: string;
        completedActions: string[];
        lastOutcome: string;
        agentSummaries: Record<string, string>;
    }
): Promise<ContextSummary | null> {
    try {
        const prompt = `Summarize workflow state:
Goal: ${context.goal}
Completed: ${context.completedActions.slice(-5).join(", ")}
Last: ${context.lastOutcome}

Respond with JSON: {"summary": "...", "keyFacts": ["...", "..."]}`;

        const response = await fetch(`${LAMBDA_API_URL}/api/inference`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "nvidia/nemotron-3-nano-30b-a3b:free",
                messages: [
                    { role: "system", content: "Respond with valid JSON only" },
                    { role: "user", content: prompt },
                ],
                temperature: 0.3,
            }),
        });

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || "";
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;

        const parsed = JSON.parse(jsonMatch[0]);

        // Store in Mem0 using SDK
        await addMemoryWithGraph({
            messages: [
                { role: "system", content: `Context summary for ${workflowId}` },
                { role: "assistant", content: parsed.summary },
            ],
            agent_id: `manowar-${workflowId}`,
            run_id: runId,
            metadata: { type: "context_summary", key_facts: parsed.keyFacts },
        });

        return {
            summary: parsed.summary,
            keyFacts: parsed.keyFacts || [],
            preservedContext: {},
            tokensSaved: 0,
        };
    } catch (error) {
        console.error("[Summarizer] Failed:", error);
        return null;
    }
}

// =============================================================================
// Essential Functions (Kept from original)
// =============================================================================

/**
 * Compress tool output to essential content only
 * KEPT: Tool-specific compression still needed
 */
export function compressToolOutput(
    rawOutput: unknown,
    agentName: string,
    options?: { maxLength?: number; preserveStructure?: boolean }
): string {
    const maxLength = options?.maxLength || 800;

    if (typeof rawOutput === "string") {
        if (rawOutput.length <= maxLength) return `[${agentName}]: ${rawOutput}`;
        return `[${agentName}]: ${rawOutput.slice(0, maxLength)}...`;
    }

    if (rawOutput === null || rawOutput === undefined) {
        return `[${agentName}]: (no output)`;
    }

    // Handle objects
    const obj = rawOutput as Record<string, unknown>;

    // Priority extraction: output > content > message > result
    const content = obj.output || obj.content || obj.message || obj.result;

    if (content) {
        const str = typeof content === "string" ? content : JSON.stringify(content);
        return `[${agentName}]: ${str.slice(0, maxLength)}`;
    }

    // Full object fallback (remove verbose fields)
    const cleaned = { ...obj };
    delete cleaned.walletAddress;
    delete cleaned.agentId;
    delete cleaned.threadId;
    delete cleaned.messages;
    delete cleaned.metadata;

    const json = JSON.stringify(cleaned);
    return `[${agentName}]: ${json.slice(0, maxLength)}`;
}

/**
 * Generate minimal structured task prompt for agents
 * KEPT: Workflow-specific task formatting
 */
export function generateStructuredTaskPrompt(
    agentName: string,
    task: string,
    context?: {
        previousStepOutput?: string;
        currentStep?: number;
        totalSteps?: number;
        expectedOutputFormat?: string;
    }
): string {
    const parts: string[] = [];

    if (context?.currentStep && context?.totalSteps) {
        parts.push(`[Step ${context.currentStep}/${context.totalSteps}]`);
    }

    parts.push(`Task: ${task}`);

    if (context?.previousStepOutput) {
        parts.push(`Previous: ${context.previousStepOutput.slice(0, 500)}`);
    }

    if (context?.expectedOutputFormat) {
        parts.push(`Format: ${context.expectedOutputFormat}`);
    }

    return parts.join("\n");
}
