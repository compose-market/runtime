/**
 * Embeddings Module - Mem0-backed Vector Search
 * 
 * Provides context retrieval via semantic embeddings using Mem0's 
 * advanced features with e5-mistral-7b-instruct embedding model.
 * 
 * Replaces the file-based context and tool-masking systems with
 * a simpler embeddings-based approach as recommended in suggestions.md.
 */

import { addMemoryWithGraph, searchMemoryWithGraph } from "./memory.js";

const MEM0_API_KEY = process.env.MEM0_API_KEY;
const LAMBDA_API_URL = process.env.LAMBDA_API_URL || "https://api.compose.market";

// Embedding model from user specification
const EMBEDDING_MODEL = "e5-mistral-7b-instruct";

// =============================================================================
// Types
// =============================================================================

export interface EmbeddingResult {
    id: string;
    content: string;
    score: number;
    metadata?: Record<string, unknown>;
}

export interface StoredEmbedding {
    id: string;
    workflowId: string;
    content: string;
    timestamp: number;
}

// =============================================================================
// Embedding Operations
// =============================================================================

/**
 * Compute embedding for content via Lambda API (uses e5-mistral-7b-instruct)
 */
export async function computeEmbedding(content: string): Promise<number[] | null> {
    try {
        const response = await fetch(`${LAMBDA_API_URL}/api/embeddings`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: EMBEDDING_MODEL,
                input: content,
            }),
        });

        if (!response.ok) {
            console.error(`[embeddings] Compute failed: ${response.status}`);
            return null;
        }

        const data = await response.json();
        return data.data?.[0]?.embedding || null;
    } catch (error) {
        console.error("[embeddings] Compute error:", error);
        return null;
    }
}

/**
 * Store content with embeddings in Mem0 for later retrieval
 */
export async function storeEmbedding(
    workflowId: string,
    content: string,
    metadata?: Record<string, unknown>
): Promise<string | null> {
    if (!MEM0_API_KEY) {
        console.warn("[embeddings] MEM0_API_KEY not set, skipping store");
        return null;
    }

    try {
        const memories = await addMemoryWithGraph({
            messages: [{ role: "assistant", content }],
            agent_id: workflowId,
            run_id: String(metadata?.run_id || "unknown"),
            metadata: {
                ...metadata,
                timestamp: Date.now(),
                embedding_model: EMBEDDING_MODEL,
            },
        });
        return memories?.[0]?.id || null;
    } catch (error) {
        console.error("[embeddings] Store error:", error);
        return null;
    }
}

/**
 * Search for relevant context using semantic similarity
 * Uses Mem0's advanced retrieval with reranking and keyword search
 */
export async function searchByEmbedding(
    workflowId: string,
    query: string,
    limit: number = 5
): Promise<EmbeddingResult[]> {
    if (!MEM0_API_KEY) {
        return [];
    }

    try {
        const results = await searchMemoryWithGraph({
            query,
            agent_id: workflowId,
            limit,
            options: {
                rerank: true,
                keyword_search: true,
                filter_memories: true,
            },
        });

        return results.memories.map((m: any) => ({
            id: m.id,
            content: m.memory || m.content || "",
            score: m.score || m.relevance_score || 0,
            metadata: m.metadata,
        }));
    } catch (error) {
        console.error("[embeddings] Search error:", error);
        return [];
    }
}

/**
 * Get relevant context for a task by searching embeddings
 * Returns formatted string for inclusion in prompts
 */
export async function getRelevantContext(
    workflowId: string,
    query: string,
    limit: number = 3
): Promise<string> {
    const results = await searchByEmbedding(workflowId, query, limit);

    if (results.length === 0) {
        return "";
    }

    return results
        .map((r, i) => `[Context ${i + 1}]: ${r.content}`)
        .join("\n\n");
}

/**
 * Store a conversation turn for later retrieval
 */
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
