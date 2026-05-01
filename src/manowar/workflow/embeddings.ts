/**
 * Workflow embeddings — first-party context retrieval for workflow runs.
 *
 * Stores workflow turns as `source: "session"` vectors in our Mongo `memory`
 * collection (with `metadata.workflow_wallet`), and recalls them via the
 * unified vectors layer. No mem0. No separate embedder. Same Voyage +
 * Atlas $vectorSearch + CF BAAI rerank stack as the agent loop.
 */

import { indexMemoryContent, searchVectors, getEmbedding } from "../memory/index.js";

export interface EmbeddingResult {
    id: string;
    content: string;
    score: number;
    metadata?: Record<string, unknown>;
}

export async function computeEmbedding(content: string): Promise<number[] | null> {
    try {
        const result = await getEmbedding(content);
        return result.embedding;
    } catch (error) {
        console.error("[workflow:embeddings] computeEmbedding error:", error);
        return null;
    }
}

export async function storeEmbedding(
    workflowId: string,
    content: string,
    metadata?: Record<string, unknown>
): Promise<string | null> {
    try {
        const result = await indexMemoryContent({
            content,
            agentWallet: workflowId,
            source: "session",
            metadata: {
                ...metadata,
                workflow_wallet: workflowId,
                timestamp: Date.now(),
                layer: "scene",
            },
        });
        return result.vectorId ?? null;
    } catch (error) {
        console.error("[workflow:embeddings] store error:", error);
        return null;
    }
}

export async function searchByEmbedding(
    workflowId: string,
    query: string,
    limit: number = 5
): Promise<EmbeddingResult[]> {
    try {
        const results = await searchVectors({
            query,
            agentWallet: workflowId,
            filters: { "metadata.workflow_wallet": workflowId },
            limit,
            options: {
                temporalDecay: true,
                rerank: true,
                mmr: true,
                mmrLambda: 0.7,
            },
        });
        return results.map((row) => ({
            id: row.vectorId ?? row.id,
            content: row.content,
            score: row.score,
            metadata: { decayScore: row.decayScore, accessCount: row.accessCount, createdAt: row.createdAt },
        }));
    } catch (error) {
        console.error("[workflow:embeddings] search error:", error);
        return [];
    }
}

export async function getRelevantContext(
    workflowId: string,
    query: string,
    limit: number = 3
): Promise<string> {
    const results = await searchByEmbedding(workflowId, query, limit);
    if (results.length === 0) return "";
    return results.map((r, i) => `[Context ${i + 1}]: ${r.content}`).join("\n\n");
}

export async function recordConversationTurn(
    workflowId: string,
    role: "user" | "assistant",
    content: string,
    stepNumber?: number,
    runId?: string
): Promise<void> {
    await storeEmbedding(workflowId, content, {
        role,
        step_number: stepNumber,
        type: "conversation_turn",
        run_id: runId,
    });
}
