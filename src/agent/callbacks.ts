/**
 * Mem0 Callback Handler
 * 
 * Middleware that automatically captures relevant agent interactions and stores them in Mem0.
 * Allows agents to have "photographic memory" of their actions without manual tool calls.
 */

import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { ChainValues } from "@langchain/core/utils/types";
import { addMemory } from "../memory/mem0.js";

export class Mem0CallbackHandler extends BaseCallbackHandler {
    name = "mem0_callback_handler";
    private agentWallet: string;
    private threadId: string;
    private userId?: string;
    private workflowWallet?: string;
    private composeRunId?: string;
    private toolRunNames = new Map<string, string>();

    constructor(agentWallet: string, threadId: string, userId?: string, workflowWallet?: string, composeRunId?: string) {
        super();
        this.agentWallet = agentWallet;
        this.threadId = threadId;
        this.userId = userId;
        this.workflowWallet = workflowWallet;
        this.composeRunId = composeRunId;
    }

    /**
     * Handle LLM generation end (capture AI response)
     */
    async handleLLMEnd(output: any, runId: string): Promise<void> {
        // We often prefer to capture the full chain result rather than raw LLM tokens
        // But this can be used to capture raw thoughts if needed.
    }

    /**
     * Handle Tool start (capture tool inputs/intent)
     */
    async handleToolStart(tool: Serialized, input: string, runId: string, parentRunId?: string): Promise<void> {
        if (!tool) return;

        const toolName = tool.name || "unknown_tool";
        this.toolRunNames.set(runId, toolName);

        // Ignore internal memory tools to avoid feedback loops
        if (toolName.includes("knowledge") || toolName.includes("feedback") || toolName.includes("memory")) return;

        console.log(`[Mem0Handler] Capturing tool start: ${toolName}`);

        await addMemory({
            messages: [
                { role: "system", content: `Tool '${toolName}' started.` },
                { role: "user", content: `Input: ${typeof input === 'string' ? input : JSON.stringify(input)}` }
            ],
            agent_id: this.agentWallet,
            user_id: this.userId,
            run_id: this.threadId,
            metadata: {
                type: "tool_execution",
                tool: toolName,
                run_id: runId,
                workflow_wallet: this.workflowWallet,
                compose_run_id: this.composeRunId,
            }
        });
    }

    /**
     * Handle Tool end (capture tool outputs)
     */
    async handleToolEnd(output: any, runId: string): Promise<void> {
        const toolName = this.toolRunNames.get(runId) || "unknown_tool";
        this.toolRunNames.delete(runId);

        await addMemory({
            messages: [
                { role: "system", content: `Tool '${toolName}' completed.` },
                { role: "assistant", content: `Output: ${serializeToolPayload(output)}` },
            ],
            agent_id: this.agentWallet,
            user_id: this.userId,
            run_id: this.threadId,
            metadata: {
                type: "tool_output",
                tool: toolName,
                run_id: runId,
                workflow_wallet: this.workflowWallet,
                compose_run_id: this.composeRunId,
            },
        });
    }

    /**
     * Handle Chain end (capture final agent response)
     */
    async handleChainEnd(outputs: ChainValues, runId: string): Promise<void> {
        // Identify if this is the top-level agent chain
        if (outputs.output || outputs.messages) {
            const content = outputs.output || (outputs.messages && outputs.messages.length > 0 ? outputs.messages[outputs.messages.length - 1].content : null);

            if (content && typeof content === "string") {
                console.log(`[Mem0Handler] Capturing chain output`);
                await addMemory({
                    messages: [
                        { role: "assistant", content: content }
                    ],
                    agent_id: this.agentWallet,
                    user_id: this.userId,
                    run_id: this.threadId,
                    metadata: {
                        type: "agent_response",
                        run_id: runId,
                        workflow_wallet: this.workflowWallet,
                        compose_run_id: this.composeRunId,
                    }
                });
            }
        }
    }

    /**
     * Handle user input (on chain start - tricky because callbacks mostly handle outputs)
     * The best place to capture USER input is actually before invoking the agent, 
     * but we can try to capture it here if we have access to inputs.
     */
    async handleChainStart(chain: Serialized, inputs: ChainValues): Promise<void> {
        // Capture User Input
        if (inputs.input || (inputs.messages && inputs.messages.length > 0)) {
            // Simple heuristic to identify the user message
            let userMsg = "";
            if (typeof inputs.input === "string") userMsg = inputs.input;
            else if (Array.isArray(inputs.messages)) {
                const lastMsg = inputs.messages[inputs.messages.length - 1];
                if (lastMsg.constructor.name === "HumanMessage") {
                    userMsg = lastMsg.content;
                }
            }

            if (userMsg) {
                // Don't await this to avoid blocking latency
                addMemory({
                    messages: [{ role: "user", content: userMsg }],
                    agent_id: this.agentWallet,
                    user_id: this.userId,
                    run_id: this.threadId,
                    metadata: {
                        type: "user_message",
                        workflow_wallet: this.workflowWallet,
                        compose_run_id: this.composeRunId,
                    }
                }).catch((err: Error) => console.error("[Mem0Handler] Background save failed:", err));
            }
        }
    }
}

function serializeToolPayload(value: unknown): string {
    if (typeof value === "string") {
        return value.slice(0, 4000);
    }

    try {
        return JSON.stringify(value, null, 2).slice(0, 4000);
    } catch {
        return String(value).slice(0, 4000);
    }
}
