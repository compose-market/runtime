/**
 * Mem0 Callback Handler
 * 
 * Middleware that automatically captures relevant agent interactions and stores them in Mem0.
 * Allows agents to have "photographic memory" of their actions without manual tool calls.
 */

import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { ChainValues } from "@langchain/core/utils/types";

const LAMBDA_API_URL = process.env.LAMBDA_API_URL || "https://api.compose.market";

// HTTP client for mem0 API
async function addMemory(params: {
    messages: Array<{ role: string; content: string }>;
    agent_id?: string;
    user_id?: string;
    run_id?: string;
    metadata?: Record<string, unknown>;
}): Promise<any[]> {
    try {
        const response = await fetch(`${LAMBDA_API_URL}/api/memory/add`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params),
        });
        if (!response.ok) {
            console.error(`[mem0] HTTP ${response.status}: ${await response.text()}`);
            return [];
        }
        return await response.json();
    } catch (error) {
        console.error("[mem0] Failed to add memory:", error);
        return [];
    }
}

export class Mem0CallbackHandler extends BaseCallbackHandler {
    name = "mem0_callback_handler";
    private agentId: string;
    private threadId: string;
    private userId?: string;
    private manowarId?: string;

    constructor(agentId: string, threadId: string, userId?: string, manowarId?: string) {
        super();
        this.agentId = agentId;
        this.threadId = threadId;
        this.userId = userId;
        this.manowarId = manowarId;
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

        // Ignore internal memory tools to avoid feedback loops
        if (toolName.includes("knowledge") || toolName.includes("feedback") || toolName.includes("memory")) return;

        console.log(`[Mem0Handler] Capturing tool start: ${toolName}`);

        await addMemory({
            messages: [
                { role: "system", content: `Tool '${toolName}' started.` },
                { role: "user", content: `Input: ${typeof input === 'string' ? input : JSON.stringify(input)}` }
            ],
            agent_id: this.agentId,
            user_id: this.userId,
            run_id: this.threadId,
            metadata: {
                type: "tool_execution",
                tool: toolName,
                run_id: runId,
                manowar_id: this.manowarId
            }
        });
    }

    /**
     * Handle Tool end (capture tool outputs)
     */
    async handleToolEnd(output: any, runId: string): Promise<void> {
        // We could capture output here, but we lack the tool name in this signature.
        // For now, capturing the input in handleToolStart is sufficient for intent tracking.
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
                    agent_id: this.agentId,
                    user_id: this.userId,
                    run_id: this.threadId,
                    metadata: {
                        type: "agent_response",
                        run_id: runId,
                        manowar_id: this.manowarId
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
                    agent_id: this.agentId,
                    user_id: this.userId,
                    run_id: this.threadId,
                    metadata: {
                        type: "user_message",
                        manowar_id: this.manowarId
                    }
                }).catch((err: Error) => console.error("[Mem0Handler] Background save failed:", err));
            }
        }
    }
}

