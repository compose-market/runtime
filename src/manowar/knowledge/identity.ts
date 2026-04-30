import { buildPinataGatewayIpfsUrl } from "../../auth.js";
import {
  addKnowledge,
  getEmbedding,
  getMemoryVectorsCollection,
  indexMemoryContent,
  searchMemory,
} from "../memory/index.js";
import { resolveAgent } from "../runtime.js";
import type { KnowledgeSearchResult } from "./workspace.js";

type AgentCardKnowledge = {
  knowledge?: string[];
};

const identityWarmups = new Map<string, Promise<void>>();

function toCid(uri: string): string {
  return uri.replace(/^ipfs:\/\//i, "").replace(/^\/+/, "").split("/")[0] || uri;
}

function chunkText(text: string, maxChars = 1400, overlap = 180): string[] {
  const normalized = text.replace(/\r/g, "").trim();
  if (!normalized) {
    return [];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < normalized.length) {
    let end = Math.min(start + maxChars, normalized.length);
    if (end < normalized.length) {
      const boundary = normalized.lastIndexOf("\n", end);
      if (boundary > start + Math.floor(maxChars * 0.5)) {
        end = boundary;
      }
    }

    const chunk = normalized.slice(start, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }

    if (end >= normalized.length) {
      break;
    }

    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}

async function extractPdfText(data: ArrayBuffer): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({
    data: new Uint8Array(data),
    disableFontFace: true,
    useWorkerFetch: false,
  }).promise;
  const pages: string[] = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .filter(Boolean)
      .join(" ")
      .trim();
    if (text) {
      pages.push(text);
    }
  }

  return pages.join("\n\n");
}

async function extractDocumentText(response: Response, uri: string): Promise<string> {
  const contentType = (response.headers.get("content-type") || "").toLowerCase();

  if (contentType.includes("application/pdf") || uri.toLowerCase().endsWith(".pdf")) {
    return extractPdfText(await response.arrayBuffer());
  }

  if (contentType.includes("application/json") || uri.toLowerCase().endsWith(".json")) {
    const payload = await response.json();
    return JSON.stringify(payload, null, 2);
  }

  return response.text();
}

async function resolveIdentityUris(agentWallet: string): Promise<string[]> {
  const agent = resolveAgent(agentWallet);
  const agentCardUri = agent?.agentCardUri;
  if (!agentCardUri?.startsWith("ipfs://")) {
    return [];
  }

  const response = await fetch(buildPinataGatewayIpfsUrl(toCid(agentCardUri)));
  if (!response.ok) {
    throw new Error(`Failed to fetch agent card for identity knowledge (${response.status})`);
  }

  const card = await response.json() as AgentCardKnowledge;
  return Array.isArray(card.knowledge)
    ? card.knowledge.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

async function isIdentityIndexed(agentWallet: string, cid: string): Promise<boolean> {
  const vectors = await getMemoryVectorsCollection();
  const existing = await vectors.findOne({
    agentWallet,
    source: "knowledge",
    "metadata.scope": "identity",
    "metadata.cid": cid,
  }, {
    projection: { _id: 1 },
  });
  return Boolean(existing);
}

async function indexIdentityUri(agentWallet: string, uri: string): Promise<void> {
  const cid = toCid(uri);
  if (!cid || await isIdentityIndexed(agentWallet, cid)) {
    return;
  }

  const response = await fetch(buildPinataGatewayIpfsUrl(cid));
  if (!response.ok) {
    throw new Error(`Failed to fetch identity document ${cid} (${response.status})`);
  }

  const text = (await extractDocumentText(response, uri)).trim();
  if (!text) {
    return;
  }

  const chunks = chunkText(text);
  await Promise.all(chunks.map(async (chunk, index) => {
    const metadata = {
      scope: "identity",
      type: "knowledge",
      cid,
      uri,
      chunk: index + 1,
    };
    const key = `${cid}#${index + 1}`;

    await addKnowledge({
      content: chunk,
      agent_id: agentWallet,
      key,
      source: "file",
      metadata,
    });

    await indexMemoryContent({
      agentWallet,
      content: chunk,
      source: "knowledge",
      metadata,
    });
  }));
}

export async function ensureIdentityKnowledge(agentWallet: string): Promise<void> {
  const existing = identityWarmups.get(agentWallet);
  if (existing) {
    return existing;
  }

  const warmup = (async () => {
    const uris = await resolveIdentityUris(agentWallet);
    for (const uri of uris) {
      await indexIdentityUri(agentWallet, uri);
    }
  })().finally(() => {
    identityWarmups.delete(agentWallet);
  });

  identityWarmups.set(agentWallet, warmup);
  return warmup;
}

function dedupeIdentityResults(results: KnowledgeSearchResult[], limit: number): KnowledgeSearchResult[] {
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

async function searchIdentityVectors(params: {
  query: string;
  agentWallet: string;
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
            source: "knowledge",
            "metadata.scope": "identity",
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
      scope: "identity",
    }));
  } catch (error) {
    console.warn("[knowledge:identity] vector search unavailable, falling back to keyword search", error);
    const terms = params.query.toLowerCase().split(/\s+/).filter(Boolean);
    const docs = await vectors
      .find({
        agentWallet: params.agentWallet,
        source: "knowledge",
        "metadata.scope": "identity",
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
          scope: "identity" as const,
        };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, params.limit);
  }
}

export async function searchIdentityKnowledge(params: {
  query: string;
  agentWallet: string;
  limit: number;
}): Promise<KnowledgeSearchResult[]> {
  await ensureIdentityKnowledge(params.agentWallet);

  const [graphResults, vectorResults] = await Promise.all([
    searchMemory({
      query: params.query,
      agent_id: params.agentWallet,
      limit: params.limit,
      filters: {
        type: "knowledge",
        scope: "identity",
      },
    }),
    searchIdentityVectors(params),
  ]);

  const normalizedGraphResults = graphResults.map((item, index) => ({
    content: item.memory,
    score: Math.max(0.2, 0.68 - index * 0.04),
    scope: "identity" as const,
  }));

  return dedupeIdentityResults([
    ...normalizedGraphResults,
    ...vectorResults,
  ], params.limit);
}
