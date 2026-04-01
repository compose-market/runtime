import { invalidateMemoryScope } from "./cache.js";
import { getSessionsCollection, getSessionTranscriptsCollection } from "./mongo.js";
import type { SessionTranscript } from "./types.js";
import { indexMemoryContent } from "./vector.js";
import { buildApiInternalHeaders, requireApiInternalUrl } from "../../auth.js";

export interface TranscriptStoreParams {
    sessionId: string;
    threadId: string;
    agentWallet: string;
    messages: SessionTranscript["messages"];
    userAddress?: string;
    summary?: string;
    summaryEmbedding?: number[];
    tokenCount: number;
    metadata?: SessionTranscript["metadata"];
}

const DEFAULT_SESSION_MEMORY_TTL_MS = Number(process.env.MEMORY_SESSION_TTL_MS || 30 * 24 * 60 * 60 * 1000);
const DEFAULT_SESSION_MEMORY_CONTEXT_LIMIT = Number(process.env.MEMORY_SESSION_CONTEXT_LIMIT || 12);

export async function storeTranscript(params: TranscriptStoreParams): Promise<{ success: boolean }> {
    const transcripts = await getSessionTranscriptsCollection();

    await transcripts.updateOne(
        { sessionId: params.sessionId },
        {
            $set: {
                sessionId: params.sessionId,
                threadId: params.threadId,
                agentWallet: params.agentWallet,
                userAddress: params.userAddress,
                messages: params.messages,
                summary: params.summary,
                summaryEmbedding: params.summaryEmbedding,
                tokenCount: params.tokenCount,
                metadata: params.metadata || {
                    modelUsed: "unknown",
                    totalTokens: params.tokenCount,
                    contextWindow: 128000,
                },
                createdAt: Date.now(),
            } satisfies SessionTranscript,
        },
        { upsert: true },
    );

    await invalidateMemoryScope({
        agentWallet: params.agentWallet,
        userAddress: params.userAddress,
        threadId: params.threadId,
    });

    return { success: true };
}

function normalizeWorkingMemoryLine(message: SessionTranscript["messages"][number]): string {
    return `${message.role}: ${message.content}`.trim().slice(0, 1000);
}

export async function rememberSessionMessages(params: {
    sessionId: string;
    threadId: string;
    agentWallet: string;
    userAddress?: string;
    messages: SessionTranscript["messages"];
    state?: Record<string, unknown>;
    entities?: Record<string, unknown>;
}): Promise<{ success: boolean; contextCount: number }> {
    const sessions = await getSessionsCollection();
    const existing = await sessions.findOne({ sessionId: params.sessionId });
    const now = Date.now();

    const nextContext = [
        ...(existing?.workingMemory.context || []),
        ...params.messages
            .filter((message) => message.role !== "system" && message.role !== "tool" && message.content.trim().length > 0)
            .map(normalizeWorkingMemoryLine),
    ].slice(-DEFAULT_SESSION_MEMORY_CONTEXT_LIMIT);

    await sessions.updateOne(
        { sessionId: params.sessionId },
        {
            $set: {
                agentWallet: params.agentWallet,
                userAddress: params.userAddress,
                threadId: params.threadId,
                workingMemory: {
                    context: nextContext,
                    entities: {
                        ...(existing?.workingMemory.entities || {}),
                        ...(params.entities || {}),
                    },
                    state: {
                        ...(existing?.workingMemory.state || {}),
                        ...(params.state || {}),
                    },
                },
                compressed: false,
                expiresAt: now + DEFAULT_SESSION_MEMORY_TTL_MS,
                lastAccessedAt: now,
            },
            $setOnInsert: {
                sessionId: params.sessionId,
                createdAt: now,
            },
        },
        { upsert: true },
    );

    await invalidateMemoryScope({
        agentWallet: params.agentWallet,
        userAddress: params.userAddress,
        threadId: params.threadId,
    });

    return {
        success: true,
        contextCount: nextContext.length,
    };
}

export async function getTranscriptBySessionId(sessionId: string): Promise<SessionTranscript | null> {
    const transcripts = await getSessionTranscriptsCollection();
    return transcripts.findOne({ sessionId });
}

export async function getTranscriptByThreadId(threadId: string): Promise<SessionTranscript | null> {
    const transcripts = await getSessionTranscriptsCollection();
    return transcripts.findOne({ threadId });
}

export function shouldIndexSessionTranscript(messages: SessionTranscript["messages"]): boolean {
    return messages.some((message) => message.role !== "system" && message.role !== "tool" && message.content.trim().length > 0);
}

export async function indexSessionTranscript(params: {
    sessionId: string;
    agentWallet: string;
    userAddress?: string;
    threadId: string;
    messages: SessionTranscript["messages"];
    modelUsed: string;
    totalTokens: number;
}): Promise<{ indexed: boolean; messageCount: number; vectorCount: number }> {
    const { sessionId, agentWallet, userAddress, threadId, messages, modelUsed, totalTokens } = params;

    if (!shouldIndexSessionTranscript(messages)) {
        return { indexed: false, messageCount: messages.length, vectorCount: 0 };
    }

    await storeTranscript({
        sessionId,
        threadId,
        agentWallet,
        userAddress,
        messages,
        tokenCount: totalTokens,
        metadata: {
            modelUsed,
            totalTokens,
            contextWindow: 128000,
        },
    });

    let vectorCount = 0;

    for (let i = 0; i < messages.length; i += 1) {
        const message = messages[i];
        if (message.role === "system" || message.role === "tool") {
            continue;
        }

        const result = await indexMemoryContent({
            content: message.content,
            agentWallet,
            userAddress,
            threadId,
            source: "session",
            metadata: {
                sessionId,
                role: message.role,
                timestamp: message.timestamp,
                messageIndex: i,
            },
        });

        if (result.success) {
            vectorCount += 1;
        }
    }

    return {
        indexed: true,
        messageCount: messages.length,
        vectorCount,
    };
}

export async function getSessionTranscript(params: {
    sessionId: string;
    agentWallet: string;
}): Promise<SessionTranscript | null> {
    const transcript = await getTranscriptBySessionId(params.sessionId);
    if (!transcript || transcript.agentWallet !== params.agentWallet) {
        return null;
    }
    return transcript;
}

export async function getTranscriptByThread(threadId: string): Promise<SessionTranscript | null> {
    return getTranscriptByThreadId(threadId);
}

export async function compressSession(params: {
    sessionId: string;
    agentWallet: string;
    coordinatorModel: string;
}): Promise<{ summary: string; entitiesExtracted: number }> {
    const transcript = await getSessionTranscript({
        sessionId: params.sessionId,
        agentWallet: params.agentWallet,
    });

    if (!transcript) {
        return { summary: "", entitiesExtracted: 0 };
    }

    const summaryPrompt = `Summarize this conversation, extracting key facts, decisions, and entities:\n\n${transcript.messages
        .map((message) => `${message.role}: ${message.content}`)
        .join("\n")}\n\nRespond with JSON: { "summary": "...", "entities": ["entity1", "entity2"], "keyFacts": ["fact1", "fact2"] }`;

    try {
        const response = await fetch(`${requireApiInternalUrl()}/api/inference`, {
            method: "POST",
            headers: buildApiInternalHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({
                model: params.coordinatorModel,
                messages: [{ role: "user", content: summaryPrompt }],
                temperature: 0.2,
                max_tokens: 500,
            }),
        });

        const data = await response.json() as {
            choices?: Array<{ message?: { content?: string } }>;
        };

        const content = data.choices?.[0]?.message?.content || "";
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return { summary: content, entitiesExtracted: 0 };
        }

        const parsed = JSON.parse(jsonMatch[0]) as {
            summary?: string;
            entities?: string[];
            keyFacts?: string[];
        };

        if (parsed.summary) {
            await indexMemoryContent({
                content: parsed.summary,
                agentWallet: params.agentWallet,
                source: "archive",
                metadata: {
                    sessionId: params.sessionId,
                    type: "session_compression",
                    keyFacts: parsed.keyFacts,
                },
            });
        }

        return {
            summary: parsed.summary || "",
            entitiesExtracted: parsed.entities?.length || 0,
        };
    } catch (error) {
        console.error("[memory:transcript] compression failed", error);
        return { summary: "", entitiesExtracted: 0 };
    }
}
