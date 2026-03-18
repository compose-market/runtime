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
import type { AgentCard, WorkflowCard } from "./registry.js";
import {
    buildEmbeddedRuntimeHeaders,
    requireEmbeddedRuntimeBaseUrl,
} from "../../auth.js";

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
    retryable?: boolean;
    failureCategory?: "timeout" | "rate_limit" | "transport" | "server" | "client" | "unknown";
    timing: {
        startedAt: number;
        completedAt: number;
        durationMs: number;
    };
}

export interface DelegationOptions {
    /** Timeout in ms (default: 120000) */
    timeout?: number;
    /** Correlation run ID for end-to-end observability */
    composeRunId?: string;
    /** Idempotency key to deduplicate retries */
    idempotencyKey?: string;
    /** End user wallet context for nested agent execution */
    userId?: string;
    /** Thread/session context from orchestrator request */
    threadId?: string;
    /** Workflow wallet */
    workflowWallet?: string;
    /** Browser/device permissions granted in parent session */
    grantedPermissions?: string[];
    /** Whether the parent request has an active authorized session */
    sessionActive?: boolean;
    /** Budget available to the parent request in USDC wei */
    sessionBudgetRemaining?: number | null;
}

// =============================================================================
// Configuration
// =============================================================================

// Agent delegation calls re-enter the embedded runtime workflow mount.
// The /agent/:wallet/chat endpoint is defined in moved agent-routes.ts.
const DEFAULT_TIMEOUT = 120000; // 2 minutes

function classifyFailure(status?: number, error?: string): { retryable: boolean; failureCategory: DelegationResult["failureCategory"] } {
    const message = (error || "").toLowerCase();
    if (message.includes("timeout") || message.includes("aborted")) {
        return { retryable: true, failureCategory: "timeout" };
    }
    if (status === 429) {
        return { retryable: true, failureCategory: "rate_limit" };
    }
    if (status && [500, 502, 503, 504].includes(status)) {
        return { retryable: true, failureCategory: "server" };
    }
    if (status && status >= 400 && status < 500) {
        return { retryable: false, failureCategory: "client" };
    }
    if (message.includes("econnreset") || message.includes("enotfound") || message.includes("network")) {
        return { retryable: true, failureCategory: "transport" };
    }
    return { retryable: false, failureCategory: "unknown" };
}

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
): Promise<{
    success: boolean;
    output: string;
    tokensUsed?: number;
    inputTokens?: number;
    outputTokens?: number;
    error?: string;
    retryable?: boolean;
    failureCategory?: DelegationResult["failureCategory"];
}> {
    const startedAt = Date.now();
    const timeout = options.timeout || DEFAULT_TIMEOUT;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const response = await fetch(`${requireEmbeddedRuntimeBaseUrl()}/agent/${agentWallet}/chat`, {
            method: "POST",
            headers: buildEmbeddedRuntimeHeaders({
                "Content-Type": "application/json",
                ...(options.userId ? { "x-session-user-address": options.userId } : {}),
                ...(typeof options.sessionActive === "boolean"
                    ? { "x-session-active": options.sessionActive ? "true" : "false" }
                    : {}),
                ...(typeof options.sessionBudgetRemaining === "number"
                    ? { "x-session-budget-remaining": String(Math.max(0, options.sessionBudgetRemaining)) }
                    : {}),
            }),
            body: JSON.stringify({
                message,
                threadId: options.threadId,
                workflowWallet: options.workflowWallet,
                grantedPermissions: options.grantedPermissions || [],
                composeRunId: options.composeRunId,
                userId: options.userId,
            }),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text().catch(() => "Unknown error");
            const failure = classifyFailure(response.status, errorText);
            return {
                success: false,
                output: "",
                error: `Agent returned ${response.status}: ${errorText}`,
                retryable: failure.retryable,
                failureCategory: failure.failureCategory,
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
        const failure = classifyFailure(undefined, errorMessage);
        return {
            success: false,
            output: "",
            error: errorMessage.includes("aborted") ? "Request timeout" : errorMessage,
            retryable: failure.retryable,
            failureCategory: failure.failureCategory,
        };
    }
}

/**
 * Delegate a plan step to an agent
 * 
 * @param step - PlanStep from planner.ts ExecutionPlan
 * @param agentCard - AgentCard with agent details (from workflowCard)
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
