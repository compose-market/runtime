import { addMemory } from "./mem0.js";
import {
    DEFAULT_AGENT_MEMORY_LAYERS,
    extractLayeredMemoryItems,
    formatAgentMemoryPrompt,
} from "./summary.js";
import { searchMemoryLayers } from "./layers.js";
import { rememberSessionMessages, storeTranscript } from "./transcript.js";
import { indexMemoryContent } from "./vector.js";
import { createContentHash } from "./cache.js";
import type { LayeredSearchParams, SessionTranscript } from "./types.js";
import {
    asNumber,
    asObject,
    asString,
    buildThreadSessionId,
    clampInteger,
    measureMemoryChars,
    normalizeMemoryMode,
} from "./utils.js";

export const AGENT_MEMORY_WORKFLOW_VERSION = "compose.agent_memory.v1";

export type AgentMemoryLayer = typeof DEFAULT_AGENT_MEMORY_LAYERS[number];
export type AgentMemoryLoopStep = "pre_turn" | "post_turn" | "remember";

export class AgentMemoryInputError extends Error {
    readonly statusCode = 400;
}

export interface AgentMemoryScope {
    agentWallet: string;
    userAddress?: string;
    threadId?: string;
    mode?: "global" | "local";
    haiId?: string;
    filters?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
}

export interface AgentMemoryContextResponse {
    workflow: {
        v: typeof AGENT_MEMORY_WORKFLOW_VERSION;
        step: "pre_turn";
        next: Array<"post_turn" | "remember">;
    };
    contextId: string;
    prompt: string | null;
    items: Array<{
        layer: string;
        text: string;
        id?: string;
        score?: number;
        source?: string;
        createdAt?: number;
    }>;
    totals: Record<string, number>;
    contextUsage: {
        characters: number;
        rawCharacters: number;
        budgetCharacters?: number;
        savedCharactersVsRaw: number;
        items: number;
    };
    omitted: Record<string, number>;
    raw?: Record<string, unknown[]>;
}

export interface AgentMemoryRecordResponse {
    workflow: {
        v: typeof AGENT_MEMORY_WORKFLOW_VERSION;
        step: "post_turn";
        next: Array<"pre_turn" | "remember">;
    };
    success: true;
    sessionId: string;
    threadId: string;
    turnId: string;
    vectorId?: string;
    stored: {
        transcript: boolean;
        working: boolean;
        vector: boolean;
        graph: boolean;
    };
}

export interface AgentMemoryRememberResponse {
    workflow: {
        v: typeof AGENT_MEMORY_WORKFLOW_VERSION;
        step: "remember";
        next: Array<"pre_turn" | "post_turn">;
    };
    success: boolean;
    graphSaved: boolean;
    vectorSaved: boolean;
    vectorId?: string;
    memory?: {
        id?: string;
        text: string;
        type: string;
        retention?: string;
        confidence?: number;
        status: "active";
    };
}

interface AgentMemoryMessageInput {
    role: "user" | "assistant" | "system" | "tool";
    content: string;
    timestamp?: number;
    toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new AgentMemoryInputError(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

export function normalizeAgentMemoryScope(input: Record<string, unknown>): AgentMemoryScope {
    const agentWallet = asString(input.agentWallet) ?? asString(input.agent_id);
    if (!agentWallet) {
        throw new AgentMemoryInputError("agentWallet is required");
    }

    const mode = normalizeMemoryMode(input.mode);
    const haiId = asString(input.haiId) ?? asString(input.hai_id);
    if (mode === "local" && !haiId) {
        throw new AgentMemoryInputError("haiId is required when mode is local");
    }

    return {
        agentWallet,
        userAddress: asString(input.userAddress) ?? asString(input.user_id),
        threadId: asString(input.threadId) ?? asString(input.thread_id) ?? asString(input.runId) ?? asString(input.run_id),
        mode,
        haiId,
        filters: asObject(input.filters),
        metadata: asObject(input.metadata),
    };
}

function normalizeLayers(value: unknown): AgentMemoryLayer[] {
    if (!Array.isArray(value) || value.length === 0) {
        return [...DEFAULT_AGENT_MEMORY_LAYERS];
    }
    const allowed = new Set<string>(DEFAULT_AGENT_MEMORY_LAYERS);
    const layers = value.filter((item): item is AgentMemoryLayer => typeof item === "string" && allowed.has(item));
    return layers.length > 0 ? layers : [...DEFAULT_AGENT_MEMORY_LAYERS];
}

function normalizeBudget(value: unknown): { maxCharacters?: number } {
    const record = asObject(value);
    const maxCharacters = asNumber(record?.maxCharacters)
        ?? asNumber(record?.max_chars)
        ?? asNumber(record?.maxContextCharacters)
        ?? asNumber(record?.max_context_chars);
    return {
        maxCharacters: maxCharacters ? Math.max(1, Math.floor(maxCharacters)) : undefined,
    };
}

function normalizeMessages(input: Record<string, unknown>): SessionTranscript["messages"] {
    if (Array.isArray(input.messages)) {
        return input.messages.map((message, index) => {
            const record = assertObject(message, `messages[${index}]`);
            const role = record.role;
            const content = asString(record.content);
            if (role !== "user" && role !== "assistant" && role !== "system" && role !== "tool") {
                throw new AgentMemoryInputError(`messages[${index}].role is invalid`);
            }
            if (!content) {
                throw new AgentMemoryInputError(`messages[${index}].content is required`);
            }
            return {
                role,
                content,
                timestamp: asNumber(record.timestamp) ?? Date.now() + index,
                toolCalls: Array.isArray(record.toolCalls)
                    ? record.toolCalls as AgentMemoryMessageInput["toolCalls"]
                    : undefined,
            };
        });
    }

    const userMessage = asString(input.userMessage);
    const assistantMessage = asString(input.assistantMessage);
    if (!userMessage || !assistantMessage) {
        throw new AgentMemoryInputError("messages or userMessage plus assistantMessage are required");
    }

    const now = Date.now();
    return [
        { role: "user", content: userMessage, timestamp: now },
        { role: "assistant", content: assistantMessage, timestamp: now + 1 },
    ];
}

function normalizeToolEvents(input: unknown): SessionTranscript["messages"] {
    if (!Array.isArray(input)) {
        return [];
    }

    return input.map((item, index) => {
        const record = assertObject(item, `toolEvents[${index}]`);
        const name = asString(record.name) ?? asString(record.toolName) ?? asString(record.tool);
        if (!name) {
            throw new AgentMemoryInputError(`toolEvents[${index}].name is required`);
        }
        const args = asObject(record.args) ?? asObject(record.input) ?? {};
        const status = asString(record.status) ?? "completed";
        const resultText = asString(record.result) ?? asString(record.output) ?? "";
        const content = resultText
            ? `tool:${name} status:${status} result:${resultText.slice(0, 2_000)}`
            : `tool:${name} status:${status}`;
        return {
            role: "tool",
            content,
            timestamp: asNumber(record.timestamp) ?? Date.now() + index,
            toolCalls: [{ name, args }],
        };
    });
}

function buildCompactTurnSummary(messages: SessionTranscript["messages"]): string {
    return messages
        .filter((message) => message.role === "user" || message.role === "assistant" || message.role === "tool")
        .slice(-6)
        .map((message) => {
            const text = message.content.replace(/\s+/g, " ").trim();
            const maxChars = message.role === "tool" ? 500 : 800;
            return `${message.role}: ${text.slice(0, maxChars)}`;
        })
        .join("\n")
        .slice(0, 1_800);
}

function buildGraphTurnMessages(messages: SessionTranscript["messages"]): Array<{ role: string; content: string }> {
    const conversational = messages
        .filter((message) => message.role === "user" || message.role === "assistant")
        .slice(-6)
        .map((message) => ({
            role: message.role,
            content: message.content.replace(/\s+/g, " ").trim().slice(0, 1_200),
        }))
        .filter((message) => message.content.length > 0);

    if (conversational.length >= 2) {
        return conversational;
    }

    const summary = buildCompactTurnSummary(messages);
    return summary
        ? [
            { role: "user", content: `Remember the useful durable facts from this agent turn:\n${summary}` },
            { role: "assistant", content: "I will retain the stable facts and ignore transient execution noise." },
        ]
        : [];
}

function buildRecordSessionId(scope: AgentMemoryScope, explicitSessionId?: string): string {
    if (explicitSessionId) {
        return explicitSessionId;
    }
    if (!scope.threadId) {
        throw new AgentMemoryInputError("threadId or sessionId is required");
    }
    return buildThreadSessionId(scope);
}

function renderPromptFromItems(items: AgentMemoryContextResponse["items"]): string | null {
    if (items.length === 0) {
        return null;
    }
    const summary = items
        .map((item) => `[${item.layer.toUpperCase()}] ${item.text}`)
        .join("\n\n");
    return formatAgentMemoryPrompt(summary);
}

function buildContextId(scope: AgentMemoryScope, query: string): string {
    const seed = [
        scope.agentWallet,
        scope.userAddress || "",
        scope.threadId || "",
        scope.mode || "",
        scope.haiId || "",
        query,
        Date.now(),
    ].join("|");
    return `ctx_${createContentHash(seed)}`;
}

function countRawLayerItems(result: Record<string, unknown[]>): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [layer, items] of Object.entries(result)) {
        counts[layer] = Array.isArray(items) ? items.length : 0;
    }
    return counts;
}

function countSelectedLayerItems(items: AgentMemoryContextResponse["items"]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const item of items) {
        counts[item.layer] = (counts[item.layer] || 0) + 1;
    }
    return counts;
}

export async function assembleAgentMemoryContext(input: unknown): Promise<AgentMemoryContextResponse> {
    const body = assertObject(input, "memory context request");
    const query = asString(body.query);
    if (!query) {
        throw new AgentMemoryInputError("query is required");
    }

    const scope = normalizeAgentMemoryScope(body);
    const layers = normalizeLayers(body.layers);
    const limit = clampInteger(body.limit, 5, 20);
    const maxItems = clampInteger(body.maxItems, 8, 24);
    const maxTextLength = clampInteger(body.maxItemChars, 500, 2_000);
    const budget = normalizeBudget(body.budget);

    const result = await searchMemoryLayers({
        query,
        agentWallet: scope.agentWallet,
        userAddress: scope.userAddress,
        threadId: scope.threadId,
        mode: scope.mode,
        haiId: scope.haiId,
        filters: scope.filters,
        layers: layers as LayeredSearchParams["layers"],
        limit,
    });
    const items = extractLayeredMemoryItems(result, {
        maxItems,
        maxTextLength,
        maxCharacters: budget.maxCharacters,
        layerOrder: layers,
    });
    const prompt = renderPromptFromItems(items);
    const rawCounts = countRawLayerItems(result.layers);
    const selectedCounts = countSelectedLayerItems(items);
    const omitted: Record<string, number> = {};
    for (const [layer, count] of Object.entries(rawCounts)) {
        omitted[layer] = Math.max(0, count - (selectedCounts[layer] || 0));
    }
    const rawCharacters = measureMemoryChars(formatAgentMemoryPrompt(
        Object.values(result.layers).flat().map((item) => JSON.stringify(item)).join("\n\n"),
    ));
    const promptCharacters = measureMemoryChars(prompt);

    return {
        workflow: {
            v: AGENT_MEMORY_WORKFLOW_VERSION,
            step: "pre_turn",
            next: ["post_turn", "remember"],
        },
        contextId: buildContextId(scope, query),
        prompt,
        items,
        totals: result.totals,
        contextUsage: {
            characters: promptCharacters,
            rawCharacters,
            budgetCharacters: budget.maxCharacters,
            savedCharactersVsRaw: Math.max(0, rawCharacters - promptCharacters),
            items: items.length,
        },
        omitted,
        raw: body.includeRaw === true ? result.layers : undefined,
    };
}

export async function recordAgentMemoryTurn(input: unknown): Promise<AgentMemoryRecordResponse> {
    const body = assertObject(input, "memory turn request");
    const scope = normalizeAgentMemoryScope(body);
    const messages = [...normalizeMessages(body), ...normalizeToolEvents(body.toolEvents)]
        .sort((a, b) => a.timestamp - b.timestamp);
    const sessionId = buildRecordSessionId(scope, asString(body.sessionId));
    const threadId = scope.threadId ?? sessionId;
    const turnId = asString(body.turnId) ?? `turn_${createContentHash(`${sessionId}|${threadId}|${Date.now()}`)}`;
    const totalTokens = asNumber(body.totalTokens) ?? asNumber(body.tokenCount) ?? 0;
    const modelUsed = asString(body.modelUsed) ?? asString(body.model) ?? "external";
    const summary = asString(body.summary) ?? buildCompactTurnSummary(messages);
    const turnContent = summary || messages.map((message) => `${message.role}: ${message.content}`).join("\n");
    const metadata = {
        type: "agent_memory_turn",
        source: "agent_loop",
        contextId: asString(body.contextId),
        turnId,
        ...scope.metadata,
        ...asObject(body.metadata),
    };

    await storeTranscript({
        sessionId,
        threadId,
        agentWallet: scope.agentWallet,
        userAddress: scope.userAddress,
        mode: scope.mode,
        haiId: scope.haiId,
        messages,
        tokenCount: totalTokens,
        summary,
        metadata: {
            modelUsed,
            totalTokens,
            contextWindow: asNumber(body.contextWindow) ?? 0,
            contextId: asString(body.contextId),
            turnId,
            ...scope.metadata,
            ...asObject(body.metadata),
        },
    });

    const graphMessages = buildGraphTurnMessages(messages);
    const [vectorResult, graphResult, sessionResult] = await Promise.allSettled([
        indexMemoryContent({
            content: turnContent,
            agentWallet: scope.agentWallet,
            userAddress: scope.userAddress,
            threadId,
            mode: scope.mode,
            haiId: scope.haiId,
            source: "session",
            metadata,
        }),
        graphMessages.length > 0 ? addMemory({
            messages: graphMessages,
            agent_id: scope.agentWallet,
            user_id: scope.userAddress,
            run_id: threadId,
            mode: scope.mode,
            haiId: scope.haiId,
            metadata: {
                ...metadata,
                type: "agent_memory_turn_graph",
            },
        }) : Promise.resolve([]),
        rememberSessionMessages({
            sessionId: buildThreadSessionId({ ...scope, threadId }),
            threadId,
            agentWallet: scope.agentWallet,
            userAddress: scope.userAddress,
            mode: scope.mode,
            haiId: scope.haiId,
            messages,
            state: {
                lastSessionId: sessionId,
                lastTurnAt: Date.now(),
                contextId: asString(body.contextId),
                turnId,
            },
            metadata,
        }),
    ]);

    return {
        workflow: {
            v: AGENT_MEMORY_WORKFLOW_VERSION,
            step: "post_turn",
            next: ["pre_turn", "remember"],
        },
        success: true,
        sessionId,
        threadId,
        turnId,
        vectorId: vectorResult.status === "fulfilled" ? vectorResult.value.vectorId : undefined,
        stored: {
            transcript: true,
            working: sessionResult.status === "fulfilled",
            vector: vectorResult.status === "fulfilled" && Boolean(vectorResult.value.vectorId),
            graph: graphResult.status === "fulfilled" && graphResult.value.length > 0,
        },
    };
}

export async function rememberAgentMemory(input: unknown): Promise<AgentMemoryRememberResponse> {
    const body = assertObject(input, "memory remember request");
    const scope = normalizeAgentMemoryScope(body);
    const content = asString(body.content) ?? asString(body.fact);
    if (!content) {
        throw new AgentMemoryInputError("content is required");
    }

    const metadata = {
        type: asString(body.type) ?? "explicit_save",
        source: "agent_loop",
        retention: asString(body.retention),
        scope: asString(body.scope),
        conflictPolicy: asString(body.conflictPolicy) ?? asString(body.conflict_policy),
        confidence: asNumber(body.confidence),
        ...scope.metadata,
        ...asObject(body.metadata),
    };

    const [graphResult, vectorResult] = await Promise.allSettled([
        addMemory({
            messages: [
                { role: "user", content: `Remember this durable fact for future agent turns: ${content}` },
                { role: "assistant", content: "Stored. I will use this fact only when it is relevant." },
            ],
            agent_id: scope.agentWallet,
            user_id: scope.userAddress,
            run_id: scope.threadId,
            mode: scope.mode,
            haiId: scope.haiId,
            metadata,
        }),
        indexMemoryContent({
            content,
            agentWallet: scope.agentWallet,
            userAddress: scope.userAddress,
            threadId: scope.threadId,
            mode: scope.mode,
            haiId: scope.haiId,
            source: "fact",
            metadata,
        }),
    ]);

    const graphSaved = graphResult.status === "fulfilled" && graphResult.value.length > 0;
    const vectorSaved = vectorResult.status === "fulfilled" && vectorResult.value.success;

    return {
        workflow: {
            v: AGENT_MEMORY_WORKFLOW_VERSION,
            step: "remember",
            next: ["pre_turn", "post_turn"],
        },
        success: graphSaved || vectorSaved,
        graphSaved,
        vectorSaved,
        vectorId: vectorResult.status === "fulfilled" ? vectorResult.value.vectorId : undefined,
        memory: {
            id: vectorResult.status === "fulfilled" ? vectorResult.value.vectorId : undefined,
            text: content,
            type: String(metadata.type),
            retention: asString(body.retention),
            confidence: asNumber(body.confidence),
            status: "active",
        },
    };
}

export async function runAgentMemoryLoop(input: unknown): Promise<AgentMemoryContextResponse | AgentMemoryRecordResponse | AgentMemoryRememberResponse> {
    const body = assertObject(input, "memory loop request");
    const step = asString(body.step) ?? asString(body.op);
    if (step === "pre_turn" || step === "context") {
        return assembleAgentMemoryContext(body);
    }
    if (step === "post_turn" || step === "record_turn") {
        return recordAgentMemoryTurn(body);
    }
    if (step === "remember" || step === "save") {
        return rememberAgentMemory(body);
    }
    throw new AgentMemoryInputError("step must be pre_turn, post_turn, or remember");
}
