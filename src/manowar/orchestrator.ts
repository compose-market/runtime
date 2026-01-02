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
    performSafeWipe,
    findSimilarSolutions,
    saveSolutionPattern,
    optimizeWithGraph,
    // Token optimization constants
    SLIDING_WINDOW_SIZE,
    getDynamicThresholdPercent,
} from "./memory.js";
// LangSmith distributed tracing for A2A calls
import { getCurrentRunTree } from "langsmith/traceable";
import {
    noteTakerNode,
    windowTrackerNode,
    toolBoxerNode,
    evaluatorNode,
    reviewerNode,
    type TokenLedgerState,
} from "./nodes.js";
import { TokenLedger, getModelContextSpec } from "./context.js";
import { createRun, startRun, completeRun, failRun } from "./run-tracker.js";

// Enhancements (Jan 2026)
import { TaskPlanner, type ExecutionPlan, type PlanStep, type StepReflection } from "./planner.js";
import { FileContextManager, getContextManager, processForContext, formatReference, type ContextReference } from "./file-context.js";
import { ToolRegistry, getToolRegistry, createMaskingConfig, clearToolRegistry, type MaskingConfig } from "./tool-masking.js";
import { createContractFromStep, generateStructuredPrompt, parseAgentOutput, summarizeOutput, type ContextualTaskContract, type AgentOutput } from "./task-contracts.js";

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
    workflowId: string,
    runId: string,
    stepContext?: { currentStep?: number; totalSteps?: number; previousOutputs?: Array<{ stepNumber: number; agentName: string; summary: string }> },
    onProgress?: (event: SSEProgressEvent) => void
): DynamicStructuredTool {
    const agentName = agentStep.name.replace(/[^a-zA-Z0-9_]/g, "_");

    return new DynamicStructuredTool({
        name: `delegate_to_${agentName}`,
        description: `Delegate a sub-task to agent "${agentStep.name}". Use for this agent's specialized capabilities.`,
        schema: z.object({
            task: z.string().describe("The specific sub-task to delegate"),
            attachmentUrl: z.string().optional().describe("Optional attachment URL (image, audio, etc.)"),
        }),
        func: async ({ task, attachmentUrl }) => {
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

                // =========================================================
                // Use structured task contracts for unambiguous delegation
                // =========================================================
                const taskContract: ContextualTaskContract = createContractFromStep(
                    agentStep,
                    task,
                    stepContext?.currentStep || 1,
                    stepContext?.totalSteps || 1,
                    stepContext?.previousOutputs || [],
                    attachmentUrl
                );

                // Generate structured prompt from contract
                const structuredTask = generateStructuredPrompt(taskContract);
                console.log(`[orchestrator] Task contract created: ${taskContract.taskId} (${taskContract.priority} priority)`);

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
                const rawResult = await response.json();

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

                // =========================================================
                // NEW: Parse agent output with structured schema
                // =========================================================
                const parsedOutput: AgentOutput = parseAgentOutput(
                    typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult),
                    agentStep.name
                );

                // Track multimodal output
                if (parsedOutput.outputType !== "text" && parsedOutput.artifactUrl) {
                    setMultimodalOutput({
                        output: parsedOutput.artifactUrl,
                        outputType: parsedOutput.outputType as "image" | "audio" | "video",
                        fromAgent: agentStep.name
                    });
                }

                // =========================================================
                // Process large outputs for context externalization
                // =========================================================
                const contextResult: { reference: ContextReference | null; inline: string | null } = await processForContext(
                    parsedOutput.result,
                    "tool_output",
                    workflowId,
                    runId
                );

                // If externalized, return compact reference; otherwise summarized output
                if (contextResult.reference) {
                    const ref: ContextReference = contextResult.reference;
                    console.log(`[orchestrator] Externalized ${agentStep.name} output to file: ${ref.fileId}`);
                    return formatReference(ref);
                }

                // Summarize output for token efficiency
                const summary = summarizeOutput(parsedOutput, 800);
                console.log(`[orchestrator] ${agentStep.name} output: ${summary.length} chars (success: ${parsedOutput.success})`);
                return summary;
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

    // Enhancements (Jan 2026)
    /** Task planner for Plan→Act→Reflect pattern */
    private planner: TaskPlanner;
    /** File-based context manager */
    private fileContextManager: FileContextManager;
    /** Static tool registry for masking */
    private toolRegistry: ToolRegistry;
    /** Cached stable system prompt prefix (never changes) */
    private stablePromptPrefix: string | null = null;
    /** Step outputs for context building */
    private stepOutputMap: Map<number, string> = new Map();
    /** Shadow Orchestra node models - assigned by coordinator */
    private orchestraModels: { planner: string; evaluator: string; summarizer: string };

    constructor(workflow: Workflow, options: ExecutorOptions) {
        this.workflow = workflow;
        this.options = options;
        this.runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        this.tokenLedger = new TokenLedger();

        // Coordinator model comes from on-chain manowar data
        if (!options.coordinatorModel) {
            throw new Error("coordinatorModel is required. User must select a coordinator model when minting the manowar.");
        }
        this.coordinatorModel = options.coordinatorModel;
        console.log(`[orchestrator] Using coordinator model: ${this.coordinatorModel}`);

        // Coordinator assigns models to shadow orchestra nodes
        // Use coordinatorModel for all internal nodes by default
        // This can be enhanced to distribute across AGENTIC_COORDINATOR_MODELS for diversity
        this.orchestraModels = {
            planner: this.coordinatorModel,
            evaluator: this.coordinatorModel,
            summarizer: this.coordinatorModel,
        };
        console.log(`[orchestrator] Assigned Shadow Orchestra models:`, this.orchestraModels);

        // Initialize components with coordinator-assigned models
        this.planner = new TaskPlanner(workflow, this.orchestraModels.planner);
        this.fileContextManager = getContextManager(workflow.id, this.runId);
        this.toolRegistry = getToolRegistry(workflow);

        // CRITICAL FIX: Initialize tool registry with factories
        // Without this, getMaskedTools() returns empty arrays
        this.toolRegistry.buildRegistry({
            createDelegationTool: (step) => createAgentDelegationTool(
                step,
                this.options.payment,
                this.workflow.id,
                this.runId,
                undefined,
                this.options.onProgress
            ),
            createMcpTool: (step) => {
                if (step.connectorId && step.toolName) {
                    return createMcpTool(step.connectorId, step.toolName, step.name);
                }
                return null;
            },
            createMemoryTools: () => createMemoryTools(
                this.workflow.id,
                this.runId,
                this.options.payment.userId
            ),
        });

        console.log(`[orchestrator] Components initialized with ${this.toolRegistry.getAllToolIds().length} static tools`);
    }

    /**
     * Emit SSE progress event if callback is registered
     * 
     * Event types: start, progress, step, agent, tool_start, tool_end, response, result, error, done
     */
    private emitProgress(
        type: "start" | "progress" | "step" | "agent" | "tool_start" | "tool_end" | "response" | "result" | "error" | "done",
        data: {
            stepName?: string;
            stepIndex?: number;
            totalSteps?: number;
            agentName?: string;
            agentWallet?: string;
            toolName?: string;
            message?: string;
            output?: string;
            error?: string;
            tokenCount?: number;
            tokensUsed?: number;
            tokenBudget?: number;
            cost?: number;
            progress?: number;
            duration?: number;
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
     * Build the stable coordinator system prompt (KV-cache friendly)
     * This prefix never changes during workflow execution
     * 
     * Dynamic content (memory, enhancements) goes into separate messages after cache breakpoint
     */
    private buildStableSystemPrompt(): string {
        // Return cached version if available
        if (this.stablePromptPrefix) {
            return this.stablePromptPrefix;
        }

        const agentSteps = this.workflow.steps.filter(s => s.type === "agent");

        // Build complete agent pipeline with full metadata from agentCardUri
        const agentPipeline = agentSteps.map((s, i) => {
            const toolName = `delegate_to_${s.name.replace(/[^a-zA-Z0-9_]/g, "_")}`;
            const meta = s.inputTemplate || {};

            // Extract agent card metadata (resolved from manowarCardUri at registration)
            const model = meta.model;
            const description = meta.description;

            // Plugins are the MCP tools/connectors the agent has access to
            const plugins = Array.isArray(meta.plugins)
                ? meta.plugins.map((p: any) => typeof p === 'string' ? p : (p.name || p.registryId)).join(", ")
                : "none";

            // Skills describe what the agent can do
            const skills = Array.isArray(meta.skills) && meta.skills.length > 0
                ? meta.skills.join(", ")
                : "";

            // Agent card URI for full context (IPFS source of truth)
            const cardUri = meta.agentCardUri;

            return `### ${i + 1}. ${s.name}
- **Delegation Tool**: \`${toolName}\`
- **Model**: ${model}
- **Plugins/Tools**: ${plugins}
- **Skills**: ${skills}${description ? `\n- **Description**: ${description}` : ""}${cardUri ? `\n- **Agent Card**: ${cardUri}` : ""}
- **Invoke**: Call \`${toolName}\` with structured task context and any attachments`;
        }).join("\n\n");

        // MCP/Connector tools in workflow (available for direct use if needed)
        const mcpSteps = this.workflow.steps.filter(s => s.type === "mcpTool" || s.type === "connectorTool");
        const mcpTools = mcpSteps.length > 0
            ? `\n\n## MCP TOOLS AVAILABLE\n${mcpSteps.map(s => `- ${s.name}: ${s.toolName} (${s.connectorId})`).join("\n")}`
            : "";

        // Stable prompt prefix - no dynamic content
        // User request, memory, and enhancements go in separate messages
        this.stablePromptPrefix = `You are the **Shadow Orchestra Coordinator** for "${this.workflow.name}".

## WORKFLOW GOAL
${this.workflow.description || "Execute the workflow steps in sequence"}

## COMPONENT AGENTS PIPELINE
Execute these agents SEQUENTIALLY using the Plan→Act→Reflect pattern.
Each agent is self-sufficient with its own tools.

${agentPipeline}${mcpTools}

## CRITICAL ORCHESTRATION RULES

### 1. PING, DON'T EXECUTE
You are the **COORDINATOR**, NOT an executor. You MUST delegate all tasks to the component agents above.
- Call each agent using their delegation tool (e.g., \`delegate_to_AgentName\`)
- Do NOT attempt to perform agent tasks yourself
- Do NOT use generic tools when an agent is designed for that task

### 2. FOLLOW THE PLAN
If an execution plan exists, follow it step by step.
- Execute the current step from the plan
- Wait for completion before moving to next step
- Report progress and any deviations

### 3. STRUCTURED DELEGATION
When calling an agent, provide:
- Clear task description from the plan
- Previous agent(s) output/results as context
- Attachment URLs if applicable
- Any constraints or requirements

### 4. WAIT FOR RESPONSE
After calling an agent, WAIT for their response before proceeding.
- Evaluate if the response satisfies the step requirements
- If incomplete, you may re-call the same agent with clarification

### 5. A2A RESOLUTION (Agent-to-Agent)
If an agent needs clarification or has questions:
- Resolve it by providing more context or re-delegating
- Do NOT ask the user interactively mid-workflow
- Use your knowledge of the workflow and previous outputs to answer agent queries

### 6. FINAL RESPONSE
ONLY provide the USER with the final, complete result when ALL steps are done.`;

        console.log(`[orchestrator] Stable prompt built: ${Math.ceil(this.stablePromptPrefix.length / 4)} tokens (cacheable)`);
        return this.stablePromptPrefix;
    }

    /**
     * Build dynamic context message (for inclusion AFTER cache breakpoint)
     * This content changes per invocation - kept separate for KV-cache efficiency
     */
    private buildDynamicContext(state: ManowarState): string {
        const parts: string[] = [];

        // User request
        const rawMessage = this.options.input.message || this.options.input.task || this.options.input.prompt || "";
        const userMessage = typeof rawMessage === 'string' ? rawMessage : String(rawMessage);

        // Handle attachment format
        const attachment = this.options.input.attachment as { type?: string; url?: string } | undefined;
        let attachmentNote = "";
        if (attachment?.url) {
            attachmentNote = ` [${attachment.type || 'file'} attached: ${attachment.url}]`;
        }

        parts.push(`## USER REQUEST\n"${userMessage}"${attachmentNote}`);

        // Current plan (if exists)
        if (state.currentPlan) {
            parts.push(`## EXECUTION PLAN (v${state.currentPlan.version})`);
            for (const step of state.currentPlan.steps) {
                const status = state.stepOutputs?.[step.stepNumber] ? "✓" :
                    step.stepNumber === state.currentStepNumber ? "→" : "○";
                parts.push(`${status} Step ${step.stepNumber}: ${step.agentName} - ${step.task.slice(0, 100)}`);
            }
        }

        // Previous step outputs (compact)
        const completedSteps = Object.entries(state.stepOutputs || {}).slice(-3);
        if (completedSteps.length > 0) {
            parts.push(`## PREVIOUS STEP RESULTS`);
            for (const [stepNum, output] of completedSteps) {
                parts.push(`Step ${stepNum}: ${String(output).slice(0, 300)}${String(output).length > 300 ? "..." : ""}`);
            }
        }

        // Memory context (cached)
        if (state.cachedMemories?.results?.length) {
            parts.push(`## PRIOR CONTEXT`);
            for (const mem of state.cachedMemories.results.slice(0, 3)) {
                parts.push(`- ${mem.memory}`);
            }
        }

        // Context file references
        if (state.contextReferences?.length) {
            parts.push(`## AVAILABLE CONTEXT FILES`);
            for (const ref of state.contextReferences.slice(0, 5)) {
                parts.push(`- [${ref.type}] ${ref.summary}`);
            }
        }

        // Improvements from previous loop
        if (state.contextEnhancements?.length) {
            parts.push(`## IMPROVEMENTS APPLIED`);
            parts.push(state.contextEnhancements.join("\n"));
        }

        return parts.join("\n\n");
    }

    /**
     * Legacy method for backwards compatibility
     * @deprecated Use buildStableSystemPrompt + buildDynamicContext instead
     */
    private buildSystemPrompt(): string {
        if (this.cachedSystemPrompt) {
            return this.cachedSystemPrompt;
        }

        // For backwards compat, combine stable + dynamic (less efficient)
        const stable = this.buildStableSystemPrompt();
        this.cachedSystemPrompt = stable;
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

        // Initialize FileContextManager before graph construction
        // Prevents race conditions and redundant mkdir calls during externalize()
        await this.fileContextManager.initialize();
        console.log(`[orchestrator] FileContextManager initialized`);

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
                // ============================================================
                // Planner Node - Creates execution plan
                // ============================================================
                .addNode("planner", async (state: ManowarState) => {
                    if (state.planningComplete && state.currentPlan) {
                        console.log(`[orchestrator] Plan already exists, skipping planner`);
                        return {};
                    }

                    const goal = state.activeGoal ||
                        this.options.input.message ||
                        this.options.input.task ||
                        this.workflow.description;

                    console.log(`[orchestrator] Creating execution plan for: ${String(goal).slice(0, 80)}...`);

                    // Get attachment URL if any
                    const attachment = this.options.input.attachment as { url?: string } | undefined;

                    // Create the plan
                    const plan: ExecutionPlan = await this.planner.createPlan(String(goal), {
                        attachmentUrl: attachment?.url,
                        priorContext: state.cachedMemories?.results?.slice(0, 2).map(m => m.memory).join("; "),
                    });

                    // Log plan steps (each step is a PlanStep)
                    const steps: PlanStep[] = plan.steps;
                    console.log(`[orchestrator] Plan created: ${steps.length} steps, ~${plan.totalEstimatedTokens} tokens`);

                    // Convert to state format
                    return {
                        currentPlan: {
                            planId: plan.planId,
                            goal: plan.goal,
                            version: plan.version,
                            steps: plan.steps,
                            totalEstimatedTokens: plan.totalEstimatedTokens,
                            createdAt: plan.createdAt,
                            validated: plan.validated,
                        },
                        planningComplete: true,
                        currentStepNumber: 1,
                    };
                })

                // ============================================================
                // Main Coordinator Node - Uses STABLE PROMPT + DYNAMIC CONTEXT
                // ============================================================
                .addNode("coordinator", async (state: ManowarState) => {
                    // Build STABLE system prompt (cacheable - never changes)
                    const stablePrompt = this.buildStableSystemPrompt();

                    // Build DYNAMIC context (per-invocation - after cache breakpoint)
                    const dynamicContext = this.buildDynamicContext(state);

                    // =========================================================
                    // TOOL MASKING: Use static registry exclusively for KV-cache efficiency
                    // Tools are already built in constructor via buildRegistry()
                    // =========================================================

                    // Create masking config from current state
                    const maskingConfig: MaskingConfig = createMaskingConfig(state);
                    const currentStepIndex = (state.currentStepNumber || 1) - 1;
                    console.log(`[orchestrator] Masking config: step ${currentStepIndex + 1}, disabled: ${maskingConfig.disabledToolIds.size}`);

                    // Get tools from registry with masking applied
                    // Registry already contains all delegation, MCP, and memory tools
                    const progressiveTools = this.toolRegistry.getMaskedTools(maskingConfig);

                    console.log(`[orchestrator] Using ${progressiveTools.length} tools from registry for step ${currentStepIndex + 1}`);

                    // Bind tools to model
                    const modelWithTools = (model as any).bindTools(progressiveTools);

                    // =========================================================
                    // MEMORY CACHING (Phase 1) - Prevent redundant queries
                    // =========================================================
                    let updatedCachedMemories = state.cachedMemories;

                    const memoryCacheExpired = !state.cachedMemories ||
                        (Date.now() - (state.cachedMemories.timestamp || 0)) > (state.memoryCacheTTL || 60000);

                    if (memoryCacheExpired && state.messages.length <= 2) {
                        try {
                            const query = String(state.messages[0]?.content || this.workflow.description);
                            const memResult = await searchMemoryWithGraph({
                                query,
                                agent_id: this.workflow.id,
                                run_id: this.runId,
                                limit: 5,
                                options: { rerank: true },
                            });

                            updatedCachedMemories = {
                                query,
                                results: memResult.memories.slice(0, 5).map(m => ({ memory: m.memory })),
                                timestamp: Date.now(),
                            };
                            console.log(`[orchestrator] Memory cached: ${updatedCachedMemories.results.length} memories`);
                        } catch {
                            // Memory not available, continue
                        }
                    }

                    // =========================================================
                    // TOKEN ESTIMATION & SLIDING WINDOW
                    // =========================================================
                    const estimatedTokens = Math.ceil(
                        stablePrompt.length / 4 +
                        dynamicContext.length / 4 +
                        state.messages.reduce((sum, m) => sum + String(m.content || '').length / 4, 0)
                    );

                    const modelSpec = await getModelContextSpec(this.coordinatorModel);
                    const usagePercent = (estimatedTokens / modelSpec.effectiveWindow) * 100;

                    console.log(`[orchestrator] Context: ~${estimatedTokens} tokens (${usagePercent.toFixed(1)}% of ${modelSpec.effectiveWindow})`);

                    // Dynamic sliding window - threshold adapts to model's context size
                    const dynamicThreshold = getDynamicThresholdPercent(modelSpec.effectiveWindow);
                    let messagesToUse: BaseMessage[] = state.messages;

                    if (usagePercent > dynamicThreshold && state.messages.length > SLIDING_WINDOW_SIZE) {
                        console.log(`[orchestrator] Activating sliding window (${usagePercent.toFixed(1)}% > ${dynamicThreshold.toFixed(1)}% threshold)`);
                        const firstMsg = state.messages[0];
                        const recentMsgs = state.messages.slice(-SLIDING_WINDOW_SIZE);
                        messagesToUse = [firstMsg, ...recentMsgs];
                        console.log(`[orchestrator] Messages: ${state.messages.length} → ${messagesToUse.length}`);
                    }

                    // =========================================================
                    // MESSAGE SANITIZATION (externalize large content)
                    // =========================================================
                    const sanitizeMessage = (m: BaseMessage): BaseMessage => {
                        const content = String(m.content || '');

                        // Skip short messages
                        if (content.length < 2000) return m;

                        // Try to extract Pinata URL or image metadata
                        const pinataMatch = content.match(/https:\/\/[^"'\s]*pinata[^"'\s]*/i);
                        const ipfsMatch = content.match(/ipfs:\/\/[^"'\s]+/i);
                        const typeMatch = content.match(/"type"\s*:\s*"(image|audio|video)"/);
                        const nameMatch = content.match(/"name"\s*:\s*"([^"]+)"/);

                        // If this looks like a tool response with large data
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

                    // =========================================================
                    // BUILD FINAL MESSAGES (Cache-Friendly Pattern)
                    // =========================================================
                    // 1. Stable system prompt (cacheable)
                    // 2. Dynamic context as separate message (after cache breakpoint)
                    // 3. Sanitized conversation messages
                    const messagesWithSystem = [
                        new SystemMessage(stablePrompt),
                        new SystemMessage(`[CONTEXT]\n${dynamicContext}`), // After cache breakpoint
                        ...sanitizedMessages,
                    ];

                    if (this.langsmithTracker) {
                        this.langsmithTracker.setCurrentAgent("coordinator");
                    }

                    const response = await modelWithTools.invoke(messagesWithSystem);

                    // Calculate estimated KV-cache hit rate
                    const kvCacheHit = state.messages.length > 1 ?
                        Math.round((stablePrompt.length / (stablePrompt.length + dynamicContext.length)) * 100) : 0;

                    // Populate contextReferences from FileContextManager
                    const contextManifest = this.fileContextManager.getContextManifest();

                    return {
                        messages: [response],
                        completedActions: [`Coordinator response`],
                        cachedMemories: updatedCachedMemories,
                        kvCacheHitEstimate: kvCacheHit,
                        // File-based context references for dynamic context building
                        contextReferences: contextManifest,
                    };
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
                    const result = await toolNode.invoke(state);

                    // Track step outputs for Plan→Act→Reflect context
                    const updatedStepOutputs: Record<number, string> = { ...state.stepOutputs };
                    const currentStep = state.currentStepNumber || 1;

                    // Extract output from tool messages
                    const newMessages = result.messages || [];
                    for (const msg of newMessages) {
                        if (msg._getType() === 'tool') {
                            const content = String(msg.content).slice(0, 500); // Truncate for context
                            updatedStepOutputs[currentStep] = content;
                            console.log(`[tools] Saved output for step ${currentStep}: ${content.slice(0, 100)}...`);
                        }
                    }

                    return {
                        ...result,
                        stepOutputs: updatedStepOutputs,
                    };
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

                // Shadow Orchestra: Memory Wipe (Safe Wipe with context preservation)
                .addNode("memoryWipe", async (state: ManowarState) => {
                    const result = await performSafeWipe(
                        this.workflow.id,
                        this.runId,
                        this.coordinatorModel,
                        {
                            goal: state.activeGoal,
                            completedActions: state.completedActions || [],
                            lastOutcome: String(state.messages[state.messages.length - 1]?.content || ""),
                            agentSummaries: {},
                            messageCount: state.messages.length,
                        },
                        this.options.payment.userId
                    );

                    if (result) {
                        // Safe Wipe: return single system message (reducer will replace)
                        return {
                            messages: [new SystemMessage(`[CONTEXT REFRESHED] ${result.summary}`)],
                            lastSummary: result.summary,
                            tokensSavedByExternalization: result.tokensSaved,
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

                // Edges: Main flow - START → Planner → Coordinator
                .addEdge(START, "planner")
                .addEdge("planner", "coordinator")
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

                // ==================================================================
                // Reviewer node - integrates improvements from previous loops
                // ==================================================================
                .addNode("reviewer", async (state: ManowarState) => {
                    // Only active on loop 2+ in continuous workflows
                    const loopNum = state.lastEvaluation?.loopNumber || 1;
                    if (loopNum > 1 && state.lastEvaluation) {
                        console.log(`[orchestrator] Running reviewer for loop ${loopNum}`);
                        return reviewerNode(state);
                    }
                    return {}; // Skip on first loop
                })

                // ==================================================================
                // Memory saver node - saves workflow outcomes to Mem0
                // ==================================================================
                .addNode("memorySaver", async (state: ManowarState) => {
                    // Save significant outcomes to Mem0 for future reference
                    try {
                        const lastMessage = state.messages[state.messages.length - 1];
                        if (lastMessage && state.activeGoal) {
                            const outcome = typeof lastMessage.content === 'string'
                                ? lastMessage.content
                                : JSON.stringify(lastMessage.content);

                            // Calculate total tokens from tokenMetrics
                            let totalTokens = 0;
                            if (state.tokenMetrics) {
                                for (const metrics of Object.values(state.tokenMetrics)) {
                                    totalTokens += metrics.totalTokens || 0;
                                }
                            }

                            // Only save if outcome is substantial
                            if (outcome.length > 100) {
                                await addMemoryWithGraph({
                                    messages: [
                                        { role: "user", content: state.activeGoal },
                                        { role: "assistant", content: outcome.slice(0, 2000) }, // Limit to 2000 chars
                                    ],
                                    agent_id: this.workflow.id,
                                    run_id: this.runId,
                                    user_id: this.options.payment.userId,
                                    metadata: {
                                        workflowName: this.workflow.name,
                                        success: state.status !== "error",
                                        tokensUsed: totalTokens,
                                    },
                                });
                                console.log(`[orchestrator] Saved workflow outcome to memory`);
                            }
                        }
                    } catch (err) {
                        console.warn(`[orchestrator] Failed to save memory:`, err);
                    }
                    return {}; // Don't modify state
                })

                // Evaluator node for quality assessment
                .addNode("evaluator", async (state: ManowarState) => {
                    return evaluatorNode(state);
                })

                // ==================================================================
                // Graph edges: Complete Shadow Orchestra flow
                // planner → coordinator → tools → noteTaker → windowTracker
                // → (memoryWipe) → toolBoxer → graphOptimize → evaluator
                // → [conditionally: memorySaver → END or reviewer → coordinator]
                // ==================================================================
                .addEdge("graphOptimize", "evaluator")

                // Production continuous loop: evaluator decides whether to continue or end
                .addConditionalEdges("evaluator", (state: ManowarState) => {
                    // Check if this is a multi-loop workflow and should continue
                    const shouldContinue = state.shouldContinueLoop &&
                        state.loopCount < state.maxLoops &&
                        state.maxLoops > 0;

                    if (shouldContinue) {
                        console.log(`[orchestrator] Loop ${state.loopCount}/${state.maxLoops}: continuing to reviewer`);
                        return "reviewer";
                    }

                    // Either one-shot workflow or loop complete - save and end
                    console.log(`[orchestrator] Workflow complete after ${state.loopCount} loop(s)`);
                    return "memorySaver";
                })

                // Reviewer leads back to coordinator for next loop iteration
                .addEdge("reviewer", "coordinator")
                .addEdge("memorySaver", END);

            // Compile and execute
            const app = graph.compile();

            const task = this.options.input.task || this.options.input.message || this.options.input.prompt || JSON.stringify(this.options.input);

            console.log(`[orchestrator] Executing task: ${String(task).substring(0, 80)}...`);

            // Create initial state using the state factory
            const initialState = {
                ...createInitialState(this.workflow.id, String(task)),
                messages: [new HumanMessage(String(task))],
                runId: this.runId,
                status: "running" as const,
                // maxLoops can be set via workflow config if supported
            };

            const result = await app.invoke(
                initialState,
                {
                    ...(await createLangSmithConfig(this.workflow.id, this.runId, this.coordinatorModel)),
                    callbacks: this.langsmithTracker ? [this.langsmithTracker] : [],
                    recursionLimit: 50, // Increase from default 25 for complex workflows
                }
            );

            // Extract final output
            const messages = result.messages || [];
            const lastMessage = messages[messages.length - 1];
            const output = lastMessage?.content?.toString() || "";

            console.log(`[orchestrator] Complete in ${Date.now() - this.startTime}ms`);

            // SSE: Emit done event
            this.emitProgress("done", {
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

            // Clean up tool registry after successful execution
            clearToolRegistry(this.workflow.id);

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

            // Clean up tool registry
            clearToolRegistry(this.workflow.id);

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
