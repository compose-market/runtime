/**
 * Sub-agent execution engine.
 *
 * Compiles a fresh LangGraph for the sub-agent (separate checkpoint thread,
 * scoped tool subset, isolated memory scope), runs it under the parent's
 * AsyncLocalStorage context with overridden fields, and returns a distilled
 * answer + audit trail.
 *
 * "Logical isolation" by default: same Node process, fresh state. Physical
 * isolation (Daytona sandbox) is opt-in via spec.isolated and dispatched
 * through harness/sandbox.ts.
 *
 * Budget gates are runtime-only (tokens, tool batches, wall time, depth).
 * No cost / pricing logic lives here — that's api/'s responsibility.
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import type { DynamicStructuredTool } from "@langchain/core/tools";

import {
    createModel,
    registerRunAbortController,
    clearRunAbortController,
} from "../framework.js";
import { createAgentGraph } from "../agent/graph.js";
import { createKnowledgeTools, createMemoryTools } from "../agent/tools.js";
import { readToolCallsFromRecord } from "../agent/tool-calls.js";
import {
    runWithAgentExecutionContext,
    type AgentExecutionContext,
} from "../agent/context.js";
import {
    AgentMemoryTracker,
    extractTokens,
    resolveAuthoritativeTokens,
} from "../langsmith.js";
import {
    DEFAULT_BUDGET,
    buildSubAgentRunKey,
    type BindSpec,
    type HarnessBudget,
    type SubAgentResult,
    type SubAgentSpec,
    type SubAgentStopReason,
    type SubAgentToolCall,
} from "./types.js";

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function mergeBudget(spec?: HarnessBudget, fallback: HarnessBudget = DEFAULT_BUDGET): Required<HarnessBudget> {
    return {
        maxToolBatches: spec?.maxToolBatches ?? fallback.maxToolBatches ?? DEFAULT_BUDGET.maxToolBatches,
        maxTokens: spec?.maxTokens ?? fallback.maxTokens ?? DEFAULT_BUDGET.maxTokens,
        maxWallMs: spec?.maxWallMs ?? fallback.maxWallMs ?? DEFAULT_BUDGET.maxWallMs,
        maxDepth: spec?.maxDepth ?? fallback.maxDepth ?? DEFAULT_BUDGET.maxDepth,
    };
}

/**
 * Build the tool subset for the sub-agent based on the BindSpec. Each tool is
 * a LangChain DynamicStructuredTool so the existing LangGraph executor binds
 * them transparently.
 *
 * The bind is intentionally conservative:
 *  - memory:false by default (sub-agents are throwaway by design)
 *  - knowledge:false by default
 *  - composeTools / agentTools resolved by the parent's tool factory; we
 *    accept the resolved arrays directly via the `resolveTools` callback so
 *    callers (cal interpreter, harness host) own the sourcing policy.
 */
/**
 * Caller-supplied resolver shape. The engine treats `agentWallet` as an
 * opaque label; it can be empty, an EVM address, a model id, a DID, etc.
 */
export interface ResolveToolsContext {
    bind: BindSpec | undefined;
    agentWallet: string;
    userAddress?: string;
    /**
     * The parent's already-loaded tool catalog. The engine itself doesn't
     * know how to fetch MCP tools or compose_* tools — that's the cal
     * interpreter / harness host. The caller passes a resolver that returns
     * the sub-agent's tool subset given the BindSpec.
     */
    resolve: (input: {
        bind: BindSpec | undefined;
        agentWallet: string;
        userAddress?: string;
    }) => Promise<DynamicStructuredTool[]>;
}

async function buildSubAgentTools(ctx: ResolveToolsContext): Promise<DynamicStructuredTool[]> {
    const tools: DynamicStructuredTool[] = [];

    // Memory + knowledge tools are opt-in for sub-agents. We default to false
    // because nested research-style children should not pollute the parent's
    // long-term memory layers; persistence happens at the parent's turn.
    if (ctx.bind?.memory) {
        for (const tool of createMemoryTools(ctx.agentWallet, ctx.userAddress)) {
            tools.push(tool);
        }
    }
    if (ctx.bind?.knowledge) {
        // createKnowledgeTools expects a 0x-prefixed wallet for IPFS lookups.
        // The harness identity is opaque, so we cast here — knowledge tools
        // only do meaningful work when the caller supplied a real agent
        // wallet anyway. Non-hex identities will see empty knowledge results.
        for (const tool of createKnowledgeTools({
            agentWallet: { address: ctx.agentWallet as `0x${string}` },
            userAddress: ctx.userAddress,
        })) {
            tools.push(tool);
        }
    }

    // Caller-resolved tools (compose_*, agentCard.plugins, semantic-bind) get
    // appended. The resolver also dedupes by name on its own.
    const resolved = await ctx.resolve({
        bind: ctx.bind,
        agentWallet: ctx.agentWallet,
        userAddress: ctx.userAddress,
    });

    const seen = new Set(tools.map((t) => t.name));
    for (const tool of resolved) {
        if (!seen.has(tool.name)) {
            tools.push(tool);
            seen.add(tool.name);
        }
    }

    return tools;
}

function buildSubAgentExecutionContext(
    spec: SubAgentSpec,
    identity: string,
    threadId: string,
    parentCtx: AgentExecutionContext | undefined,
): AgentExecutionContext {
    // Layer-N inherits the swarm's layer-0 rootComposeRunId. Walking the
    // chain: spec.rootComposeRunId (when caller passed it) →
    // parentCtx.rootComposeRunId (when parent had one) → spec.parentRunId
    // (top-of-swarm fallback — the original user request id).
    const rootComposeRunId =
        spec.rootComposeRunId ?? parentCtx?.rootComposeRunId ?? spec.parentRunId;
    return {
        // Sub-agents always run in `local` memory mode keyed by an
        // (identity, parentRunId, subId) triple so memory isolation is
        // automatic and parent's global scope is untouched.
        mode: "local",
        composeRunId: `${spec.parentRunId}:${spec.subId}`,
        rootComposeRunId,
        threadId,
        agentWallet: identity,
        userAddress: spec.userAddress ?? parentCtx?.userAddress,
        haiId: `${spec.parentRunId}:${spec.subId}`,
        memoryPrompt: undefined,
        lastUserMessage: spec.prompt,
        // Inherit the parent's session view (cloud permissions, budget,
        // backpack accounts) so sub-agent tool calls see the same auth
        // surface as the coordinator without us having to plumb it
        // through SubAgentSpec. Phase 2.5: AsyncLocalStorage discipline.
        sessionContext: parentCtx?.sessionContext,
    };
}

// ---------------------------------------------------------------------------
// Tool-batch counting from final message stream
// ---------------------------------------------------------------------------

function countToolBatches(messages: unknown[]): number {
    let count = 0;
    for (const message of messages) {
        const m = message as { _getType?: () => string };
        const isAi = typeof m._getType === "function" && m._getType() === "ai";
        if (!isAi) continue;
        if (readToolCallsFromRecord(message).length > 0) count += 1;
    }
    return count;
}

function collectToolCalls(messages: unknown[]): SubAgentToolCall[] {
    const calls: SubAgentToolCall[] = [];
    const callById = new Map<string, { name: string; args?: unknown }>();
    for (const message of messages) {
        const m = message as {
            _getType?: () => string;
            tool_call_id?: string;
            name?: string;
            content?: unknown;
            status?: string;
        };
        const type = typeof m._getType === "function" ? m._getType() : "";
        if (type === "ai") {
            for (const call of readToolCallsFromRecord(message)) {
                callById.set(call.id, { name: call.name, args: call.args });
            }
        } else if (type === "tool" && typeof m.tool_call_id === "string") {
            const meta = callById.get(m.tool_call_id);
            const failed = m.status === "error" || (typeof m.content === "string" && /^Error:/i.test(m.content.trim()));
            calls.push({
                name: meta?.name ?? m.name ?? "tool",
                args: meta?.args,
                output: m.content,
                failed,
                ...(failed && typeof m.content === "string" ? { error: m.content } : {}),
            });
        }
    }
    return calls;
}

function lastAiText(messages: unknown[]): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i] as { _getType?: () => string; content?: unknown };
        const type = typeof m._getType === "function" ? m._getType() : "";
        if (type !== "ai") continue;
        if (typeof m.content === "string") return m.content;
        if (Array.isArray(m.content)) {
            return m.content
                .map((part) => {
                    const p = part as { type?: string; text?: string };
                    return p.type === "text" && typeof p.text === "string" ? p.text : "";
                })
                .filter(Boolean)
                .join("");
        }
    }
    return "";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunSubAgentOptions {
    /** Resolver for the bind spec. Required — engine never reaches into
     *  agent/tools.ts directly because that would create a circular dep when
     *  the cal interpreter wants to inject built-in tools. */
    resolveTools: ResolveToolsContext["resolve"];
    /** Optional parent runtime AsyncLocalStorage context (so userAddress
     *  propagates when the sub-agent is invoked from inside a parent agent's
     *  tool call). */
    parentExecutionContext?: AgentExecutionContext;
    /**
     * Parent's run-key chain for cancellation tree audits. The engine
     * appends the new child run-key and propagates it to nested runs.
     */
    parentRunKeyChain?: string[];
}

export async function runSubAgent(
    spec: SubAgentSpec,
    options: RunSubAgentOptions,
): Promise<SubAgentResult> {
    const startedAt = Date.now();
    const budget = mergeBudget(spec.budget);
    const runKey = buildSubAgentRunKey(spec.parentRunId, spec.subId, spec.depth);
    const runKeyChain = [...(options.parentRunKeyChain ?? []), runKey];

    // Identity is opaque to the harness. When the caller doesn't supply one,
    // synthesize a stable label from (parentRunId, subId) so memory scoping
    // and the AgentMemoryTracker still have a non-empty key. This works for
    // raw-model sub-agents that have no on-chain wallet.
    const identity = spec.agentWallet && spec.agentWallet.length > 0
        ? spec.agentWallet
        : `harness:${spec.parentRunId}:${spec.subId}`;

    // Depth gate before anything else.
    if (spec.depth > budget.maxDepth) {
        return {
            success: false,
            output: "",
            stopReason: "depth_exceeded",
            error: `Sub-agent depth ${spec.depth} exceeds budget.maxDepth ${budget.maxDepth}`,
            toolCalls: [],
            usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 },
            toolBatches: 0,
            wallMs: 0,
            runKey,
            runKeyChain,
        };
    }

    // Wire the abort controller (cooperative cancellation tree). External
    // signal -> internal controller, plus our own wallclock timeout.
    const controller = registerRunAbortController(runKey);
    const wallTimer = setTimeout(() => {
        try { controller.abort(new Error("[harness] wall budget exceeded")); } catch { /* noop */ }
    }, budget.maxWallMs);

    let externalUnsub: (() => void) | undefined;
    if (spec.abortSignal) {
        if (spec.abortSignal.aborted) {
            try { controller.abort(new Error("[harness] external abort")); } catch { /* noop */ }
        } else {
            const onAbort = () => {
                try { controller.abort(new Error("[harness] external abort")); } catch { /* noop */ }
            };
            spec.abortSignal.addEventListener("abort", onAbort, { once: true });
            externalUnsub = () => spec.abortSignal?.removeEventListener("abort", onAbort);
        }
    }

    try {
        // Threading: brand-new thread_id keeps the LangGraph checkpointer's
        // state for this sub-agent fully separate from the parent's.
        const threadId = `sub:${spec.parentRunId}:${spec.subId}:${randomUUID()}`;

        // Tools.
        const tools = await buildSubAgentTools({
            bind: spec.bind,
            agentWallet: identity,
            userAddress: spec.userAddress,
            resolve: options.resolveTools,
        });

        // Model. Driven through the same OpenAI-compatible client used by
        // createModel — the api gateway handles routing/billing. The runtime
        // never sees price.
        const model = createModel(spec.model, 0.4);

        // Fresh LangGraph compile, separate checkpoint dir slice keyed by
        // (parentRunId, subId) so this sub-agent can be replayed without
        // touching the parent's main thread.
        const checkpointDir = path.resolve(
            process.cwd(),
            "data",
            "checkpoints",
            "harness",
            spec.parentRunId,
        );
        const executor = createAgentGraph(
            model,
            tools,
            checkpointDir,
            spec.systemPrompt,
            undefined,
        );

        // Per-turn callbacks (token totals).
        const usageTracker = new AgentMemoryTracker(identity, threadId);

        // Build the typed sub-agent execution context. Session context
        // (cloud perms, budget, backpack) is inherited from the parent
        // via AsyncLocalStorage — see `buildSubAgentExecutionContext`.
        const childCtx = buildSubAgentExecutionContext(spec, identity, threadId, options.parentExecutionContext);

        // Run.
        const recursionLimit = Math.min(
            // Each tool batch is two graph nodes (model+tools), so allow ~3x.
            Math.max(12, budget.maxToolBatches * 3),
            500,
        );

        const messages: BaseMessage[] = [new HumanMessage(spec.prompt)];
        if (spec.systemPrompt) {
            // Inject persona override as a SystemMessage at the head; the
            // graph's callModel also injects it via `systemPrompt` arg, but
            // doing it here makes the first model call deterministic even if
            // the graph's static-prompt path is bypassed.
            messages.unshift(new SystemMessage(spec.systemPrompt));
        }

        let result: { messages?: unknown[] } | null = null;
        let stopReason: SubAgentStopReason = "completed";
        let invocationError: Error | null = null;

        try {
            result = await runWithAgentExecutionContext(childCtx, async () =>
                executor.invoke(
                    { messages },
                    {
                        configurable: {
                            thread_id: threadId,
                            recursionDepth: spec.depth,
                            maxRecursionDepth: budget.maxDepth,
                            startTime: startedAt,
                        },
                        callbacks: [usageTracker],
                        recursionLimit,
                        signal: controller.signal,
                    },
                ),
            ) as { messages?: unknown[] };
        } catch (error) {
            invocationError = error instanceof Error ? error : new Error(String(error));
            if (controller.signal.aborted) {
                const reason = controller.signal.reason instanceof Error
                    ? controller.signal.reason.message
                    : String(controller.signal.reason ?? "");
                if (reason.includes("wall")) stopReason = "budget_wall";
                else if (reason.includes("external")) stopReason = "aborted";
                else stopReason = "aborted";
            } else {
                stopReason = "error";
            }
        }

        const finalMessages = Array.isArray(result?.messages) ? result!.messages! : [];
        const toolBatches = countToolBatches(finalMessages);
        const toolCalls = collectToolCalls(finalMessages);

        // Token accounting via the existing AgentMemoryTracker + an
        // authoritative resolver.
        const trackedMetrics = usageTracker.getMetrics().contextMetrics;
        const tokens = resolveAuthoritativeTokens(
            result ?? { messages: [] },
            trackedMetrics
                ? {
                    inputTokens: trackedMetrics.inputTokens,
                    outputTokens: trackedMetrics.outputTokens,
                    reasoningTokens: 0,
                    totalTokens: trackedMetrics.totalTokens,
                }
                : null,
        );

        // Apply post-run budget gates. We deliberately enforce these AFTER
        // the run instead of mid-run (LangGraph's native recursionLimit + the
        // graph.ts MAX_TOOL_BATCHES_PER_TURN already give a per-turn bound;
        // these are aggregate sub-agent caps).
        let success = stopReason === "completed" && !invocationError;
        if (success && tokens.totalTokens > budget.maxTokens) {
            success = false;
            stopReason = "budget_tokens";
        } else if (success && toolBatches > budget.maxToolBatches) {
            success = false;
            stopReason = "budget_tool_batches";
        }

        const output = success ? lastAiText(finalMessages) : "";

        return {
            success,
            output,
            stopReason,
            error: invocationError?.message,
            toolCalls,
            usage: {
                inputTokens: tokens.inputTokens,
                outputTokens: tokens.outputTokens,
                reasoningTokens: tokens.reasoningTokens,
                totalTokens: tokens.totalTokens,
            },
            toolBatches,
            wallMs: Date.now() - startedAt,
            runKey,
            runKeyChain,
        };
    } finally {
        clearTimeout(wallTimer);
        if (externalUnsub) externalUnsub();
        clearRunAbortController(runKey);
    }
}
