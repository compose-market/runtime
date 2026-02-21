import type { SessionTranscript, MemoryVector } from "./types.js";
import { getEmbeddingsBatch } from "./embedding.js";
import { indexMemoryContent } from "./search.js";

const LAMBDA_API_URL = process.env.LAMBDA_API_URL || "https://api.compose.market";

const INDEXING_THRESHOLD_MESSAGES = 10;
const INDEXING_THRESHOLD_CHARS = 5000;

export async function indexSessionTranscript(params: {
    sessionId: string;
    agentWallet: string;
    userId?: string;
    threadId: string;
    messages: SessionTranscript["messages"];
    modelUsed: string;
    totalTokens: number;
}): Promise<{ indexed: boolean; messageCount: number; vectorCount: number }> {
    const { sessionId, agentWallet, userId, threadId, messages, modelUsed, totalTokens } = params;

    if (messages.length < INDEXING_THRESHOLD_MESSAGES) {
        return { indexed: false, messageCount: messages.length, vectorCount: 0 };
    }

    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    if (totalChars < INDEXING_THRESHOLD_CHARS) {
        return { indexed: false, messageCount: messages.length, vectorCount: 0 };
    }

    try {
        await fetch(`${LAMBDA_API_URL}/api/memory/transcript-store`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                sessionId,
                threadId,
                agentWallet,
                userId,
                messages,
                tokenCount: totalTokens,
                metadata: { modelUsed, totalTokens, contextWindow: 128000 },
            }),
        });
    } catch (error) {
        console.error("[indexer] Failed to store transcript:", error);
    }

    const contents = messages
        .filter(m => m.role === "user" || m.role === "assistant")
        .map(m => m.content);

    const embeddings = await getEmbeddingsBatch(contents);

    let vectorCount = 0;
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role === "system" || msg.role === "tool") continue;

        const result = await indexMemoryContent({
            content: msg.content,
            agentWallet,
            userId,
            threadId,
            source: "session",
            metadata: {
                sessionId,
                role: msg.role,
                timestamp: msg.timestamp,
                messageIndex: i,
            },
        });

        if (result.success) vectorCount++;
    }

    console.log(`[indexer] Indexed session ${sessionId}: ${messages.length} messages, ${vectorCount} vectors`);
    return { indexed: true, messageCount: messages.length, vectorCount };
}

export async function getSessionTranscript(params: {
    sessionId: string;
    agentWallet: string;
}): Promise<SessionTranscript | null> {
    const { sessionId } = params;

    try {
        const response = await fetch(`${LAMBDA_API_URL}/api/memory/transcript-get/${sessionId}?type=sessionId`, {
            method: "GET",
            headers: { "Content-Type": "application/json" },
        });

        if (!response.ok) return null;
        return await response.json() as SessionTranscript;
    } catch {
        return null;
    }
}

export async function getTranscriptByThread(threadId: string): Promise<SessionTranscript | null> {
    try {
        const response = await fetch(`${LAMBDA_API_URL}/api/memory/transcript-get/${threadId}?type=threadId`, {
            method: "GET",
            headers: { "Content-Type": "application/json" },
        });

        if (!response.ok) return null;
        return await response.json() as SessionTranscript;
    } catch {
        return null;
    }
}

export async function compressSession(params: {
    sessionId: string;
    agentWallet: string;
    coordinatorModel: string;
}): Promise<{ summary: string; entitiesExtracted: number }> {
    const transcript = await getSessionTranscript(params);
    if (!transcript) {
        return { summary: "", entitiesExtracted: 0 };
    }

    const summaryPrompt = `Summarize this conversation, extracting key facts, decisions, and entities:

${transcript.messages.map(m => `${m.role}: ${m.content}`).join("\n")}

Respond with JSON: { "summary": "...", "entities": ["entity1", "entity2"], "keyFacts": ["fact1", "fact2"] }`;

    try {
        const response = await fetch(`${LAMBDA_API_URL}/api/inference`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: params.coordinatorModel,
                messages: [{ role: "user", content: summaryPrompt }],
                temperature: 0.2,
                max_tokens: 500,
            }),
        });

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || "";

        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return { summary: content, entitiesExtracted: 0 };
        }

        const parsed = JSON.parse(jsonMatch[0]);

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

        return {
            summary: parsed.summary,
            entitiesExtracted: parsed.entities?.length || 0,
        };
    } catch (error) {
        console.error("[indexer] Compression failed:", error);
        return { summary: "", entitiesExtracted: 0 };
    }
}