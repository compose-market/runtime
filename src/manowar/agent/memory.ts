import type { LayeredSearchResult } from "../memory/types.js";
import {
    type AgentMemoryContextResponse,
    type AgentMemoryRememberResponse,
    runAgentMemoryLoop,
} from "../memory/agent-loop.js";
import { DEFAULT_AGENT_MEMORY_LAYERS, summarizeLayeredMemory } from "../memory/summary.js";
import type { ResolvedMemoryScope } from "./memory-scope.js";

export { DEFAULT_AGENT_MEMORY_LAYERS, summarizeLayeredMemory } from "../memory/summary.js";

const AGENT_TURN_MEMORY_LAYERS = ["working", "vectors", "graph", "patterns"] as const;

function summarizeContextItems(items: AgentMemoryContextResponse["items"]): string | null {
    const summary = items.map((item) => `[${item.layer.toUpperCase()}] ${item.text}`).join("\n\n").trim();
    return summary || null;
}

function compactTurnSummary(userMessage: string, assistantMessage: string): string {
    const user = userMessage.replace(/\s+/g, " ").trim().slice(0, 700);
    const assistant = assistantMessage.replace(/\s+/g, " ").trim().slice(0, 900);
    return `User: ${user}\nAssistant: ${assistant}`;
}

export async function retrieveAgentMemory(params: {
    query: string;
    scope: Pick<ResolvedMemoryScope, "agentWallet" | "userId" | "threadId" | "mode" | "haiId" | "filters">;
    limit?: number;
}): Promise<{ result: LayeredSearchResult; summary: string | null; prompt: string | null }> {
    const response = await runAgentMemoryLoop({
        step: "pre_turn",
        query: params.query,
        agentWallet: params.scope.agentWallet,
        userAddress: params.scope.userId,
        threadId: params.scope.threadId,
        mode: params.scope.mode,
        haiId: params.scope.haiId,
        filters: params.scope.filters,
        layers: [...AGENT_TURN_MEMORY_LAYERS],
        limit: params.limit ?? 3,
        maxItems: 4,
        maxItemChars: 360,
        budget: { maxCharacters: 900 },
    });

    if (response.workflow.step !== "pre_turn") {
        return {
            result: { query: params.query, layers: {}, totals: {} },
            summary: null,
            prompt: null,
        };
    }

    const context = response as AgentMemoryContextResponse;
    return {
        result: { query: params.query, layers: {}, totals: context.totals },
        summary: summarizeContextItems(context.items),
        prompt: context.prompt,
    };
}

export async function persistAgentConversationTurn(params: {
    scope: Pick<ResolvedMemoryScope, "agentWallet" | "userId" | "threadId" | "metadata" | "mode" | "haiId">;
    sessionId: string;
    userMessage: string;
    assistantMessage: string;
    modelUsed: string;
    totalTokens: number;
    metadata?: Record<string, unknown>;
}): Promise<void> {
    const userMessage = params.userMessage.trim();
    const assistantMessage = params.assistantMessage.trim();
    if (!userMessage || !assistantMessage) {
        return;
    }

    await runAgentMemoryLoop({
        step: "post_turn",
        agentWallet: params.scope.agentWallet,
        userAddress: params.scope.userId,
        threadId: params.scope.threadId,
        mode: params.scope.mode,
        haiId: params.scope.haiId,
        sessionId: params.sessionId,
        userMessage,
        assistantMessage,
        summary: compactTurnSummary(userMessage, assistantMessage),
        modelUsed: params.modelUsed,
        totalTokens: params.totalTokens,
        metadata: {
            ...params.scope.metadata,
            ...params.metadata,
        },
    });
}

export async function persistExplicitAgentMemory(params: {
    scope: Pick<ResolvedMemoryScope, "agentWallet" | "userId" | "threadId" | "composeRunId" | "metadata" | "mode" | "haiId">;
    content: string;
    metadata?: Record<string, unknown>;
}): Promise<boolean> {
    const content = params.content.trim();
    if (!content) {
        return false;
    }

    const result = await runAgentMemoryLoop({
        step: "remember",
        agentWallet: params.scope.agentWallet,
        userAddress: params.scope.userId,
        threadId: params.scope.threadId,
        mode: params.scope.mode,
        haiId: params.scope.haiId,
        content,
        type: "explicit_save",
        metadata: {
            mode: params.scope.mode,
            ...params.scope.metadata,
            ...params.metadata,
            ...(params.scope.composeRunId ? { compose_run_id: params.scope.composeRunId } : {}),
        },
    });

    return result.workflow.step === "remember" && (result as AgentMemoryRememberResponse).success;
}
