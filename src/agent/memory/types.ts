export interface MemoryVector {
    vectorId: string;
    agentWallet: string;
    userId?: string;
    threadId?: string;
    content: string;
    embedding: number[];
    source: "session" | "knowledge" | "pattern" | "archive" | "fact";
    decayScore: number;
    accessCount: number;
    lastAccessedAt: number;
    createdAt: number;
    updatedAt: number;
}

export interface SessionTranscript {
    sessionId: string;
    agentWallet: string;
    userId?: string;
    threadId: string;
    messages: Array<{
        role: "user" | "assistant" | "system" | "tool";
        content: string;
        timestamp: number;
        toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
    }>;
    metadata: {
        modelUsed: string;
        totalTokens: number;
        contextWindow: number;
    };
    createdAt: number;
    expiresAt?: number;
}

export interface SearchResult {
    id: string;
    content: string;
    score: number;
    source: MemoryVector["source"];
    agentWallet: string;
    userId?: string;
    threadId?: string;
    decayScore: number;
    accessCount: number;
    createdAt: number;
}

export interface EmbeddingResult {
    embedding: number[];
    provider: "voyage" | "cloudflare";
    cached: boolean;
    dimensions: number;
}

export interface HybridSearchParams {
    query: string;
    agentWallet: string;
    userId?: string;
    threadId?: string;
    limit?: number;
    options?: {
        vectorWeight?: number;
        textWeight?: number;
        rerank?: boolean;
        temporalDecay?: boolean;
        mmr?: boolean;
        mmrLambda?: number;
    };
}

export interface MMRConfig {
    enabled: boolean;
    lambda: number;
}

export interface TemporalDecayConfig {
    enabled: boolean;
    halfLifeDays: number;
}

export const DEFAULT_MMR_CONFIG: MMRConfig = {
    enabled: false,
    lambda: 0.7,
};

export const DEFAULT_TEMPORAL_DECAY_CONFIG: TemporalDecayConfig = {
    enabled: true,
    halfLifeDays: 30,
};

export const EMBEDDING_DIMENSIONS = 1024;