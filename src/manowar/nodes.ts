/**
 * Sub-Agent Node Implementations
 * 
 * Functional implementations of the orchestration sub-agents:
 * - NoteTaker: Token usage checkpointing
 * - WindowTracker: Context window health monitoring
 * - ToolBoxer: Registry-based tool recommendations with spawn params
 * - Evaluator: End-of-loop performance assessment
 * - Reviewer: Start-of-loop improvement integration
 * 
 * These are LangGraph node functions that operate on ManowarOrchestrationState.
 */

import type {
    ManowarState,
    AgentTokenMetrics,
    WindowHealthStatus,
    ToolRecommendation,
    LoopEvaluation,
} from "./state.js";
import { getModelContextSpec } from "./context.js";
import { searchRegistryTools, inspectToolCapability } from "./context.js";

// =============================================================================
// Configuration
// =============================================================================

const LAMBDA_API_URL = process.env.LAMBDA_API_URL || "https://api.compose.market";

// Model used for Evaluator reasoning (thinking model for nuanced analysis)
const EVALUATOR_MODEL = "moonshotai/kimi-k2-thinking";

// =============================================================================
// NoteTaker: Token Usage Checkpointing
// =============================================================================

export interface TokenLedgerState {
    checkpoints: Array<{
        agentId: string;
        modelId: string;
        action: string;
        inputTokens: number;
        outputTokens: number;
        reasoningTokens: number;
        timestamp: number;
    }>;
    cumulativeTotal: number;
}

/**
 * NoteTaker node: Compiles token ledger state into graph state
 * Called after each LLM invocation to update metrics
 */
export async function noteTakerNode(
    state: ManowarState,
    ledgerState: TokenLedgerState
): Promise<Partial<ManowarState>> {
    // Aggregate by agent
    const tokenMetrics: Record<string, AgentTokenMetrics> = { ...state.tokenMetrics };

    for (const checkpoint of ledgerState.checkpoints) {
        const existing = tokenMetrics[checkpoint.agentId] || {
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            totalTokens: 0,
            lastUpdated: 0,
        };

        tokenMetrics[checkpoint.agentId] = {
            inputTokens: existing.inputTokens + checkpoint.inputTokens,
            outputTokens: existing.outputTokens + checkpoint.outputTokens,
            reasoningTokens: existing.reasoningTokens + (checkpoint.reasoningTokens || 0),
            totalTokens: existing.totalTokens + checkpoint.inputTokens + checkpoint.outputTokens + (checkpoint.reasoningTokens || 0),
            lastUpdated: checkpoint.timestamp,
        };
    }

    console.log(
        `[NoteTaker] Updated metrics for ${Object.keys(tokenMetrics).length} agents, ` +
        `cumulative total: ${ledgerState.cumulativeTotal}`
    );

    return { tokenMetrics };
}

// =============================================================================
// WindowTracker: Context Window Health Monitoring
// =============================================================================

/**
 * WindowTracker node: Monitors context window health across all agents
 * Returns health status and cleanup trigger
 */
export async function windowTrackerNode(
    state: ManowarState
): Promise<Partial<ManowarState>> {
    const windowHealth: Record<string, WindowHealthStatus> = {};
    let needsCleanup = false;

    // Check each agent's token usage against model limits
    for (const [agentId, metrics] of Object.entries(state.tokenMetrics || {})) {
        const modelId = state.agentModels?.[agentId] || "default";

        // Fetch model specs (async for dynamic registry lookup)
        const modelSpec = await getModelContextSpec(modelId);
        const usage = metrics.totalTokens;
        const limit = modelSpec.effectiveWindow;
        const usagePercent = (usage / limit) * 100;
        const healthy = usagePercent < 80;  // 80% threshold

        windowHealth[agentId] = {
            usage,
            limit,
            usagePercent,
            healthy,
        };

        if (!healthy) {
            needsCleanup = true;
            console.log(
                `[WindowTracker] Agent ${agentId} at ${usagePercent.toFixed(1)}% capacity - cleanup needed`
            );
        }
    }

    // Also check coordinator (implicit in state.messages)
    const messageTokenEstimate = state.messages.reduce(
        (sum, m) => sum + Math.ceil(String(m.content).length / 4),
        0
    );

    const coordinatorModel = state.agentModels?.["coordinator"] || "minimax/minimax-m2.1";
    const coordSpec = await getModelContextSpec(coordinatorModel);
    const coordUsagePercent = (messageTokenEstimate / coordSpec.effectiveWindow) * 100;

    windowHealth["coordinator"] = {
        usage: messageTokenEstimate,
        limit: coordSpec.effectiveWindow,
        usagePercent: coordUsagePercent,
        healthy: coordUsagePercent < 80,
    };

    if (coordUsagePercent >= 80) {
        needsCleanup = true;
        console.log(
            `[WindowTracker] Coordinator at ${coordUsagePercent.toFixed(1)}% capacity - cleanup needed`
        );
    }

    return { windowHealth, needsCleanup };
}

// =============================================================================
// ToolBoxer: Registry-Based Tool Recommendations
// =============================================================================

/**
 * ToolBoxer node: Recommends tools from registry with spawn parameters
 * Provides actionable tool selections for dynamic binding
 */
export async function toolBoxerNode(
    state: ManowarState
): Promise<Partial<ManowarState>> {
    const currentGoal = state.activeGoal || "";
    const boundPlugins = state.boundPlugins || [];

    if (!currentGoal) {
        return {
            suggestedTools: [],
            toolBoxerReasoning: "No active goal to recommend tools for",
        };
    }

    // Search registry for relevant tools
    const searchResults = await searchRegistryTools(currentGoal, {
        limit: 15,
        executableOnly: true,
    });

    // Filter out already-bound plugins
    const newTools = searchResults.filter(
        tool => !boundPlugins.some(
            p => p.includes(tool.registryId) || p.includes(tool.name.toLowerCase())
        )
    );

    // Get spawn parameters for top recommendations
    const recommendations: ToolRecommendation[] = [];

    for (const tool of newTools.slice(0, 5)) {
        // Inspect tool for spawn configuration
        const details = await inspectToolCapability(tool.registryId);

        recommendations.push({
            registryId: tool.registryId,
            name: tool.name,
            description: tool.description,
            spawnParams: details?.spawnConfig ? {
                transport: details.spawnConfig.transport,
                image: details.spawnConfig.image,
                remoteUrl: details.spawnConfig.remoteUrl,
            } : undefined,
            confidence: calculateToolConfidence(tool, currentGoal),
        });
    }

    const reasoning = recommendations.length > 0
        ? `Found ${recommendations.length} relevant tools for "${currentGoal.slice(0, 50)}...": ${recommendations.map(r => r.name).join(", ")}`
        : `No additional tools found for "${currentGoal.slice(0, 50)}..."`;

    console.log(`[ToolBoxer] ${reasoning}`);

    return {
        suggestedTools: recommendations,
        toolBoxerReasoning: reasoning,
    };
}

/**
 * Calculate confidence score for tool relevance
 */
function calculateToolConfidence(tool: { description: string; tags: string[] }, goal: string): number {
    const goalWords = goal.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const descWords = tool.description.toLowerCase();

    let matches = 0;
    for (const word of goalWords) {
        if (descWords.includes(word)) matches++;
        if (tool.tags.some(t => t.toLowerCase().includes(word))) matches++;
    }

    return Math.min(1, matches / Math.max(1, goalWords.length));
}

// =============================================================================
// Evaluator: End-of-Loop Performance Assessment
// =============================================================================

/**
 * Evaluator node: Assesses loop performance and suggests improvements
 * Only active in continuous-loop workflows
 */
export async function evaluatorNode(
    state: ManowarState,
    coordinatorModel: string = EVALUATOR_MODEL
): Promise<Partial<ManowarState>> {
    const loopNum = state.loopCount || 1;

    const prompt = `You are evaluating the performance of an autonomous AI workflow loop.

WORKFLOW GOAL: ${state.activeGoal}

LOOP NUMBER: ${loopNum}

COMPLETED ACTIONS:
${state.completedActions?.map((a, i) => `${i + 1}. ${a}`).join("\n") || "None recorded"}

TOKEN USAGE BY AGENT:
${Object.entries(state.tokenMetrics || {})
            .map(([agent, metrics]) => `- ${agent}: ${metrics.totalTokens} tokens (${metrics.reasoningTokens} reasoning)`)
            .join("\n") || "No metrics"}

WINDOW HEALTH:
${Object.entries(state.windowHealth || {})
            .map(([agent, health]) => `- ${agent}: ${health.usagePercent.toFixed(1)}% (${health.healthy ? "healthy" : "NEEDS CLEANUP"})`)
            .join("\n") || "Not tracked"}

TOOLS SUGGESTED:
${state.suggestedTools?.map(t => `- ${t.name}: ${t.confidence.toFixed(2)} confidence`).join("\n") || "None"}

TASK: Evaluate this loop's performance and suggest improvements for the next iteration.
Score from 0-10 on:
1. Goal adherence: How well did actions align with the goal?
2. Efficiency: Were tokens and tools used efficiently?

Respond with valid JSON only:
{
  "goalScore": N,
  "efficiencyScore": N,
  "improvements": ["specific improvement 1", "specific improvement 2", ...]
}`;

    try {
        const response = await fetch(`${LAMBDA_API_URL}/api/inference`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: coordinatorModel,
                messages: [
                    { role: "system", content: "You are a workflow performance evaluator. Respond only with valid JSON." },
                    { role: "user", content: prompt },
                ],
                temperature: 0.3,
            }),
        });

        if (!response.ok) {
            console.error(`[Evaluator] Inference failed: ${response.status}`);
            return {};
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || data.content || "";

        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            console.error("[Evaluator] No JSON in response");
            return {};
        }

        const evaluation = JSON.parse(jsonMatch[0]);

        const loopEvaluation: LoopEvaluation = {
            loopNumber: loopNum,
            goalScore: evaluation.goalScore || 5,
            efficiencyScore: evaluation.efficiencyScore || 5,
            improvements: evaluation.improvements || [],
            timestamp: Date.now(),
        };

        console.log(
            `[Evaluator] Loop ${loopNum}: goal=${loopEvaluation.goalScore}/10, ` +
            `efficiency=${loopEvaluation.efficiencyScore}/10, ` +
            `${loopEvaluation.improvements.length} improvements suggested`
        );

        return {
            lastEvaluation: loopEvaluation,
            suggestedImprovements: evaluation.improvements || [],
        };
    } catch (error) {
        console.error("[Evaluator] Failed:", error);
        return {};
    }
}

// =============================================================================
// Reviewer: Start-of-Loop Improvement Integration
// =============================================================================

/**
 * Reviewer node: Integrates improvements from previous loop
 * Only active on loop 2+ in continuous workflows
 */
export async function reviewerNode(
    state: ManowarState
): Promise<Partial<ManowarState>> {
    const loopCount = state.loopCount || 1;

    // No review needed on first loop
    if (loopCount < 2) {
        return { reviewApplied: false };
    }

    const improvements = state.suggestedImprovements || [];

    if (improvements.length === 0) {
        console.log(`[Reviewer] Loop ${loopCount}: No improvements to apply`);
        return { reviewApplied: false };
    }

    // Convert improvements to context enhancements
    const contextEnhancements = improvements.map(
        (imp, i) => `[Loop ${loopCount - 1} Learning #${i + 1}]: ${imp}`
    );

    console.log(`[Reviewer] Loop ${loopCount}: Applying ${improvements.length} improvements from previous evaluation`);

    return {
        contextEnhancements,
        reviewApplied: true,
        // Clear improvements after applying
        suggestedImprovements: [],
    };
}

// =============================================================================
// Node Factory for Graph Integration
// =============================================================================

export interface SubAgentNodes {
    noteTaker: (state: ManowarState, ledger: TokenLedgerState) => Promise<Partial<ManowarState>>;
    windowTracker: (state: ManowarState) => Promise<Partial<ManowarState>>;
    toolBoxer: (state: ManowarState) => Promise<Partial<ManowarState>>;
    evaluator: (state: ManowarState, model?: string) => Promise<Partial<ManowarState>>;
    reviewer: (state: ManowarState) => Promise<Partial<ManowarState>>;
}

/**
 * Get all sub-agent node functions for graph integration
 */
export function getSubAgentNodes(): SubAgentNodes {
    return {
        noteTaker: noteTakerNode,
        windowTracker: windowTrackerNode,
        toolBoxer: toolBoxerNode,
        evaluator: evaluatorNode,
        reviewer: reviewerNode,
    };
}
