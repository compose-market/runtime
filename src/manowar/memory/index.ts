export type {
    MemoryItem,
    MemorySearchParams,
    MemoryAddParams,
    KnowledgeAddParams,
    EmbeddingResult,
    SearchResult,
    HybridSearchParams,
    MemoryVector,
    SessionTranscript,
    MemoryStats,
    LayeredSearchParams,
    LayeredSearchResult,
    MemoryJobExecution,
    MemoryJobRecord,
    MemoryJobType,
    MemoryMaintenanceJobInput,
} from "./types.js";

export type {
    AgentMemoryLayer,
    AgentMemoryLoopStep,
    AgentMemoryScope,
    AgentMemoryContextResponse,
    AgentMemoryRecordResponse,
    AgentMemoryRememberResponse,
} from "./agent-loop.js";

export type {
    MemoryWorkflowManifest,
    MemoryWorkflowStepManifest,
} from "./workflows.js";

export {
    CACHE_TTL_SECONDS,
    createContentHash,
    getCachedJson,
    getGraphQueryCacheKey,
    getLayerQueryCacheKey,
    getRedisClient,
    getVectorQueryCacheKey,
    invalidateMemoryScope,
    setCachedJson,
} from "./cache.js";

export {
    getMemoryMongoClient,
    getMemoryMongoDb,
    closeMemoryMongo,
    getMemoryVectorsCollection,
    getSessionTranscriptsCollection,
    getPatternsCollection,
    getArchivesCollection,
    getMemoryJobsCollection,
    getSkillsCollection,
    getSessionsCollection,
} from "./mongo.js";

export {
    addMemory,
    addKnowledge,
    searchMemory,
    getAllMemories,
} from "./mem0.js";

export {
    getEmbedding,
    getEmbeddingsBatch,
} from "./embedding.js";

export {
    applyTemporalDecay,
    applyDecayToResults,
    calculateDecayMultiplier,
    toDecayLambda,
} from "./decay.js";

export {
    mmrRerank,
    mmrRerankPrecise,
} from "./mmr.js";

export {
    hybridVectorSearch,
    indexVector,
    indexMemoryContent,
    searchVectors,
} from "./vector.js";

export {
    storeTranscript,
    rememberSessionMessages,
    getTranscriptBySessionId,
    getTranscriptByThreadId,
    indexSessionTranscript,
    getWorkingSessionMemory,
    updateWorkingSessionMemory,
    getSessionTranscript,
    getTranscriptByThread,
    compressSession,
} from "./transcript.js";

export {
    rerankDocuments,
    applyVectorRanking,
} from "./ranking.js";

export {
    searchMemoryLayers,
} from "./layers.js";

export {
    AGENT_MEMORY_WORKFLOW_VERSION,
    AgentMemoryInputError,
    assembleAgentMemoryContext,
    normalizeAgentMemoryScope,
    recordAgentMemoryTurn,
    rememberAgentMemory,
    runAgentMemoryLoop,
} from "./agent-loop.js";

export {
    getMemoryWorkflowManifest,
    getMemoryWorkflowManifests,
} from "./workflows.js";

export {
    DEFAULT_AGENT_MEMORY_LAYERS,
    extractLayeredMemoryItems,
    formatAgentMemoryPrompt,
    summarizeLayeredMemory,
    trimMemoryText,
} from "./summary.js";

export {
    consolidateAgentMemories,
    extractExecutionPatterns,
    createMemoryArchive,
    updateMemoryDecayScores,
    getLearnedSkill,
    validateExtractedPattern,
    getProceduralPattern,
    listLearnedSkills,
    listProceduralPatterns,
    promotePatternToSkill,
    cleanupExpiredMemories,
    syncArchiveToPinata,
    getMemoryStats,
    listActiveMemoryAgentWallets,
} from "./operations.js";

export {
    createMemoryJobId,
    runMemoryMaintenanceJob,
    getMemoryJob,
} from "./jobs.js";

export {
    getMemoryItem,
    updateMemoryItem,
    deleteMemoryItem,
    resolveMemoryConflict,
} from "./items.js";

export {
    runMemoryEval,
} from "./evals.js";

export {
    normalizeMemoryFilters,
    mergeMemoryMongoFilters,
    matchesMemoryFilters,
} from "./filters.js";
