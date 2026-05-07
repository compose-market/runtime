/**
 * Compose Agent Loop (cal) — typed step language for multi-step / multi-agent
 * workflows.
 *
 * The main agent emits a YAML/JSON document that the runtime interpreter
 * executes deterministically. Step dispatch is a closed-enum discriminated
 * union, so the model never wastes tokens parsing English instructions about
 * "how to use tools". Compare with prompt-driven loops in Claude Code / Manus
 * (~500-2000 tokens/step parsing rules) — `cal` dispatch is 0 tokens / step.
 *
 * Discipline:
 *  - Budgets are runtime units only: maxToolBatches, maxTokens, maxWallMs,
 *    maxDepth. No price/USDC/wei fields. Pricing belongs in api/.
 *  - Every result is JSON-serializable (we round-trip through the interpreter
 *    and the agent's saveAs context).
 *  - References use {{stepId.path}} mustache syntax resolved by the
 *    interpreter, not by the LLM.
 */
import type { AgentExecutionContext } from "../agent/context.js";

// ---------------------------------------------------------------------------
// Budgets & references
// ---------------------------------------------------------------------------

/**
 * Runtime budget for a sub-agent / cal step. None of these are price-aware.
 * Hard caps protect the parent run from runaway children.
 */
export interface HarnessBudget {
    /** Max tool batches (one batch = one assistant message with >=1 tool_call). */
    maxToolBatches?: number;
    /** Max accumulated tokens (input + output + reasoning) for this run. */
    maxTokens?: number;
    /** Wallclock cap, milliseconds. */
    maxWallMs?: number;
    /** Recursion cap. Sub-agents called from sub-agents bound by this minus 1. */
    maxDepth?: number;
}

/** Default bounds applied when a CalStep / SubAgentSpec omits a budget field. */
export const DEFAULT_BUDGET: Required<HarnessBudget> = {
    maxToolBatches: 6,
    maxTokens: 80_000,
    maxWallMs: 5 * 60_000,
    maxDepth: 3,
};

/**
 * Tool-binding spec for a sub-agent. The sub-agent receives the *union* of:
 *   - composeTools listed by name (built-in compose_* tools the agent stack
 *     publishes to itself, e.g. compose_search, compose_fetch_url).
 *   - agentTools listed by registryId (the parent's own agentCard.plugins
 *     that we want the sub-agent to inherit).
 *   - semanticBind.query → top-K dynamic retrieval over the connectors
 *     catalog (Phase 2 wiring; the field is honored when the runtime has
 *     the connectors search client available).
 *   - memory tools (recall/remember) when memory:true.
 *   - knowledge tool (search_knowledge) when knowledge:true.
 */
export interface BindSpec {
    composeTools?: string[];
    agentTools?: string[];
    semanticBind?: { query: string; topK?: number };
    memory?: boolean;
    knowledge?: boolean;
}

// ---------------------------------------------------------------------------
// Cal step language
// ---------------------------------------------------------------------------

/**
 * Reference to a previously saved step output. Resolved by the interpreter,
 * not the LLM.
 *   "{{step1}}"             → entire saved value
 *   "{{step1.field}}"       → property
 *   "{{step1.list[0].name}}" → indexed traversal
 */
export type CalRef = string;

/** Common shape for steps that produce a saved value. */
interface SavedStep {
    saveAs: string;
}

/** `task` — spawn a focused sub-agent with a scoped tool subset. */
export interface CalStepTask extends SavedStep {
    op: "task";
    /** Specific model to drive the sub-agent. */
    model?: string;
    /** Optional sub-agent identity (any opaque string the host understands). */
    agentWallet?: string;
    /** What we want the sub-agent to do. */
    prompt: string | CalRef;
    /** Tool binding override. */
    bind?: BindSpec;
    /** Budget override. */
    budget?: HarnessBudget;
    /** Optional persona override. */
    systemPrompt?: string;
    /** When true, the sub-agent runs in a fresh Daytona sandbox. Default: false. */
    isolated?: boolean;
}

/** `delegate` — call a registered agent or raw model over the embedded runtime.
 *
 * The harness does NOT validate `agentWallet` shape. It can be a 0x-prefixed
 * EVM address, a model id, a DID, or any opaque string the host's resolveTools
 * callback understands. */
export interface CalStepDelegate extends SavedStep {
    op: "delegate";
    /** Opaque target identifier. Resolution semantics are owned by the host. */
    agentWallet: string;
    /** What to ask the delegate. */
    prompt: string | CalRef;
    /** Budget override (timeout + tool batches). */
    budget?: HarnessBudget;
    /** Override the driving model when the target is a raw model id. */
    model?: string;
}

/** `fanout` — execute branches with controlled concurrency. */
export interface CalStepFanout extends SavedStep {
    op: "fanout";
    /** Independent branches; each is a sequence of cal steps. */
    branches: Array<{ id: string; steps: CalStep[] }>;
    /**
     * `all`         → wait for every branch (resolves with array of results).
     * `any-success` → resolve with first successful, others abort.
     * `first`       → resolve with whichever finishes first (success or error).
     */
    gather?: "all" | "any-success" | "first";
    /** Concurrency cap. Default 4. */
    concurrency?: number;
}

/** `tool` — direct tool call, bypassing the LLM. Useful inside cal plans. */
export interface CalStepTool extends SavedStep {
    op: "tool";
    toolName: string;
    args?: Record<string, unknown>;
}

/** `search_tools` — semantic catalog search. */
export interface CalStepSearchTools extends SavedStep {
    op: "search_tools";
    query: string | CalRef;
    topK?: number;
}

/** `search_agents` — semantic agent-marketplace search. */
export interface CalStepSearchAgents extends SavedStep {
    op: "search_agents";
    query: string | CalRef;
    topK?: number;
}

/** `search_models` — Vectorized models.json discovery. */
export interface CalStepSearchModels extends SavedStep {
    op: "search_models";
    query: string | CalRef;
    topK?: number;
    /** Optional capability filter (e.g. "reasoning", "vision"). */
    capability?: string;
}

/** Conditional branching. cond is a JS expression evaluated against ctx.saved. */
export interface CalStepIf {
    op: "if";
    cond: string;
    then: CalStep[];
    else?: CalStep[];
}

/** Bounded loop. */
export interface CalStepLoop {
    op: "loop";
    while: string;
    do: CalStep[];
    maxIters?: number;
}

/** Per-run scratchpad. */
export interface CalStepScratch extends Partial<SavedStep> {
    op: "scratch";
    action: "write" | "read" | "list" | "delete";
    key?: string;
    value?: unknown;
}

/** LLM synthesis step over previously saved values. */
export interface CalStepSynthesize extends SavedStep {
    op: "synthesize";
    from: string[];
    instruction: string;
    model?: string;
}

/** Terminate the run with a final answer. */
export interface CalStepStop {
    op: "stop";
    output: string | CalRef;
    reason?: string;
}

/** Solicit input from the user (handled by the host; runtime returns the value). */
export interface CalStepAskUser extends SavedStep {
    op: "ask_user";
    question: string;
}

export type CalStep =
    | CalStepTask
    | CalStepDelegate
    | CalStepFanout
    | CalStepTool
    | CalStepSearchTools
    | CalStepSearchAgents
    | CalStepSearchModels
    | CalStepIf
    | CalStepLoop
    | CalStepScratch
    | CalStepSynthesize
    | CalStepStop
    | CalStepAskUser;

/** A cal plan is a list of steps. */
export interface CalPlan {
    /** Optional plan id (defaults to a generated nonce). */
    id?: string;
    /** Free-form description for traces. */
    description?: string;
    /** Top-level budget applied to the whole plan. */
    budget?: HarnessBudget;
    /** Steps. */
    steps: CalStep[];
    /**
     * When true, the harness boots ONE Daytona sandbox at plan start
     * and routes sandbox-aware tool calls (e.g. `compose_run_code`)
     * through it. The sandbox is destroyed at plan termination
     * (fire-and-forget). Default false.
     *
     * Decided per-plan, not per-agent — typically set by a plugin's
     * canned plan ("coding" / "data-analysis" / any plan that runs
     * untrusted user code) or by a UI-side user-approval gate.
     *
     * `CalPlan` and `CalRunResult.metadata.isolation` can prove
     * the plan ran with isolation requested. Sandbox boot/teardown
     * orchestration will lands alongside the `compose_run_code`
     * plugin migration — until then `compose_run_code` already runs
     * each call inside a fresh Daytona sandbox per-call.
     */
    requireIsolation?: boolean;
    /**
     * When true, the runtime accumulates a hash-based proof bundle
     * across plan execution (input/output/inference-run-id hashes,
     * sandbox metadata when isolated, EVM-signed by the api gateway's
     * signer) and pins it to IPFS via Pinata at plan termination. The
     * bundle's CID is returned on `CalRunResult.proofCid` for embedding
     * in receipts. Default false.
     */
    requireProof?: boolean;
}

// ---------------------------------------------------------------------------
// Sub-agent execution
// ---------------------------------------------------------------------------

/**
 * Strict sub-agent specification. The harness engine accepts this directly;
 * the cal interpreter constructs one from a `task` step.
 *
 * `agentWallet` is OPTIONAL and OPAQUE — the harness treats it as a label only.
 * When absent, a synthetic identity is derived from `parentRunId:subId` so
 * raw-model sub-agents work without any registration.
 */
export interface SubAgentSpec {
    /** Caller-provided run id; the harness will derive child runIds from it. */
    parentRunId: string;
    /** A short, human-readable id for the sub-agent (used in thread_id). */
    subId: string;
    /** Recursion depth (parent depth + 1). */
    depth: number;
    /** Optional opaque identity used by the sub-agent (no shape validation). */
    agentWallet?: string;
    /** Optional caller wallet (kept on context for memory scope). */
    userAddress?: string;
    /**
     * Layer-0 root composeRunId for the swarm. Children inherit it
     * unchanged so every layer shares the same workspace bus
     * (`harness/conclave.ts`). When omitted (only legitimate at the
     * top of a swarm), defaults to `parentRunId`.
     */
    rootComposeRunId?: string;
    /** Driving model. Required — caller decides; no defaults. */
    model: string;
    /** Optional persona override. */
    systemPrompt?: string;
    /** What to ask. */
    prompt: string;
    /** Tool binding. */
    bind?: BindSpec;
    /** Budget. */
    budget?: HarnessBudget;
    /** Cooperative cancellation. */
    abortSignal?: AbortSignal;
    /** When true, run inside a fresh Daytona sandbox via harness/sandbox.ts. */
    isolated?: boolean;
}

/** Single tool-call event captured during a sub-agent run. */
export interface SubAgentToolCall {
    name: string;
    args?: unknown;
    output?: unknown;
    failed?: boolean;
    error?: string;
}

/** Distilled answer + audit trail of a sub-agent run. */
export interface SubAgentResult {
    /** Whether the sub-agent terminated with a clean final answer. */
    success: boolean;
    /** The distilled final answer. Empty string when success=false. */
    output: string;
    /** Why it stopped: completed | budget | error | aborted | depth. */
    stopReason: SubAgentStopReason;
    /** Optional human-readable detail when stopReason !== "completed". */
    error?: string;
    /** All tool calls made by the sub-agent during this run. */
    toolCalls: SubAgentToolCall[];
    /** Aggregate token usage. */
    usage: {
        inputTokens: number;
        outputTokens: number;
        reasoningTokens: number;
        totalTokens: number;
    };
    /** Tool batches consumed. */
    toolBatches: number;
    /** Wall time, ms. */
    wallMs: number;
    /** Debug context for traces. */
    runKey: string;
    /** The parent->child run-key chain (for cancellation tree audits). */
    runKeyChain: string[];
}

export type SubAgentStopReason =
    | "completed"
    | "budget_tokens"
    | "budget_tool_batches"
    | "budget_wall"
    | "depth_exceeded"
    | "aborted"
    | "error";

// ---------------------------------------------------------------------------
// Cal interpreter context
// ---------------------------------------------------------------------------

/**
 * Lightweight view of the parent agent context the interpreter needs.
 * Borrowed from AgentExecutionContext (manowar/agent/context.ts) so we
 * don't re-derive fields the rest of the runtime already carries.
 */
export type ParentExecutionContext = AgentExecutionContext;

/** Scratchpad backend abstraction (Redis-backed in production). */
export interface HarnessScratchpad {
    write(key: string, value: unknown): Promise<void>;
    read(key: string): Promise<unknown | null>;
    list(): Promise<string[]>;
    delete(key: string): Promise<boolean>;
}

/** Result of a single cal step's execution. */
export interface CalStepResult {
    op: CalStep["op"];
    saveAs?: string;
    success: boolean;
    value?: unknown;
    error?: string;
    /** Optional sub-agent receipt when op was task/delegate/fanout. */
    subAgentResults?: SubAgentResult[];
}

/** Final result of executing a complete cal plan. */
export interface CalRunResult {
    success: boolean;
    /** Final answer (last `stop` step's output, or last savedAs value). */
    output: string;
    /** Per-step audit trail. */
    steps: CalStepResult[];
    /** Aggregated stop reason at the plan level. */
    stopReason: "completed" | "stop_op" | "error" | "aborted";
    error?: string;
    /** Aggregate over all sub-agents that ran inside this plan. */
    aggregateUsage: {
        inputTokens: number;
        outputTokens: number;
        reasoningTokens: number;
        totalTokens: number;
        toolCalls: number;
        toolBatches: number;
        wallMs: number;
    };
    /** Plan id used for traces / scratchpad scoping. */
    planId: string;
    /**
     * IPFS CID (v1) of the pinned proof bundle when the plan was run
     * with `requireProof: true`. Receipts embed this for verifiers.
     * Undefined when proof was not requested (or pinning failed —
     * pinning failure is logged but does not fail the plan).
     */
    proofCid?: string;
    /**
     * Convenience: full Pinata gateway URL for the proof CID. Computed
     * from `proofCid` + PINATA_GATEWAY_URL. Undefined when proofCid is.
     */
    proofUrl?: string;
}

// ---------------------------------------------------------------------------
// Run-key tree (cancellation propagation)
// ---------------------------------------------------------------------------

/**
 * Build a deterministic run-key for a sub-agent. Mirrors the convention used
 * in framework.ts:194 (buildRunKey) so the existing liveRunControllers map
 * can hold both parent and child controllers without collision.
 */
export function buildSubAgentRunKey(parentRunId: string, subId: string, depth: number): string {
    return `sub:${parentRunId}:${subId}:d${depth}`;
}
