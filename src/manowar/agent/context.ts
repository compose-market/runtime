import { AsyncLocalStorage } from "node:async_hooks";

export interface AgentExecutionContext {
    mode?: "global" | "local";
    composeRunId?: string;
    threadId?: string;
    agentWallet?: string;
    userAddress?: string;
    workflowWallet?: string;
    haiId?: string;
    memoryPrompt?: string;
    lastUserMessage?: string;
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
