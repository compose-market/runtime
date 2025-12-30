/**
 * Manowar Memory Module - Mem0 Platform API Integration
 * 
 * Uses direct fetch to Mem0 Platform API (SDK is browser-only)
 * 
 * Memory Priority Matrix: user_id > agent_id > run_id
 * 1. user_id: User-specific preferences and context (highest priority)
 * 2. agent_id: Agent/Manowar execution patterns and learnings
 * 3. run_id: Current execution context (lowest priority, most specific)
 */

// =============================================================================
// Configuration - Mem0 Platform API (Direct fetch, no SDK)
// =============================================================================

const MEM0_API_KEY = process.env.MEM0_API_KEY;
const MEM0_API_URL = "https://api.mem0.ai/v1";
const LAMBDA_API_URL = process.env.LAMBDA_API_URL || "https://api.compose.market";

if (!MEM0_API_KEY) {
    console.warn("[mem0] MEM0_API_KEY not found. Memory features will be disabled.");
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
export const TOKEN_THRESHOLD_PERCENT = 60; // Legacy fallback only

/**
 * Get dynamic context threshold based on model's effective window
 * 
 * Uses the model's actual contextLength from registry, NOT hardcoded values.
 * Returns threshold as a percentage of context that should trigger cleanup.
 * 
 * Formula: Base 55% + log-scaled bonus for larger contexts
 * This gives a continuous curve, not arbitrary breakpoints.
 * 
 * @param effectiveWindow - The model's effective context window (from modelSpec.effectiveWindow)
 */
export function getDynamicThresholdPercent(effectiveWindow: number): number {
    // Base threshold: 55%
    // Bonus: logarithmic scale that adds up to 15% for very large contexts
    // This avoids hardcoded breakpoints - purely dynamic based on actual model capacity
    const BASE = 55;
    const MAX_BONUS = 15;

    // Log scale: 32k => 0 bonus, 1M => ~10-12% bonus, 4M => ~15% bonus
    const logScale = Math.log10(Math.max(effectiveWindow, 32000) / 32000);
    const bonus = Math.min(MAX_BONUS, logScale * 6);

    return Math.min(70, BASE + bonus); // Cap at 70%
}

// =============================================================================
// Memory Priority Matrix Configuration
// =============================================================================

interface MemoryContext {
    user_id?: string;      // Priority 1: User context
    agent_id: string;      // Priority 2: Agent/Manowar context
    run_id?: string;       // Priority 3: Execution context
}

// =============================================================================
// Mem0 Platform API - Direct Fetch (No SDK - SDK is browser-only)
// =============================================================================

/**
 * Add memory with native graph extraction
 * Priority: user_id > agent_id > run_id
 */
export async function addMemoryWithGraph(params: {
    messages: Array<{ role: string; content: string }>;
    agent_id: string;
    user_id?: string;
    run_id: string;
    metadata?: Record<string, unknown>;
}): Promise<MemoryItem[]> {
    if (!MEM0_API_KEY) {
        console.warn("[mem0] API key not configured, skipping memory add");
        return [];
    }

    try {
        const response = await fetch(`${MEM0_API_URL}/memories/`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Token ${MEM0_API_KEY}`,
            },
            body: JSON.stringify({
                messages: params.messages,
                user_id: params.user_id,       // Priority 1
                agent_id: params.agent_id,     // Priority 2
                run_id: params.run_id,         // Priority 3
                metadata: {
                    ...params.metadata,
                    run_id: params.run_id,
                    timestamp: Date.now(),
                },
                enable_graph: true,
            }),
        });

        if (!response.ok) {
            console.error(`[mem0] Add failed: ${response.status}`);
            return [];
        }

        const result = await response.json();
        return Array.isArray(result) ? result : result.memories || [result];
    } catch (error) {
        console.error("[mem0] Failed to add memory:", error);
        return [];
    }
}

/**
 * Search memories with native advanced retrieval
 * Priority: user_id > agent_id > run_id
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
    if (!MEM0_API_KEY) {
        return { memories: [], entities: [], relations: [] };
    }

    try {
        // Build V2 filters with priority
        const filterConditions: unknown[] = [];
        if (params.agent_id) filterConditions.push({ agent_id: params.agent_id });
        if (params.user_id) filterConditions.push({ user_id: params.user_id });
        if (params.run_id) filterConditions.push({ run_id: params.run_id });

        const response = await fetch(`${MEM0_API_URL}/memories/search/`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Token ${MEM0_API_KEY}`,
            },
            body: JSON.stringify({
                query: params.query,
                agent_id: params.agent_id,
                user_id: params.user_id,
                limit: params.limit || 10,
                filters: filterConditions.length > 0 ? { AND: filterConditions } : params.filters,
                enable_graph: true,
                rerank: params.options?.rerank ?? true,
            }),
        });

        if (!response.ok) {
            console.error(`[mem0] Search failed: ${response.status}`);
            return { memories: [], entities: [], relations: [] };
        }

        const data = await response.json();
        return {
            memories: data.memories || data.results || (Array.isArray(data) ? data : []),
            entities: data.entities || [],
            relations: data.relations || [],
        };
    } catch (error) {
        console.error("[mem0] Failed to search memory:", error);
        return { memories: [], entities: [], relations: [] };
    }
}

/**
 * Get all memories for a context
 */
export async function getAllMemories(params: {
    agent_id: string;
    user_id?: string;
    run_id?: string;
}): Promise<MemoryItem[]> {
    if (!MEM0_API_KEY) return [];

    try {
        const url = new URL(`${MEM0_API_URL}/memories/`);
        if (params.agent_id) url.searchParams.set("agent_id", params.agent_id);
        if (params.user_id) url.searchParams.set("user_id", params.user_id);

        const response = await fetch(url.toString(), {
            method: "GET",
            headers: {
                "Authorization": `Token ${MEM0_API_KEY}`,
            },
        });

        if (!response.ok) return [];
        const data = await response.json();
        return data.memories || data.results || [];
    } catch {
        return [];
    }
}

// =============================================================================
// Hierarchical Memory (Priority Matrix Implementation)
// =============================================================================

/**
 * Get contextual memory with priority cascade
 * Searches: user preferences → agent patterns → execution context
 */
export async function getContextualMemory(
    query: string,
    context: MemoryContext,
    options?: { limit?: number }
): Promise<{ memories: MemoryItem[]; source: 'user' | 'agent' | 'run' }> {
    // Priority 1: User-specific memories
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

    // Priority 2: Agent-level patterns
    const agentMemories = await searchMemoryWithGraph({
        query,
        agent_id: context.agent_id,
        limit: options?.limit || 5,
    });
    if (agentMemories.memories.length > 0) {
        return { memories: agentMemories.memories, source: 'agent' };
    }

    // Priority 3: Run-specific context
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
// Memory Operations
// =============================================================================

/**
 * Optimize with graph - uses Mem0's native entity extraction
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
        agent_id: workflowId, // workflowId is already "manowar-<walletAddress>"
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
                model: "nvidia/nemotron-3-nano-30b-a3b:free",
                messages: [{ role: "user", content: summaryPrompt }],
                temperature: 0.3,
            }),
        });

        const data = await response.json();
        const summary = data.choices?.[0]?.message?.content || currentContext.lastOutcome;

        const memories = await addMemoryWithGraph({
            messages: [
                { role: "system", content: `Memory wipe summary for ${workflowId}` },
                { role: "assistant", content: summary },
            ],
            agent_id: workflowId, // workflowId is already "manowar-<walletAddress>"
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
// Solution Pattern Storage
// =============================================================================

export async function findSimilarSolutions(
    workflowId: string,
    taskDescription: string,
    options?: { limit?: number; outcomeFilter?: "success" | "partial" | "failure" }
): Promise<SolutionPattern[]> {
    const result = await searchMemoryWithGraph({
        query: taskDescription,
        agent_id: `${workflowId}-patterns`, // workflowId already has manowar- prefix
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
        agent_id: `${workflowId}-patterns`, // workflowId already has manowar- prefix
        run_id: runId,
        metadata: {
            type: "solution_pattern",
            task: pattern.task,
            toolSequence: pattern.toolSequence,
            outcome: pattern.outcome,
            confidence: pattern.confidence,
        },
    });

    return memories.length > 0;
}

// =============================================================================
// Graph Insights
// =============================================================================

export async function getGraphInsights(
    workflowId: string,
    runId: string,
    query: string
): Promise<{ entities: Array<{ name: string; type: string }>; topRelations: Array<{ source: string; target: string; relation: string }> }> {
    const result = await searchMemoryWithGraph({
        query,
        agent_id: workflowId, // workflowId is already "manowar-<walletAddress>"
        run_id: runId,
        limit: 20,
        options: { rerank: true },
    });

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
// Context Summarization
// =============================================================================

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

        await addMemoryWithGraph({
            messages: [
                { role: "system", content: `Context summary for ${workflowId}` },
                { role: "assistant", content: parsed.summary },
            ],
            agent_id: workflowId, // workflowId is already "manowar-<walletAddress>"
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
// Essential Functions
// =============================================================================

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

    const obj = rawOutput as Record<string, unknown>;
    const content = obj.output || obj.content || obj.message || obj.result;

    if (content) {
        const str = typeof content === "string" ? content : JSON.stringify(content);
        return `[${agentName}]: ${str.slice(0, maxLength)}`;
    }

    const cleaned = { ...obj };
    delete cleaned.walletAddress;
    delete cleaned.agentId;
    delete cleaned.threadId;
    delete cleaned.messages;
    delete cleaned.metadata;

    const json = JSON.stringify(cleaned);
    return `[${agentName}]: ${json.slice(0, maxLength)}`;
}

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
