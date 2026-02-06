/**
 * Checkpoint Module - Internal Agent Annotations
 * 
 * Provides ephemeral checkpoints for internal agents to:
 * 1. Maintain context between steps
 * 2. Share experiences between manowars/executions
 * 3. Persist to LangSmith feedback (primary) and Mem0 (fallback)
 * 
 * Checkpoints are stored in-memory for the current run,
 * then persisted to LangSmith feedback and/or Mem0.
 */

import { searchByEmbedding } from "./embeddings.js";
import { addMemoryWithGraph } from "./memory.js";
import {
    isLangSmithEnabled,
    recordInsightFeedback,
    recordDecisionFeedback,
    recordQualityScore,
    recordErrorFeedback,
} from "./langsmith.js";

// =============================================================================
// Types
// =============================================================================

export interface Checkpoint {
    id: string;
    runId: string;
    agentId: string;
    stepNumber: number;
    type: "observation" | "decision" | "output" | "error" | "insight";
    content: string;
    metadata?: Record<string, unknown>;
    timestamp: number;
}

export interface CheckpointSummary {
    runId: string;
    totalCheckpoints: number;
    agents: string[];
    insights: string[];
    keyDecisions: string[];
    errors: string[];
}

// =============================================================================
// In-Memory Checkpoint Store (per run)
// =============================================================================

const checkpointStore = new Map<string, Checkpoint[]>();

// =============================================================================
// Checkpoint Operations
// =============================================================================

/**
 * Create a new checkpoint
 */
export function createCheckpoint(
    runId: string,
    agentId: string,
    stepNumber: number,
    type: Checkpoint["type"],
    content: string,
    metadata?: Record<string, unknown>
): Checkpoint {
    const checkpoint: Checkpoint = {
        id: `cp-${runId}-${stepNumber}-${Date.now()}`,
        runId,
        agentId,
        stepNumber,
        type,
        content,
        metadata,
        timestamp: Date.now(),
    };

    // Add to store
    const existing = checkpointStore.get(runId) || [];
    existing.push(checkpoint);
    checkpointStore.set(runId, existing);

    console.log(`[checkpoint] Created ${type} for ${agentId} at step ${stepNumber}`);
    return checkpoint;
}

/**
 * Get all checkpoints for a run
 */
export function getCheckpoints(runId: string): Checkpoint[] {
    return checkpointStore.get(runId) || [];
}

/**
 * Get checkpoints by agent
 */
export function getAgentCheckpoints(runId: string, agentId: string): Checkpoint[] {
    return getCheckpoints(runId).filter(cp => cp.agentId === agentId);
}

/**
 * Get checkpoints by type
 */
export function getCheckpointsByType(runId: string, type: Checkpoint["type"]): Checkpoint[] {
    return getCheckpoints(runId).filter(cp => cp.type === type);
}

/**
 * Get insights from checkpoints
 */
export function getInsights(runId: string): string[] {
    return getCheckpointsByType(runId, "insight").map(cp => cp.content);
}

/**
 * Get decision trail from checkpoints
 */
export function getDecisionTrail(runId: string): string[] {
    return getCheckpointsByType(runId, "decision").map(cp =>
        `[Step ${cp.stepNumber}] ${cp.agentId}: ${cp.content}`
    );
}

// =============================================================================
// Summarize & Persist to Mem0
// =============================================================================

/**
 * Summarize checkpoints for a run
 */
export function summarizeCheckpoints(runId: string): CheckpointSummary {
    const checkpoints = getCheckpoints(runId);
    const agents = [...new Set(checkpoints.map(cp => cp.agentId))];

    return {
        runId,
        totalCheckpoints: checkpoints.length,
        agents,
        insights: getInsights(runId),
        keyDecisions: getDecisionTrail(runId),
        errors: getCheckpointsByType(runId, "error").map(cp => cp.content),
    };
}

/**
 * Persist checkpoints to LangSmith feedback (primary) and Mem0 (fallback)
 * 
 * When langsmithRunId is provided, stores feedback directly on the run.
 * Always stores to Mem0 for graph retrieval and long-term persistence.
 */
export async function persistCheckpoints(
    runId: string,
    manowarWallet: string,
    langsmithRunId?: string
): Promise<string | null> {
    const summary = summarizeCheckpoints(runId);

    if (summary.totalCheckpoints === 0) {
        return null;
    }

    const checkpoints = getCheckpoints(runId);

    // =========================================================================
    // LangSmith Feedback (primary - when langsmithRunId available)
    // =========================================================================
    if (langsmithRunId && isLangSmithEnabled()) {
        console.log(`[checkpoint] Persisting ${summary.totalCheckpoints} checkpoints to LangSmith`);

        for (const cp of checkpoints) {
            switch (cp.type) {
                case "insight":
                    await recordInsightFeedback(langsmithRunId, cp.content, cp.agentId);
                    break;
                case "decision":
                    await recordDecisionFeedback(
                        langsmithRunId,
                        cp.content,
                        (cp.metadata?.reasoning as string) || undefined
                    );
                    break;
                case "error":
                    await recordErrorFeedback(langsmithRunId, cp.content, cp.agentId);
                    break;
                default:
                    // observations and outputs don't need feedback
                    break;
            }
        }

        // Record overall quality score for the run
        const errorRate = summary.errors.length / summary.totalCheckpoints;
        const qualityScore = Math.max(0, 1 - errorRate);
        await recordQualityScore(
            langsmithRunId,
            qualityScore,
            `${summary.agents.length} agents, ${summary.insights.length} insights, ${summary.errors.length} errors`
        );
    }

    // =========================================================================
    // Mem0 Persistence (fallback - always for graph retrieval)
    // =========================================================================

    // Build embeddable content
    const content = [
        `## Workflow Checkpoints: ${runId}`,
        ``,
        `### Agents: ${summary.agents.join(", ")}`,
        ``,
        `### Key Decisions`,
        ...summary.keyDecisions.map(d => `- ${d}`),
        ``,
        `### Insights`,
        ...summary.insights.map(i => `- ${i}`),
        summary.errors.length > 0 ? `\n### Errors` : "",
        ...summary.errors.map(e => `- ${e}`),
    ].join("\n");

    // Store in Mem0 with graph enabled
    const memoryId = await addMemoryWithGraph({
        messages: [
            { role: "system", content: `Checkpoint summary for ${manowarWallet}` },
            { role: "assistant", content },
        ],
        agent_id: manowarWallet,
        run_id: runId,
        metadata: {
            type: "checkpoint_summary",
            checkpoint_count: summary.totalCheckpoints,
            agent_count: summary.agents.length,
            has_errors: summary.errors.length > 0,
            langsmith_run_id: langsmithRunId,
        },
    });

    console.log(`[checkpoint] Persisted ${summary.totalCheckpoints} checkpoints to Mem0`);

    // Clean up in-memory store
    checkpointStore.delete(runId);

    return memoryId?.[0]?.id || null;
}

/**
 * Retrieve past checkpoints from Mem0 for a manowar
 * Used for A2A context sharing and multi-run learning
 */
export async function retrievePastInsights(
    manowarWallet: string,
    query: string,
    limit: number = 5
): Promise<string[]> {
    const results = await searchByEmbedding(manowarWallet, query, limit);

    // Filter for checkpoint summaries
    const checkpointResults = results.filter(r =>
        r.metadata?.type === "checkpoint_summary" ||
        r.content.includes("Checkpoint") ||
        r.content.includes("Insights")
    );

    return checkpointResults.map(r => r.content);
}

// =============================================================================
// Convenience Functions for Orchestrator
// =============================================================================

/**
 * Record an observation checkpoint
 */
export function recordObservation(
    runId: string,
    agentId: string,
    stepNumber: number,
    observation: string
): Checkpoint {
    return createCheckpoint(runId, agentId, stepNumber, "observation", observation);
}

/**
 * Record a decision checkpoint
 */
export function recordDecision(
    runId: string,
    agentId: string,
    stepNumber: number,
    decision: string,
    reasoning?: string
): Checkpoint {
    return createCheckpoint(runId, agentId, stepNumber, "decision", decision, { reasoning });
}

/**
 * Record an insight checkpoint (for multi-loop learning)
 */
export function recordInsight(
    runId: string,
    agentId: string,
    stepNumber: number,
    insight: string
): Checkpoint {
    return createCheckpoint(runId, agentId, stepNumber, "insight", insight);
}

/**
 * Record an error checkpoint
 */
export function recordError(
    runId: string,
    agentId: string,
    stepNumber: number,
    error: string
): Checkpoint {
    return createCheckpoint(runId, agentId, stepNumber, "error", error);
}
