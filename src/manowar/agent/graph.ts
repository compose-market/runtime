/**
 * Agent State Graph
 * 
 * Defines the LangGraph execution flow:
 * [Start] -> [Model] -> [Tools?] -> [Model] ... -> [End]
 */

import { StateGraph, MessagesAnnotation, START } from "@langchain/langgraph";
import { type BaseMessage, AIMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { DynamicStructuredTool } from "@langchain/core/tools";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { FileSystemCheckpointSaver } from "./checkpoint.js";
import type { RunnableConfig } from "@langchain/core/runnables";
import { readToolCallsFromRecord, type NormalizedToolCall } from "./tool-calls.js";

const TOOL_REPAIR_MARKER = "[compose:tool-repair]";
const MAX_TOOL_REPAIR_ATTEMPTS = 3;

/**
 * Per-turn budget gate.
 *
 * The previous design used a single hard cap (`MAX_TOOL_BATCHES_PER_TURN = 6`)
 * which was the load-bearing terminator and the SOTA bottleneck — Manus
 * averages ~50 tool calls per task, Codex runs hundreds. We've moved to a
 * three-axis budget that lets long-horizon tasks complete while keeping
 * runaway loops bounded:
 *
 *   1. WALL TIME ─ wall-clock cap from `configurable.startTime`. Default
 *      4 min so Cloud Run's 5-min window always settles. Override via
 *      `COMPOSE_AGENT_MAX_WALL_MS_PER_TURN`.
 *   2. CONSECUTIVE FAILURES ─ if the last N tool batches all errored, we
 *      stop. Distinct from `repairAttemptsExhausted`, which is repair-marker
 *      driven. Default 4. Override via
 *      `COMPOSE_AGENT_MAX_TOOL_FAILURES_IN_ROW`.
 *   3. SAFETY CEILING ─ a Manus-grade hard cap on total tool batches per
 *      turn (default 50). Override via
 *      `COMPOSE_AGENT_MAX_TOOL_BATCHES_PER_TURN`. Lower this for cost-
 *      sensitive deployments.
 *
 * Token budgets are NOT enforced here. `api/inference/metering.ts` +
 * x402 envelopes already cap spend per call; duplicating in the graph
 * would race the facilitator. Tokens-per-turn lives at the payment
 * boundary, batches at the loop boundary. Clean separation.
 */
const DEFAULT_MAX_WALL_MS_PER_TURN = 4 * 60_000;
const DEFAULT_MAX_TOOL_FAILURES_IN_ROW = 4;
const DEFAULT_MAX_TOOL_BATCHES_PER_TURN = 50;

function configuredMaxWallMs(): number {
    const parsed = Number.parseInt(process.env.COMPOSE_AGENT_MAX_WALL_MS_PER_TURN || "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_WALL_MS_PER_TURN;
}

function configuredMaxFailuresInRow(): number {
    const parsed = Number.parseInt(process.env.COMPOSE_AGENT_MAX_TOOL_FAILURES_IN_ROW || "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TOOL_FAILURES_IN_ROW;
}

function configuredMaxToolBatches(): number {
    const parsed = Number.parseInt(process.env.COMPOSE_AGENT_MAX_TOOL_BATCHES_PER_TURN || "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TOOL_BATCHES_PER_TURN;
}

// ----------------------------------------------------------------------------
// Stable tool binding (Manus / KV-cache discipline).
//
// We bind the FULL tool list every turn. The previous design re-scored and
// pruned to 12 tools per iteration, which mutated the bound-tool set across
// iterations of the same turn and invalidated the KV cache the model relies
// on for prompt-prefix reuse. Manus, deepagents, and Claude Code all keep
// bound tools stable; selection is constrained via system prompt + tool-name
// prefixes (e.g. `compose_*`, `memory_*`, `a2a_*`), not via mutation.
//
// If an agent legitimately has too many tools, cap at agent-build time in
// `createAgentTools` rather than per-turn here.
// ----------------------------------------------------------------------------

// ToolCallSnapshot was the previous local type; now uses the shared
// NormalizedToolCall from tool-calls.ts. Alias kept for in-file readability.
type ToolCallSnapshot = NormalizedToolCall;

type ToolFailureSnapshot = {
    toolName: string;
    args?: unknown;
    error: string;
    count: number;
};

function normalizeToolMessage(message: BaseMessage): BaseMessage {
    if (message._getType() !== "tool") {
        return message;
    }

    const toolCallId =
        (message as { tool_call_id?: unknown }).tool_call_id
        ?? (message as { lc_kwargs?: { tool_call_id?: unknown } }).lc_kwargs?.tool_call_id;

    if (typeof toolCallId !== "string" || toolCallId.length === 0) {
        return message;
    }

    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    const name =
        (message as { name?: unknown }).name
        ?? (message as { lc_kwargs?: { name?: unknown } }).lc_kwargs?.name;

    return new ToolMessage({
        content,
        tool_call_id: toolCallId,
        ...(typeof name === "string" && name.length > 0 ? { name } : {}),
    });
}

function messageType(message: BaseMessage): string {
    return message._getType?.() || "unknown";
}

function contentText(message: BaseMessage): string {
    const content = message.content;
    if (typeof content === "string") {
        return content;
    }
    try {
        return JSON.stringify(content);
    } catch {
        return "";
    }
}

function normalizeForSignature(value: unknown): string {
    if (typeof value === "string") {
        return value.replace(/\s+/g, " ").trim().slice(0, 600);
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function extractToolCalls(message: BaseMessage): ToolCallSnapshot[] {
    // Single source of truth for tool-call extraction.
    return readToolCallsFromRecord(message);
}

function toolCallId(message: BaseMessage): string | undefined {
    const candidate = message as {
        tool_call_id?: unknown;
        lc_kwargs?: { tool_call_id?: unknown };
    };
    const id = candidate.tool_call_id ?? candidate.lc_kwargs?.tool_call_id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
}

function toolName(message: BaseMessage, callById: Map<string, ToolCallSnapshot>): string {
    const candidate = message as {
        name?: unknown;
        lc_kwargs?: { name?: unknown };
    };
    const name = candidate.name ?? candidate.lc_kwargs?.name;
    if (typeof name === "string" && name.length > 0) {
        return name;
    }
    const id = toolCallId(message);
    return id ? callById.get(id)?.name ?? "tool" : "tool";
}

function isToolError(message: BaseMessage): boolean {
    if (messageType(message) !== "tool") {
        return false;
    }
    const candidate = message as { status?: unknown; lc_kwargs?: { status?: unknown } };
    const status = candidate.status ?? candidate.lc_kwargs?.status;
    if (status === "error") {
        return true;
    }
    return /^Error:/i.test(contentText(message).trim());
}

function lastUserTurnIndex(messages: BaseMessage[]): number {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messageType(messages[index]) === "human" && !contentText(messages[index]).includes(TOOL_REPAIR_MARKER)) {
            return index;
        }
    }
    return -1;
}

function currentTurnMessages(messages: BaseMessage[]): BaseMessage[] {
    return messages.slice(lastUserTurnIndex(messages) + 1);
}

function repairAttemptCount(messages: BaseMessage[]): number {
    return currentTurnMessages(messages).filter((message) => contentText(message).includes(TOOL_REPAIR_MARKER)).length;
}

function unresolvedPlaceholder(text: string): boolean {
    const normalized = text.toLowerCase();
    return normalized.includes("i'll get back to you")
        || normalized.includes("i will get back to you")
        || normalized.includes("bear with me")
        || normalized.includes("while i resolve")
        || normalized.includes("while i fix")
        || normalized.includes("experiencing an issue")
        || normalized.includes("encountering an issue");
}

function repeatedToolFailure(messages: BaseMessage[]): ToolFailureSnapshot | null {
    const currentTurn = currentTurnMessages(messages);
    const callById = new Map<string, ToolCallSnapshot>();
    for (const message of currentTurn) {
        for (const call of extractToolCalls(message)) {
            callById.set(call.id, call);
        }
    }

    const failures = new Map<string, ToolFailureSnapshot>();
    for (const message of currentTurn) {
        if (!isToolError(message)) {
            continue;
        }
        const id = toolCallId(message);
        const call = id ? callById.get(id) : undefined;
        const name = toolName(message, callById);
        const error = normalizeForSignature(contentText(message));
        const args = call?.args;
        const signature = `${name}:${normalizeForSignature(args)}:${error}`;
        const existing = failures.get(signature);
        if (existing) {
            existing.count += 1;
        } else {
            failures.set(signature, {
                toolName: name,
                args,
                error,
                count: 1,
            });
        }
    }

    const repeated = Array.from(failures.values())
        .filter((failure) => failure.count >= 2)
        .sort((left, right) => right.count - left.count)[0];
    return repeated ?? null;
}

function repairAttemptsExhausted(messages: BaseMessage[]): boolean {
    return repairAttemptCount(messages) >= MAX_TOOL_REPAIR_ATTEMPTS && repeatedToolFailure(messages) !== null;
}

/**
 * Count how many tool batches the model has issued in the current user turn.
 * A "batch" is one assistant message that emitted >= 1 tool_call.
 */
function toolBatchCount(messages: BaseMessage[]): number {
    let count = 0;
    for (const message of currentTurnMessages(messages)) {
        if (messageType(message) !== "ai") continue;
        if (extractToolCalls(message).length > 0) count += 1;
    }
    return count;
}

/**
 * Count consecutive failed tool batches at the tail of the current turn.
 * A "failed batch" is one whose tool messages contain at least one error.
 * Counting stops at the first successful batch (or non-tool message).
 */
function consecutiveFailedBatches(messages: BaseMessage[]): number {
    const turn = currentTurnMessages(messages);
    let count = 0;
    let i = turn.length - 1;
    while (i >= 0) {
        // Skip trailing AI messages without tool calls (model recovered).
        while (i >= 0 && messageType(turn[i]) !== "tool") i -= 1;
        if (i < 0) break;
        // Walk back through this batch's tool messages.
        let batchHasError = false;
        let batchStart = i;
        while (batchStart >= 0 && messageType(turn[batchStart]) === "tool") {
            if (isToolError(turn[batchStart])) batchHasError = true;
            batchStart -= 1;
        }
        if (batchHasError) {
            count += 1;
            i = batchStart;
        } else {
            // Found a successful batch — streak broken.
            break;
        }
    }
    return count;
}

type BudgetExhaustion = { kind: "wall"; elapsedMs: number; capMs: number }
    | { kind: "failures"; count: number; cap: number }
    | { kind: "batches"; count: number; cap: number };

function checkTurnBudget(messages: BaseMessage[], startTime: number | undefined): BudgetExhaustion | null {
    const wallCap = configuredMaxWallMs();
    if (typeof startTime === "number" && Number.isFinite(startTime)) {
        const elapsed = Date.now() - startTime;
        if (elapsed >= wallCap) {
            return { kind: "wall", elapsedMs: elapsed, capMs: wallCap };
        }
    }
    const failuresCap = configuredMaxFailuresInRow();
    const failures = consecutiveFailedBatches(messages);
    if (failures >= failuresCap) {
        return { kind: "failures", count: failures, cap: failuresCap };
    }
    const batchesCap = configuredMaxToolBatches();
    const batches = toolBatchCount(messages);
    if (batches >= batchesCap) {
        return { kind: "batches", count: batches, cap: batchesCap };
    }
    return null;
}

function describeBudgetExhaustion(b: BudgetExhaustion): string {
    switch (b.kind) {
        case "wall":
            return `Wall-time budget exhausted (${(b.elapsedMs / 1000).toFixed(1)}s of ${(b.capMs / 1000).toFixed(0)}s). Stop calling tools.`;
        case "failures":
            return `Consecutive tool failures (${b.count} of ${b.cap}). Stop calling tools and explain the blocker.`;
        case "batches":
            return `Tool-batch ceiling reached (${b.count} of ${b.cap}). Stop calling tools.`;
    }
}

function shouldInjectToolRepair(state: typeof MessagesAnnotation.State): boolean {
    return Boolean(repeatedToolFailure(state.messages) && repairAttemptCount(state.messages) < MAX_TOOL_REPAIR_ATTEMPTS);
}

function latestToolBatchFailed(messages: BaseMessage[]): boolean {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (messageType(message) !== "tool") {
            break;
        }
        if (isToolError(message)) {
            return true;
        }
    }
    return false;
}

function buildToolRepairInstruction(state: typeof MessagesAnnotation.State): string {
    const failure = repeatedToolFailure(state.messages);
    const attempt = repairAttemptCount(state.messages) + 1;
    const args = failure?.args === undefined ? "unknown" : normalizeForSignature(failure.args);
    const finalAttempt = attempt >= MAX_TOOL_REPAIR_ATTEMPTS;
    return [
        TOOL_REPAIR_MARKER,
        "A tool call for this same user turn failed repeatedly with the same argument shape.",
        "Continue the task now; do not promise future follow-up unless a durable follow-up job has actually been scheduled.",
        "Use the tool's declared schema exactly. If an identifier or enum value is missing, first use an available discovery/search/list tool instead of retrying the same invalid arguments.",
        finalAttempt
            ? "This is the final repair attempt. If the task still cannot be completed, return an honest final answer naming the exact tool blocker and what input is missing."
            : "If the task can be completed, call the corrected tool now. If it cannot, explain the exact missing input instead of retrying the same call.",
        failure ? `Repeated failure: ${failure.toolName} failed ${failure.count} times.` : undefined,
        failure ? `Previous arguments: ${args}.` : undefined,
        failure ? `Tool error: ${failure.error}.` : undefined,
    ].filter((line): line is string => Boolean(line)).join("\n");
}

export function createAgentGraph(
    model: any,
    tools: DynamicStructuredTool[],
    checkpointDir: string,
    systemPrompt?: string,
    dynamicSystemPrompt?: () => string | undefined,
) {
    const toolNode = new ToolNode(tools);

    // Define Nodes
    async function callModel(state: typeof MessagesAnnotation.State, config?: RunnableConfig) {
        // Inject system prompt as first message if provided and not already present
        let messages = state.messages;
        const injectedPrompts: BaseMessage[] = [];
        if (systemPrompt && (messages.length === 0 || messages[0]._getType() !== "system")) {
            injectedPrompts.push(new SystemMessage(systemPrompt));
        }
        const runtimePrompt = dynamicSystemPrompt?.();
        if (runtimePrompt) {
            injectedPrompts.push(new SystemMessage(runtimePrompt));
        }
        if (injectedPrompts.length > 0) {
            messages = [...injectedPrompts, ...messages];
        }
        // Tool-loop exit ramps. Each ramp unbinds tools and injects a SystemMessage
        // that forces a final answer. WITHOUT these, the model can recurse indefinitely
        // on tool calls, the runtime never emits `done`, the API gateway never settles,
        // and on-chain x402 payment never lands.
        //
        // Two ramps:
        //   1. Repair attempts exhausted (same arg-shape failure 3x in a row).
        //   2. Per-turn budget exhausted (wall time / consecutive failures /
        //      Manus-grade hard ceiling on total tool batches). See
        //      `checkTurnBudget` for the three axes.
        let boundTools: DynamicStructuredTool[];
        const turnStartTime = (config?.configurable as { startTime?: number } | undefined)?.startTime;
        if (repairAttemptsExhausted(messages)) {
            boundTools = [];
            messages = [
                ...messages,
                new SystemMessage([
                    "[compose:tool-loop-stop]",
                    "Repair attempts exhausted. Stop calling tools.",
                    "Write a single, honest final answer that names the exact tool blocker and what input was missing.",
                ].join("\n")),
            ];
        } else {
            const exhausted = checkTurnBudget(messages, turnStartTime);
            if (exhausted) {
                boundTools = [];
                messages = [
                    ...messages,
                    new SystemMessage([
                        "[compose:tool-budget-exhausted]",
                        describeBudgetExhaustion(exhausted),
                        "Write a single, concise final answer summarising what you have so far for the user.",
                    ].join("\n")),
                ];
            } else {
                // Stable bind: full tool list, never re-scored or pruned.
                // KV cache stays warm across iterations of the same turn.
                boundTools = tools;
            }
        }
        const modelWithTools = model.bindTools(boundTools);
        const response = await modelWithTools.invoke(messages.map(normalizeToolMessage), config);
        return { messages: [response] };
    }

    function shouldContinue(state: typeof MessagesAnnotation.State) {
        const lastMessage = state.messages[state.messages.length - 1] as AIMessage;

        // If the LLM made tool calls, verify if we should route to tools
        if (extractToolCalls(lastMessage).length > 0) {
            return "tools";
        }
        if (shouldInjectToolRepair(state) && unresolvedPlaceholder(contentText(lastMessage))) {
            return "repair";
        }
        return "__end__"; // LangGraph uses __end__ or END constant
    }

    function shouldRepairAfterTools(state: typeof MessagesAnnotation.State) {
        return latestToolBatchFailed(state.messages) && shouldInjectToolRepair(state) ? "repair" : "agent";
    }

    async function requestToolRepair(state: typeof MessagesAnnotation.State) {
        return { messages: [new SystemMessage(buildToolRepairInstruction(state))] };
    }

    // Construct Graph
    const workflow = new StateGraph(MessagesAnnotation)
        .addNode("agent", callModel)
        .addNode("tools", toolNode)
        .addNode("repair", requestToolRepair)
        .addEdge(START, "agent")
        .addConditionalEdges("agent", shouldContinue)
        .addConditionalEdges("tools", shouldRepairAfterTools)
        .addEdge("repair", "agent");

    // Initialize Checkpointer
    const checkpointer = new FileSystemCheckpointSaver(checkpointDir);

    // Compile
    return workflow.compile({
        checkpointer
    });
}

export const __test = {
    extractToolCalls,
};
