import type { IndexDirection, ObjectId } from "mongodb";

// =============================================================================
// Mem0 Domain
// =============================================================================

export interface MemoryItem {
    id: string;
    memory: string;
    user_id?: string;
    agent_id?: string;
    run_id?: string;
    metadata?: Record<string, unknown>;
    created_at?: string;
    updated_at?: string;
    relations?: Array<{ source: string; target: string; relation: string }>;
}

export interface FilterCondition {
    key: string;
    value: string | number | boolean;
    operator?: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains" | "icontains";
}

export interface V2Filters {
    AND?: FilterCondition[];
    OR?: FilterCondition[];
    NOT?: FilterCondition[];
}

export interface MemorySearchParams {
    query: string;
    user_id?: string;
    agent_id?: string;
    run_id?: string;
    limit?: number;
    filters?: Record<string, unknown>;
    enable_graph?: boolean;
    rerank?: boolean;
    keyword_search?: boolean;
    v2_filters?: V2Filters;
    custom_categories?: string[];
}

export interface MemoryAddParams {
    messages: Array<{ role: string; content: string }>;
    user_id?: string;
    agent_id?: string;
    run_id?: string;
    metadata?: Record<string, unknown>;
    enable_graph?: boolean;
}

export interface KnowledgeAddParams {
    content: string;
    agent_id: string;
    user_id?: string;
    key?: string;
    source?: "file" | "url" | "paste";
    enable_graph?: boolean;
    metadata?: Record<string, unknown>;
}

// =============================================================================
// Embedding / Search Domain
// =============================================================================

export interface EmbeddingResult {
    embedding: number[];
    provider: "voyage" | "cloudflare";
    cached: boolean;
    dimensions: number;
}

export interface SearchResult {
    id: string;
    vectorId?: string;
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

export interface HybridSearchParams {
    query: string;
    agentWallet: string;
    userId?: string;
    threadId?: string;
    limit?: number;
    threshold?: number;
    options?: {
        vectorWeight?: number;
        textWeight?: number;
        temporalDecay?: boolean;
        rerank?: boolean;
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

// =============================================================================
// MongoDB Persistence Domain
// =============================================================================

export interface ProceduralPattern {
    _id?: ObjectId;
    patternId: string;
    agentWallet: string;
    patternType: "workflow" | "decision" | "response" | "tool_sequence";
    trigger: {
        type: "intent" | "keyword" | "context" | "state";
        value: string;
        conditions?: Record<string, unknown>;
    };
    steps: Array<{
        action: string;
        params?: Record<string, unknown>;
        expectedOutcome?: string;
        order: number;
    }>;
    summary: string;
    embedding?: number[];
    successRate: number;
    executionCount: number;
    lastExecuted: number;
    metadata?: {
        taskType?: string;
        tags?: string[];
        sourceRunId?: string;
    };
    createdAt: number;
    updatedAt?: number;
}

export interface MemoryArchive {
    _id?: ObjectId;
    archiveId: string;
    agentWallet: string;
    summary: string;
    summaryEmbedding?: number[];
    content: string;
    contentEmbedding?: number[];
    compressed: boolean;
    ipfsCid?: string;
    dateRange: {
        start: number;
        end: number;
    };
    metadata?: {
        entryCount?: number;
        originalSize?: number;
        compressedSize?: number;
        topics?: string[];
    };
    createdAt: number;
    expiresAt?: number;
}

export interface SkillDocument {
    _id?: ObjectId;
    skillId: string;
    name: string;
    description: string;
    descriptionEmbedding?: number[];
    category: string;
    trigger: {
        type: "intent" | "keyword" | "pattern";
        patterns: string[];
    };
    spawnConfig: {
        skillType: "learned" | "custom" | "builtin";
        systemPrompt?: string;
        tools?: string[];
        maxSteps?: number;
        conditions?: Record<string, unknown>;
    };
    successRate: number;
    usageCount: number;
    creator: string;
    agents: string[];
    tags?: string[];
    createdAt: number;
    updatedAt?: number;
}

export interface SessionMemory {
    _id?: ObjectId;
    sessionId: string;
    agentWallet: string;
    userId?: string;
    threadId?: string;
    workingMemory: {
        context: string[];
        entities: Record<string, unknown>;
        state: Record<string, unknown>;
    };
    compressed: boolean;
    createdAt: number;
    expiresAt: number;
    lastAccessedAt: number;
}

export interface MemoryVector {
    _id?: ObjectId;
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
    metadata?: Record<string, unknown>;
}

export interface SessionTranscript {
    _id?: ObjectId;
    sessionId: string;
    threadId: string;
    agentWallet: string;
    userId?: string;
    messages: Array<{
        role: "user" | "assistant" | "system" | "tool";
        content: string;
        timestamp: number;
        toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
    }>;
    summary?: string;
    summaryEmbedding?: number[];
    tokenCount?: number;
    metadata: {
        modelUsed: string;
        totalTokens: number;
        contextWindow: number;
    };
    createdAt: number;
    expiresAt?: number;
}

export const MEMORY_VECTOR_INDEXES: { key: { [key: string]: IndexDirection }; name: string }[] = [
    { key: { agentWallet: 1 }, name: "idx_vector_wallet" },
    { key: { vectorId: 1 }, name: "idx_vector_id" },
    { key: { agentWallet: 1, createdAt: -1 }, name: "idx_vector_wallet_created" },
    { key: { agentWallet: 1, threadId: 1 }, name: "idx_vector_wallet_thread" },
    { key: { userId: 1 }, name: "idx_vector_user" },
    { key: { source: 1 }, name: "idx_vector_source" },
    { key: { decayScore: -1 }, name: "idx_vector_decay" },
    { key: { lastAccessedAt: -1 }, name: "idx_vector_last_accessed" },
];

export const TRANSCRIPT_INDEXES: { key: { [key: string]: IndexDirection }; name: string; unique?: boolean }[] = [
    { key: { sessionId: 1 }, name: "idx_transcript_session_id", unique: true },
    { key: { threadId: 1 }, name: "idx_transcript_thread_id" },
    { key: { agentWallet: 1 }, name: "idx_transcript_wallet" },
    { key: { agentWallet: 1, createdAt: -1 }, name: "idx_transcript_wallet_created" },
    { key: { userId: 1 }, name: "idx_transcript_user" },
];

export const PATTERN_INDEXES: { key: { [key: string]: IndexDirection }; name: string }[] = [
    { key: { agentWallet: 1 }, name: "idx_pattern_wallet" },
    { key: { patternId: 1 }, name: "idx_pattern_id" },
    { key: { agentWallet: 1, patternType: 1 }, name: "idx_pattern_wallet_type" },
    { key: { "trigger.type": 1, "trigger.value": 1 }, name: "idx_pattern_trigger_lookup" },
    { key: { successRate: -1 }, name: "idx_pattern_success_rate" },
    { key: { lastExecuted: -1 }, name: "idx_pattern_last_executed" },
    { key: { agentWallet: 1, successRate: -1 }, name: "idx_pattern_wallet_success" },
];

export const ARCHIVE_INDEXES: { key: { [key: string]: IndexDirection }; name: string }[] = [
    { key: { agentWallet: 1 }, name: "idx_archive_wallet" },
    { key: { archiveId: 1 }, name: "idx_archive_id" },
    { key: { agentWallet: 1, createdAt: -1 }, name: "idx_archive_wallet_created" },
    { key: { "dateRange.start": 1, "dateRange.end": 1 }, name: "idx_archive_date_range" },
];

export const SKILL_INDEXES: { key: { [key: string]: IndexDirection }; name: string }[] = [
    { key: { skillId: 1 }, name: "idx_skill_id" },
    { key: { creator: 1 }, name: "idx_skill_creator" },
    { key: { "trigger.type": 1 }, name: "idx_skill_trigger_type" },
    { key: { successRate: -1, usageCount: -1 }, name: "idx_skill_success_usage" },
    { key: { agents: 1 }, name: "idx_skill_agents" },
    { key: { category: 1 }, name: "idx_skill_category" },
];

export const SESSION_INDEXES: { key: { [key: string]: IndexDirection }; name: string }[] = [
    { key: { sessionId: 1 }, name: "idx_session_id" },
    { key: { agentWallet: 1 }, name: "idx_session_wallet" },
    { key: { expiresAt: 1 }, name: "idx_session_ttl" },
    { key: { lastAccessedAt: -1 }, name: "idx_session_last_accessed" },
];

export interface MemoryStats {
    totalVectors: number;
    totalTranscripts: number;
    avgDecayScore: number;
    oldestVector: number;
    newestVector: number;
    byType: Record<string, number>;
}

export interface LayeredSearchParams {
    query: string;
    agentWallet: string;
    userId?: string;
    threadId?: string;
    layers: Array<"working" | "scene" | "graph" | "patterns" | "archives" | "vectors">;
    limit?: number;
}

export interface LayeredSearchResult {
    query: string;
    layers: Record<string, unknown[]>;
    totals: Record<string, number>;
}
