import type { AgentExecutionContext } from "./context.js";

type MemoryScopeMode = "global" | "local";

export interface ResolveMemoryScopeInput {
  agentId: string;
  userAddress?: string;
  workflowWallet?: string;
  context?: AgentExecutionContext;
}

export interface ResolvedMemoryScope {
  mode: MemoryScopeMode;
  agentId: string;
  userId?: string;
  threadId?: string;
  composeRunId?: string;
  filters: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export function resolveMemoryScope(input: ResolveMemoryScopeInput): ResolvedMemoryScope {
  const context = input.context;

  if (context?.mode === "local") {
    const haiId = context.haiId?.trim();
    if (!haiId) {
      throw new Error("Local memory scope requires haiId");
    }

    return {
      mode: "local",
      agentId: haiId,
      threadId: context.threadId?.trim() || haiId,
      filters: {
        mode: "local",
        hai_id: haiId,
      },
      metadata: {
        mode: "local",
        hai_id: haiId,
      },
    };
  }

  const metadata: Record<string, unknown> = {};
  const filters: Record<string, unknown> = {};

  if (input.workflowWallet) {
    metadata.workflow_wallet = input.workflowWallet;
    filters.workflow_wallet = input.workflowWallet;
  }

  return {
    mode: "global",
    agentId: input.agentId,
    userId: context?.userAddress || input.userAddress,
    threadId: context?.threadId,
    composeRunId: context?.composeRunId,
    filters,
    metadata,
  };
}
