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
} from "./types.js";

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
    consolidateAgentMemories,
    extractExecutionPatterns,
    createMemoryArchive,
    updateMemoryDecayScores,
    validateExtractedPattern,
    promotePatternToSkill,
    cleanupExpiredMemories,
    syncArchiveToPinata,
    getMemoryStats,
} from "./operations.js";
