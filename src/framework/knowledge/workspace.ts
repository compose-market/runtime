import {
  addKnowledge,
  getEmbedding,
  getMemoryVectorsCollection,
  indexMemoryContent,
  indexVector,
  searchMemory,
} from "../memory/index.js";

export type WorkspaceDocument = {
  content: string;
  key?: string;
  source?: "file" | "url" | "paste";
  embedding?: number[];
  metadata?: Record<string, unknown>;
};

export type KnowledgeSearchResult = {
  content: string;
  score: number;
  scope: "identity" | "workspace";
};

export function normalizeWorkspaceDocuments(input: unknown): WorkspaceDocument[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .filter((item): item is WorkspaceDocument => typeof item === "object" && item !== null)
    .map((item) => ({
      ...item,
      content: typeof item.content === "string" ? item.content.trim() : "",
      key: typeof item.key === "string" ? item.key.trim() : undefined,
    }))
    .filter((item) => item.content.length > 0);
}

export function normalizeKnowledgeLimit(input: unknown): number {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return 5;
  }
  return Math.max(1, Math.min(8, Math.trunc(input)));
}

function dedupeWorkspaceResults(results: KnowledgeSearchResult[], limit: number): KnowledgeSearchResult[] {
  const seen = new Set<string>();
  const deduped: KnowledgeSearchResult[] = [];

  for (const result of results.sort((left, right) => right.score - left.score)) {
    const key = result.content.trim().toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(result);
    if (deduped.length >= limit) {
      break;
    }
  }

  return deduped;
}

function normalizeWorkspaceGraphResults(items: Array<{ memory: string }>): KnowledgeSearchResult[] {
  return items.map((item, index) => ({
    content: item.memory,
    score: Math.max(0.2, 0.68 - index * 0.04),
    scope: "workspace",
  }));
}

export async function indexWorkspaceDocuments(params: {
  agentWallet: string;
  userAddress: string;
  documents: WorkspaceDocument[];
}): Promise<{ indexed: number; documents: Array<{ key: string }> }> {
  await Promise.all(params.documents.map(async (document) => {
    const metadata = {
      ...(document.metadata || {}),
      scope: "workspace",
      type: "knowledge",
    };

    await addKnowledge({
      content: document.content,
      agent_id: params.agentWallet,
      user_id: params.userAddress,
      key: document.key,
      source: document.source || "file",
      enable_graph: true,
      metadata,
    });

    if (Array.isArray(document.embedding) && document.embedding.length > 0) {
      await indexVector({
        agentWallet: params.agentWallet,
        userAddress: params.userAddress,
        content: document.content,
        embedding: document.embedding,
        source: "knowledge",
        metadata,
      });
      return;
    }

    await indexMemoryContent({
      agentWallet: params.agentWallet,
      userAddress: params.userAddress,
      content: document.content,
      source: "knowledge",
      metadata,
    });
  }));

  return {
    indexed: params.documents.length,
    documents: params.documents.map((document, index) => ({
      key: document.key || `document-${index + 1}`,
    })),
  };
}

async function searchWorkspaceVectors(params: {
  query: string;
  agentWallet: string;
  userAddress: string;
  limit: number;
}): Promise<KnowledgeSearchResult[]> {
  const vectors = await getMemoryVectorsCollection();
  const embedding = await getEmbedding(params.query);
  const candidateLimit = Math.max(params.limit * 12, 48);

  try {
    const rawResults = await vectors.aggregate<{
      content: string;
      rawScore: number;
    }>([
      {
        $vectorSearch: {
          index: "vector_index",
          path: "embedding",
          queryVector: embedding.embedding,
          numCandidates: candidateLimit * 4,
          limit: candidateLimit,
          filter: {
            agentWallet: params.agentWallet,
            userAddress: params.userAddress,
            source: "knowledge",
            "metadata.scope": "workspace",
          },
        },
      },
      {
        $addFields: {
          rawScore: { $meta: "vectorSearchScore" },
        },
      },
      {
        $project: {
          _id: 0,
          content: 1,
          rawScore: 1,
        },
      },
    ]).toArray();

    return rawResults.slice(0, params.limit).map((item) => ({
      content: item.content,
      score: item.rawScore,
      scope: "workspace",
    }));
  } catch (error) {
    console.warn("[knowledge:workspace] vector search unavailable, falling back to keyword search", error);
    const terms = params.query.toLowerCase().split(/\s+/).filter(Boolean);
    const docs = await vectors
      .find({
        agentWallet: params.agentWallet,
        userAddress: params.userAddress,
        source: "knowledge",
        "metadata.scope": "workspace",
      })
      .sort({ createdAt: -1 })
      .limit(candidateLimit)
      .toArray();

    return docs
      .map((item) => {
        const contentLower = item.content.toLowerCase();
        const keywordHits = terms.reduce((acc, term) => acc + (contentLower.includes(term) ? 1 : 0), 0);
        const keywordScore = terms.length > 0 ? keywordHits / terms.length : 0;
        return {
          content: item.content,
          score: keywordScore * 0.7 + (item.decayScore || 1) * 0.3,
          scope: "workspace" as const,
        };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, params.limit);
  }
}

export async function searchWorkspaceDocuments(params: {
  query: string;
  agentWallet: string;
  userAddress: string;
  limit: number;
}): Promise<KnowledgeSearchResult[]> {
  const [graphResults, vectorResults] = await Promise.all([
    searchMemory({
      query: params.query,
      agent_id: params.agentWallet,
      user_id: params.userAddress,
      limit: params.limit,
      filters: {
        type: "knowledge",
        scope: "workspace",
      },
      enable_graph: true,
      rerank: true,
    }),
    searchWorkspaceVectors(params),
  ]);

  return dedupeWorkspaceResults([
    ...normalizeWorkspaceGraphResults(graphResults),
    ...vectorResults,
  ], params.limit);
}
