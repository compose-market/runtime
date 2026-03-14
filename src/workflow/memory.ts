/**
 * Workflow Memory Module - Mem0 Platform API Integration
 * 
 * Uses direct fetch to Mem0 Platform API (SDK is browser-only)
 * 
 * Memory Priority Matrix: user_id > agent_id > run_id
 * 1. user_id: User-specific preferences and context (highest priority)
 * 2. agent_id: Agent/Workflow execution patterns and learnings
 * 3. run_id: Current execution context (lowest priority, most specific)
 */

// =============================================================================
// Configuration - Mem0 Platform API (Direct fetch, no SDK)
// =============================================================================

import { buildApiInternalHeaders, requireApiInternalUrl } from "../auth.js";

const MEM0_API_KEY = process.env.MEM0_API_KEY;
const MEM0_API_URL = "https://api.mem0.ai/v1";

if (!MEM0_API_KEY) {
    console.warn("[mem0] MEM0_API_KEY not found. Memory features will be disabled.");
}

/**
 * Check if Mem0 memory service is available
 * Components should check this before attempting memory operations
 */
export function isMem0Available(): boolean {
    return Boolean(MEM0_API_KEY);
}

// =============================================================================
// Centralized Mem0 API Fetch Helper
// =============================================================================

/**
 * Centralized fetch wrapper for all Mem0 Platform API calls.
 * Reduces boilerplate and ensures consistent error handling.
 * 
 * @param endpoint - API endpoint (e.g., "/memories/", "/memories/search/")
 * @param method - HTTP method
 * @param body - Request body (for POST/PUT)
 */
async function mem0Fetch<T>(
    endpoint: string,
    method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
    body?: object
): Promise<T | null> {
    if (!MEM0_API_KEY) return null;

    try {
        const options: RequestInit = {
            method,
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Token ${MEM0_API_KEY}`,
            },
        };
        if (body && method !== "GET") {
            options.body = JSON.stringify(body);
        }

        const response = await fetch(`${MEM0_API_URL}${endpoint}`, options);
        if (!response.ok) {
            console.error(`[mem0] ${method} ${endpoint} failed: ${response.status}`);
            return null;
        }
        return await response.json() as T;
    } catch (error) {
        console.error(`[mem0] ${method} ${endpoint} error:`, error);
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

// NOTE: SLIDING_WINDOW_SIZE and getDynamicThresholdPercent moved to context.ts
// Import from context.ts if needed

// =============================================================================
// Memory Priority Matrix Configuration
// =============================================================================


interface MemoryContext {
    user_id?: string;      // Priority 1: User context
    agent_id: string;      // Priority 2: Agent/Workflow context
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
    const result = await mem0Fetch<MemoryItem[] | { memories: MemoryItem[] }>("/memories/", "POST", {
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
    });

    if (!result) return [];
    return Array.isArray(result) ? result : result.memories || [];
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
    // Build V2 filters with priority
    const filterConditions: unknown[] = [];
    if (params.agent_id) filterConditions.push({ agent_id: params.agent_id });
    if (params.user_id) filterConditions.push({ user_id: params.user_id });
    if (params.run_id) filterConditions.push({ run_id: params.run_id });

    const data = await mem0Fetch<{ memories?: MemoryItem[]; results?: MemoryItem[]; entities?: GraphMemoryResult['entities']; relations?: GraphMemoryResult['relations'] }>(
        "/memories/search/", "POST", {
        query: params.query,
        agent_id: params.agent_id,
        user_id: params.user_id,
        limit: params.limit || 10,
        filters: filterConditions.length > 0 ? { AND: filterConditions } : params.filters,
        enable_graph: true,
        rerank: params.options?.rerank ?? true,
        keyword_search: params.options?.keyword_search ?? true,
        filter_memories: params.options?.filter_memories ?? true,
    }
    );

    if (!data) return { memories: [], entities: [], relations: [] };
    return {
        memories: data.memories || data.results || [],
        entities: data.entities || [],
        relations: data.relations || [],
    };
}

/**
 * Get all memories for a context
 */
export async function getAllMemories(params: {
    agent_id: string;
    user_id?: string;
    run_id?: string;
}): Promise<MemoryItem[]> {
    // Build query string for GET request
    const queryParams = new URLSearchParams();
    if (params.agent_id) queryParams.set("agent_id", params.agent_id);
    if (params.user_id) queryParams.set("user_id", params.user_id);

    const data = await mem0Fetch<{ memories?: MemoryItem[]; results?: MemoryItem[] }>(
        `/memories/?${queryParams.toString()}`, "GET"
    );
    return data?.memories || data?.results || [];
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
        agent_id: workflowId, // workflowId is already "workflow-<walletAddress>"
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
 * Perform SAFE memory wipe with context preservation
 * 
 * Safe-wipe pattern:
 * 1. Compress current conversation into summary using the coordinator model
 * 2. Store summary with Mem0 graph memory (entities + relations extracted)
 * 3. Return [CONTEXT REFRESHED] marker for reducer state reset
 * 
 * This ensures NO information is lost - it's compressed and stored in graph memory
 * for later retrieval while freeing up context window space.
 * 
 * @param coordinatorModel - The coordinator model selected at mint time
 */
export async function performSafeWipe(
    workflowId: string,
    runId: string,
    coordinatorModel: string,  // from coordinatorModels list
    currentContext: {
        goal: string;
        completedActions: string[];
        lastOutcome: string;
        agentSummaries: Record<string, string>;
        messageCount?: number;
    },
    userId?: string
): Promise<{
    summary: string;
    marker: string;
    memoryId?: string;
    entitiesExtracted: number;
    tokensSaved: number;
} | null> {
    // Build comprehensive summary prompt
    const agentSummaryText = Object.entries(currentContext.agentSummaries)
        .map(([agent, summary]) => `- ${agent}: ${summary}`)
        .join("\n");

    const summaryPrompt = `Summarize this workflow execution into a concise paragraph that preserves all critical information:

## Workflow Goal
${currentContext.goal}

## Actions Completed
${currentContext.completedActions.join(", ")}

## Agent Outputs
${agentSummaryText || "No agent summaries available"}

## Last Outcome
${currentContext.lastOutcome}

Create a summary that:
1. Captures the key facts and decisions made
2. Notes any important entities (users, tools, data sources)
3. Preserves information needed for future context recovery
4. Is concise but complete (max 200 words)`;

    try {
        // Use the coordinator model (selected at mint time, from coordinatorModels)
        const response = await fetch(`${requireApiInternalUrl()}/api/inference`, {
            method: "POST",
            headers: buildApiInternalHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({
                model: coordinatorModel,  // User-selected coordinator model
                messages: [{ role: "user", content: summaryPrompt }],
                temperature: 0.2,
                max_tokens: 500,
            }),
        });

        const data = await response.json();
        const summary = data.choices?.[0]?.message?.content || currentContext.lastOutcome;

        // 2. Store summary in Mem0 graph memory with entity extraction
        const memories = await addMemoryWithGraph({
            messages: [
                { role: "system", content: `Context wipe summary for workflow ${workflowId}` },
                { role: "assistant", content: summary },
            ],
            agent_id: workflowId, // workflowId is already "workflow-<walletAddress>"
            user_id: userId,
            run_id: runId,
            metadata: {
                type: "context_wipe_summary",
                goal: currentContext.goal,
                actionCount: currentContext.completedActions.length,
                timestamp: Date.now(),
            },
        });

        // Count entities extracted from graph memory
        const entitiesExtracted = memories.reduce(
            (sum, m) => sum + (m.relations?.length || 0),
            0
        );

        // Estimate tokens saved (rough: 4 chars per token)
        const originalTokens = currentContext.completedActions.join("").length / 4;
        const summaryTokens = summary.length / 4;
        const tokensSaved = Math.max(0, Math.round(originalTokens - summaryTokens));

        console.log(
            `[SafeWipe] Compressed ${currentContext.completedActions.length} actions into ${Math.round(summaryTokens)} tokens, saved ~${tokensSaved} tokens`
        );

        // 3. Return marker for reducer reset
        return {
            summary,
            marker: "[CONTEXT REFRESHED]",
            memoryId: memories[0]?.id,
            entitiesExtracted,
            tokensSaved,
        };
    } catch (error) {
        console.error("[SafeWipe] Failed:", error);
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
        agent_id: `${workflowId}-patterns`, // workflowId already has workflow- prefix
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
        agent_id: `${workflowId}-patterns`, // workflowId already has workflow- prefix
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
        agent_id: workflowId, // workflowId is already "workflow-<walletAddress>"
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

        const response = await fetch(`${requireApiInternalUrl()}/api/inference`, {
            method: "POST",
            headers: buildApiInternalHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({
                model: "nvidia/nemotron-3-nano-30b-a3b",
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
            agent_id: workflowId, // workflowId is already "workflow-<walletAddress>"
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

/**
 * Execution learning from past runs
 */
export interface ExecutionLearning {
    step: number;
    agent: string;
    task: string;
    qualityScore: number;
    learnings: string[];
    tokenEfficiency: number;
    hasErrors: boolean;
    runId: string;
    timestamp: number;
}

/**
 * Advanced memory search with full Mem0 Platform features.
 * Exposes threshold, top_k, and enable_graph toggle for performance tuning.
 * 
 * @param params - Search parameters with advanced options
 */
export async function searchMemoryAdvanced(params: {
    query: string;
    agent_id: string;
    user_id?: string;
    run_id?: string;
    /** Minimum similarity score (0-1), memories below this are excluded */
    threshold?: number;
    /** Number of results to return (replaces limit) */
    top_k?: number;
    /** Toggle reranking per request for precision vs speed */
    rerank?: boolean;
    /** Toggle graph memory per request for performance */
    enable_graph?: boolean;
    /** V2 filters with AND/OR/NOT and operators (gt, lt, in, contains, etc.) */
    filters?: {
        AND?: Array<Record<string, unknown>>;
        OR?: Array<Record<string, unknown>>;
        NOT?: Array<Record<string, unknown>>;
        [key: string]: unknown;
    };
}): Promise<GraphMemoryResult> {
    if (!MEM0_API_KEY) {
        return { memories: [], entities: [], relations: [] };
    }

    try {
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
                run_id: params.run_id,
                // Advanced parameters
                limit: params.top_k || 10,
                threshold: params.threshold,
                rerank: params.rerank ?? true,
                enable_graph: params.enable_graph ?? true,
                keyword_search: true,
                filter_memories: true,
                // V2 filter syntax
                filters: params.filters,
            }),
        });

        if (!response.ok) {
            console.error(`[mem0] Advanced search failed: ${response.status}`);
            return { memories: [], entities: [], relations: [] };
        }

        const data = await response.json();
        return {
            memories: data.memories || data.results || (Array.isArray(data) ? data : []),
            entities: data.entities || [],
            relations: data.relations || [],
        };
    } catch (error) {
        console.error("[mem0] Advanced search failed:", error);
        return { memories: [], entities: [], relations: [] };
    }
}

/**
 * Get execution learnings for a specific agent or task type from past runs.
 * Uses Mem0's V2 metadata filtering instead of parsing JSON from text.
 * 
 * @param agentId - The workflow wallet address (agent_id for Mem0)
 * @param query - Description of the current task for semantic matching
 * @param options - Filter options (agentName, successOnly, limit)
 */
export async function getExecutionLearnings(
    agentId: string,
    query: string,
    options?: {
        agentName?: string;
        successOnly?: boolean;
        limit?: number;
    }
): Promise<ExecutionLearning[]> {
    // Build V2 filters using proper metadata operators
    const filterConditions: Array<Record<string, unknown>> = [
        { "metadata.type": { eq: "execution_learning" } },
    ];

    // Filter by agent name using metadata
    if (options?.agentName) {
        filterConditions.push({ "metadata.agent": { eq: options.agentName } });
    }

    // Filter by quality score for success-only queries
    if (options?.successOnly) {
        filterConditions.push({ "metadata.quality": { gte: 7 } });
        filterConditions.push({ "metadata.hasErrors": { eq: false } });
    }

    // Use advanced search with proper V2 filters
    const result = await searchMemoryAdvanced({
        query: `execution learning ${query}`,
        agent_id: agentId,
        top_k: options?.limit || 10,
        rerank: true,
        enable_graph: false, // Performance: skip graph for execution queries
        filters: { AND: filterConditions },
    });

    // Map memory items to ExecutionLearning type using metadata
    // Mem0 stores metadata directly - no need to parse JSON from text
    return result.memories.map(mem => ({
        step: (mem.metadata?.step as number) || 0,
        agent: (mem.metadata?.agent as string) || "unknown",
        task: mem.memory || "",
        qualityScore: (mem.metadata?.quality as number) || 0,
        learnings: [], // Learnings are in graph relations, not parsed from text
        tokenEfficiency: (mem.metadata?.tokenEfficiency as number) ?? 1,
        hasErrors: (mem.metadata?.hasErrors as boolean) ?? false,
        runId: mem.run_id || "",
        timestamp: mem.created_at ? new Date(mem.created_at).getTime() : Date.now(),
    }));
}

/**
 * Get memories related to a specific entity via graph relations.
 * Uses Mem0's graph memory to traverse entity relationships.
 * 
 * @param entityName - Name of the entity to find relations for
 * @param relation - Type of relation to follow (e.g., "used", "created", "depends_on")
 * @param agent_id - Workflow wallet address for scoping
 */
export async function getRelatedMemories(
    entityName: string,
    relation: string,
    agent_id: string
): Promise<MemoryItem[]> {
    // Search with entity name and enable graph for relation extraction
    const result = await searchMemoryAdvanced({
        query: entityName,
        agent_id,
        enable_graph: true,
        rerank: true,
        top_k: 20,
    });

    // Filter to memories that have the specified relation
    return result.memories.filter(mem => {
        const relations = mem.relations || [];
        return relations.some(
            r => (r.source === entityName || r.target === entityName) &&
                r.relation.toLowerCase().includes(relation.toLowerCase())
        );
    });
}

/**
 * Get agent reliability score based on past execution learnings.
 * Uses proper Mem0 metadata filtering for accurate statistics.
 */
export async function getAgentReliability(
    workflowWallet: string,
    agentName: string
): Promise<{ avgQuality: number; successRate: number; avgTokenEfficiency: number; totalRuns: number }> {
    const learnings = await getExecutionLearnings(workflowWallet, agentName, {
        agentName,
        limit: 50,
    });

    if (learnings.length === 0) {
        // Return optimistic defaults for new agents
        return { avgQuality: 7, successRate: 0.8, avgTokenEfficiency: 1, totalRuns: 0 };
    }

    const totalRuns = learnings.length;
    const avgQuality = learnings.reduce((sum, l) => sum + l.qualityScore, 0) / totalRuns;
    const successCount = learnings.filter(l => l.qualityScore >= 7 && !l.hasErrors).length;
    const successRate = successCount / totalRuns;
    const avgTokenEfficiency = learnings.reduce((sum, l) => sum + l.tokenEfficiency, 0) / totalRuns;

    return { avgQuality, successRate, avgTokenEfficiency, totalRuns };
}

// Mem0 automatically extracts entities and facts when enable_graph: true.
// Use custom_prompt in addMemoryWithGraph() to customize extraction behavior.
