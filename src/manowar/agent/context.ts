import { AsyncLocalStorage } from "node:async_hooks";

import type { AgentSessionContext } from "../framework.js";

export interface AgentExecutionContext {
    mode?: "global" | "local";
    composeRunId?: string;
    /**
     * Layer-0 root composeRunId for a swarm. Equals `composeRunId` at
     * the top of the swarm; layer-N descendants inherit it unchanged so
     * every layer shares the same workspace bus
     * (`harness/conclave.ts`). When undefined, callers default to
     * `composeRunId`.
     */
    rootComposeRunId?: string;
    threadId?: string;
    agentWallet?: string;
    userAddress?: string;
    workflowWallet?: string;
    haiId?: string;
    memoryPrompt?: string;
    lastUserMessage?: string;
    /**
     * Per-request session state (active session, budget remaining, granted
     * cloud permissions, connected Backpack accounts).
     *
     * MUST live on AsyncLocalStorage rather than on the AgentInstance
     * config — the AgentInstance is module-cached and shared across
     * concurrent requests, so mutating `agent.config.sessionContext` per
     * request races between users. Reading from AsyncLocalStorage gives
     * each in-flight request its own isolated session view.
     */
    sessionContext?: AgentSessionContext;
}

const executionContextStorage = new AsyncLocalStorage<AgentExecutionContext>();

export function getAgentExecutionContext(): AgentExecutionContext | undefined {
    return executionContextStorage.getStore();
}

export async function runWithAgentExecutionContext<T>(
    context: AgentExecutionContext,
    fn: () => Promise<T>,
): Promise<T> {
    return await executionContextStorage.run(context, fn);
}
