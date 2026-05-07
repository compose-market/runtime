/**
 * Compose Agent Loop — typed step interpreter.
 *
 * Parses a cal plan (YAML or already-parsed object), validates it against
 * the typed schema, and dispatches each step deterministically. The model
 * never mediates step transitions — the interpreter is the entire control
 * plane between steps.
 *
 * Reference resolution: `{{stepId}}` and `{{stepId.path}}` are mustache-
 * style references resolved against the scope's saved values. Parsing is
 * intentionally restrictive (alphanumeric + dots + simple `[index]`) so we
 * never fall back to JS eval.
 */
import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type { DynamicStructuredTool } from "@langchain/core/tools";

import { runSubAgent, type RunSubAgentOptions } from "./engine.js";
import { runIsolatedSubAgent } from "./sandbox.js";
import { runParallel } from "./parallel.js";
import { createScratchpad } from "./scratchpad.js";
import { createCalCheckpointStore, type CalCheckpoint, type CalCheckpointStore } from "./checkpoint.js";
import {
    createProofAccumulator,
    hashValue,
    pinProofBundleToIPFS,
    signProofBundle,
    type ProofAccumulator,
} from "./proof.js";
import { ensureRegisteredAgent } from "./registry.js";
import { peekAgentIdentity, resolveAgentIdentity } from "../agent/identity.js";
import { buildPinataGatewayIpfsUrl } from "../../auth.js";
import { searchAgents, searchModels, searchTools } from "./discovery.js";
import {
    DEFAULT_BUDGET,
    type CalPlan,
    type CalRunResult,
    type CalStep,
    type CalStepDelegate,
    type CalStepFanout,
    type CalStepResult,
    type CalStepSearchAgents,
    type CalStepSearchModels,
    type CalStepSearchTools,
    type CalStepSynthesize,
    type CalStepTask,
    type CalStepTool,
    type HarnessBudget,
    type HarnessScratchpad,
    type ParentExecutionContext,
    type SubAgentResult,
    type SubAgentSpec,
} from "./types.js";

import { createModel } from "../framework.js";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

// ---------------------------------------------------------------------------
// Parsing & validation
// ---------------------------------------------------------------------------

const VALID_OPS: ReadonlySet<CalStep["op"]> = new Set([
    "task",
    "delegate",
    "fanout",
    "tool",
    "search_tools",
    "search_agents",
    "search_models",
    "if",
    "loop",
    "scratch",
    "synthesize",
    "stop",
    "ask_user",
]);

export class CalValidationError extends Error {
    constructor(message: string, public path: string) {
        super(`[cal:invalid] ${message} (at ${path})`);
        this.name = "CalValidationError";
    }
}

/** Parse a cal plan from YAML or JSON text, or accept a pre-parsed object. */
export function parseCalPlan(input: string | unknown): CalPlan {
    let raw: unknown;
    if (typeof input === "string") {
        try {
            raw = parseYaml(input, { strict: true });
        } catch (error) {
            throw new CalValidationError(
                `failed to parse YAML: ${error instanceof Error ? error.message : String(error)}`,
                "$",
            );
        }
    } else {
        raw = input;
    }
    return validateCalPlan(raw);
}

function validateCalPlan(raw: unknown): CalPlan {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new CalValidationError("plan must be an object with `steps`", "$");
    }
    const obj = raw as Record<string, unknown>;
    if (!Array.isArray(obj.steps)) {
        throw new CalValidationError("plan.steps must be an array", "$.steps");
    }
    const steps: CalStep[] = obj.steps.map((step, idx) => validateStep(step, `$.steps[${idx}]`));
    return {
        id: typeof obj.id === "string" && obj.id.length > 0 ? obj.id : `cal_${randomUUID().slice(0, 8)}`,
        description: typeof obj.description === "string" ? obj.description : undefined,
        budget: validateBudget(obj.budget, "$.budget"),
        steps,
        ...(typeof obj.requireIsolation === "boolean" ? { requireIsolation: obj.requireIsolation } : {}),
        ...(typeof obj.requireProof === "boolean" ? { requireProof: obj.requireProof } : {}),
    };
}

function validateBudget(raw: unknown, path: string): HarnessBudget | undefined {
    if (raw === undefined) return undefined;
    if (!raw || typeof raw !== "object") {
        throw new CalValidationError("budget must be an object", path);
    }
    const b = raw as Record<string, unknown>;
    return {
        maxToolBatches: numOrUndefined(b.maxToolBatches, `${path}.maxToolBatches`),
        maxTokens: numOrUndefined(b.maxTokens, `${path}.maxTokens`),
        maxWallMs: numOrUndefined(b.maxWallMs, `${path}.maxWallMs`),
        maxDepth: numOrUndefined(b.maxDepth, `${path}.maxDepth`),
    };
}

function numOrUndefined(value: unknown, path: string): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new CalValidationError("must be a non-negative finite number", path);
    }
    return value;
}

function strField(value: unknown, path: string, required: boolean = true): string | undefined {
    if (value === undefined || value === null) {
        if (required) throw new CalValidationError("required string field", path);
        return undefined;
    }
    if (typeof value !== "string" || value.length === 0) {
        throw new CalValidationError("must be a non-empty string", path);
    }
    return value;
}

function validateStep(raw: unknown, path: string): CalStep {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new CalValidationError("step must be an object", path);
    }
    const obj = raw as Record<string, unknown>;
    const op = obj.op;
    if (typeof op !== "string" || !VALID_OPS.has(op as CalStep["op"])) {
        throw new CalValidationError(`unknown op: ${String(op)}`, `${path}.op`);
    }

    switch (op as CalStep["op"]) {
        case "task": {
            return {
                op: "task",
                saveAs: strField(obj.saveAs, `${path}.saveAs`)!,
                model: strField(obj.model, `${path}.model`, false),
                agentWallet: strField(obj.agentWallet, `${path}.agentWallet`, false),
                prompt: strField(obj.prompt, `${path}.prompt`)!,
                bind: validateBind(obj.bind, `${path}.bind`),
                budget: validateBudget(obj.budget, `${path}.budget`),
                systemPrompt: strField(obj.systemPrompt, `${path}.systemPrompt`, false),
                isolated: typeof obj.isolated === "boolean" ? obj.isolated : false,
            };
        }
        case "delegate": {
            return {
                op: "delegate",
                saveAs: strField(obj.saveAs, `${path}.saveAs`)!,
                agentWallet: strField(obj.agentWallet, `${path}.agentWallet`)!,
                prompt: strField(obj.prompt, `${path}.prompt`)!,
                budget: validateBudget(obj.budget, `${path}.budget`),
                model: strField(obj.model, `${path}.model`, false),
            };
        }
        case "fanout": {
            const branches = Array.isArray(obj.branches) ? obj.branches : null;
            if (!branches) throw new CalValidationError("fanout.branches must be an array", `${path}.branches`);
            return {
                op: "fanout",
                saveAs: strField(obj.saveAs, `${path}.saveAs`)!,
                branches: branches.map((b, i) => {
                    if (!b || typeof b !== "object") {
                        throw new CalValidationError("branch must be an object", `${path}.branches[${i}]`);
                    }
                    const br = b as Record<string, unknown>;
                    if (!Array.isArray(br.steps)) {
                        throw new CalValidationError("branch.steps required", `${path}.branches[${i}].steps`);
                    }
                    return {
                        id: strField(br.id, `${path}.branches[${i}].id`, false) ?? `branch_${i}`,
                        steps: br.steps.map((s, j) => validateStep(s, `${path}.branches[${i}].steps[${j}]`)),
                    };
                }),
                gather: validateGather(obj.gather, `${path}.gather`),
                concurrency: numOrUndefined(obj.concurrency, `${path}.concurrency`),
            };
        }
        case "tool": {
            return {
                op: "tool",
                saveAs: strField(obj.saveAs, `${path}.saveAs`)!,
                toolName: strField(obj.toolName, `${path}.toolName`)!,
                args: typeof obj.args === "object" && obj.args !== null && !Array.isArray(obj.args)
                    ? (obj.args as Record<string, unknown>)
                    : undefined,
            };
        }
        case "search_tools":
        case "search_agents":
        case "search_models": {
            const base = {
                op,
                saveAs: strField(obj.saveAs, `${path}.saveAs`)!,
                query: strField(obj.query, `${path}.query`)!,
                topK: numOrUndefined(obj.topK, `${path}.topK`),
            };
            if (op === "search_models") {
                return {
                    ...base,
                    op: "search_models",
                    capability: strField(obj.capability, `${path}.capability`, false),
                };
            }
            return base as CalStepSearchTools | CalStepSearchAgents;
        }
        case "if": {
            if (!Array.isArray(obj.then)) throw new CalValidationError("if.then required", `${path}.then`);
            return {
                op: "if",
                cond: strField(obj.cond, `${path}.cond`)!,
                then: obj.then.map((s, i) => validateStep(s, `${path}.then[${i}]`)),
                else: Array.isArray(obj.else) ? obj.else.map((s, i) => validateStep(s, `${path}.else[${i}]`)) : undefined,
            };
        }
        case "loop": {
            if (!Array.isArray(obj.do)) throw new CalValidationError("loop.do required", `${path}.do`);
            return {
                op: "loop",
                while: strField(obj.while, `${path}.while`)!,
                do: obj.do.map((s, i) => validateStep(s, `${path}.do[${i}]`)),
                maxIters: numOrUndefined(obj.maxIters, `${path}.maxIters`),
            };
        }
        case "scratch": {
            const action = obj.action;
            if (action !== "write" && action !== "read" && action !== "list" && action !== "delete") {
                throw new CalValidationError(
                    "scratch.action must be one of write|read|list|delete",
                    `${path}.action`,
                );
            }
            return {
                op: "scratch",
                action,
                key: strField(obj.key, `${path}.key`, false),
                value: obj.value,
                saveAs: strField(obj.saveAs, `${path}.saveAs`, false),
            };
        }
        case "synthesize": {
            const from = obj.from;
            if (!Array.isArray(from) || from.some((f) => typeof f !== "string")) {
                throw new CalValidationError("synthesize.from must be a string array", `${path}.from`);
            }
            return {
                op: "synthesize",
                saveAs: strField(obj.saveAs, `${path}.saveAs`)!,
                from: from as string[],
                instruction: strField(obj.instruction, `${path}.instruction`)!,
                model: strField(obj.model, `${path}.model`, false),
            };
        }
        case "stop": {
            return {
                op: "stop",
                output: strField(obj.output, `${path}.output`)!,
                reason: strField(obj.reason, `${path}.reason`, false),
            };
        }
        case "ask_user": {
            return {
                op: "ask_user",
                saveAs: strField(obj.saveAs, `${path}.saveAs`)!,
                question: strField(obj.question, `${path}.question`)!,
            };
        }
    }
    throw new CalValidationError(`unhandled op ${op}`, `${path}.op`);
}

function validateGather(value: unknown, path: string): CalStepFanout["gather"] {
    if (value === undefined || value === null) return undefined;
    if (value === "all" || value === "any-success" || value === "first") return value;
    throw new CalValidationError("gather must be all|any-success|first", path);
}

function validateBind(value: unknown, path: string): CalStepTask["bind"] {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "object" || Array.isArray(value)) {
        throw new CalValidationError("bind must be an object", path);
    }
    const b = value as Record<string, unknown>;
    return {
        composeTools: Array.isArray(b.composeTools) ? (b.composeTools.filter((s): s is string => typeof s === "string")) : undefined,
        agentTools: Array.isArray(b.agentTools) ? (b.agentTools.filter((s): s is string => typeof s === "string")) : undefined,
        memory: typeof b.memory === "boolean" ? b.memory : undefined,
        knowledge: typeof b.knowledge === "boolean" ? b.knowledge : undefined,
        semanticBind: validateSemanticBind(b.semanticBind, `${path}.semanticBind`),
    };
}

function validateSemanticBind(value: unknown, path: string): { query: string; topK?: number } | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "object" || Array.isArray(value)) {
        throw new CalValidationError("semanticBind must be an object", path);
    }
    const v = value as Record<string, unknown>;
    return {
        query: strField(v.query, `${path}.query`)!,
        topK: numOrUndefined(v.topK, `${path}.topK`),
    };
}

// ---------------------------------------------------------------------------
// Reference resolution ({{stepId.path}})
// ---------------------------------------------------------------------------

const REF_RE = /\{\{\s*([a-zA-Z0-9_][a-zA-Z0-9_.\[\]]*)\s*\}\}/g;
const PATH_TOKEN = /([a-zA-Z0-9_]+)|\[(\d+)\]/g;

function resolvePath(root: Record<string, unknown>, path: string): unknown {
    const tokens: Array<string | number> = [];
    let match: RegExpExecArray | null;
    PATH_TOKEN.lastIndex = 0;
    while ((match = PATH_TOKEN.exec(path)) !== null) {
        tokens.push(match[1] ?? Number(match[2]));
    }
    let cursor: unknown = root;
    for (const token of tokens) {
        if (cursor === null || cursor === undefined) return undefined;
        if (typeof token === "number") {
            if (!Array.isArray(cursor)) return undefined;
            cursor = cursor[token];
        } else {
            if (typeof cursor !== "object") return undefined;
            cursor = (cursor as Record<string, unknown>)[token];
        }
    }
    return cursor;
}

function stringifyRef(value: unknown): string {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function resolveRefs(input: string, saved: Record<string, unknown>): string {
    if (!input.includes("{{")) return input;
    return input.replace(REF_RE, (_, path: string) => stringifyRef(resolvePath(saved, path)));
}

function resolveArgsRefs(args: unknown, saved: Record<string, unknown>): unknown {
    if (typeof args === "string") return resolveRefs(args, saved);
    if (Array.isArray(args)) return args.map((a) => resolveArgsRefs(a, saved));
    if (args && typeof args === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
            out[k] = resolveArgsRefs(v, saved);
        }
        return out;
    }
    return args;
}

// ---------------------------------------------------------------------------
// Condition evaluator (safe: tiny grammar, no eval)
// ---------------------------------------------------------------------------

/**
 * Tiny safe condition evaluator. Supports:
 *   - "{{ref}}"
 *   - "{{ref}} == value", "!= value"
 *   - "{{ref}} > num", "<", ">=", "<="
 *   - boolean coercion of single ref
 *   - && and || combinators
 * Anything more is a deliberate no-go; if you need full logic, write it in a
 * `task` step and let the LLM decide.
 */
function evalCondition(expr: string, saved: Record<string, unknown>): boolean {
    const orParts = expr.split("||").map((s) => s.trim());
    return orParts.some((part) => part.split("&&").map((s) => s.trim()).every((atom) => evalAtom(atom, saved)));
}

function evalAtom(atom: string, saved: Record<string, unknown>): boolean {
    const m = atom.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
    if (!m) {
        const value = resolveExprValue(atom, saved);
        return Boolean(value);
    }
    const left = resolveExprValue(m[1].trim(), saved);
    const right = parseLiteral(m[3].trim(), saved);
    switch (m[2]) {
        case "==": return left === right;
        case "!=": return left !== right;
        case ">": return Number(left) > Number(right);
        case "<": return Number(left) < Number(right);
        case ">=": return Number(left) >= Number(right);
        case "<=": return Number(left) <= Number(right);
    }
    return false;
}

function resolveExprValue(expr: string, saved: Record<string, unknown>): unknown {
    const refMatch = expr.match(/^\{\{\s*([a-zA-Z0-9_][a-zA-Z0-9_.\[\]]*)\s*\}\}$/);
    if (refMatch) return resolvePath(saved, refMatch[1]);
    return parseLiteral(expr, saved);
}

function parseLiteral(expr: string, saved: Record<string, unknown>): unknown {
    const refMatch = expr.match(/^\{\{\s*([a-zA-Z0-9_][a-zA-Z0-9_.\[\]]*)\s*\}\}$/);
    if (refMatch) return resolvePath(saved, refMatch[1]);
    if (expr === "true") return true;
    if (expr === "false") return false;
    if (expr === "null") return null;
    const num = Number(expr);
    if (!Number.isNaN(num) && /^-?\d+(\.\d+)?$/.test(expr)) return num;
    if ((expr.startsWith('"') && expr.endsWith('"')) || (expr.startsWith("'") && expr.endsWith("'"))) {
        return expr.slice(1, -1);
    }
    return expr;
}

// ---------------------------------------------------------------------------
// Aggregate usage
// ---------------------------------------------------------------------------

function emptyAggregate(): CalRunResult["aggregateUsage"] {
    return { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, toolCalls: 0, toolBatches: 0, wallMs: 0 };
}

function addUsage(agg: CalRunResult["aggregateUsage"], r: SubAgentResult): void {
    agg.inputTokens += r.usage.inputTokens;
    agg.outputTokens += r.usage.outputTokens;
    agg.reasoningTokens += r.usage.reasoningTokens;
    agg.totalTokens += r.usage.totalTokens;
    agg.toolCalls += r.toolCalls.length;
    agg.toolBatches += r.toolBatches;
    agg.wallMs += r.wallMs;
}

// ---------------------------------------------------------------------------
// Interpreter
// ---------------------------------------------------------------------------

export interface InterpreterContext {
    /** Required: the parent agent's wallet (used for scratchpad scoping). */
    agentWallet: string;
    /** Required: parent run id (used for scratchpad scoping + sub-agent runKey). */
    composeRunId: string;
    /**
     * Layer-0 root composeRunId for the swarm. Defaults to `composeRunId`
     * when omitted (top-of-swarm case). Sub-agents at depth-N inherit
     * this unchanged so all layers share the same workspace bus
     * (`harness/conclave.ts`). Critical for cross-layer artifact
     * coordination during depth-3 a2a swarms.
     */
    rootComposeRunId?: string;
    /** Caller wallet inherited by sub-agents. */
    userAddress?: string;
    /** Tool resolver (engine.RunSubAgentOptions.resolveTools). */
    resolveTools: RunSubAgentOptions["resolveTools"];
    /** Optional parent execution context for sub-agent context propagation. */
    parentExecutionContext?: ParentExecutionContext;
    /** Direct tool registry for `op: tool`. Map by tool name. */
    directTools?: Map<string, DynamicStructuredTool>;
    /** Cooperative cancel. */
    abortSignal?: AbortSignal;
    /** Scratchpad override (default: Redis-backed). */
    scratchpad?: HarnessScratchpad;
    /** Plain handler for `ask_user` — defaults to error if absent. */
    askUser?: (question: string) => Promise<string>;
    /** Parent run-key chain for cancellation tree audits. */
    parentRunKeyChain?: string[];
    /** Recursion depth in the cal interpreter itself (sub-cal-from-task). */
    interpreterDepth?: number;
    /**
     * Step-by-step checkpoint store. When provided (or when
     * `enableCheckpoints` is true and the host wants the default Redis
     * store), the interpreter saves a `CalCheckpoint` after every step
     * and skips already-completed steps on resume. Cleared on terminal
     * completion.
     *
     * Disabled by default for sub-cal recursion (`interpreterDepth > 0`)
     * and for if/loop blocks — only the top-level plan checkpoints, so
     * resume is deterministic.
     */
    checkpointStore?: CalCheckpointStore;
    /**
     * Convenience flag: when true and `checkpointStore` is omitted, the
     * interpreter creates a default Redis-backed store keyed by
     * (agentWallet, composeRunId).
     */
    enableCheckpoints?: boolean;
    /**
     * When true, skip the registered-agent validation for `task` /
     * `delegate` / fanout-task steps. Default: false (enforce).
     *
     * Compose's a2a contract requires every swarm participant to be a
     * registered on-chain agent — the validator hits
     * `GET ${API_URL}/agent/${wallet}` and rejects unregistered or
     * malformed identities. Tests / dev hosts that don't have a live
     * agents endpoint can set this to true to bypass.
     */
    skipAgentRegistryCheck?: boolean;
}

/** Execute a cal plan end-to-end. */
export async function runCalPlan(plan: CalPlan, ctx: InterpreterContext): Promise<CalRunResult> {
    const planId = plan.id ?? `cal_${randomUUID().slice(0, 8)}`;
    const interpreterDepth = ctx.interpreterDepth ?? 0;

    // Checkpointing is keyed by (agentWallet, composeRunId). Each cal-plan
    // run at every swarm depth has a UNIQUE pair because each a2a hop
    // produces a fresh composeRunId derived from the (parent_agent,
    // child_agent) negotiation — see harness/engine.ts. So layer-0,
    // layer-1, layer-2 sub-agents ALL get their own checkpoint.
    //
    // The ONE exception: inline cal recursion via if/loop/inline-fanout
    // shares the parent's composeRunId. Those bump `interpreterDepth`
    // to mark "same plan, inner block" — we skip checkpointing there
    // because the parent's step result already captures the relevant
    // state. Only top-of-plan calls (`interpreterDepth === 0`) checkpoint.
    const checkpointStore = interpreterDepth === 0
        ? (ctx.checkpointStore ?? (ctx.enableCheckpoints
            ? createCalCheckpointStore({ agentWallet: ctx.agentWallet, composeRunId: ctx.composeRunId })
            : undefined))
        : undefined;

    // Resume detection: if a prior run wrote a checkpoint with the same
    // planId, replay state into our local vars and skip ahead.
    const resumed = checkpointStore ? await checkpointStore.load() : null;
    const resumedSamePlan = resumed && resumed.planId === planId ? resumed : null;

    const saved: Record<string, unknown> = resumedSamePlan ? { ...resumedSamePlan.saved } : {};
    const stepResults: CalStepResult[] = resumedSamePlan ? [...resumedSamePlan.steps] : [];
    const aggregate: CalRunResult["aggregateUsage"] = resumedSamePlan
        ? { ...resumedSamePlan.aggregateUsage }
        : emptyAggregate();
    const startIndex = resumedSamePlan ? resumedSamePlan.completedStepIndex + 1 : 0;

    const scratchpad = ctx.scratchpad ?? createScratchpad({
        agentWallet: ctx.agentWallet,
        composeRunId: ctx.composeRunId,
    });
    const planBudget = plan.budget;

    // Proof accumulation. Only the top-of-plan call records
    // — inner cal recursion (interpreterDepth > 0) skips so we don't
    // double-count steps from inline if/loop/inline-fanout blocks.
    const planStartedAt = Date.now();
    const proof: ProofAccumulator | undefined = (interpreterDepth === 0 && plan.requireProof === true)
        ? createProofAccumulator({
            planId,
            composeRunId: ctx.composeRunId,
            rootComposeRunId: ctx.rootComposeRunId ?? ctx.composeRunId,
            agentWallet: ctx.agentWallet,
            userAddress: ctx.userAddress,
            startedAt: planStartedAt,
            planHash: hashValue(plan),
        })
        : undefined;

    if (interpreterDepth > (planBudget?.maxDepth ?? DEFAULT_BUDGET.maxDepth)) {
        return {
            success: false,
            output: "",
            steps: [],
            stopReason: "error",
            error: "interpreter recursion depth exceeded",
            aggregateUsage: aggregate,
            planId,
        };
    }

    let stopOutput = "";
    let stopReason: CalRunResult["stopReason"] = "completed";
    let runError: string | undefined;

    try {
        outer: for (let i = startIndex; i < plan.steps.length; i += 1) {
            if (ctx.abortSignal?.aborted) {
                stopReason = "aborted";
                runError = "interpreter aborted";
                break;
            }
            const step = plan.steps[i];
            const result = await executeStep(step, {
                planBudget,
                planId,
                saved,
                aggregate,
                scratchpad,
                ctx,
            });
            stepResults.push(result);

            if (result.saveAs) {
                saved[result.saveAs] = result.value;
            }

            // Record proof contribution for this step. We hash the
            // step's input (the step itself, with refs unresolved — the
            // canonical plan-time form) and its output (saved value).
            // Inference run ids are pulled from sub-agent results when
            // present (task / delegate / fanout) so the bundle can
            // x-ref the x402 receipts that settled them.
            if (proof) {
                const inferenceRunIds = (result.subAgentResults ?? [])
                    .map((r) => r.runKey)
                    .filter((id): id is string => typeof id === "string" && id.length > 0);
                proof.recordStep({
                    index: i,
                    op: step.op,
                    saveAs: result.saveAs,
                    inputHash: hashValue(step),
                    outputHash: hashValue(result.value),
                    success: result.success,
                    invokedTool: step.op === "tool" ? (step as { toolName?: string }).toolName : undefined,
                    inferenceRunIds: inferenceRunIds.length > 0 ? inferenceRunIds : undefined,
                });
            }

            // Checkpoint after every NON-TERMINAL step (success only).
            // Skipping terminal saves means a resume never sees a "completed"
            // checkpoint that has nothing left to do — the clear() below
            // handles those. Persisting partial-failure state is also
            // skipped: an `error` step ends the run; the clear keeps Redis
            // tidy and a retry starts fresh.
            const willTerminate = step.op === "stop" || !result.success;
            if (checkpointStore && !willTerminate) {
                const snapshot: CalCheckpoint = {
                    planId,
                    composeRunId: ctx.composeRunId,
                    completedStepIndex: i,
                    steps: stepResults,
                    saved,
                    aggregateUsage: aggregate,
                    updatedAt: Date.now(),
                };
                // Fire-and-forget: a checkpoint write failure must not
                // block plan progress. Operators see a warn log instead.
                void checkpointStore.save(snapshot).catch((error) => {
                    console.warn(
                        `[harness:checkpoint] save failed for plan ${planId}: ${error instanceof Error ? error.message : String(error)}`,
                    );
                });
            }

            if (step.op === "stop") {
                stopOutput = result.value as string;
                stopReason = "stop_op";
                break outer;
            }

            if (!result.success) {
                stopReason = "error";
                runError = result.error;
                break outer;
            }
        }

        if (stopReason === "completed" && stepResults.length > 0) {
            // Default final answer = the last savedAs string-coerced.
            const last = stepResults[stepResults.length - 1];
            if (typeof last.value === "string") stopOutput = last.value;
            else stopOutput = stringifyRef(last.value);
        }
    } catch (error) {
        stopReason = "error";
        runError = error instanceof Error ? error.message : String(error);
    }

    // Clear the checkpoint on any terminal outcome — completed, stop_op,
    // error, aborted. We never persist partial-failure state (see the
    // save-skip logic above), and on success there's nothing more to
    // resume. Aborted runs clear so a retry starts fresh; the caller
    // can re-snapshot and resume manually if needed by re-running with
    // the same composeRunId before the TTL expires.
    if (checkpointStore) {
        void checkpointStore.clear().catch(() => {
            // Cleanup failure is non-fatal; TTL will handle it.
        });
    }

    // Build + pin the proof bundle when requested. Pinning is awaited
    // (not fire-and-forget) so the CID can be returned on CalRunResult
    // and embedded in receipts. A pin failure logs and degrades to no
    // proofCid — it must NOT fail the plan itself.
    let proofCid: string | undefined;
    let proofUrl: string | undefined;
    if (proof) {
        try {
            const bundle = await signProofBundle(
                proof.build({ stopReason, finishedAt: Date.now() }),
            );
            const cid = await pinProofBundleToIPFS(bundle);
            if (cid) {
                proofCid = cid;
                try {
                    proofUrl = buildPinataGatewayIpfsUrl(cid);
                } catch {
                    // PINATA_GATEWAY_URL unset; CID still useful by itself.
                }
            }
        } catch (error) {
            console.warn(
                `[harness:proof] proof finalization failed for plan ${planId}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    return {
        success: stopReason === "completed" || stopReason === "stop_op",
        output: stopOutput,
        steps: stepResults,
        stopReason,
        error: runError,
        aggregateUsage: aggregate,
        planId,
        ...(proofCid ? { proofCid } : {}),
        ...(proofUrl ? { proofUrl } : {}),
    };
}

interface StepCtx {
    planBudget: HarnessBudget | undefined;
    planId: string;
    saved: Record<string, unknown>;
    aggregate: CalRunResult["aggregateUsage"];
    scratchpad: HarnessScratchpad;
    ctx: InterpreterContext;
}

async function executeStep(step: CalStep, sctx: StepCtx): Promise<CalStepResult> {
    try {
        switch (step.op) {
            case "task": return await execTask(step, sctx);
            case "delegate": return await execDelegate(step, sctx);
            case "fanout": return await execFanout(step, sctx);
            case "tool": return await execTool(step, sctx);
            case "search_tools": return await execSearchTools(step, sctx);
            case "search_agents": return await execSearchAgents(step, sctx);
            case "search_models": return await execSearchModels(step, sctx);
            case "if": return await execIf(step, sctx);
            case "loop": return await execLoop(step, sctx);
            case "scratch": return await execScratch(step, sctx);
            case "synthesize": return await execSynthesize(step, sctx);
            case "stop": return execStop(step, sctx);
            case "ask_user": return await execAskUser(step, sctx);
        }
    } catch (error) {
        return {
            op: step.op,
            saveAs: "saveAs" in step ? step.saveAs : undefined,
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Resolve the model id for a `task` / `delegate` / `synthesize` step.
 *
 * Resolution rules:
 *   - `task` / `delegate` → look up the registered agent's on-chain card.
 *     `peekAgentIdentity` (sync, in-memory cache) hits first; on miss we
 *     hydrate via `resolveAgentIdentity` (async IPFS round-trip). 
 *     The registry validator already guaranteed the agent is registered
 *     before we get here, so the model field is always populated for
 *     real production agents.
 *   - `synthesize` has no `agentWallet` — it's a coordinator-side glue
 *     call. It defaults this to a dynamic coordinator from
 *     `harness/coordinators.listAgenticCoordinators`. Today: returns
 *     undefined and the step fails with "model required".
 *   - `step.model` is preserved as an EXPLICIT override only — useful
 *     for ops debugging when an agent's card model is broken and we
 *     need to pin a known-good model temporarily. Production callers
 *     omit it and let the agent card own the contract.
 *
 * NO host `resolveModel` callback exists — agent cards are the single
 * source of truth. Raw model calls live in the `model_tool` plugin
 * where models are TOOLS, not swarm participants.
 */
async function resolveStepModel(
    op: "task" | "delegate" | "synthesize",
    explicit: string | undefined,
    agentWallet: string | undefined,
): Promise<string | undefined> {
    if (explicit && explicit.length > 0) return explicit;
    if (op === "synthesize") return undefined;
    if (!agentWallet || agentWallet.length === 0) return undefined;
    const cached = peekAgentIdentity(agentWallet);
    if (cached?.model && cached.model.length > 0) return cached.model;
    try {
        const identity = await resolveAgentIdentity(agentWallet);
        if (identity.model && identity.model.length > 0) return identity.model;
    } catch {
        // IPFS / registry failure — fall through to undefined; the step
        // returns a clean "model required" error.
    }
    return undefined;
}

async function execTask(step: CalStepTask, sctx: StepCtx): Promise<CalStepResult> {
    const subId = step.saveAs;
    const depth = (sctx.ctx.interpreterDepth ?? 0) + 1;
    const prompt = resolveRefs(step.prompt, sctx.saved);
    // Compose's agent-fabric thesis: every swarm participant is a
    // registered on-chain agent. Raw models are tools, not swarm peers.
    // Skip the registry check when the host disables it (tests / dev
    // hosts that don't need full a2a semantics).
    if (!sctx.ctx.skipAgentRegistryCheck) {
        try {
            await ensureRegisteredAgent("task", step.agentWallet);
        } catch (error) {
            return {
                op: "task",
                saveAs: step.saveAs,
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
    const model = await resolveStepModel("task", step.model, step.agentWallet);
    if (!model) {
        return {
            op: "task",
            saveAs: step.saveAs,
            success: false,
            error: `task step "${step.saveAs}" requires a model (set step.model or supply InterpreterContext.resolveModel)`,
        };
    }
    const spec: SubAgentSpec = {
        parentRunId: sctx.ctx.composeRunId,
        rootComposeRunId: sctx.ctx.rootComposeRunId ?? sctx.ctx.composeRunId,
        subId,
        depth,
        agentWallet: step.agentWallet,
        userAddress: sctx.ctx.userAddress,
        model,
        systemPrompt: step.systemPrompt,
        prompt,
        bind: step.bind,
        budget: { ...step.budget, ...sctx.planBudget },
        abortSignal: sctx.ctx.abortSignal,
        isolated: step.isolated === true,
    };

    const result = step.isolated
        ? await runIsolatedSubAgent(spec, runOptionsFromCtx(sctx.ctx))
        : await runSubAgent(spec, runOptionsFromCtx(sctx.ctx));

    addUsage(sctx.aggregate, result);

    return {
        op: "task",
        saveAs: step.saveAs,
        success: result.success,
        value: result.success ? result.output : undefined,
        error: result.success ? undefined : result.error ?? result.stopReason,
        subAgentResults: [result],
    };
}

async function execDelegate(step: CalStepDelegate, sctx: StepCtx): Promise<CalStepResult> {
    const subId = step.saveAs;
    const depth = (sctx.ctx.interpreterDepth ?? 0) + 1;
    const prompt = resolveRefs(step.prompt, sctx.saved);
    // Same agent-only enforcement as `execTask` — see comment there.
    if (!sctx.ctx.skipAgentRegistryCheck) {
        try {
            await ensureRegisteredAgent("delegate", step.agentWallet);
        } catch (error) {
            return {
                op: "delegate",
                saveAs: step.saveAs,
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
    const model = await resolveStepModel("delegate", step.model, step.agentWallet);
    if (!model) {
        return {
            op: "delegate",
            saveAs: step.saveAs,
            success: false,
            error: `delegate step "${step.saveAs}" requires a model (set step.model or supply InterpreterContext.resolveModel)`,
        };
    }
    const spec: SubAgentSpec = {
        parentRunId: sctx.ctx.composeRunId,
        rootComposeRunId: sctx.ctx.rootComposeRunId ?? sctx.ctx.composeRunId,
        subId,
        depth,
        agentWallet: step.agentWallet,
        userAddress: sctx.ctx.userAddress,
        model,
        prompt,
        budget: { ...step.budget, ...sctx.planBudget },
        abortSignal: sctx.ctx.abortSignal,
        isolated: false,
    };
    const result = await runSubAgent(spec, runOptionsFromCtx(sctx.ctx));
    addUsage(sctx.aggregate, result);
    return {
        op: "delegate",
        saveAs: step.saveAs,
        success: result.success,
        value: result.success ? result.output : undefined,
        error: result.success ? undefined : result.error ?? result.stopReason,
        subAgentResults: [result],
    };
}

async function execFanout(step: CalStepFanout, sctx: StepCtx): Promise<CalStepResult> {
    // Each branch is a mini cal plan. We flatten branch outputs into an
    // array preserving the input order. Failed branches show up as
    // {success:false, error:...} entries.
    const branchSpecs: SubAgentSpec[] = [];
    const inlineBranches: Array<{ id: string; steps: CalStep[]; index: number }> = [];

    // We support two shapes per branch:
    //   - Single `task` step → run as a sub-agent (cheap).
    //   - Multi-step → recurse the cal interpreter inside a child run.
    let branchModelMissing: { branchId: string; saveAs: string } | null = null;
    let branchUnregistered: { branchId: string; saveAs: string; wallet: string; error: string } | null = null;
    for (let idx = 0; idx < step.branches.length; idx += 1) {
        const branch = step.branches[idx];
        if (branch.steps.length === 1 && branch.steps[0].op === "task") {
            const t = branch.steps[0] as CalStepTask;
            const prompt = resolveRefs(t.prompt, sctx.saved);
            // Agent-only enforcement: each fan-out task targets a registered
            // agent. Same contract as the standalone `execTask` path.
            if (!sctx.ctx.skipAgentRegistryCheck) {
                try {
                    await ensureRegisteredAgent("task", t.agentWallet);
                } catch (error) {
                    branchUnregistered ??= {
                        branchId: branch.id,
                        saveAs: t.saveAs,
                        wallet: t.agentWallet ?? "<missing>",
                        error: error instanceof Error ? error.message : String(error),
                    };
                    continue;
                }
            }
            const branchModel = await resolveStepModel("task", t.model, t.agentWallet);
            if (!branchModel) {
                branchModelMissing ??= { branchId: branch.id, saveAs: t.saveAs };
                continue;
            }
            branchSpecs.push({
                parentRunId: sctx.ctx.composeRunId,
                rootComposeRunId: sctx.ctx.rootComposeRunId ?? sctx.ctx.composeRunId,
                subId: `${step.saveAs}:${branch.id}`,
                depth: (sctx.ctx.interpreterDepth ?? 0) + 1,
                agentWallet: t.agentWallet,
                userAddress: sctx.ctx.userAddress,
                model: branchModel,
                systemPrompt: t.systemPrompt,
                prompt,
                bind: t.bind,
                budget: { ...t.budget, ...sctx.planBudget },
                isolated: t.isolated === true,
            });
        } else {
            inlineBranches.push({ id: branch.id, steps: branch.steps, index: idx });
        }
    }

    if (branchUnregistered) {
        return {
            op: "fanout",
            saveAs: step.saveAs,
            success: false,
            error: `fanout branch "${branchUnregistered.branchId}" task "${branchUnregistered.saveAs}": ${branchUnregistered.error}`,
        };
    }

    if (branchModelMissing) {
        return {
            op: "fanout",
            saveAs: step.saveAs,
            success: false,
            error: `fanout branch "${branchModelMissing.branchId}" task "${branchModelMissing.saveAs}" requires a model (set step.model or supply InterpreterContext.resolveModel)`,
        };
    }

    const outputs: unknown[] = new Array(step.branches.length).fill(undefined);
    const subResults: SubAgentResult[] = [];

    if (branchSpecs.length > 0) {
        const parallel = await runParallel(
            { specs: branchSpecs, gather: step.gather, concurrency: step.concurrency, abortSignal: sctx.ctx.abortSignal },
            runOptionsFromCtx(sctx.ctx),
        );
        // Branches were appended in the same order they appeared.
        let cursor = 0;
        for (let i = 0; i < step.branches.length; i += 1) {
            if (step.branches[i].steps.length === 1 && step.branches[i].steps[0].op === "task") {
                const r = parallel.results[cursor++];
                outputs[i] = r.success ? r.output : { error: r.error ?? r.stopReason };
                subResults.push(r);
                addUsage(sctx.aggregate, r);
            }
        }
    }

    for (const branch of inlineBranches) {
        const subPlan: CalPlan = {
            id: `${sctx.planId}:${branch.id}`,
            steps: branch.steps,
            budget: sctx.planBudget,
        };
        const result = await runCalPlan(subPlan, {
            ...sctx.ctx,
            interpreterDepth: (sctx.ctx.interpreterDepth ?? 0) + 1,
            parentRunKeyChain: [...(sctx.ctx.parentRunKeyChain ?? []), `cal:${sctx.planId}`],
        });
        outputs[branch.index] = result.success ? result.output : { error: result.error ?? result.stopReason };
        // Aggregate token usage from nested cal.
        sctx.aggregate.inputTokens += result.aggregateUsage.inputTokens;
        sctx.aggregate.outputTokens += result.aggregateUsage.outputTokens;
        sctx.aggregate.reasoningTokens += result.aggregateUsage.reasoningTokens;
        sctx.aggregate.totalTokens += result.aggregateUsage.totalTokens;
        sctx.aggregate.toolCalls += result.aggregateUsage.toolCalls;
        sctx.aggregate.toolBatches += result.aggregateUsage.toolBatches;
        sctx.aggregate.wallMs += result.aggregateUsage.wallMs;
    }

    return {
        op: "fanout",
        saveAs: step.saveAs,
        success: outputs.every((o) => !(o && typeof o === "object" && "error" in (o as Record<string, unknown>))),
        value: outputs,
        subAgentResults: subResults,
    };
}

async function execTool(step: CalStepTool, sctx: StepCtx): Promise<CalStepResult> {
    const tool = sctx.ctx.directTools?.get(step.toolName);
    if (!tool) {
        return {
            op: "tool",
            saveAs: step.saveAs,
            success: false,
            error: `tool not registered: ${step.toolName}`,
        };
    }
    const args = (resolveArgsRefs(step.args ?? {}, sctx.saved) as Record<string, unknown>) ?? {};
    const output = await tool.invoke(args);
    return { op: "tool", saveAs: step.saveAs, success: true, value: output };
}

async function execSearchTools(step: CalStepSearchTools, sctx: StepCtx): Promise<CalStepResult> {
    const q = resolveRefs(step.query, sctx.saved);
    const hits = await searchTools(q, step.topK);
    return { op: "search_tools", saveAs: step.saveAs, success: true, value: hits };
}

async function execSearchAgents(step: CalStepSearchAgents, sctx: StepCtx): Promise<CalStepResult> {
    const q = resolveRefs(step.query, sctx.saved);
    const hits = await searchAgents(q, step.topK);
    return { op: "search_agents", saveAs: step.saveAs, success: true, value: hits };
}

async function execSearchModels(step: CalStepSearchModels, sctx: StepCtx): Promise<CalStepResult> {
    const q = resolveRefs(step.query, sctx.saved);
    const hits = await searchModels(q, { topK: step.topK, capability: step.capability });
    return { op: "search_models", saveAs: step.saveAs, success: true, value: hits };
}

async function execIf(step: { op: "if"; cond: string; then: CalStep[]; else?: CalStep[] }, sctx: StepCtx): Promise<CalStepResult> {
    const taken = evalCondition(step.cond, sctx.saved) ? step.then : step.else ?? [];
    const subPlan: CalPlan = { id: `${sctx.planId}:if`, steps: taken };
    const result = await runCalPlan(subPlan, {
        ...sctx.ctx,
        interpreterDepth: (sctx.ctx.interpreterDepth ?? 0) + 1,
    });
    sctx.aggregate.inputTokens += result.aggregateUsage.inputTokens;
    sctx.aggregate.outputTokens += result.aggregateUsage.outputTokens;
    sctx.aggregate.reasoningTokens += result.aggregateUsage.reasoningTokens;
    sctx.aggregate.totalTokens += result.aggregateUsage.totalTokens;
    sctx.aggregate.toolCalls += result.aggregateUsage.toolCalls;
    sctx.aggregate.toolBatches += result.aggregateUsage.toolBatches;
    sctx.aggregate.wallMs += result.aggregateUsage.wallMs;
    return { op: "if", success: result.success, value: result.output, error: result.error };
}

async function execLoop(step: { op: "loop"; while: string; do: CalStep[]; maxIters?: number }, sctx: StepCtx): Promise<CalStepResult> {
    const maxIters = step.maxIters ?? 8;
    let iter = 0;
    while (iter < maxIters && evalCondition(step.while, sctx.saved)) {
        const subPlan: CalPlan = { id: `${sctx.planId}:loop:${iter}`, steps: step.do };
        const result = await runCalPlan(subPlan, {
            ...sctx.ctx,
            interpreterDepth: (sctx.ctx.interpreterDepth ?? 0) + 1,
        });
        sctx.aggregate.inputTokens += result.aggregateUsage.inputTokens;
        sctx.aggregate.outputTokens += result.aggregateUsage.outputTokens;
        sctx.aggregate.reasoningTokens += result.aggregateUsage.reasoningTokens;
        sctx.aggregate.totalTokens += result.aggregateUsage.totalTokens;
        sctx.aggregate.toolCalls += result.aggregateUsage.toolCalls;
        sctx.aggregate.toolBatches += result.aggregateUsage.toolBatches;
        sctx.aggregate.wallMs += result.aggregateUsage.wallMs;
        if (!result.success) {
            return { op: "loop", success: false, error: result.error, value: result.output };
        }
        iter += 1;
    }
    return { op: "loop", success: true, value: { iterations: iter } };
}

async function execScratch(step: { op: "scratch"; action: "write" | "read" | "list" | "delete"; key?: string; value?: unknown; saveAs?: string }, sctx: StepCtx): Promise<CalStepResult> {
    switch (step.action) {
        case "write": {
            if (!step.key) return { op: "scratch", success: false, error: "write requires key" };
            await sctx.scratchpad.write(step.key, resolveArgsRefs(step.value, sctx.saved));
            return { op: "scratch", saveAs: step.saveAs, success: true, value: true };
        }
        case "read": {
            if (!step.key) return { op: "scratch", success: false, error: "read requires key" };
            const value = await sctx.scratchpad.read(step.key);
            return { op: "scratch", saveAs: step.saveAs, success: true, value };
        }
        case "list": {
            const keys = await sctx.scratchpad.list();
            return { op: "scratch", saveAs: step.saveAs, success: true, value: keys };
        }
        case "delete": {
            if (!step.key) return { op: "scratch", success: false, error: "delete requires key" };
            const deleted = await sctx.scratchpad.delete(step.key);
            return { op: "scratch", saveAs: step.saveAs, success: true, value: deleted };
        }
    }
}

async function execSynthesize(step: CalStepSynthesize, sctx: StepCtx): Promise<CalStepResult> {
    const inputs = step.from
        .map((ref) => `### ${ref}\n${stringifyRef(sctx.saved[ref])}`)
        .join("\n\n");
    const modelId = await resolveStepModel("synthesize", step.model, undefined);
    if (!modelId) {
        return {
            op: "synthesize",
            saveAs: step.saveAs,
            success: false,
            error: `synthesize step "${step.saveAs}" requires a model (set step.model or supply InterpreterContext.resolveModel)`,
        };
    }
    const model = createModel(modelId, 0.2);
    const response = await model.invoke(
        [
            new SystemMessage("You are a synthesizer. Combine the input artifacts into a single coherent answer. Do not invent facts; only use what's provided."),
            new HumanMessage(`# INSTRUCTION\n${step.instruction}\n\n# INPUTS\n${inputs}`),
        ],
    );
    const content = typeof response.content === "string" ? response.content : stringifyRef(response.content);
    return { op: "synthesize", saveAs: step.saveAs, success: true, value: content };
}

function execStop(step: { op: "stop"; output: string; reason?: string }, sctx: StepCtx): CalStepResult {
    const value = resolveRefs(step.output, sctx.saved);
    return { op: "stop", success: true, value };
}

async function execAskUser(step: { op: "ask_user"; saveAs: string; question: string }, sctx: StepCtx): Promise<CalStepResult> {
    if (!sctx.ctx.askUser) {
        return { op: "ask_user", saveAs: step.saveAs, success: false, error: "no askUser handler installed" };
    }
    const value = await sctx.ctx.askUser(resolveRefs(step.question, sctx.saved));
    return { op: "ask_user", saveAs: step.saveAs, success: true, value };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runOptionsFromCtx(ctx: InterpreterContext): RunSubAgentOptions {
    return {
        resolveTools: ctx.resolveTools,
        parentExecutionContext: ctx.parentExecutionContext,
        parentRunKeyChain: ctx.parentRunKeyChain,
    };
}
