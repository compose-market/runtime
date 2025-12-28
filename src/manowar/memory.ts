/**
 * Manowar Memory Module - Mem0 Graph Memory Integration
 * 
 * Implements the memory management layer for continuous workflows:
 * - Mem0GraphOptimizer: Entity extraction and relationship mapping
 * - MemoryWipe: Intelligent context cleanup with summarization
 * - Summarizer: Context compression using Kimi K2 Thinking model
 * - Solution Pattern Storage: Workflow learning and retrieval
 * 
 * All operations use:
 * - enable_graph: true for relationship tracking (Mem0 Pro)
 * - run_id: Unique per execution to prevent cross-contamination
 */

import type { BaseMessage } from "@langchain/core/messages";

// =============================================================================
// Configuration
// =============================================================================

const LAMBDA_API_URL = process.env.LAMBDA_API_URL || "https://api.compose.market";

// Default model for summarization (Kimi K2 for superior thinking capability)
const SUMMARIZER_MODEL = "moonshotai/kimi-k2-thinking";

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

// =============================================================================
// Core Memory Operations (Graph-Enabled)
// =============================================================================

/**
 * Add memory with graph extraction enabled
 * Always includes run_id for execution isolation
 */
export async function addMemoryWithGraph(params: {
    messages: Array<{ role: string; content: string }>;
    agent_id: string;
    user_id?: string;
    run_id: string;  // Required for execution isolation
    metadata?: Record<string, unknown>;
}): Promise<MemoryItem[]> {
    try {
        const response = await fetch(`${LAMBDA_API_URL}/api/memory/add`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                messages: params.messages,
                agent_id: params.agent_id,
                user_id: params.user_id,
                run_id: params.run_id,
                metadata: {
                    ...params.metadata,
                    run_id: params.run_id,  // Also in metadata for filtering
                    timestamp: Date.now(),
                },
                enable_graph: true,  // Always enable for Manowar
            }),
        });

        if (!response.ok) {
            console.error(`[Mem0Graph] Add failed: ${response.status}`);
            return [];
        }

        const result = await response.json();
        return Array.isArray(result) ? result : result.memories || [result];
    } catch (error) {
        console.error("[Mem0Graph] Failed to add memory:", error);
        return [];
    }
}

/**
 * Search memories with graph relations
 * Filters by run_id to get execution-specific context
 */
export async function searchMemoryWithGraph(params: {
    query: string;
    agent_id: string;
    user_id?: string;
    run_id?: string;  // Optional - if not provided, searches across all runs
    limit?: number;
    filters?: Record<string, unknown>;
}): Promise<GraphMemoryResult> {
    try {
        const searchFilters = {
            ...params.filters,
        };

        // Add run_id filter if provided
        if (params.run_id) {
            searchFilters.run_id = params.run_id;
        }

        const response = await fetch(`${LAMBDA_API_URL}/api/memory/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                query: params.query,
                agent_id: params.agent_id,
                user_id: params.user_id,
                limit: params.limit || 10,
                filters: searchFilters,
                enable_graph: true,
                rerank: true,  // Use reranking for better relevance
            }),
        });

        if (!response.ok) {
            console.error(`[Mem0Graph] Search failed: ${response.status}`);
            return { memories: [], entities: [], relations: [] };
        }

        const data = await response.json();
        return {
            memories: data.memories || data.results || (Array.isArray(data) ? data : []),
            entities: data.entities || [],
            relations: data.relations || [],
        };
    } catch (error) {
        console.error("[Mem0Graph] Failed to search memory:", error);
        return { memories: [], entities: [], relations: [] };
    }
}

// =============================================================================
// Mem0GraphOptimizer: Entity Extraction and Storage
// =============================================================================

/**
 * Extract entities and relationships from content and store in graph memory
 * This is the core of the Mem0GraphOptimizer sub-agent
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
            {
                role: "system",
                content: `Workflow: ${workflowId} | Goal: ${context.goal} | Action: ${context.actionType || "execute"}`
            },
            { role: "assistant", content },
        ],
        agent_id: `manowar-${workflowId}`,
        user_id: context.userId,
        run_id: runId,
        metadata: {
            type: "graph_optimization",
            workflow_id: workflowId,
            agent_id: context.agentId,
            action_type: context.actionType,
        },
    });

    // Count entities from returned memories
    const entitiesExtracted = memories.filter(m => m.relations?.length).length;
    const relationsCreated = memories.reduce(
        (sum, m) => sum + (m.relations?.length || 0),
        0
    );

    console.log(
        `[Mem0GraphOptimizer] Processed: entities=${entitiesExtracted} relations=${relationsCreated}`
    );

    return {
        success: memories.length > 0,
        entitiesExtracted,
        relationsCreated,
    };
}

// =============================================================================
// Summarizer: Context Compression using Kimi K2 Thinking
// =============================================================================

/**
 * Summarize workflow state for context continuity
 * Uses Kimi K2 Thinking for superior reasoning about what to preserve
 */
export async function summarizeForContinuity(
    workflowId: string,
    runId: string,
    context: {
        goal: string;
        completedActions: string[];
        lastOutcome: string;
        agentSummaries: Record<string, string>;
        tokenMetrics?: Record<string, { total: number }>;
    },
    model: string = SUMMARIZER_MODEL
): Promise<ContextSummary | null> {
    try {
        const tokenInfo = context.tokenMetrics
            ? `\nTOKEN USAGE:\n${Object.entries(context.tokenMetrics)
                .map(([k, v]) => `- ${k}: ${v.total} tokens`)
                .join("\n")}`
            : "";

        const prompt = `You are an expert at context compression for continuous AI workflows.

WORKFLOW GOAL: ${context.goal}

COMPLETED ACTIONS (in order):
${context.completedActions.map((a, i) => `${i + 1}. ${a}`).join("\n") || "None yet"}

LAST OUTCOME:
${context.lastOutcome}

AGENT CONTRIBUTIONS:
${Object.entries(context.agentSummaries)
                .map(([k, v]) => `- ${k}: ${v}`)
                .join("\n") || "None recorded"}
${tokenInfo}

TASK: Create a compressed summary that preserves all critical context needed for the workflow to continue. Identify:
1. The essential state that MUST be preserved
2. Key facts that inform next decisions
3. Any patterns or learnings from the actions taken

Respond with valid JSON only:
{
  "summary": "A clear, dense summary of workflow state (2-4 sentences)",
  "keyFacts": ["fact1", "fact2", ...],
  "preservedContext": { "key": "value" for any structured data to preserve }
}`;

        const response = await fetch(`${LAMBDA_API_URL}/api/inference`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model,
                messages: [
                    {
                        role: "system",
                        content: "You are a context summarization agent. Respond ONLY with valid JSON, no markdown."
                    },
                    { role: "user", content: prompt },
                ],
                temperature: 0.3,  // Lower temp for consistent summarization
            }),
        });

        if (!response.ok) {
            console.error(`[Summarizer] Inference failed: ${response.status}`);
            return null;
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || data.content || "";

        // Extract JSON from response (handle potential markdown wrapping)
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            console.error("[Summarizer] No JSON found in response");
            return null;
        }

        const parsed = JSON.parse(jsonMatch[0]);

        // Store summary in memory for retrieval
        await addMemoryWithGraph({
            messages: [
                { role: "system", content: `Context summary for workflow ${workflowId}` },
                { role: "assistant", content: `Summary: ${parsed.summary}\n\nKey Facts:\n${parsed.keyFacts.map((f: string) => `- ${f}`).join("\n")}` },
            ],
            agent_id: `manowar-${workflowId}`,
            run_id: runId,
            metadata: {
                type: "context_summary",
                workflow_id: workflowId,
                key_facts_count: parsed.keyFacts.length,
            },
        });

        return {
            summary: parsed.summary,
            keyFacts: parsed.keyFacts || [],
            preservedContext: parsed.preservedContext || {},
            tokensSaved: 0,  // Will be calculated by caller
        };
    } catch (error) {
        console.error("[Summarizer] Failed:", error);
        return null;
    }
}

// =============================================================================
// MemoryWipe: Intelligent Context Cleanup
// =============================================================================

/**
 * Perform memory wipe with intelligent summarization
 * Stores summary in Mem0 before wiping, returns refreshed context
 */
export async function performMemoryWipe(
    workflowId: string,
    runId: string,
    currentMessages: BaseMessage[],
    context: {
        goal: string;
        completedActions: string[];
        agentSummaries: Record<string, string>;
        tokenMetrics?: Record<string, { total: number }>;
    },
    model: string = SUMMARIZER_MODEL
): Promise<WipeResult | null> {
    // Extract last outcome from messages
    const assistantMessages = currentMessages.filter(m => m._getType?.() === "ai" || m._getType?.() === "assistant");
    const lastOutcome = assistantMessages.length > 0
        ? String(assistantMessages[assistantMessages.length - 1].content)
        : "No outcome recorded";

    // Step 1: Create comprehensive summary before wipe
    console.log(`[MemoryWipe] Starting wipe for workflow ${workflowId}, ${currentMessages.length} messages`);

    const summary = await summarizeForContinuity(workflowId, runId, {
        ...context,
        lastOutcome,
    }, model);

    if (!summary) {
        console.error("[MemoryWipe] Failed to summarize before wipe");
        return null;
    }

    // Step 2: Store the wipe event in memory for audit trail
    const memories = await addMemoryWithGraph({
        messages: [
            { role: "system", content: `Memory wipe performed for workflow ${workflowId}` },
            {
                role: "assistant",
                content: `WIPE SUMMARY:\n${summary.summary}\n\nPRESERVED FACTS:\n${summary.keyFacts.map(f => `- ${f}`).join("\n")}\n\nWIPED ${currentMessages.length} messages`
            },
        ],
        agent_id: `manowar-${workflowId}`,
        run_id: runId,
        metadata: {
            type: "memory_wipe",
            workflow_id: workflowId,
            wiped_message_count: currentMessages.length,
            preserved_facts_count: summary.keyFacts.length,
        },
    });

    console.log(`[MemoryWipe] Completed. Preserved ${summary.keyFacts.length} facts, wiped ${currentMessages.length} messages`);

    return {
        previousSummary: summary.summary,
        preservedFacts: summary.keyFacts,
        wipedMessageCount: currentMessages.length,
        memoryId: memories[0]?.id,
    };
}

/**
 * Retrieve the most recent summary for a workflow run
 * Used when resuming after a wipe
 */
export async function retrieveLatestSummary(
    workflowId: string,
    runId: string
): Promise<ContextSummary | null> {
    const result = await searchMemoryWithGraph({
        query: "context summary memory wipe",
        agent_id: `manowar-${workflowId}`,
        run_id: runId,
        limit: 1,
        filters: { type: "context_summary" },
    });

    if (result.memories.length === 0) {
        return null;
    }

    const memory = result.memories[0];
    // Parse the stored summary format
    const content = memory.memory || "";
    const summaryMatch = content.match(/Summary: (.*?)(?:\n|$)/);
    const factsMatch = content.match(/Key Facts:\n([\s\S]*?)$/);

    return {
        summary: summaryMatch?.[1] || content,
        keyFacts: factsMatch?.[1]?.split("\n").filter(l => l.startsWith("-")).map(l => l.slice(2)) || [],
        preservedContext: {},
        tokensSaved: 0,
    };
}

// =============================================================================
// Solution Pattern Storage (Workflow Learning)
// =============================================================================

/**
 * Save a successful (or failed) solution pattern for future reference
 */
export async function saveSolutionPattern(
    workflowId: string,
    runId: string,
    pattern: SolutionPattern,
    userId?: string
): Promise<boolean> {
    const memories = await addMemoryWithGraph({
        messages: [
            { role: "user", content: `Task: ${pattern.task}` },
            {
                role: "assistant",
                content: `Solution: ${pattern.toolSequence.join(" → ")}\nOutcome: ${pattern.outcome}${pattern.notes ? `\nNotes: ${pattern.notes}` : ""}\nConfidence: ${pattern.confidence}`
            },
        ],
        agent_id: `manowar-${workflowId}`,
        user_id: userId,
        run_id: runId,
        metadata: {
            type: "solution_pattern",
            outcome: pattern.outcome,
            tool_count: pattern.toolSequence.length,
            confidence: pattern.confidence,
        },
    });

    console.log(`[SolutionPattern] Saved: ${pattern.outcome} pattern with ${pattern.toolSequence.length} tools`);
    return memories.length > 0;
}

/**
 * Find similar solutions from historical patterns
 * Searches across all runs (not run-specific) for learning
 */
export async function findSimilarSolutions(
    workflowId: string,
    taskDescription: string,
    options?: {
        limit?: number;
        outcomeFilter?: "success" | "partial" | "failure";
    }
): Promise<SolutionPattern[]> {
    const filters: Record<string, unknown> = { type: "solution_pattern" };
    if (options?.outcomeFilter) {
        filters.outcome = options.outcomeFilter;
    }

    const result = await searchMemoryWithGraph({
        query: taskDescription,
        agent_id: `manowar-${workflowId}`,
        limit: options?.limit || 5,
        filters,
        // No run_id filter - we want cross-execution learning
    });

    return result.memories.map(m => {
        const content = m.memory || "";
        const taskMatch = content.match(/Task: (.*?)(?:\n|$)/);
        const solutionMatch = content.match(/Solution: (.*?)(?:\n|$)/);
        const outcomeMatch = content.match(/Outcome: (.*?)(?:\n|$)/);
        const confidenceMatch = content.match(/Confidence: ([\d.]+)/);

        return {
            task: taskMatch?.[1] || "",
            toolSequence: solutionMatch?.[1]?.split(" → ") || [],
            outcome: (outcomeMatch?.[1] || "success") as "success" | "partial" | "failure",
            confidence: parseFloat(confidenceMatch?.[1] || "0.5"),
        };
    });
}

// =============================================================================
// Utility: Get Graph Insights
// =============================================================================

/**
 * Get entity and relationship insights from the workflow's graph memory
 */
export async function getGraphInsights(
    workflowId: string,
    runId?: string
): Promise<{
    entities: Array<{ name: string; type: string; frequency: number }>;
    topRelations: Array<{ source: string; target: string; relation: string }>;
}> {
    const result = await searchMemoryWithGraph({
        query: "entities relationships patterns",
        agent_id: `manowar-${workflowId}`,
        run_id: runId,
        limit: 50,
    });

    // Aggregate entities by frequency
    const entityMap = new Map<string, { type: string; count: number }>();
    for (const entity of result.entities) {
        const key = entity.name.toLowerCase();
        const existing = entityMap.get(key);
        if (existing) {
            existing.count++;
        } else {
            entityMap.set(key, { type: entity.type, count: 1 });
        }
    }

    const entities = Array.from(entityMap.entries())
        .map(([name, data]) => ({ name, type: data.type, frequency: data.count }))
        .sort((a, b) => b.frequency - a.frequency);

    return {
        entities,
        topRelations: result.relations.slice(0, 20),
    };
}

// =============================================================================
// Token Optimization: Sliding Window with Summary
// =============================================================================

/**
 * Constants for sliding window optimization
 */
export const SLIDING_WINDOW_SIZE = 4;  // Keep last N messages
export const TOKEN_THRESHOLD_PERCENT = 60;  // Trigger compression at 60% of effective window
export const CHARS_PER_TOKEN = 4;  // Approximate characters per token

/**
 * Estimate token count from content using character-based approximation
 * More accurate than simple division for mixed content
 */
export function estimateTokenCount(content: string): number {
    if (!content) return 0;

    // JSON and code typically have more tokens per character
    const isJsonLike = content.startsWith('{') || content.startsWith('[');
    const multiplier = isJsonLike ? 3 : CHARS_PER_TOKEN;

    return Math.ceil(content.length / multiplier);
}

/**
 * Estimate total tokens from LangChain messages
 */
export function estimateMessagesTokens(messages: BaseMessage[]): number {
    return messages.reduce((sum, m) => {
        const content = String(m.content || '');
        // Add overhead for message structure
        return sum + estimateTokenCount(content) + 10;
    }, 0);
}

/**
 * Summarize older messages for sliding window context compression
 * Uses efficient local summarization without LLM when possible
 */
export async function summarizeMessagesForWindow(
    messages: BaseMessage[],
    workflowId: string,
    runId: string,
    options?: {
        useLLM?: boolean;
        model?: string;
        maxSummaryTokens?: number;
    }
): Promise<{
    summary: string;
    keyFacts: string[];
    tokensBefore: number;
    tokensAfter: number;
}> {
    const tokensBefore = estimateMessagesTokens(messages);

    // Extract essential content from each message
    const extractedContent: string[] = [];
    const keyFacts: string[] = [];

    for (const msg of messages) {
        const content = String(msg.content || '');
        const msgType = msg._getType?.() || 'unknown';

        if (msgType === 'human') {
            // User messages: keep full text, it's the goal
            extractedContent.push(`User: ${content.slice(0, 200)}`);
        } else if (msgType === 'ai') {
            // AI messages: extract conclusion only
            const conclusion = extractConclusion(content);
            if (conclusion) {
                extractedContent.push(`AI: ${conclusion}`);
            }
        } else if (msgType === 'tool') {
            // Tool messages: extract result only
            const result = extractToolResult(content);
            if (result) {
                extractedContent.push(`Tool: ${result}`);
                keyFacts.push(result);
            }
        }
    }

    // Build compressed summary
    const summary = extractedContent.join('\n');
    const tokensAfter = estimateTokenCount(summary);

    console.log(`[SlidingWindow] Compressed ${tokensBefore} tokens → ${tokensAfter} tokens (${Math.round((1 - tokensAfter / tokensBefore) * 100)}% reduction)`);

    // Store summary in memory for future retrieval
    await addMemoryWithGraph({
        messages: [
            { role: 'system', content: `Sliding window summary for ${workflowId}` },
            { role: 'assistant', content: summary },
        ],
        agent_id: `manowar-${workflowId}`,
        run_id: runId,
        metadata: {
            type: 'sliding_window_summary',
            tokens_before: tokensBefore,
            tokens_after: tokensAfter,
            message_count: messages.length,
        },
    });

    return {
        summary,
        keyFacts,
        tokensBefore,
        tokensAfter,
    };
}

/**
 * Extract conclusion/result from AI message content
 */
function extractConclusion(content: string): string {
    // If content is short, keep it
    if (content.length < 300) return content;

    // Look for conclusion patterns
    const conclusionPatterns = [
        /(?:in conclusion|to summarize|the result is|therefore|thus)[:\s]*(.*?)(?:\n\n|$)/is,
        /(?:answer|result|output)[:\s]*(.*?)(?:\n\n|$)/is,
        /(?:here's what|here is)[:\s]*(.*?)(?:\n\n|$)/is,
    ];

    for (const pattern of conclusionPatterns) {
        const match = content.match(pattern);
        if (match?.[1]) {
            return match[1].slice(0, 300).trim();
        }
    }

    // Fallback: take last paragraph or first 300 chars
    const paragraphs = content.split('\n\n');
    const lastPara = paragraphs[paragraphs.length - 1];

    return lastPara.length < 300 ? lastPara : content.slice(0, 300) + '...';
}

/**
 * Extract essential result from tool output
 */
function extractToolResult(content: string): string {
    // Try to parse as JSON first
    try {
        const parsed = JSON.parse(content);

        // Common patterns in tool responses
        if (parsed.output) return String(parsed.output).slice(0, 500);
        if (parsed.result) return String(parsed.result).slice(0, 500);
        if (parsed.content) return String(parsed.content).slice(0, 500);
        if (parsed.data) return typeof parsed.data === 'string'
            ? parsed.data.slice(0, 500)
            : JSON.stringify(parsed.data).slice(0, 500);
        if (parsed.messages?.length) {
            const lastMsg = parsed.messages[parsed.messages.length - 1];
            return String(lastMsg.content || '').slice(0, 500);
        }

        // Fallback: stringify but limit size
        return JSON.stringify(parsed).slice(0, 500);
    } catch {
        // Not JSON, return truncated
        return content.slice(0, 500);
    }
}

// =============================================================================
// Token Optimization: Tool Output Compression
// =============================================================================

/**
 * Compress tool output to essential content only
 * Removes duplicate data, metadata, and irrelevant fields
 */
export function compressToolOutput(
    rawOutput: unknown,
    agentName: string,
    options?: {
        maxLength?: number;
        preserveStructure?: boolean;
    }
): string {
    const maxLength = options?.maxLength || 800;

    // Handle string input
    if (typeof rawOutput === 'string') {
        // Try to parse as JSON
        try {
            const parsed = JSON.parse(rawOutput);
            return compressToolOutput(parsed, agentName, options);
        } catch {
            // Not JSON, compress as text
            return `[${agentName}]: ${rawOutput.slice(0, maxLength)}`;
        }
    }

    // Handle object input
    if (typeof rawOutput === 'object' && rawOutput !== null) {
        const obj = rawOutput as Record<string, unknown>;

        // Priority extraction order
        const essentialFields = ['output', 'result', 'content', 'data', 'answer', 'response'];

        for (const field of essentialFields) {
            if (obj[field]) {
                const value = obj[field];
                const extracted = typeof value === 'string'
                    ? value
                    : JSON.stringify(value);
                return `[${agentName}]: ${extracted.slice(0, maxLength)}`;
            }
        }

        // Handle messages array (common in agent responses)
        if (Array.isArray(obj.messages) && obj.messages.length > 0) {
            const lastMessage = obj.messages[obj.messages.length - 1];
            if (typeof lastMessage === 'object' && lastMessage.content) {
                return `[${agentName}]: ${String(lastMessage.content).slice(0, maxLength)}`;
            }
        }

        // Fallback: construct minimal summary
        const status = obj.success !== undefined
            ? (obj.success ? 'completed' : 'failed')
            : 'executed';
        const name = obj.name || agentName;

        // Get any text content
        const textContent = findTextContent(obj, maxLength - 100);

        return `[${name}] ${status}: ${textContent || 'Task completed'}`;
    }

    // Primitive types
    return `[${agentName}]: ${String(rawOutput).slice(0, maxLength)}`;
}

/**
 * Recursively find text content in object
 */
function findTextContent(obj: Record<string, unknown>, maxLength: number): string {
    const textFields = ['text', 'message', 'description', 'summary', 'body'];

    for (const field of textFields) {
        if (typeof obj[field] === 'string') {
            return obj[field] as string;
        }
    }

    // Look in nested objects
    for (const value of Object.values(obj)) {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            const nested = findTextContent(value as Record<string, unknown>, maxLength);
            if (nested) return nested.slice(0, maxLength);
        }
    }

    return '';
}

// =============================================================================
// Token Optimization: Memory-Based Context Retrieval
// =============================================================================

/**
 * Get relevant context from memory instead of replaying full message history
 * This is the Mem0-style 90% token savings approach
 */
export async function getRelevantContextFromMemory(
    workflowId: string,
    runId: string,
    currentGoal: string,
    options?: {
        limit?: number;
        includePatterns?: boolean;
        userId?: string;
    }
): Promise<{
    contextString: string;
    memories: MemoryItem[];
    tokensUsed: number;
}> {
    const limit = options?.limit || 5;

    // Parallel fetch: current run context + relevant patterns
    const [runContext, patterns] = await Promise.all([
        searchMemoryWithGraph({
            query: currentGoal,
            agent_id: `manowar-${workflowId}`,
            run_id: runId,
            limit: limit,
        }),
        options?.includePatterns
            ? findSimilarSolutions(workflowId, currentGoal, { limit: 3, outcomeFilter: 'success' })
            : Promise.resolve([]),
    ]);

    // Build context string
    const contextParts: string[] = [];

    // Add memories
    if (runContext.memories.length > 0) {
        contextParts.push('## Workflow Context');
        for (const mem of runContext.memories) {
            contextParts.push(`- ${mem.memory}`);
        }
    }

    // Add relevant patterns
    if (patterns.length > 0) {
        contextParts.push('## Successful Patterns');
        for (const pattern of patterns) {
            contextParts.push(`- ${pattern.task}: ${pattern.toolSequence.join(' → ')}`);
        }
    }

    // Add relationships if present
    if (runContext.relations.length > 0) {
        contextParts.push('## Key Relationships');
        for (const rel of runContext.relations.slice(0, 5)) {
            contextParts.push(`- ${rel.source} → ${rel.relation} → ${rel.target}`);
        }
    }

    const contextString = contextParts.join('\n');
    const tokensUsed = estimateTokenCount(contextString);

    console.log(`[MemoryRetrieval] Retrieved ${runContext.memories.length} memories, ${tokensUsed} tokens`);

    return {
        contextString,
        memories: runContext.memories,
        tokensUsed,
    };
}

// =============================================================================
// Token Optimization: Structured Task Decomposition
// =============================================================================

/**
 * Generate a minimal, structured task prompt for an agent
 * Reduces reasoning overhead by being explicit about expectations
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

    // Step context
    if (context?.currentStep && context?.totalSteps) {
        parts.push(`[Step ${context.currentStep}/${context.totalSteps}]`);
    }

    // Task
    parts.push(`Task: ${task}`);

    // Previous context (compressed)
    if (context?.previousStepOutput) {
        const compressed = context.previousStepOutput.slice(0, 500);
        parts.push(`Previous: ${compressed}`);
    }

    // Output format hint
    if (context?.expectedOutputFormat) {
        parts.push(`Format: ${context.expectedOutputFormat}`);
    }

    return parts.join('\n');
}
