/**
 * Context Window Manager
 * 
 * SINGLE RESPONSIBILITY: Context window tracking + per-agent state
 * 
 * Uses:
 * - API (api.compose.market) for fetching ModelCard contextWindow
 * - memory.ts for persisting usage metrics
 * 
 * Owns:
 * - ContextWindowManager class
 * - AgentContextState interface
 * - ModelContextSpec interface
 * - Sliding window helpers
 * - Dynamic threshold calculation
 */

import type { TokenUsage, ContextWindowState } from "./types.js";

// =============================================================================
// Constants
// =============================================================================

/** Sliding window size for recent messages */
export const SLIDING_WINDOW_SIZE = 6;

/** Lambda API URL for fetching model metadata */
const LAMBDA_API_URL = process.env.LAMBDA_API_URL || "https://api.compose.market";

/** Cache TTL for model context windows (30 minutes) */
const MODEL_CACHE_TTL = 30 * 60 * 1000;

// =============================================================================
// Model Context Window Cache
// =============================================================================

interface CachedModelContext {
    contextWindow: number;
    fetchedAt: number;
}

const modelContextCache = new Map<string, CachedModelContext>();

/**
 * Fetch contextWindow for a specific model from the Lambda API
 * Caches results for 30 minutes to avoid repeated fetches.
 * 
 * Uses /api/registry/model/{modelId} for efficient single-model lookup
 * instead of fetching the full 43K+ model registry.
 * 
 * @param modelId - The model ID to fetch context window for
 * @returns The context window size (token limit)
 */
export async function fetchModelContextWindow(modelId: string): Promise<number> {
    // Check cache first
    const cached = modelContextCache.get(modelId);
    if (cached && Date.now() - cached.fetchedAt < MODEL_CACHE_TTL) {
        return cached.contextWindow;
    }

    try {
        // Fetch single model from registry API (efficient lookup)
        const response = await fetch(`${LAMBDA_API_URL}/api/registry/model/${encodeURIComponent(modelId)}`);
        if (!response.ok) {
            console.warn(`[context] Failed to fetch model ${modelId}: ${response.status}`);
            return 128000; // Fallback default
        }

        const model = await response.json();
        const contextWindow = model?.contextWindow ?? 128000; // Fallback if not found

        // Cache the result
        modelContextCache.set(modelId, { contextWindow, fetchedAt: Date.now() });
        console.log(`[context] Cached contextWindow for ${modelId}: ${contextWindow}`);

        return contextWindow;
    } catch (error) {
        console.error(`[context] Error fetching model context:`, error);
        return 128000; // Safe fallback
    }
}

// =============================================================================
// Token Checkpoint (for LangSmith integration)
// =============================================================================

export interface TokenCheckpoint {
    agentId: string;
    modelId: string;
    action: string;
    inputTokens: number;
    outputTokens: number;
    timestamp: number;
}

// =============================================================================
// Model Context Specs (from API fetch)
// =============================================================================

export interface ModelContextSpec {
    modelId: string;
    contextLength: number;
    effectiveWindow: number;
    source: "api" | "unknown";
}

/**
 * Get model context spec from API
 * Uses fetchModelContextWindow for the actual fetch
 */
export async function getModelContextSpec(modelId: string): Promise<ModelContextSpec> {
    const contextLength = await fetchModelContextWindow(modelId);

    if (contextLength > 0) {
        return {
            modelId,
            contextLength,
            effectiveWindow: Math.floor(contextLength * 0.70),
            source: "api",
        };
    }

    console.warn(`[context] No contextLength found for model ${modelId}`);
    return {
        modelId,
        contextLength: 0,
        effectiveWindow: 0,
        source: "unknown",
    };
}

/**
 * Sync version - returns unknown when async not possible
 */
export function getModelContextSpecSync(modelId: string): ModelContextSpec {
    return {
        modelId,
        contextLength: 0,
        effectiveWindow: 0,
        source: "unknown",
    };
}

// =============================================================================
// Dynamic Threshold (moved from memory.ts)
// =============================================================================

/**
 * Get dynamic context threshold based on model's effective window
 * 
 * Formula: 55% + 0.5 × log₁₀(window/1024)
 * 
 * Scales with model capacity:
 * - 32k context → ~56.8%
 * - 128k context → ~58.9%
 * - 1M context → ~61.4%
 */
export function getDynamicThresholdPercent(effectiveWindow: number): number {
    const BASE_THRESHOLD = 55;
    const SCALE_FACTOR = 0.5;
    const NORMALIZATION_DIVISOR = 1024;

    const normalizedWindow = Math.max(effectiveWindow, NORMALIZATION_DIVISOR) / NORMALIZATION_DIVISOR;
    const logBonus = SCALE_FACTOR * Math.log10(normalizedWindow);

    return Math.min(75, BASE_THRESHOLD + logBonus);
}

// =============================================================================
// Per-Agent Context State
// =============================================================================

export interface AgentContextState {
    agentId: string;
    modelId: string;
    contextLength: number;
    maxTokens: number;
    currentTokens: number;
    inputTokens: number;
    outputTokens: number;
    calls: number;
    lastActivity: number;
}

// =============================================================================
// Context Window Manager
// =============================================================================

export class ContextWindowManager {
    private coordinatorModel: string;
    private maxTokens: number = 0;
    private currentTokens: number = 0;
    private agentUsage: Map<string, TokenUsage> = new Map();
    private agentContexts: Map<string, AgentContextState> = new Map();
    private initialized: boolean = false;

    constructor(coordinatorModel: string) {
        this.coordinatorModel = coordinatorModel;
    }

    /**
     * Initialize with REAL model context from Lambda API
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;

        const spec = await getModelContextSpec(this.coordinatorModel);

        if (spec.contextLength > 0) {
            this.maxTokens = spec.contextLength;
            console.log(`[context] Initialized: ${this.coordinatorModel} = ${spec.contextLength} tokens`);
        } else {
            console.error(`[context] No context length for ${this.coordinatorModel}`);
        }

        this.initialized = true;
    }

    /**
     * Record token usage for an agent
     */
    recordUsage(usage: TokenUsage): void {
        const existing = this.agentUsage.get(usage.agentId);
        if (existing) {
            existing.inputTokens += usage.inputTokens;
            existing.outputTokens += usage.outputTokens;
            existing.totalTokens += usage.totalTokens;
            existing.timestamp = usage.timestamp;
        } else {
            this.agentUsage.set(usage.agentId, { ...usage });
        }
        this.currentTokens += usage.totalTokens;
        this.updateAgentContext(usage);
    }

    /**
     * Update per-agent context state
     */
    private async updateAgentContext(usage: TokenUsage): Promise<void> {
        const agentId = usage.agentId;
        const modelId = usage.model || this.coordinatorModel;
        const existing = this.agentContexts.get(agentId);

        if (existing) {
            existing.currentTokens += usage.totalTokens;
            existing.inputTokens += usage.inputTokens;
            existing.outputTokens += usage.outputTokens;
            existing.calls += 1;
            existing.lastActivity = usage.timestamp;
        } else {
            const spec = await getModelContextSpec(modelId);
            this.agentContexts.set(agentId, {
                agentId,
                modelId,
                contextLength: spec.contextLength,
                maxTokens: spec.contextLength,
                currentTokens: usage.totalTokens,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                calls: 1,
                lastActivity: usage.timestamp,
            });
        }
    }

    /**
     * Record tokens from a message (using actual token count from LangSmith callback)
     */
    recordMessage(
        agentId: string,
        model: string,
        tokenCount: number,
        isOutput = false
    ): TokenUsage {
        const usage: TokenUsage = {
            agentId,
            model,
            inputTokens: isOutput ? 0 : tokenCount,
            outputTokens: isOutput ? tokenCount : 0,
            totalTokens: tokenCount,
            timestamp: Date.now(),
        };
        this.recordUsage(usage);
        return usage;
    }

    /**
     * Get current state
     */
    getState(): ContextWindowState {
        const usagePercent = this.maxTokens > 0
            ? (this.currentTokens / this.maxTokens) * 100
            : 0;

        const threshold = this.maxTokens > 0
            ? getDynamicThresholdPercent(this.maxTokens * 0.7)
            : 80;

        return {
            currentTokens: this.currentTokens,
            maxTokens: this.maxTokens,
            usagePercent,
            cleanupThreshold: threshold,
            needsCleanup: usagePercent >= threshold,
            agentUsage: new Map(this.agentUsage),
        };
    }

    /**
     * Get per-agent context states
     */
    getAgentContexts(): Map<string, AgentContextState> {
        return new Map(this.agentContexts);
    }

    /**
     * Get context state for a specific agent
     */
    getAgentContext(agentId: string): AgentContextState | undefined {
        return this.agentContexts.get(agentId);
    }

    /**
     * Check if an agent is approaching context limit
     */
    isAgentApproachingLimit(agentId: string, threshold = 0.8): boolean {
        const ctx = this.agentContexts.get(agentId);
        if (!ctx || ctx.maxTokens === 0) return false;
        return ctx.currentTokens / ctx.maxTokens >= threshold;
    }

    /**
     * Get remaining tokens
     */
    getRemainingTokens(): number {
        if (this.maxTokens === 0) return 0;
        return Math.max(0, this.maxTokens - this.currentTokens);
    }

    /**
     * Get remaining tokens for a specific agent
     */
    getAgentRemainingTokens(agentId: string): number {
        const ctx = this.agentContexts.get(agentId);
        if (!ctx || ctx.maxTokens === 0) return 0;
        return Math.max(0, ctx.maxTokens - ctx.currentTokens);
    }

    // =========================================================================
    // TokenLedgerInterface Implementation (for LangSmith integration)
    // =========================================================================

    /**
     * Record a token checkpoint from LangSmith callback
     * Implements TokenLedgerInterface.recordCheckpoint
     */
    recordCheckpoint(checkpoint: TokenCheckpoint): void {
        const usage: TokenUsage = {
            agentId: checkpoint.agentId,
            model: checkpoint.modelId,
            inputTokens: checkpoint.inputTokens,
            outputTokens: checkpoint.outputTokens,
            totalTokens: checkpoint.inputTokens + checkpoint.outputTokens,
            timestamp: checkpoint.timestamp,
        };
        this.recordUsage(usage);
    }

    /**
     * Get cumulative total tokens across all agents
     * Implements TokenLedgerInterface.getCumulativeTotal
     */
    getCumulativeTotal(): number {
        return this.currentTokens;
    }
}

// =============================================================================
// Sliding Window Helper
// =============================================================================

/**
 * Get a sliding window of recent messages
 * Keeps the system message and last N messages
 */
export function getSlidingWindow<T extends { role: string }>(
    messages: T[],
    windowSize: number = SLIDING_WINDOW_SIZE
): T[] {
    if (messages.length <= windowSize + 1) {
        return messages;
    }

    const systemMessage = messages[0]?.role === "system" ? [messages[0]] : [];
    const recentMessages = messages.slice(-windowSize);

    return [...systemMessage, ...recentMessages];
}
