/**
 * Manowar Orchestrator - Shadow Orchestra Pattern
 * 
 * Implements the full orchestration architecture:
 * - EXTRINSIC (Shadow Orchestra): NoteTaker, WindowTracker, ToolBoxer, Summarizer, MemoryWipe
 * - INTRINSIC (Main Stage): Coordinator → Agent Delegation → Tool Execution
 * 
 * The Shadow Orchestra runs behind the scenes to:
 * 1. Track token consumption via LangSmith callbacks
 * 2. Monitor context window health
 * 3. Recommend tools from 16K+ registry
 * 4. Perform intelligent memory wipes with summarization
 * 5. Evaluate and improve across continuous loops
 * 
 * Uses ManowarOrchestrationState with proper reducers for state persistence.
 */

import { StateGraph, START, END } from "@langchain/langgraph";
import { HumanMessage, SystemMessage, AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { z } from "zod";

// New modules
import { ManowarOrchestrationState, type ManowarState, createInitialState } from "./state.js";
import { LangSmithTokenTracker, createLangSmithConfig, isLangSmithEnabled } from "./langsmith.js";
import {
    addMemoryWithGraph,
    searchMemoryWithGraph,
    performMemoryWipe,
    findSimilarSolutions,
    saveSolutionPattern,
    optimizeWithGraph,
    // Kept token optimization functions
    SLIDING_WINDOW_SIZE,
    TOKEN_THRESHOLD_PERCENT,
    compressToolOutput,
    generateStructuredTaskPrompt,
} from "./memory.js";
// LangSmith distributed tracing for A2A calls
import { getCurrentRunTree } from "langsmith/traceable";
import {
    noteTakerNode,
    windowTrackerNode,
    toolBoxerNode,
    // evaluatorNode and reviewerNode - reserved for continuous loop workflows
    // Will be integrated when loop mode is implemented
    evaluatorNode,
    reviewerNode,
    type TokenLedgerState,
} from "./nodes.js";
import { TokenLedger, getModelContextSpec } from "./context.js";
import { createRun, startRun, completeRun, failRun } from "./run-tracker.js";

// Existing imports
import type { Workflow, WorkflowStep, WorkflowExecutionState, ExecutorOptions, PaymentContext, SSEProgressEvent } from "./types.js";

// =============================================================================
// Configuration
// =============================================================================

const MCP_URL = process.env.MCP_URL || "https://mcp.compose.market";
const LAMBDA_API_URL = process.env.LAMBDA_API_URL || "https://api.compose.market";
// Agent chat endpoints are on manowar server, not MCP
const MANOWAR_URL = process.env.MANOWAR_URL || "https://manowar.compose.market";

// Import default from agentic.ts
import { getDefaultCoordinatorModel } from "./agentic.js";

// =============================================================================
// Multimodal Output Tracking (preserved from original)
// =============================================================================

interface MultimodalOutput {
    output: string;
    outputType: "image" | "audio" | "video" | "text";
    fromAgent?: string;
}

let lastMultimodalOutput: MultimodalOutput | null = null;

function resetMultimodalOutput() { lastMultimodalOutput = null; }
function setMultimodalOutput(output: MultimodalOutput) { lastMultimodalOutput = output; }
function getMultimodalOutput(): MultimodalOutput | null { return lastMultimodalOutput; }

// =============================================================================
// Tool Factories
// =============================================================================

function createMcpTool(connectorId: string, toolName: string, description: string): DynamicStructuredTool {
    return new DynamicStructuredTool({
        name: `mcp_${connectorId}_${toolName}`.replace(/[^a-zA-Z0-9_]/g, "_"),
        description: description || `Execute ${toolName} on ${connectorId}`,
        schema: z.object({
            args: z.record(z.string(), z.unknown()).optional().describe("Tool arguments as key-value pairs"),
        }),
        func: async ({ args }) => {
            try {
                const response = await fetch(`${MCP_URL}/runtime/execute`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "x-tool-price": "1000" },
                    body: JSON.stringify({
                        source: connectorId.startsWith("mcp") ? "mcp" : "goat",
                        pluginId: connectorId,
                        serverId: connectorId,
                        toolName,
                        args: args || {},
                    }),
                });
                if (!response.ok) throw new Error(`MCP execution failed: ${await response.text()}`);
                const result = await response.json();
                if (!result.success && result.error) throw new Error(result.error);
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
    manowarWallet: string,
    runId: string,
    stepContext?: { currentStep?: number; totalSteps?: number; previousOutput?: string },
    onProgress?: (event: SSEProgressEvent) => void
): DynamicStructuredTool {
    const agentName = agentStep.name.replace(/[^a-zA-Z0-9_]/g, "_");

    return new DynamicStructuredTool({
        name: `delegate_to_${agentName}`,
        description: `Delegate a sub-task to agent "${agentStep.name}". Use for this agent's specialized capabilities.`,
        schema: z.object({
            task: z.string().describe("The specific sub-task to delegate"),
        }),
        func: async ({ task }) => {
            try {
                const agentId = agentStep.agentAddress || agentStep.agentId;
                if (!agentId) throw new Error("Agent ID not found");

                console.log(`[orchestrator] Delegating to ${agentStep.name}: ${task.substring(0, 80)}...`);

                const stepProgress = stepContext?.currentStep && stepContext.totalSteps
                    ? Math.round((stepContext.currentStep / stepContext.totalSteps) * 80) + 10 // 10-90% range
                    : 50;

                // SSE: Emit agent start event
                onProgress?.({
                    type: "agent",
                    timestamp: Date.now(),
                    data: {
                        agentName: agentStep.name,
                        stepName: `Step ${stepContext?.currentStep || '?'}/${stepContext?.totalSteps || '?'}`,
                        message: `Calling agent "${agentStep.name}"...`,
                        progress: stepProgress,
                    },
                });

                // Base headers
                const headers: Record<string, string> = {
                    "Content-Type": "application/json",
                    "x-manowar-internal": "manowar-internal-v1-secret",
                    "x-tool-price": "2000",
                };
                if (paymentContext.paymentData) headers["x-payment"] = paymentContext.paymentData;
                if (paymentContext.userId) headers["x-session-user-address"] = paymentContext.userId;

                // LANGSMITH DISTRIBUTED TRACING: Propagate trace context to child agents
                try {
                    const runTree = getCurrentRunTree();
                    if (runTree) {
                        const traceHeaders = runTree.toHeaders();
                        Object.assign(headers, traceHeaders);
                        console.log(`[orchestrator] Propagating LangSmith trace to ${agentStep.name}`);
                    }
                } catch {
                    // Tracing not available, continue without
                }

                // Generate structured task prompt with minimal context
                const structuredTask = generateStructuredTaskPrompt(
                    agentStep.name,
                    task,
                    stepContext ? {
                        currentStep: stepContext.currentStep,
                        totalSteps: stepContext.totalSteps,
                        previousStepOutput: stepContext.previousOutput?.slice(0, 500),
                    } : undefined
                );

                // Minimal agent context - no workflow metadata
                const response = await fetch(`${MANOWAR_URL}/agent/${agentId}/chat`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                        message: structuredTask,
                        threadId: `agent-${agentId}-${Date.now()}`,
                        sessionContext: "single-task",
                    }),
                });

                if (!response.ok) throw new Error(`Agent invocation failed: ${await response.text()}`);
                const result = await response.json();

                // SSE: Emit agent complete event
                onProgress?.({
                    type: "step",
                    timestamp: Date.now(),
                    data: {
                        agentName: agentStep.name,
                        message: `Agent "${agentStep.name}" completed`,
                        progress: stepProgress + 5,
                    },
                });

                // Track multimodal output
                if (result.type && result.data && result.type !== "text") {
                    setMultimodalOutput({ output: result.data, outputType: result.type, fromAgent: agentStep.name });
                }

                // OPTIMIZATION: Compress output instead of raw JSON
                // This reduces tool output tokens by 60-80%
                const compressed = compressToolOutput(result, agentStep.name, { maxLength: 800 });
                console.log(`[orchestrator] Compressed ${agentStep.name} output: ${compressed.length} chars`);

                return compressed;
            } catch (err) {
                // SSE: Emit error event
                onProgress?.({
                    type: "error",
                    timestamp: Date.now(),
                    data: {
                        agentName: agentStep.name,
                        error: err instanceof Error ? err.message : String(err),
                    },
                });
                return `Error delegating to ${agentStep.name}: ${err instanceof Error ? err.message : String(err)}`;
            }
        },
    });
}

// =============================================================================
// Memory Tools (integrated with run_id)
// =============================================================================

function createMemoryTools(workflowId: string, runId: string, userId?: string): DynamicStructuredTool[] {
    const searchSolutions = new DynamicStructuredTool({
        name: "search_workflow_solutions",
        description: "Search for previously successful tool sequences. Use before attempting a new task.",
        schema: z.object({ query: z.string().describe("Description of the task") }),
        func: async ({ query }) => {
            const solutions = await findSimilarSolutions(workflowId, query, { limit: 5, outcomeFilter: "success" });
            if (solutions.length === 0) return "No previous solutions found.";
            return solutions.map(s => `[Solution] ${s.task}: ${s.toolSequence.join(" → ")} (${s.outcome})`).join("\n");
        },
    });

    const saveSolution = new DynamicStructuredTool({
        name: "save_workflow_solution",
        description: "Save a successful tool sequence for future reference.",
        schema: z.object({
            task: z.string().describe("The task that was solved"),
            solution: z.string().describe("The tools/steps used"),
        }),
        func: async ({ task, solution }) => {
            await saveSolutionPattern(workflowId, runId, {
                task,
                toolSequence: solution.split(/[→,]/).map(s => s.trim()),
                outcome: "success",
                confidence: 0.8,
            });
            return "Solution saved for future reference.";
        },
    });

    return [searchSolutions, saveSolution];
}

// =============================================================================
// Orchestrator Class
// =============================================================================

export class ManowarOrchestrator {
    private workflow: Workflow;
    private options: ExecutorOptions;
    private runId: string;
    private coordinatorModel: string;
    private tokenLedger: TokenLedger;
    private langsmithTracker: LangSmithTokenTracker | null = null;
    private startTime: number = 0;
    // System prompt cache for reduced token overhead on repeated calls
    private cachedSystemPrompt: string | null = null;

    constructor(workflow: Workflow, options: ExecutorOptions) {
        this.workflow = workflow;
        this.options = options;
        this.runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        this.tokenLedger = new TokenLedger();
        // Use coordinator model from options (passed from registry) or default from agentic.ts
        this.coordinatorModel = options.coordinatorModel || getDefaultCoordinatorModel();
        console.log(`[orchestrator] Using coordinator model: ${this.coordinatorModel}`);
    }

    /**
     * Emit SSE progress event if callback is registered
     */
    private emitProgress(
        type: "start" | "step" | "agent" | "tool" | "response" | "error" | "complete",
        data: {
            stepName?: string;
            agentName?: string;
            toolName?: string;
            message?: string;
            output?: string;
            error?: string;
            tokenCount?: number;
            progress?: number;
        }
    ): void {
        if (this.options.onProgress) {
            this.options.onProgress({
                type,
                timestamp: Date.now(),
                data: {
                    runId: this.runId,
                    ...data,
                },
            });
        }
    }

    /**
     * Build coordinator tools from workflow definition
     * Includes step context for structured task decomposition
     */
    private buildTools(): DynamicStructuredTool[] {
        const tools: DynamicStructuredTool[] = [];

        // Agent delegation tools with step context
        const agentSteps = this.workflow.steps.filter(s => s.type === "agent");
        const totalSteps = agentSteps.length;

        for (let i = 0; i < agentSteps.length; i++) {
            const step = agentSteps[i];
            tools.push(createAgentDelegationTool(
                step,
                this.options.payment,
                this.workflow.id,
                this.runId,
                { currentStep: i + 1, totalSteps },
                this.options.onProgress
            ));
        }

        // MCP tools
        for (const step of this.workflow.steps) {
            if ((step.type === "mcpTool" || step.type === "connectorTool") && step.connectorId && step.toolName) {
                tools.push(createMcpTool(step.connectorId, step.toolName, step.name));
            }
        }

        // Memory tools
        tools.push(...createMemoryTools(this.workflow.id, this.runId, this.options.payment.userId));

        return tools;
    }

    /**
     * Build the coordinator system prompt with COMPLETE workflow context
     * Includes full agent card metadata so coordinator can orchestrate properly
     */
    private buildSystemPrompt(): string {
        // Return cached version if available
        if (this.cachedSystemPrompt) {
            return this.cachedSystemPrompt;
        }

        const agentSteps = this.workflow.steps.filter(s => s.type === "agent");

        // Build complete agent pipeline with full metadata from inputTemplate
        const agentPipeline = agentSteps.map((s, i) => {
            const toolName = `delegate_to_${s.name.replace(/[^a-zA-Z0-9_]/g, "_")}`;
            const meta = s.inputTemplate || {};

            // Extract agent card metadata (from buildManowarWorkflow in onchain.ts)
            const model = meta.model || "default";

            // Plugins are the MCP tools/connectors the agent has access to
            const plugins = Array.isArray(meta.plugins)
                ? meta.plugins.map((p: any) => typeof p === 'string' ? p : (p.name || p.registryId)).join(", ")
                : "none";

            // Skills describe what the agent can do
            const skills = Array.isArray(meta.skills) && meta.skills.length > 0
                ? meta.skills.join(", ")
                : "";

            // Agent card URI for full context
            const cardUri = meta.agentCardUri || s.agentAddress || "";

            return `### ${i + 1}. ${s.name}
- **Delegation Tool**: \`${toolName}\`
- **Model**: ${model}
- **Plugins/Tools**: ${plugins}${skills ? `\n- **Skills**: ${skills}` : ""}${cardUri ? `\n- **Agent Card**: ${cardUri}` : ""}`;
        }).join("\n\n");

        // MCP/Connector tools in workflow
        const mcpSteps = this.workflow.steps.filter(s => s.type === "mcpTool" || s.type === "connectorTool");
        const mcpTools = mcpSteps.length > 0
            ? `\n\n## MCP TOOLS AVAILABLE\n${mcpSteps.map(s => `- ${s.name}: ${s.toolName} (${s.connectorId})`).join("\n")}`
            : "";

        // User input with attachments (now Pinata URLs, not base64)
        const rawMessage = this.options.input.message || this.options.input.task || this.options.input.prompt || "";
        const userMessage = typeof rawMessage === 'string' ? rawMessage : String(rawMessage);

        // Handle new attachment format: { type: "image"|"audio", url: "https://..." }
        const attachment = this.options.input.attachment as { type?: string; url?: string } | undefined;
        let attachmentNote = "";
        if (attachment?.url) {
            attachmentNote = ` [${attachment.type || 'file'} attached: ${attachment.url}]`;
        } else if (this.options.input.image || this.options.input.audio) {
            // Legacy format fallback
            const attachments: string[] = [];
            if (this.options.input.image) attachments.push("Image attached");
            if (this.options.input.audio) attachments.push("Audio attached");
            attachmentNote = attachments.length > 0 ? ` [${attachments.join(", ")}]` : "";
        }

        // Complete system prompt with full context
        this.cachedSystemPrompt = `You are the **Shadow Orchestra Coordinator** for "${this.workflow.name}".

## WORKFLOW GOAL
${this.workflow.description || "Execute the workflow steps in sequence"}

## USER REQUEST
"${userMessage}"${attachmentNote}

## COMPONENT AGENTS PIPELINE
Execute these agents SEQUENTIALLY. Each agent is self-sufficient with its own tools.
Pass each agent's output to the next step. Evaluate responses to determine if additional work is needed.

${agentPipeline}${mcpTools}

## ORCHESTRATION RULES
1. **SEQUENTIAL EXECUTION**: Call agents in order (1 → 2 → 3...)
2. **PASS OUTPUT FORWARD**: Each agent's response becomes context for the next
3. **EVALUATE RESPONSES**: Check if step completed successfully before proceeding
4. **USE AGENT CAPABILITIES**: Each agent has specific tools - delegate appropriately
5. **HANDLE MISSING DATA**: If data is incomplete, use available tools or ask the appropriate agent
6. **FINAL RESPONSE**: Return the completed result to the user`;

        console.log(`[orchestrator] System prompt built: ${Math.ceil(this.cachedSystemPrompt.length / 4)} tokens`);
        return this.cachedSystemPrompt;
    }

    /**
     * Execute the orchestrated workflow
     */
    async execute(): Promise<WorkflowExecutionState> {
        this.startTime = Date.now();
        resetMultimodalOutput();

        console.log(`[orchestrator] Starting workflow ${this.workflow.id} (run: ${this.runId})`);

        // SSE: Emit start event
        this.emitProgress("start", {
            message: `Starting workflow "${this.workflow.name}"`,
            progress: 0,
        });

        // Create tracked run
        // Extract wallet address from workflow ID (format: "manowar-0xABC...")
        const manowarWallet = this.workflow.id.startsWith("manowar-")
            ? this.workflow.id.substring(8) // Skip "manowar-" prefix
            : undefined;
        const trackedRun = createRun({
            workflowId: this.workflow.id,
            manowarWallet, // Use wallet address, not numeric ID
            input: this.options.input,
            triggeredBy: this.options.triggerId
                ? { type: "cron", triggerId: this.options.triggerId }
                : { type: "manual" },
        });

        try {
            // coordinatorModel already set in constructor from options (single source of truth)
            // No need for on-chain fetch - registry has canonical data

            // Initialize LangSmith tracker
            if (isLangSmithEnabled()) {
                this.langsmithTracker = new LangSmithTokenTracker(this.workflow.id, this.runId, {
                    recordCheckpoint: (cp) => this.tokenLedger.recordFromResponse(cp.agentId, cp.modelId, cp.action, { usage: { prompt_tokens: cp.inputTokens, completion_tokens: cp.outputTokens } }),
                    getCumulativeTotal: () => this.tokenLedger.getCumulativeTotal(),
                });
                this.langsmithTracker.setCurrentModel(this.coordinatorModel);
            }

            // ================================================================
            // Shadow Binding Pattern: Control Plane vs Data Plane separation
            // ================================================================

            // 1. Build IMMUTABLE Workflow Tools (Data Plane)
            // These are the on-chain defined tools - agents cannot access registry tools
            const workflowTools = this.buildTools();
            console.log(`[orchestrator] Built ${workflowTools.length} workflow tools (Data Plane)`);

            // Mark run as started
            startRun(trackedRun.runId, this.runId);

            // Create base model
            const { createModel } = await import("../frameworks/langchain.js");
            const model = createModel(this.coordinatorModel, 0.3);

            // Build the orchestration graph
            const graph = new StateGraph(ManowarOrchestrationState)
                // Main coordinator node - with PROGRESSIVE tool binding
                .addNode("coordinator", async (state: ManowarState) => {
                    const systemPrompt = this.buildSystemPrompt();

                    // Add context enhancements from Reviewer if any
                    const enhancements = state.contextEnhancements?.length
                        ? `\n\n## IMPROVEMENTS FROM PREVIOUS LOOP\n${state.contextEnhancements.join("\n")}`
                        : "";

                    // =========================================================
                    // PROGRESSIVE TOOL LOADING (Phase 3.5 Optimization)
                    // Only bind tools needed for current step, reducing token overhead
                    // =========================================================

                    // Determine current step based on completed actions
                    const agentSteps = this.workflow.steps.filter(s => s.type === "agent");
                    const completedAgentActions = (state.completedActions || []).filter(a => a.startsWith("delegate_to_"));
                    const currentStepIndex = Math.min(completedAgentActions.length, agentSteps.length - 1);

                    // Build progressive tools: current step agent + memory tools (always available)
                    const progressiveTools: DynamicStructuredTool[] = [];

                    // 1. Add current step's agent delegation tool (if any agent steps remain)
                    if (currentStepIndex < agentSteps.length) {
                        const currentAgentStep = agentSteps[currentStepIndex];
                        progressiveTools.push(createAgentDelegationTool(
                            currentAgentStep,
                            this.options.payment,
                            this.workflow.id,
                            this.runId,
                            { currentStep: currentStepIndex + 1, totalSteps: agentSteps.length }
                        ));
                        console.log(`[orchestrator] Progressive: loading step ${currentStepIndex + 1}/${agentSteps.length} (${currentAgentStep.name})`);
                    }

                    // 2. Add MCP/connector tools (always available for current workflow)
                    for (const step of this.workflow.steps) {
                        if ((step.type === "mcpTool" || step.type === "connectorTool") && step.connectorId && step.toolName) {
                            progressiveTools.push(createMcpTool(step.connectorId, step.toolName, step.name));
                        }
                    }

                    // 3. Add memory tools (always available)
                    progressiveTools.push(...createMemoryTools(this.workflow.id, this.runId, this.options.payment.userId));

                    // 4. Add optimization tools if recommended by ToolBoxer
                    if (state.suggestedTools?.length) {
                        for (const rec of state.suggestedTools) {
                            if (rec.spawnParams) {
                                progressiveTools.push(createMcpTool(rec.registryId, rec.name, rec.description));
                            }
                        }
                    }

                    console.log(`[orchestrator] Progressive loading: ${progressiveTools.length} tools (vs ${workflowTools.length} static)`);

                    // Bind progressive tools to model
                    const modelWithTools = (model as any).bindTools(progressiveTools);

                    // =========================================================

                    // 1. Token estimation
                    const estimatedTokens = Math.ceil(
                        systemPrompt.length / 4 +
                        state.messages.reduce((sum, m) => sum + String(m.content || '').length / 4, 0)
                    );

                    const modelSpec = await getModelContextSpec(this.coordinatorModel);
                    const usagePercent = (estimatedTokens / modelSpec.effectiveWindow) * 100;

                    console.log(`[orchestrator] Context: ~${estimatedTokens} tokens (${usagePercent.toFixed(1)}% of ${modelSpec.effectiveWindow})`);

                    // 2. Standard sliding window at 60%
                    let messagesToUse: BaseMessage[] = state.messages;

                    if (usagePercent > TOKEN_THRESHOLD_PERCENT && state.messages.length > SLIDING_WINDOW_SIZE) {
                        console.log(`[orchestrator] Activating sliding window`);
                        const firstMsg = state.messages[0];
                        const recentMsgs = state.messages.slice(-SLIDING_WINDOW_SIZE);
                        messagesToUse = [firstMsg, ...recentMsgs];
                        console.log(`[orchestrator] Messages: ${state.messages.length} → ${messagesToUse.length}`);
                    }

                    // 3. Memory retrieval via Mem0 native search (first call only)
                    let memoryContext = "";
                    if (state.messages.length <= 2) {
                        try {
                            const memResult = await searchMemoryWithGraph({
                                query: String(state.messages[0]?.content || this.workflow.description),
                                agent_id: `manowar-${this.workflow.id}`,
                                run_id: this.runId,
                                limit: 5,
                                options: { rerank: true },
                            });
                            if (memResult.memories.length > 0) {
                                memoryContext = `\n\n## Prior Context\n${memResult.memories.slice(0, 3).map(m => `- ${m.memory}`).join('\n')}`;
                            }
                        } catch {
                            // Memory not available, continue
                        }
                    }

                    // 4. SANITIZE messages - extract Pinata URLs from attachments
                    // Orchestrator only needs: hasAttachment=true + pinataUrl (NOT base64 data)
                    const sanitizeMessage = (m: BaseMessage): BaseMessage => {
                        const content = String(m.content || '');

                        // Skip short messages
                        if (content.length < 2000) return m;

                        // Try to extract Pinata URL or image metadata
                        const pinataMatch = content.match(/https:\/\/[^"'\s]*pinata[^"'\s]*/i);
                        const ipfsMatch = content.match(/ipfs:\/\/[^"'\s]+/i);
                        const typeMatch = content.match(/"type"\s*:\s*"(image|audio|video)"/);
                        const nameMatch = content.match(/"name"\s*:\s*"([^"]+)"/);

                        // If this looks like a tool response with image data
                        if (content.includes('"data"') && content.length > 5000) {
                            const url = pinataMatch?.[0] || ipfsMatch?.[0];
                            const mediaType = typeMatch?.[1] || 'image';
                            const name = nameMatch?.[1] || 'attachment';

                            // Create compact reference
                            const compactContent = JSON.stringify({
                                hasAttachment: true,
                                type: mediaType,
                                name: name,
                                pinataUrl: url || '[uploaded to Pinata]',
                                success: true,
                            });

                            if (m._getType() === 'tool') {
                                console.log(`[orchestrator] Sanitized ${mediaType} attachment → compact reference`);
                                return new ToolMessage({
                                    content: compactContent,
                                    tool_call_id: (m as any).tool_call_id,
                                    name: (m as any).name,
                                });
                            }
                        }
                        return m;
                    };

                    const sanitizedMessages = messagesToUse.map(sanitizeMessage);

                    // 5. Build final messages
                    const messagesWithSystem = [
                        new SystemMessage(systemPrompt + enhancements + memoryContext),
                        ...sanitizedMessages,
                    ];

                    if (this.langsmithTracker) {
                        this.langsmithTracker.setCurrentAgent("coordinator");
                    }

                    const response = await modelWithTools.invoke(messagesWithSystem);
                    return { messages: [response], completedActions: [`Coordinator response`] };
                })

                // 4. Tool execution node - dynamically includes suggestedTools to match coordinator
                .addNode("tools", async (state: ManowarState) => {
                    // Build complete tool set: workflow tools + any suggested tools
                    const allTools: DynamicStructuredTool[] = [...workflowTools];

                    // Add suggested tools from ToolBoxer (same logic as coordinator)
                    if (state.suggestedTools?.length) {
                        for (const rec of state.suggestedTools) {
                            if (rec.spawnParams) {
                                allTools.push(createMcpTool(rec.registryId, rec.name, rec.description));
                            }
                        }
                    }

                    // Create and invoke ToolNode with complete tool set
                    const toolNode = new ToolNode(allTools);
                    return toolNode.invoke(state);
                })


                // Shadow Orchestra: NoteTaker
                .addNode("noteTaker", async (state: ManowarState) => {
                    const ledgerState: TokenLedgerState = {
                        checkpoints: this.tokenLedger.export().map(cp => ({ ...cp, reasoningTokens: 0 })),
                        cumulativeTotal: this.tokenLedger.getCumulativeTotal(),
                    };
                    return noteTakerNode(state, ledgerState);
                })

                // Shadow Orchestra: WindowTracker
                .addNode("windowTracker", async (state: ManowarState) => {
                    // Set agent models from workflow steps
                    const agentModels: Record<string, string> = { coordinator: this.coordinatorModel };
                    for (const step of this.workflow.steps) {
                        if (step.type === "agent" && step.inputTemplate?.model) {
                            agentModels[step.name] = step.inputTemplate.model as string;
                        }
                    }
                    return windowTrackerNode({ ...state, agentModels });
                })

                // Shadow Orchestra: ToolBoxer
                .addNode("toolBoxer", async (state: ManowarState) => {
                    const boundPlugins = this.workflow.steps
                        .filter(s => s.type === "mcpTool" || s.type === "connectorTool")
                        .map(s => s.connectorId || "");
                    return toolBoxerNode({ ...state, boundPlugins });
                })

                // Shadow Orchestra: Memory Wipe
                .addNode("memoryWipe", async (state: ManowarState) => {
                    const result = await performMemoryWipe(
                        this.workflow.id,
                        this.runId,
                        {
                            goal: state.activeGoal,
                            completedActions: state.completedActions || [],
                            lastOutcome: String(state.messages[state.messages.length - 1]?.content || ""),
                            agentSummaries: {},
                        }
                    );

                    if (result) {
                        // Wipe: return single system message (reducer will replace)
                        return {
                            messages: [new SystemMessage(`[CONTEXT REFRESHED] ${result.previousSummary}`)],
                            lastSummary: result.previousSummary,
                            preservedFacts: result.preservedFacts,
                            needsCleanup: false,
                        };
                    }
                    return { needsCleanup: false };
                })

                // Graph Memory Optimization (after meaningful interactions)
                .addNode("graphOptimize", async (state: ManowarState) => {
                    const lastMessage = state.messages[state.messages.length - 1];
                    if (lastMessage && lastMessage._getType?.() === "ai") {
                        await optimizeWithGraph(
                            this.workflow.id,
                            this.runId,
                            String(lastMessage.content),
                            { goal: state.activeGoal, userId: this.options.payment.userId }
                        );
                    }
                    return {};
                })

                // Edges: Main flow
                .addEdge(START, "coordinator")
                .addConditionalEdges("coordinator", (state: ManowarState) => {
                    const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
                    if (lastMessage && (lastMessage.tool_calls?.length ?? 0) > 0) {
                        return "tools";
                    }
                    return "noteTaker"; // No more tools → enter Shadow Orchestra
                })
                .addEdge("tools", "coordinator")

                // Shadow Orchestra flow
                .addEdge("noteTaker", "windowTracker")
                .addConditionalEdges("windowTracker", (state: ManowarState) => {
                    if (state.needsCleanup) {
                        console.log(`[orchestrator] Triggering memory wipe`);
                        return "memoryWipe";
                    }
                    return "toolBoxer";
                })
                .addEdge("memoryWipe", "toolBoxer")
                .addEdge("toolBoxer", "graphOptimize")
                .addEdge("graphOptimize", END);

            // Compile and execute
            const app = graph.compile();

            const task = this.options.input.task || this.options.input.message || this.options.input.prompt || JSON.stringify(this.options.input);

            console.log(`[orchestrator] Executing task: ${String(task).substring(0, 80)}...`);

            const result = await app.invoke(
                {
                    messages: [new HumanMessage(String(task))],
                    workflowId: this.workflow.id,
                    runId: this.runId,
                    activeGoal: String(task),
                    status: "running",
                },
                {
                    ...createLangSmithConfig(this.workflow.id, this.runId),
                    callbacks: this.langsmithTracker ? [this.langsmithTracker] : [],
                    recursionLimit: 50, // Increase from default 25 for complex workflows
                }
            );

            // Extract final output
            const messages = result.messages || [];
            const lastMessage = messages[messages.length - 1];
            const output = lastMessage?.content?.toString() || "";

            console.log(`[orchestrator] Complete in ${Date.now() - this.startTime}ms`);

            // SSE: Emit complete event
            this.emitProgress("complete", {
                message: "Workflow completed successfully",
                output: output.substring(0, 500), // Preview only
                progress: 100,
                tokenCount: this.tokenLedger.getCumulativeTotal(),
            });

            // Complete tracked run
            completeRun(trackedRun.runId, { output }, {
                inputTokens: this.tokenLedger.export().reduce((sum, cp) => sum + cp.inputTokens, 0),
                outputTokens: this.tokenLedger.export().reduce((sum, cp) => sum + cp.outputTokens, 0),
                reasoningTokens: 0,
                totalTokens: this.tokenLedger.getCumulativeTotal(),
            });

            return {
                workflowId: this.workflow.id,
                status: "success",
                startTime: this.startTime,
                endTime: Date.now(),
                steps: this.workflow.steps.map(step => ({
                    stepId: step.id,
                    stepName: step.name,
                    status: "success" as const,
                    startTime: this.startTime,
                    endTime: Date.now(),
                })),
                context: {
                    ...this.options.input,
                    output,
                    multimodal: getMultimodalOutput(),
                    runId: this.runId,
                    tokenMetrics: result.tokenMetrics,
                },
                totalCostWei: result.totalCostWei || "10000",
                triggeredBy: this.options.triggerId,
                tokenState: {
                    currentTokens: this.tokenLedger.getCumulativeTotal(),
                    maxTokens: (await getModelContextSpec(this.coordinatorModel)).effectiveWindow,
                    usagePercent: 0,
                    cleanupThreshold: 80,
                    needsCleanup: false,
                    agentUsage: new Map(),
                },
            };

        } catch (error) {
            console.error(`[orchestrator] Failed:`, error);

            // Fail tracked run
            failRun(trackedRun.runId, error instanceof Error ? error.message : String(error));
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
// Export
// =============================================================================

/**
 * Execute a Manowar workflow with the Shadow Orchestra pattern
 */
export async function executeWithOrchestrator(
    workflow: Workflow,
    options: ExecutorOptions
): Promise<WorkflowExecutionState> {
    const orchestrator = new ManowarOrchestrator(workflow, options);
    return orchestrator.execute();
}
