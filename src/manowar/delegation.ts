/**
 * Agent Delegation
 * 
 * Handles direct HTTP calls to component agents for task delegation.
 * Follows the ExecutionPlan steps from planner.ts.
 * 
 * Key features:
 * - Direct HTTP POST to agent endpoints
 * - Follows PlanStep structure from planner
 * - Returns structured DelegationResult
 * - Uses agent-routes.ts endpoint format
 */

import type { PlanStep, ExecutionPlan } from "./planner.js";
import type { AgentCard, ManowarCard } from "./registry.js";

// =============================================================================
// Types
// =============================================================================

export interface DelegationResult {
    success: boolean;
    stepNumber: number;
    agentName: string;
    output: string;
    /** Total tokens used (input + output) */
    tokensUsed?: number;
    /** Input/prompt tokens (from agent response) */
    inputTokens?: number;
    /** Output/completion tokens (from agent response) */
    outputTokens?: number;
    error?: string;
    timing: {
        startedAt: number;
        completedAt: number;
        durationMs: number;
    };
}

export interface DelegationOptions {
    /** Timeout in ms (default: 120000) */
    timeout?: number;
    /** Payment context for x402 */
    paymentData?: string;
    /** Internal secret for bypassing payment */
    internalSecret?: string;
}

// =============================================================================
// Configuration
// =============================================================================

// Agent delegation calls go to MANOWAR SERVER (manowar.compose.market)
// The /agent/:wallet/chat endpoint is defined in agent-routes.ts on Manowar
const MANOWAR_URL = process.env.MANOWAR_URL || "https://manowar.compose.market";
const DEFAULT_TIMEOUT = 120000; // 2 minutes

// Internal secret for agent-to-agent calls (bypasses payment)
const MANOWAR_INTERNAL_SECRET = process.env.MANOWAR_INTERNAL_SECRET || `manowar-internal-${Date.now()}`;

// =============================================================================
// Core Delegation
// =============================================================================

/**
 * Call an agent directly via HTTP
 * 
 * Uses the /agent/:identifier/run endpoint from agent-routes.ts
 */
export async function callAgent(
    agentWallet: string,
    message: string,
    options: DelegationOptions = {}
): Promise<{ success: boolean; output: string; tokensUsed?: number; inputTokens?: number; outputTokens?: number; error?: string }> {
    const startedAt = Date.now();
    const timeout = options.timeout || DEFAULT_TIMEOUT;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const response = await fetch(`${MANOWAR_URL}/agent/${agentWallet}/chat`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(options.paymentData && { "PAYMENT-SIGNATURE": options.paymentData }),
                // Use internal secret to bypass payment for orchestrator-initiated calls
                "x-manowar-internal": options.internalSecret || MANOWAR_INTERNAL_SECRET,
            },
            body: JSON.stringify({ message }),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text().catch(() => "Unknown error");
            return {
                success: false,
                output: "",
                error: `Agent returned ${response.status}: ${errorText}`,
            };
        }

        const result = await response.json();

        // Extract token usage - agents should return usage.input_tokens/output_tokens
        const usage = result.usage || {};
        const inputTokens = usage.input_tokens || usage.prompt_tokens || usage.inputTokens;
        const outputTokens = usage.output_tokens || usage.completion_tokens || usage.outputTokens;
        const totalTokens = result.tokensUsed || usage.total_tokens || usage.totalTokens ||
            (inputTokens && outputTokens ? inputTokens + outputTokens : undefined);

        return {
            success: true,
            output: result.result || result.output || result.message || JSON.stringify(result),
            tokensUsed: totalTokens,
            inputTokens,
            outputTokens,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            success: false,
            output: "",
            error: errorMessage.includes("aborted") ? "Request timeout" : errorMessage,
        };
    }
}

/**
 * Delegate a plan step to an agent
 * 
 * @param step - PlanStep from planner.ts ExecutionPlan
 * @param agentCard - AgentCard with agent details (from manowarCard)
 * @param context - Additional context (prior step outputs)
 */
export async function delegatePlanStep(
    step: PlanStep,
    agentCard: AgentCard | undefined,
    context: { priorOutputs?: string[]; relevantContext?: string } = {},
    options: DelegationOptions = {}
): Promise<DelegationResult> {
    const startedAt = Date.now();
    // Prefer explicit wallet address from step, then from agentCard, then fallback to agentName
    const agentWallet = step.agentWallet || agentCard?.walletAddress || step.agentName;
    if (!agentWallet) {
        return {
            success: false,
            stepNumber: step.stepNumber,
            agentName: step.agentName,
            output: "",
            error: "Missing agent wallet address for delegation",
            timing: {
                startedAt,
                completedAt: Date.now(),
                durationMs: 0,
            },
        };
    }

    // Build the task message
    let message = step.task;
    if (step.expectedOutput) {
        message += `\n\nExpected output: ${step.expectedOutput}`;
    }
    if (context.priorOutputs?.length) {
        message += `\n\n## Prior context:\n${context.priorOutputs.join("\n---\n")}`;
    }
    if (context.relevantContext) {
        message += `\n\n## Relevant context:\n${context.relevantContext}`;
    }

    console.log(`[delegation] Step ${step.stepNumber}: Calling ${step.agentName} (${agentWallet?.slice(0, 8)}...)`);

    const result = await callAgent(agentWallet, message, options);
    const completedAt = Date.now();

    return {
        success: result.success,
        stepNumber: step.stepNumber,
        agentName: step.agentName,
        output: result.output,
        tokensUsed: result.tokensUsed,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        error: result.error,
        timing: {
            startedAt,
            completedAt,
            durationMs: completedAt - startedAt,
        },
    };
}
