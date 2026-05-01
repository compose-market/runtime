/**
 * Workflow memory — first-party graph + vector layer for multi-agent
 * orchestration. Replaces the old mem0 cloud round-trip with our own
 * Mongo + Voyage + CF BAAI rerank stack.
 *
 * Surface kept (callers in orchestrator/planner/checkpoint depend on these):
 *   - addMemoryWithGraph    — store a workflow turn / checkpoint / evaluation
 *   - searchMemoryWithGraph — hybrid recall over workflow memory
 *   - getAgentReliability   — aggregate quality + success rate per workflow agent
 *   - performSafeWipe       — context-window safety summary
 *   - getAllMemories        — admin/debug list
 */

import {
    indexAgentMemoryFacts,
    indexMemoryContent,
    searchVectors,
    getMemoryVectorsCollection,
    type MemoryItem,
} from "../memory/index.js";
import type { SessionTranscript } from "../memory/types.js";

export interface GraphMemoryResult {
    memories: MemoryItem[];
    relations?: Array<{ source: string; target: string; relation: string }>;
}

export interface ContextSummary {
    summary: string;
    keyPoints: string[];
    completedActions: string[];
    pendingTasks: string[];
}

export interface WipeResult {
    success: boolean;
    summaryStored: boolean;
    keyPointsRetained: number;
}

interface AddMemoryParams {
    messages: Array<{ role: string; content: string }>;
    agent_id: string;
    user_id?: string;
    run_id?: string;
    metadata?: Record<string, unknown>;
}

interface SearchMemoryParams {
    query: string;
    agent_id: string;
    user_id?: string;
    run_id?: string;
    limit?: number;
    options?: Record<string, unknown>;
}

function turnSummary(messages: AddMemoryParams["messages"], maxChars = 1_800): string {
    return messages
        .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "system")
        .slice(-6)
        .map((m) => `${m.role}: ${m.content.replace(/\s+/g, " ").trim().slice(0, 600)}`)
        .join("\n")
        .slice(0, maxChars);
}

/**
 * Store a workflow turn / checkpoint / evaluation. Two artifacts land:
 *   1. A `source: "session"` vector for hybrid recall (the full turn summary).
 *   2. Distilled durable facts via the first-party graph extractor (gemini-3.1-flash-lite-preview).
 */
export async function addMemoryWithGraph(params: AddMemoryParams): Promise<MemoryItem[]> {
    const summary = turnSummary(params.messages);
    if (!summary) {
        return [];
    }

    const metadata = {
        ...params.metadata,
        workflow_wallet: params.agent_id,
        run_id: params.run_id,
        user_id: params.user_id,
    };

    const indexResult = await indexMemoryContent({
        content: summary,
        agentWallet: params.agent_id,
        userAddress: params.user_id,
        threadId: params.run_id,
        source: "session",
        metadata,
    }).catch((error) => {
        console.warn("[workflow:memory] indexMemoryContent failed:", error instanceof Error ? error.message : error);
        return { success: false, vectorId: undefined } as { success: boolean; vectorId?: string };
    });

    // Fact extraction in the background — workflow memory benefits from
    // distilled facts, but never blocks the orchestrator.
    const extractMessages: SessionTranscript["messages"] = params.messages.map((m, i) => ({
        role: (m.role === "user" || m.role === "assistant" || m.role === "system" || m.role === "tool")
            ? m.role
            : "user",
        content: m.content,
        timestamp: Date.now() + i,
    }));
    void indexAgentMemoryFacts({
        agentWallet: params.agent_id,
        userAddress: params.user_id,
        threadId: params.run_id,
        messages: extractMessages,
        metadata,
    }).catch((error) => {
        console.warn("[workflow:memory] graph fact extraction failed:", error instanceof Error ? error.message : error);
    });

    if (!indexResult.success || !indexResult.vectorId) {
        return [];
    }

    return [{
        id: indexResult.vectorId,
        memory: summary,
        agent_id: params.agent_id,
        user_id: params.user_id,
        run_id: params.run_id,
        metadata,
        created_at: new Date().toISOString(),
    }];
}

/**
 * Recall workflow memory by semantic query. Backed by Atlas $vectorSearch +
 * decay + CF BAAI rerank + MMR. The `options` parameter is accepted for
 * back-compat with the old mem0 surface but is ignored — our pipeline owns
 * top_k/threshold/rerank.
 */
export async function searchMemoryWithGraph(params: SearchMemoryParams): Promise<GraphMemoryResult> {
    void params.options;

    const results = await searchVectors({
        query: params.query,
        agentWallet: params.agent_id,
        userAddress: params.user_id,
        threadId: params.run_id,
        filters: { "metadata.workflow_wallet": params.agent_id },
        limit: params.limit ?? 5,
        options: { temporalDecay: true, rerank: true, mmr: true, mmrLambda: 0.7 },
    });

    const memories: MemoryItem[] = results.map((row) => ({
        id: row.vectorId ?? row.id,
        memory: row.content,
        agent_id: row.agentWallet,
        user_id: row.userAddress,
        run_id: row.threadId,
        metadata: { score: row.score, decayScore: row.decayScore, accessCount: row.accessCount, createdAt: row.createdAt },
        created_at: row.createdAt ? new Date(row.createdAt).toISOString() : undefined,
    }));

    return { memories };
}

/**
 * Admin/debug list — returns the most recent N workflow memories for an
 * (agent_id, user_id) scope.
 */
export async function getAllMemories(params: {
    agent_id: string;
    user_id?: string;
    limit?: number;
}): Promise<MemoryItem[]> {
    const vectors = await getMemoryVectorsCollection();
    const filter: Record<string, unknown> = {
        agentWallet: params.agent_id,
        "metadata.workflow_wallet": params.agent_id,
    };
    if (params.user_id) filter.userAddress = params.user_id;
    const docs = await vectors
        .find(filter)
        .sort({ createdAt: -1 })
        .limit(Math.max(1, params.limit ?? 50))
        .project({ embedding: 0 })
        .toArray();

    return docs.map((doc) => ({
        id: doc.vectorId,
        memory: doc.content,
        agent_id: doc.agentWallet,
        user_id: doc.userAddress,
        run_id: doc.threadId,
        metadata: doc.metadata,
        created_at: doc.createdAt ? new Date(doc.createdAt).toISOString() : undefined,
        updated_at: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : undefined,
    }));
}

/**
 * Reliability rollup — for a workflow agent, aggregate quality / success
 * across past runs. Reads from the `metadata.qualityScore` / `metadata.success`
 * embedded in stored evaluations.
 */
export async function getAgentReliability(workflowWallet: string, agentName: string): Promise<{
    avgQuality: number;
    successRate: number;
    totalRuns: number;
}> {
    const vectors = await getMemoryVectorsCollection();
    const docs = await vectors
        .find({
            agentWallet: workflowWallet,
            "metadata.workflow_wallet": workflowWallet,
            "metadata.type": { $in: ["step_learning", "workflow_evaluation"] },
            "metadata.agent": agentName,
        })
        .sort({ createdAt: -1 })
        .limit(50)
        .project({ embedding: 0 })
        .toArray();

    if (docs.length === 0) {
        return { avgQuality: 0, successRate: 0, totalRuns: 0 };
    }

    let qualitySum = 0;
    let qualityCount = 0;
    let successCount = 0;

    for (const doc of docs) {
        const meta = doc.metadata as Record<string, unknown> | undefined;
        const quality = typeof meta?.qualityScore === "number" ? meta.qualityScore : null;
        if (quality !== null && Number.isFinite(quality)) {
            qualitySum += quality;
            qualityCount += 1;
        }
        const success = meta?.success;
        if (success === true || success === "true") {
            successCount += 1;
        }
    }

    return {
        avgQuality: qualityCount > 0 ? qualitySum / qualityCount : 0,
        successRate: docs.length > 0 ? successCount / docs.length : 0,
        totalRuns: docs.length,
    };
}

/**
 * Context-window safety: when a workflow run is approaching the model's
 * context limit, store a compact summary so future steps can reference it
 * without holding the entire transcript in memory.
 */
export async function performSafeWipe(
    workflowWallet: string,
    runId: string,
    _coordinatorModel: string,
    context: {
        goal: string;
        agentSummaries: Record<string, string> | string[];
        messageCount: number;
        completedActions: string[];
        lastOutcome: string;
    },
): Promise<WipeResult> {
    const summarisedAgents = Array.isArray(context.agentSummaries)
        ? context.agentSummaries.join("; ")
        : Object.entries(context.agentSummaries).map(([k, v]) => `${k}: ${v}`).join("; ");

    const summary = [
        `Workflow ${workflowWallet} mid-run summary`,
        `Goal: ${context.goal.slice(0, 600)}`,
        `Agents: ${summarisedAgents.slice(0, 800)}`,
        `Messages so far: ${context.messageCount}`,
        `Completed actions: ${context.completedActions.slice(-12).join(" | ").slice(0, 600)}`,
        `Last outcome: ${context.lastOutcome.slice(0, 400)}`,
    ].join("\n");

    const stored = await indexMemoryContent({
        content: summary,
        agentWallet: workflowWallet,
        threadId: runId,
        source: "session",
        metadata: {
            workflow_wallet: workflowWallet,
            run_id: runId,
            type: "context_compaction",
            messageCount: context.messageCount,
            completedActions: context.completedActions.length,
        },
    }).catch((error) => {
        console.warn("[workflow:memory] performSafeWipe store failed:", error instanceof Error ? error.message : error);
        return { success: false, vectorId: undefined } as { success: boolean; vectorId?: string };
    });

    return {
        success: Boolean(stored.success),
        summaryStored: Boolean(stored.success),
        keyPointsRetained: context.completedActions.length,
    };
}
