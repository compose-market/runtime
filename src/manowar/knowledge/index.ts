import { searchIdentityKnowledge } from "./identity.js";
import {
  indexWorkspaceDocuments,
  normalizeKnowledgeLimit,
  normalizeWorkspaceDocuments,
  searchWorkspaceDocuments,
  type KnowledgeSearchResult,
  type WorkspaceDocument,
} from "./workspace.js";

export type { KnowledgeSearchResult, WorkspaceDocument };

export {
  indexWorkspaceDocuments,
  normalizeKnowledgeLimit,
  normalizeWorkspaceDocuments,
  searchIdentityKnowledge,
  searchWorkspaceDocuments,
};

function dedupeKnowledgeResults(results: KnowledgeSearchResult[], limit: number): KnowledgeSearchResult[] {
  const seen = new Set<string>();
  const deduped: KnowledgeSearchResult[] = [];

  for (const result of results.sort((left, right) => right.score - left.score)) {
    const key = `${result.scope}:${result.content.trim().toLowerCase()}`;
    if (!result.content.trim() || seen.has(key)) {
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

export async function searchKnowledge(params: {
  agentWallet: string;
  userAddress?: string;
  query: string;
  scope?: "identity" | "workspace" | "all";
  limit?: number;
}): Promise<KnowledgeSearchResult[]> {
  const limit = normalizeKnowledgeLimit(params.limit);
  const scope = params.scope || (params.userAddress ? "all" : "identity");
  const searches: Array<Promise<KnowledgeSearchResult[]>> = [];

  if (scope === "identity" || scope === "all") {
    searches.push(searchIdentityKnowledge({
      agentWallet: params.agentWallet,
      query: params.query,
      limit,
    }));
  }

  if ((scope === "workspace" || scope === "all") && params.userAddress) {
    searches.push(searchWorkspaceDocuments({
      agentWallet: params.agentWallet,
      userAddress: params.userAddress,
      query: params.query,
      limit,
    }));
  }

  if (searches.length === 0) {
    return [];
  }

  const results = (await Promise.all(searches)).flat();
  return dedupeKnowledgeResults(results, limit);
}
