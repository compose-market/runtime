/**
 * Manowar Workflow Executor
 * 
 * Executes Manowar workflows using LangGraph supervisor pattern:
 * - A coordinator agent receives the task and routes to specialized workers
 * - Workers (agents) execute their portion and return results
 * - Coordinator aggregates and decides next steps
 * - mem0 provides cross-agent memory for solution caching
 * 
 * Payment: x402 nested payments at each level.
 */
import { StateGraph, MessagesAnnotation, START, END, Annotation } from "@langchain/langgraph";
import { HumanMessage, AIMessage, SystemMessage, BaseMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import type {
    Workflow,
    WorkflowStep,
    WorkflowExecutionState,
    ExecutorOptions,
    PaymentContext,
} from "./types.js";
import { MANOWAR_PRICES } from "./types.js";
// NOTE: GOAT tool execution now happens via MCP service HTTP API
// import { executeGoatTool, getPluginIds } from "../compose-runtime/runtimes/goat.js";
import { fetchManowarOnchain } from "../onchain.js";

// =============================================================================
// Configuration
// =============================================================================

const LAMBDA_API_URL = process.env.LAMBDA_API_URL || "https://api.compose.market";
const MCP_URL = process.env.MCP_URL || "https://mcp.compose.market";

// HTTP clients for mem0 API
interface MemoryItem {
    id: string;
    memory: string;
    user_id?: string;
    agent_id?: string;
    run_id?: string;
    metadata?: Record<string, unknown>;
}

async function addMemory(params: {
    messages: Array<{ role: string; content: string }>;
    agent_id?: string;
    user_id?: string;
    run_id?: string;
    metadata?: Record<string, unknown>;
}): Promise<MemoryItem[]> {
    try {
        const response = await fetch(`${LAMBDA_API_URL}/api/memory/add`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params),
        });
        if (!response.ok) return [];
        return await response.json();
    } catch (error) {
        console.error("[mem0] Failed to add memory:", error);
        return [];
    }
}

async function searchMemory(params: {
    query: string;
    agent_id?: string;
    user_id?: string;
    run_id?: string;
    limit?: number;
    filters?: Record<string, unknown>;
}): Promise<MemoryItem[]> {
    try {
        const response = await fetch(`${LAMBDA_API_URL}/api/memory/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params),
        });
        if (!response.ok) return [];
        return await response.json();
    } catch (error) {
        console.error("[mem0] Failed to search memory:", error);
        return [];
    }
}

// =============================================================================
// Manowar State Annotation
// =============================================================================

const ManowarStateAnnotation = Annotation.Root({
    messages: Annotation<BaseMessage[]>({
        reducer: (curr, update) => [...curr, ...update],
        default: () => [],
    }),
    workflowId: Annotation<string>(),
    manowarId: Annotation<number | undefined>(),
    task: Annotation<string>(),
    agents: Annotation<WorkflowStep[]>(),
    currentAgentIndex: Annotation<number>({
        reducer: (_, update) => update,
        default: () => 0,
    }),
    results: Annotation<Record<string, unknown>>({
        reducer: (curr, update) => ({ ...curr, ...update }),
        default: () => ({}),
    }),
    status: Annotation<"pending" | "running" | "success" | "error">({
        reducer: (_, update) => update,
        default: () => "pending",
    }),
    totalCostWei: Annotation<string>({
        reducer: (curr, update) => (BigInt(curr) + BigInt(update)).toString(),
        default: () => "0",
    }),
    error: Annotation<string | undefined>(),
});

type ManowarState = typeof ManowarStateAnnotation.State;

// =============================================================================
// Multimodal Output Tracking
// =============================================================================

interface MultimodalOutput {
    output: string;  // base64 data or URL
    outputType: "image" | "audio" | "video" | "text";
    fromAgent?: string;
}

// Track last multimodal output from delegation tools
// This is set by createAgentDelegationTool when an agent returns media
let lastMultimodalOutput: MultimodalOutput | null = null;

function resetMultimodalOutput() {
    lastMultimodalOutput = null;
}

function setMultimodalOutput(output: MultimodalOutput) {
    lastMultimodalOutput = output;
}

function getMultimodalOutput(): MultimodalOutput | null {
    return lastMultimodalOutput;
}

// =============================================================================
// Tool Factories for Coordinator
// =============================================================================

function createMcpTool(connectorId: string, toolName: string, description: string): DynamicStructuredTool {
    return new DynamicStructuredTool({
        name: `mcp_${connectorId}_${toolName}`.replace(/[^a-zA-Z0-9_]/g, "_"),
        description: description || `Execute ${toolName} on ${connectorId}`,
        schema: z.object({
            args: z.record(z.string(), z.unknown()).optional().describe("Tool arguments as key-value pairs"),
        }),
        func: async ({ args }) => {
            const input = args || {};
            try {
                // Call MCP service to execute the tool
                const response = await fetch(
                    `${MCP_URL}/runtime/execute`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            source: connectorId.startsWith("mcp") ? "mcp" : "goat",
                            pluginId: connectorId,
                            serverId: connectorId,
                            toolName,
                            args: input,
                        }),
                    }
                );

                if (!response.ok) {
                    const error = await response.text();
                    throw new Error(`MCP execution failed: ${error}`);
                }

                const result = await response.json();
                if (!result.success && result.error) {
                    throw new Error(result.error);
                }

                return JSON.stringify(result.result);
            } catch (err) {
                return `Error: ${err instanceof Error ? err.message : String(err)}`;
            }
        },
    });
}

function createAgentDelegationTool(
    agentStep: WorkflowStep,
    paymentContext: PaymentContext,
    manowarId: string
): DynamicStructuredTool {
    const agentName = agentStep.name.replace(/[^a-zA-Z0-9_]/g, "_");

    return new DynamicStructuredTool({
        name: `delegate_to_${agentName}`,
        description: `Delegate a sub-task to agent "${agentStep.name}". Use this when the task requires this agent's specialized capabilities.`,
        schema: z.object({
            task: z.string().describe("The specific sub-task to delegate to this agent"),
        }),
        func: async ({ task }) => {
            try {
                // Use wallet address first (agents are registered by wallet address)
                // Fall back to agentId if no address (for legacy/test workflows)
                const agentId = agentStep.agentAddress || agentStep.agentId;
                if (!agentId) throw new Error("Agent ID not found");

                console.log(`[manowar] Delegating to agent ${agentStep.name} (${agentId}): ${task.substring(0, 100)}...`);

                // Build request with payment headers
                // Use internal secret to bypass x402 for nested calls (orchestration fee covers them)
                const headers: Record<string, string> = {
                    "Content-Type": "application/json",
                    "x-manowar-internal": "manowar-internal-v1-secret", // Internal bypass
                };
                if (paymentContext.paymentData) {
                    headers["x-payment"] = paymentContext.paymentData;
                }
                if (paymentContext.sessionActive && paymentContext.sessionBudgetRemaining !== null) {
                    headers["x-session-active"] = "true";
                    headers["x-session-budget-remaining"] = paymentContext.sessionBudgetRemaining.toString();
                }
                if (paymentContext.userId) {
                    headers["x-session-user-address"] = paymentContext.userId;
                }

                const response = await fetch(`${MCP_URL}/agent/${agentId}/chat`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                        message: task,
                        threadId: `manowar-${manowarId}-agent-${agentId}`,
                        manowarId,
                    }),
                });

                if (!response.ok) {
                    const error = await response.text();
                    throw new Error(`Agent invocation failed: ${error}`);
                }

                const result = await response.json();

                // Track multimodal output for final result display
                // Agent API returns: { success, type, data, mimeType, ... }
                if (result.type && result.data && result.type !== "text") {
                    console.log(`[manowar] Agent ${agentStep.name} returned ${result.type} output`);
                    setMultimodalOutput({
                        output: result.data,
                        outputType: result.type,
                        fromAgent: agentStep.name,
                    });
                }

                return JSON.stringify(result);
            } catch (err) {
                return `Error delegating to ${agentStep.name}: ${err instanceof Error ? err.message : String(err)}`;
            }
        },
    });
}

function createManowarMemoryTools(manowarId: string, userId?: string): DynamicStructuredTool[] {
    // Search for previously successful solutions
    const searchSolutions = new DynamicStructuredTool({
        name: "search_workflow_solutions",
        description: "Search for previously successful tool sequences or solutions used in this workflow. Use this before attempting a new task to see if we've solved something similar before.",
        schema: z.object({ query: z.string().describe("Description of the task or problem") }),
        func: async ({ query }) => {
            const items = await searchMemory({
                query,
                agent_id: `manowar-${manowarId}`,
                user_id: userId,
                limit: 5,
                filters: { type: "solution" },
            });
            if (!items.length) return "No previous solutions found for similar tasks.";
            return items.map((i: MemoryItem) => `[Previous Solution]: ${i.memory}`).join("\n\n");
        },
    });

    // Save successful solution patterns
    const saveSolution = new DynamicStructuredTool({
        name: "save_workflow_solution",
        description: "Save a successful tool sequence or solution so it can be reused for similar tasks in the future.",
        schema: z.object({
            task: z.string().describe("The task that was solved"),
            solution: z.string().describe("The tools/steps used to solve it"),
        }),
        func: async ({ task, solution }) => {
            await addMemory({
                messages: [{ role: "assistant", content: `Task: ${task}\nSolution: ${solution}` }],
                agent_id: `manowar-${manowarId}`,
                user_id: userId,
                metadata: { type: "solution", task },
            });
            return "Solution saved for future reference.";
        },
    });

    return [searchSolutions, saveSolution];
}



// =============================================================================
// Manowar Executor (LangGraph-based)
// =============================================================================

export class ManowarExecutor {
    private workflow: Workflow;
    private options: ExecutorOptions;
    private graph: ReturnType<typeof StateGraph.prototype.compile> | null = null;
    private startTime: number = 0;

    constructor(workflow: Workflow, options: ExecutorOptions) {
        this.workflow = workflow;
        this.options = options;
    }

    /**
     * Build the coordinator's tool set from workflow agents
     */
    private async buildCoordinatorTools(): Promise<DynamicStructuredTool[]> {
        const tools: DynamicStructuredTool[] = [];

        // Add delegation tools for each agent in the workflow
        for (const step of this.workflow.steps) {
            if (step.type === "agent") {
                tools.push(createAgentDelegationTool(
                    step,
                    this.options.payment,
                    this.workflow.id
                ));
            }
        }

        // Add MCP tools for each connector step (mcpTool or connectorTool)
        for (const step of this.workflow.steps) {
            if ((step.type === "mcpTool" || step.type === "connectorTool") && step.connectorId && step.toolName) {
                tools.push(createMcpTool(step.connectorId, step.toolName, step.name));
            }
        }

        // Add workflow memory tools
        tools.push(...createManowarMemoryTools(
            this.workflow.id,
            this.options.payment.userId
        ));

        console.log(`[manowar] Coordinator built with ${tools.length} tools`);
        return tools;
    }

    /**
     * Build the coordinator system prompt
     * Includes: workflow goal, agent metadata (LLM, skills, plugins), execution order guidance
     */
    private buildCoordinatorPrompt(): string {
        // Build detailed agent descriptions with metadata
        const agentSteps = this.workflow.steps.filter(s => s.type === "agent");
        const agentDescriptions = agentSteps
            .map((s, index) => {
                const toolName = `delegate_to_${s.name.replace(/[^a-zA-Z0-9_]/g, "_")}`;
                const template = s.inputTemplate || {};
                const model = template.model || "unknown";
                const skills = Array.isArray(template.skills) ? template.skills : [];
                const plugins = Array.isArray(template.plugins) ? template.plugins : [];

                let desc = `${index + 1}. **${s.name}** (Tool: ${toolName})`;
                desc += `\n   - LLM Model: ${model}`;
                if (skills.length > 0) {
                    desc += `\n   - Skills: ${skills.join(", ")}`;
                }
                if (plugins.length > 0) {
                    desc += `\n   - Plugins/Tools: ${plugins.join(", ")}`;
                }
                return desc;
            })
            .join("\n\n");

        const mcpDescriptions = this.workflow.steps
            .filter(s => s.type === "mcpTool" || s.type === "connectorTool")
            .map(s => `- ${s.name}: Use mcp_${s.connectorId}_${s.toolName} directly`)
            .join("\n");

        // Detect likely output type based on agent models
        const outputGuidance = this.getOutputTypeGuidance(agentSteps);

        // Build execution dependency graph description
        const edgeDescriptions = this.buildEdgeDescriptions(agentSteps);

        return `You are an intelligent workflow coordinator for "${this.workflow.name}".

## WORKFLOW GOAL
${this.workflow.description || "Execute the user's task using the available agents."}

## YOUR RESPONSIBILITIES
1. Understand the user's task completely
2. Search workflow memory for similar past solutions (search_workflow_solutions)
3. Plan the execution: which agents to use and in what order
4. Delegate sub-tasks to the most appropriate agents
5. Aggregate results and provide the FINAL output to the user
6. Save successful patterns for future use (save_workflow_solution)

## AVAILABLE AGENTS (execute in order when appropriate)
${agentDescriptions || "No agents configured"}

## AVAILABLE MCP TOOLS (direct execution)
${mcpDescriptions || "No MCP tools configured"}

${edgeDescriptions}

## EXECUTION RULES
- **Check Memory First**: Always search for previous solutions before starting work
- **Match Agent to Task**: Use each agent for what they're specialized in (check their skills/plugins)
- **Follow Dependencies**: When edges exist, ensure source agents finish before calling target agents
- **Sequential When Needed**: If agent outputs feed into another agent, delegate sequentially
- **Parallel When Possible**: Independent sub-tasks (no edges between them) can be delegated simultaneously
- **Handle Failures**: If an agent fails, try alternatives or inform the user
- **Return Final Output Only**: The user should receive only the final result, not intermediate steps

${outputGuidance}

## MEMORY TOOLS
- search_workflow_solutions: Find previously successful approaches
- save_workflow_solution: Store successful tool sequences for future reuse`;
    }

    /**
     * Generate guidance for expected output type based on agent models
     */
    private getOutputTypeGuidance(agentSteps: WorkflowStep[]): string {
        const models = agentSteps
            .map(s => (s.inputTemplate?.model as string || "").toLowerCase())
            .filter(Boolean);

        // Detect multimodal models
        const hasImageModel = models.some(m =>
            m.includes("flux") || m.includes("stable-diffusion") || m.includes("sdxl") ||
            m.includes("gemini") && m.includes("image") || m.includes("dall")
        );
        const hasAudioModel = models.some(m =>
            m.includes("whisper") || m.includes("tts") || m.includes("bark") ||
            m.includes("musicgen") || m.includes("lyria")
        );
        const hasVideoModel = models.some(m =>
            m.includes("veo") || m.includes("video") || m.includes("mochi")
        );

        if (hasImageModel) {
            return `## OUTPUT TYPE GUIDANCE
This workflow includes image generation capability. When the user's task involves creating images:
- Delegate to the image generation agent
- The final output should be the generated image (multimodal)
- Do NOT describe the image in words if the agent returns actual image data`;
        }
        if (hasAudioModel) {
            return `## OUTPUT TYPE GUIDANCE
This workflow includes audio processing capability. When handling audio tasks:
- Delegate to the audio agent for TTS/ASR/music generation
- Return the audio output directly (multimodal)`;
        }
        if (hasVideoModel) {
            return `## OUTPUT TYPE GUIDANCE
This workflow includes video generation capability. For video tasks:
- Delegate to the video generation agent
- Return the video output directly (multimodal)`;
        }

        return `## OUTPUT TYPE GUIDANCE
Provide text responses unless an agent returns multimodal content (images, audio, video).
If an agent returns media, pass it through as the final output.`;
    }

    /**
     * Build human-readable description of execution dependencies from edges
     */
    private buildEdgeDescriptions(agentSteps: WorkflowStep[]): string {
        if (!this.workflow.edges || this.workflow.edges.length === 0) {
            return "";
        }

        // Create a map of step id -> step name for lookups
        const stepNameMap = new Map<string, string>();
        this.workflow.steps.forEach(s => stepNameMap.set(s.id, s.name));

        // Build dependency descriptions
        const dependencies = this.workflow.edges.map(edge => {
            const sourceName = stepNameMap.get(edge.source) || edge.source;
            const targetName = stepNameMap.get(edge.target) || edge.target;
            const label = edge.label ? ` (${edge.label})` : "";
            return `- ${sourceName} → ${targetName}${label}`;
        });

        return `## EXECUTION DEPENDENCIES
The following shows which agents must complete before others can start:
${dependencies.join("\n")}`;
    }

    /**
     * Execute the workflow using LangGraph supervisor pattern
     */
    async execute(): Promise<WorkflowExecutionState> {
        this.startTime = Date.now();
        console.log(`[manowar] Starting LangGraph workflow: ${this.workflow.name} (${this.workflow.id})`);

        // Reset multimodal output tracker for this execution
        resetMultimodalOutput();

        try {
            // Fetch coordinator model from on-chain if this is a manowar with ID
            let coordinatorModel = "asi1-mini"; // Fallback if not a numbered manowar
            if (this.workflow.id.startsWith("manowar-")) {
                const manowarId = parseInt(this.workflow.id.split("-")[1]);
                if (!isNaN(manowarId)) {
                    const manowarData = await fetchManowarOnchain(manowarId);
                    if (manowarData?.coordinatorModel) {
                        coordinatorModel = manowarData.coordinatorModel;
                        console.log(`[manowar] Using coordinator model from on-chain: ${coordinatorModel}`);
                    }
                }
            }

            // Build coordinator tools
            const tools = await this.buildCoordinatorTools();

            // Create coordinator model - import createModel from langchain.ts
            const { createModel } = await import("../frameworks/langchain.js");
            const model = createModel(coordinatorModel, 0.3); // Lower temp for deterministic coordination
            const modelWithTools = model.bindTools(tools);

            // Create tool node
            const toolNode = new ToolNode(tools);

            // Build the coordinator graph
            const workflow = new StateGraph(MessagesAnnotation)
                .addNode("coordinator", async (state) => {
                    const systemPrompt = this.buildCoordinatorPrompt();
                    const messagesWithSystem = [
                        new SystemMessage(systemPrompt),
                        ...state.messages,
                    ];
                    const response = await modelWithTools.invoke(messagesWithSystem);
                    return { messages: [response] };
                })
                .addNode("tools", toolNode)
                .addEdge(START, "coordinator")
                .addConditionalEdges("coordinator", (state) => {
                    const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
                    if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
                        return "tools";
                    }
                    return END;
                })
                .addEdge("tools", "coordinator");

            const app = workflow.compile();

            // Build the initial task from input
            const task = this.options.input.task
                || this.options.input.message
                || this.options.input.prompt
                || JSON.stringify(this.options.input);

            // Execute
            console.log(`[manowar] Executing task: ${String(task).substring(0, 100)}...`);
            const result = await app.invoke({
                messages: [new HumanMessage(String(task))],
            }, {
                configurable: { thread_id: `manowar-${this.workflow.id}` },
            });

            // Extract final response
            const messages = result.messages || [];
            const lastMessage = messages[messages.length - 1];
            const output = lastMessage?.content?.toString() || "";

            // Build execution state
            const executionState: WorkflowExecutionState = {
                workflowId: this.workflow.id,
                status: "success",
                startTime: this.startTime,
                endTime: Date.now(),
                steps: this.workflow.steps.map((step, index) => ({
                    stepId: step.id,
                    stepName: step.name,
                    status: "success" as const,
                    startTime: this.startTime,
                    endTime: Date.now(),
                })),
                context: {
                    ...this.options.input,
                    output,
                    // Include multimodal output if an agent returned media
                    multimodal: getMultimodalOutput(),
                    messages: messages.map((m: any) => ({
                        role: m._getType?.() || "unknown",
                        content: m.content?.toString() || "",
                    })),
                },
                totalCostWei: MANOWAR_PRICES.ORCHESTRATION,
            };

            console.log(`[manowar] Workflow complete in ${Date.now() - this.startTime}ms`);
            return executionState;

        } catch (error) {
            console.error(`[manowar] Workflow failed:`, error);
            return {
                workflowId: this.workflow.id,
                status: "error",
                startTime: this.startTime,
                endTime: Date.now(),
                steps: [],
                context: this.options.input,
                totalCostWei: "0",
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
}

// =============================================================================
// Main Execute Function
// =============================================================================

/**
 * Execute a Manowar workflow with LangGraph supervisor pattern
 */
export async function executeManowar(
    workflow: Workflow,
    options: ExecutorOptions
): Promise<WorkflowExecutionState> {
    const executor = new ManowarExecutor(workflow, options);
    return executor.execute();
}
