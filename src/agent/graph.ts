/**
 * Agent State Graph
 * 
 * Defines the LangGraph execution flow:
 * [Start] -> [Model] -> [Tools?] -> [Model] ... -> [End]
 */

import { StateGraph, MessagesAnnotation, START, END } from "@langchain/langgraph";
import { type BaseMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import type { DynamicStructuredTool } from "@langchain/core/tools";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { FileSystemCheckpointSaver } from "./checkpoint.js";
import type { RunnableConfig } from "@langchain/core/runnables";
import { addMemory } from "../memory/mem0.js";

export function createAgentGraph(
    model: any,
    tools: DynamicStructuredTool[],
    checkpointDir: string,
    systemPrompt?: string
) {
    // DEBUG: Log tools before binding
    console.log(`[DEBUG] Binding ${tools.length} tools to model:`);
    tools.forEach((t, idx) => {
        console.log(`[DEBUG] Tool ${idx + 1}: ${t.name} - ${t.description}`);
    });
    if (systemPrompt) {
        console.log(`[DEBUG] System prompt provided (${systemPrompt.length} chars)`);
    }

    // Store tool definitions in graph memory to improve tool-selection context quality.
    (async () => {
        try {
            // For each tool, check/add to agent memory
            for (const tool of tools) {
                const toolDef = {
                    name: tool.name,
                    description: tool.description,
                    schema: JSON.stringify(tool.schema)
                };

                await addMemory({
                    messages: [
                        { role: "system", content: `Tooltip: ${tool.name}. Valid JSON Schema: ${toolDef.schema}. purpose: ${tool.description}` }
                    ],
                    user_id: "system_tools_v1",
                    metadata: { type: "tool_definition", tool_name: tool.name },
                });
            }
            console.log(`[Mem0] Optimized ${tools.length} tool definitions into shared memory.`);
        } catch (e) {
            console.warn("[Mem0] Failed to optimize tool definitions:", e);
        }
    })();

    // Bind tools to model
    // For vLLM compatibility: don't specify tool_choice to avoid "auto tool choice requires --enable-auto-tool-choice" error
    // The agent's system prompt instructs it when to use tools - LLM reasoning handles tool selection
    const modelWithTools = model.bindTools(tools);

    // DEBUG: Check if tools were bound - properly inspect the object
    console.log(`[DEBUG] Model after bindTools type:`, typeof modelWithTools);
    console.log(`[DEBUG] Model constructor:`, modelWithTools.constructor.name);
    console.log(`[DEBUG] Has kwargs:`, !!modelWithTools.kwargs);
    if (modelWithTools.kwargs) {
        console.log(`[DEBUG] kwargs.tools exists:`, !!modelWithTools.kwargs.tools);
        console.log(`[DEBUG] kwargs.tools length:`, modelWithTools.kwargs.tools?.length || 0);
        // Check if tool_choice is being set
        console.log(`[DEBUG] kwargs.tool_choice:`, modelWithTools.kwargs.tool_choice || 'not set');
    }

    const toolNode = new ToolNode(tools);

    // Define Nodes
    async function callModel(state: typeof MessagesAnnotation.State, config?: RunnableConfig) {
        // Inject system prompt as first message if provided and not already present
        let messages = state.messages;
        if (systemPrompt && (messages.length === 0 || messages[0]._getType() !== "system")) {
            messages = [new SystemMessage(systemPrompt), ...messages];
        }
        const response = await modelWithTools.invoke(messages, config);
        return { messages: [response] };
    }

    function shouldContinue(state: typeof MessagesAnnotation.State) {
        const lastMessage = state.messages[state.messages.length - 1] as AIMessage;

        // If the LLM made tool calls, verify if we should route to tools
        if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
            return "tools";
        }
        return "__end__"; // LangGraph uses __end__ or END constant
    }

    // Construct Graph
    const workflow = new StateGraph(MessagesAnnotation)
        .addNode("agent", callModel)
        .addNode("tools", toolNode)
        .addEdge(START, "agent")
        .addConditionalEdges("agent", shouldContinue)
        .addEdge("tools", "agent");

    // Initialize Checkpointer
    const checkpointer = new FileSystemCheckpointSaver(checkpointDir);

    // Compile
    return workflow.compile({
        checkpointer
    });
}
