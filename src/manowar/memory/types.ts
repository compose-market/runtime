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
    mode?: "global" | "local";
    haiId?: string;
    /**
     * Provider-specific scoped filters. For Mem0 v3 these are merged into the
     * `filters` object alongside the entity IDs. Our framework's CF rerank /
     * decay / MMR / top_k live on the Atlas vector layer (see ./ranking.ts
     * and ./vector.ts) — Mem0 owns its own retrieval defaults (top_k=10,
     * threshold=0.1, hybrid retrieval always on) and we do NOT thread them
     * through this type.
     */
    filters?: Record<string, unknown>;
    /**
     * Reserved for potential future de-coupling from Mem0; not wired today.
     * Mem0 v3 has built-in top_k (default 10) and we let it own that.
     */
    limit?: number;
}

export interface MemoryAddParams {
    messages: Array<{ role: string; content: string }>;
    user_id?: string;
    agent_id?: string;
    run_id?: string;
    mode?: "global" | "local";
    haiId?: string;
    metadata?: Record<string, unknown>;
}

export interface KnowledgeAddParams {
    content: string;
    agent_id: string;
    user_id?: string;
    key?: string;
    source?: "file" | "url" | "paste";
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
    userAddress?: string;
    threadId?: string;
    mode?: "global" | "local";
    haiId?: string;
    decayScore: number;
    accessCount: number;
    createdAt: number;
}

export interface HybridSearchParams {
    query: string;
    agentWallet: string;
    userAddress?: string;
    threadId?: string;
    mode?: "global" | "local";
    haiId?: string;
    filters?: Record<string, unknown>;
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
    mode?: "global" | "local";
    haiId?: string;
    scopeKind?: "global" | "local";
    scopeId?: string;
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
    mode?: "global" | "local";
    haiId?: string;
    scopeKind?: "global" | "local";
    scopeId?: string;
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
    userAddress?: string;
    threadId?: string;
    mode?: "global" | "local";
    haiId?: string;
    scopeKind?: "global" | "local";
    scopeId?: string;
    workingMemory: {
        context: string[];
        entities: Record<string, unknown>;
        state: Record<string, unknown>;
    };
    metadata?: Record<string, unknown>;
    compressed: boolean;
    createdAt: number;
    expiresAt: Date;
    lastAccessedAt: number;
}

export interface MemoryVector {
    _id?: ObjectId;
    vectorId: string;
    agentWallet: string;
    userAddress?: string;
    threadId?: string;
    mode?: "global" | "local";
    haiId?: string;
    scopeKind?: "global" | "local";
    scopeId?: string;
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
    userAddress?: string;
    mode?: "global" | "local";
    haiId?: string;
    scopeKind?: "global" | "local";
    scopeId?: string;
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
    } & Record<string, unknown>;
    createdAt: number;
    expiresAt?: number;
}

export type MemoryJobType = "consolidate" | "patterns_extract" | "archive_create" | "decay_update" | "cleanup";
export type MemoryJobExecution = "inline" | "temporal";

export interface MemoryMaintenanceJobInput {
    type: MemoryJobType;
    execution?: MemoryJobExecution;
    agentWallet?: string;
    agentWallets?: string[];
    timeRange?: {
        start: number;
        end: number;
    };
    dateRange?: {
        start: number;
        end: number;
    };
    confidenceThreshold?: number;
    halfLifeDays?: number;
    olderThanDays?: number;
    windowDays?: number;
    batchSize?: number;
    compress?: boolean;
    syncToIpfs?: boolean;
}

export interface MemoryJobRecord {
    _id?: ObjectId;
    jobId: string;
    type: MemoryJobType;
    execution: MemoryJobExecution;
    status: "running" | "completed" | "failed";
    agentWallet?: string;
    temporalWorkflowId?: string;
    temporalRunId?: string;
    data?: unknown;
    error?: string;
    createdAt: number;
    completedAt?: number;
}

export const MEMORY_VECTOR_INDEXES: { key: { [key: string]: IndexDirection }; name: string }[] = [
    { key: { agentWallet: 1 }, name: "idx_vector_wallet" },
    { key: { vectorId: 1 }, name: "idx_vector_id" },
    { key: { agentWallet: 1, createdAt: -1 }, name: "idx_vector_wallet_created" },
    { key: { agentWallet: 1, threadId: 1 }, name: "idx_vector_wallet_thread" },
    { key: { agentWallet: 1, mode: 1, haiId: 1, threadId: 1 }, name: "idx_vector_wallet_scope_thread" },
    { key: { userAddress: 1 }, name: "idx_vector_user" },
    { key: { source: 1 }, name: "idx_vector_source" },
    { key: { "metadata.app_id": 1 }, name: "idx_vector_app_id" },
    { key: { decayScore: -1 }, name: "idx_vector_decay" },
    { key: { lastAccessedAt: -1 }, name: "idx_vector_last_accessed" },
];

export const TRANSCRIPT_INDEXES: { key: { [key: string]: IndexDirection }; name: string; unique?: boolean }[] = [
    { key: { sessionId: 1 }, name: "idx_transcript_session_id", unique: true },
    { key: { threadId: 1 }, name: "idx_transcript_thread_id" },
    { key: { agentWallet: 1 }, name: "idx_transcript_wallet" },
    { key: { agentWallet: 1, createdAt: -1 }, name: "idx_transcript_wallet_created" },
    { key: { agentWallet: 1, mode: 1, haiId: 1, threadId: 1 }, name: "idx_transcript_wallet_scope_thread" },
    { key: { userAddress: 1 }, name: "idx_transcript_user" },
    { key: { "metadata.app_id": 1 }, name: "idx_transcript_app_id" },
];

export const PATTERN_INDEXES: { key: { [key: string]: IndexDirection }; name: string }[] = [
    { key: { agentWallet: 1 }, name: "idx_pattern_wallet" },
    { key: { patternId: 1 }, name: "idx_pattern_id" },
    { key: { agentWallet: 1, patternType: 1 }, name: "idx_pattern_wallet_type" },
    { key: { "trigger.type": 1, "trigger.value": 1 }, name: "idx_pattern_trigger_lookup" },
    { key: { successRate: -1 }, name: "idx_pattern_success_rate" },
    { key: { lastExecuted: -1 }, name: "idx_pattern_last_executed" },
    { key: { agentWallet: 1, successRate: -1 }, name: "idx_pattern_wallet_success" },
    { key: { "metadata.app_id": 1 }, name: "idx_pattern_app_id" },
];

export const ARCHIVE_INDEXES: { key: { [key: string]: IndexDirection }; name: string }[] = [
    { key: { agentWallet: 1 }, name: "idx_archive_wallet" },
    { key: { archiveId: 1 }, name: "idx_archive_id" },
    { key: { agentWallet: 1, createdAt: -1 }, name: "idx_archive_wallet_created" },
    { key: { "dateRange.start": 1, "dateRange.end": 1 }, name: "idx_archive_date_range" },
    { key: { "metadata.app_id": 1 }, name: "idx_archive_app_id" },
];

export const SKILL_INDEXES: { key: { [key: string]: IndexDirection }; name: string }[] = [
    { key: { skillId: 1 }, name: "idx_skill_id" },
    { key: { creator: 1 }, name: "idx_skill_creator" },
    { key: { "trigger.type": 1 }, name: "idx_skill_trigger_type" },
    { key: { successRate: -1, usageCount: -1 }, name: "idx_skill_success_usage" },
    { key: { agents: 1 }, name: "idx_skill_agents" },
    { key: { category: 1 }, name: "idx_skill_category" },
];

export const SESSION_INDEXES: { key: { [key: string]: IndexDirection }; name: string; expireAfterSeconds?: number }[] = [
    { key: { sessionId: 1 }, name: "idx_session_id" },
    { key: { agentWallet: 1 }, name: "idx_session_wallet" },
    { key: { agentWallet: 1, mode: 1, haiId: 1, threadId: 1 }, name: "idx_session_wallet_scope_thread" },
    { key: { "metadata.app_id": 1 }, name: "idx_session_app_id" },
    // TTL index: Mongo deletes documents whose `expiresAt` (BSON Date) is in
    // the past. Without `expireAfterSeconds` this would just be a plain
    // ascending index and sessions would grow unbounded.
    { key: { expiresAt: 1 }, name: "idx_session_ttl", expireAfterSeconds: 0 },
    { key: { lastAccessedAt: -1 }, name: "idx_session_last_accessed" },
];

export const MEMORY_JOB_INDEXES: { key: { [key: string]: IndexDirection }; name: string; unique?: boolean }[] = [
    { key: { jobId: 1 }, name: "idx_memory_job_id", unique: true },
    { key: { agentWallet: 1, createdAt: -1 }, name: "idx_memory_job_wallet_created" },
    { key: { status: 1, createdAt: -1 }, name: "idx_memory_job_status_created" },
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
    userAddress?: string;
    threadId?: string;
    mode?: "global" | "local";
    haiId?: string;
    filters?: Record<string, unknown>;
    layers: Array<"working" | "scene" | "graph" | "patterns" | "archives" | "vectors">;
    limit?: number;
}

export interface LayeredSearchResult {
    query: string;
    layers: Record<string, unknown[]>;
    totals: Record<string, number>;
}
