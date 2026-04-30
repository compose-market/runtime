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

const TOOL_REPAIR_MARKER = "[compose:tool-repair]";
const MAX_TOOL_REPAIR_ATTEMPTS = 3;
const DEFAULT_MAX_BOUND_TOOLS = 12;
/**
 * Hard cap on tool batches per user turn. After this many successful tool batches
 * the agent MUST emit a final answer with no further tool calls. This is the
 * canonical "outer loop bound" used by Codex (~50 calls/task), Claude Code
 * (recursionLimit), and Manus (max ~50 tool calls/task — but per turn we want
 * a tighter bound so settlement always lands within the Cloud Run window).
 *
 * Without this bound the model can recurse indefinitely on tool calls, the
 * runtime never emits `done`, the gateway never settles the x402 payment, and
 * the Cloud Run hits its 5-minute timeout. SOTA bound = 6 tool batches/turn.
 */
const MAX_TOOL_BATCHES_PER_TURN = 6;

type ToolCallSnapshot = {
    id: string;
    name: string;
    args?: unknown;
};

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

function configuredMaxBoundTools(): number {
    const parsed = Number.parseInt(process.env.COMPOSE_AGENT_MAX_BOUND_TOOLS || "", 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BOUND_TOOLS;
}

function tokenize(value: string): Set<string> {
    const normalized = value
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ");
    const tokens = new Set<string>();
    for (const raw of normalized.split(/\s+/)) {
        if (raw.length < 2) continue;
        tokens.add(raw);
        if (raw.endsWith("s") && raw.length > 3) {
            tokens.add(raw.slice(0, -1));
        }
    }
    return tokens;
}

function lastHumanText(messages: BaseMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messageType(messages[i]) === "human") {
            return contentText(messages[i]);
        }
    }
    return messages.map(contentText).join(" ");
}

function calledToolNames(messages: BaseMessage[]): Set<string> {
    const names = new Set<string>();
    for (const message of messages) {
        for (const call of extractToolCalls(message)) {
            names.add(call.name);
        }
        const toolName = (message as { name?: unknown }).name
            ?? (message as { lc_kwargs?: { name?: unknown } }).lc_kwargs?.name;
        if (typeof toolName === "string" && toolName.length > 0) {
            names.add(toolName);
        }
    }
    return names;
}

function toolSearchText(tool: DynamicStructuredTool): string {
    return `${tool.name} ${tool.description || ""}`;
}

function selectBoundTools(tools: DynamicStructuredTool[], messages: BaseMessage[]): DynamicStructuredTool[] {
    const maxTools = configuredMaxBoundTools();
    if (tools.length <= maxTools) {
        return tools;
    }

    const queryTokens = tokenize(lastHumanText(messages));
    const priorToolNames = calledToolNames(messages);
    const scored = tools.map((tool, index) => {
        if (priorToolNames.has(tool.name)) {
            return { tool, index, score: Number.MAX_SAFE_INTEGER };
        }

        const nameTokens = tokenize(tool.name);
        const searchTokens = tokenize(toolSearchText(tool));
        let score = 0;
        for (const token of queryTokens) {
            if (nameTokens.has(token)) score += 6;
            if (searchTokens.has(token)) score += 1;
        }
        return { tool, index, score };
    });

    const relevant = scored
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, maxTools)
        .map((item) => item.tool);

    if (relevant.length > 0) {
        return relevant;
    }
    if (process.env.COMPOSE_AGENT_BIND_ALL_TOOLS_ON_NO_MATCH === "true") {
        return tools;
    }
    return tools.slice(0, maxTools);
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

function parseToolArgs(value: unknown): unknown {
    if (typeof value !== "string") {
        return value;
    }
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function extractToolCalls(message: BaseMessage): ToolCallSnapshot[] {
    const candidate = message as {
        tool_calls?: Array<{ id?: unknown; name?: unknown; args?: unknown }>;
        additional_kwargs?: { tool_calls?: Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }> };
        lc_kwargs?: {
            tool_calls?: Array<{ id?: unknown; name?: unknown; args?: unknown }>;
            additional_kwargs?: { tool_calls?: Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }> };
        };
    };
    const direct = Array.isArray(candidate.tool_calls) ? candidate.tool_calls : [];
    const lcDirect = Array.isArray(candidate.lc_kwargs?.tool_calls) ? candidate.lc_kwargs?.tool_calls ?? [] : [];
    const additional = Array.isArray(candidate.additional_kwargs?.tool_calls)
        ? candidate.additional_kwargs?.tool_calls ?? []
        : Array.isArray(candidate.lc_kwargs?.additional_kwargs?.tool_calls)
            ? candidate.lc_kwargs?.additional_kwargs?.tool_calls ?? []
            : [];

    const calls: ToolCallSnapshot[] = [];
    for (const call of [...direct, ...lcDirect]) {
        if (typeof call.name !== "string") {
            continue;
        }
        calls.push({
            id: typeof call.id === "string" ? call.id : `${call.name}:${calls.length}`,
            name: call.name,
            args: call.args,
        });
    }
    for (const call of additional) {
        const name = call.function?.name;
        if (typeof name !== "string") {
            continue;
        }
        calls.push({
            id: typeof call.id === "string" ? call.id : `${name}:${calls.length}`,
            name,
            args: parseToolArgs(call.function?.arguments),
        });
    }
    return calls;
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
 * A "batch" is one assistant message that emitted >= 1 tool_call. Used to
 * enforce MAX_TOOL_BATCHES_PER_TURN — once exhausted the agent loop terminates
 * with a final-answer turn (no tools bound), which guarantees a `done` event
 * and therefore on-chain settlement.
 */
function toolBatchCount(messages: BaseMessage[]): number {
    let count = 0;
    for (const message of currentTurnMessages(messages)) {
        if (messageType(message) !== "ai") continue;
        if (extractToolCalls(message).length > 0) count += 1;
    }
    return count;
}

function toolBudgetExhausted(messages: BaseMessage[]): boolean {
    return toolBatchCount(messages) >= MAX_TOOL_BATCHES_PER_TURN;
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
        // Three ramps, all SOTA:
        //   1. Repair attempts exhausted (same arg-shape failure 3x in a row).
        //   2. Tool-batch budget exhausted (>= MAX_TOOL_BATCHES_PER_TURN successful
        //      batches in this user turn) — Codex/Manus/Claude Code style.
        let boundTools: DynamicStructuredTool[];
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
        } else if (toolBudgetExhausted(messages)) {
            boundTools = [];
            messages = [
                ...messages,
                new SystemMessage([
                    "[compose:tool-budget-exhausted]",
                    `Tool budget exhausted (${MAX_TOOL_BATCHES_PER_TURN} batches used in this turn). Stop calling tools.`,
                    "Write a single, concise final answer summarising what you have so far for the user.",
                ].join("\n")),
            ];
        } else {
            boundTools = selectBoundTools(tools, messages);
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
