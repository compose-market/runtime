/**
 * Manowar Orchestrator - Simplified Architecture
 * 
 * Implements the simplified orchestration pattern from suggestions.md:
 * - Static system prompt from manowarCard (built once)
 * - Embeddings for context retrieval (not full history)
 * - Direct delegation via HTTP (not tool-based)
 * - Sliding window for recent messages
 * 
 * This replaces the complex LangGraph-based Shadow Orchestra with
 * a streamlined execution flow.
 */

import type { Workflow, ExecutorOptions, SSEProgressEvent } from "./types.js";
import { TaskPlanner } from "./planner.js";
import { fetchManowarCard, buildSystemPromptFromCard, type ManowarCard } from "./registry.js";
import { delegatePlanStep } from "./delegation.js";
import { getRelevantContext, recordConversationTurn } from "./embeddings.js";
import { ContextWindowManager } from "./context.js";
import { addMemoryWithGraph, performSafeWipe } from "./memory.js";
import { LangSmithTokenTracker } from "./langsmith.js";
import type { TokenUsage } from "./types.js";

// =============================================================================
// Constants
// =============================================================================

// Use SLIDING_WINDOW_SIZE from context.ts (single source of truth)
const API_URL = process.env.LAMBDA_API_URL || "https://api.compose.market";

// =============================================================================
// Types
// =============================================================================

export interface OrchestratorResult {
    success: boolean;
    result: string;
    stepResults: Array<{
        stepNumber: number;
        agentName: string;
        success: boolean;
        output: string;
    }>;
    totalTokensUsed: number;
    error?: string;
}

interface Message {
    role: "system" | "user" | "assistant";
    content: string;
}

// =============================================================================
// ManowarOrchestrator Class
// =============================================================================

export class ManowarOrchestrator {
    private workflow: Workflow;
    private coordinatorModel: string;
    private systemPrompt: string = "";
    private planner: TaskPlanner | null = null;
    private contextManager: ContextWindowManager;
    private manowarCard: ManowarCard | null = null;
    private initialized: boolean = false;
    private onProgress?: (event: SSEProgressEvent) => void;
    private tokenTracker: LangSmithTokenTracker | null = null;

    constructor(workflow: Workflow, coordinatorModel: string) {
        this.workflow = workflow;
        this.coordinatorModel = coordinatorModel;
        this.contextManager = new ContextWindowManager(coordinatorModel);
    }

    /**
     * Initialize the orchestrator by fetching manowarCard and building system prompt
     */
    async initialize(manowarCardUri?: string): Promise<void> {
        if (this.initialized) return;

        try {
            // Initialize context manager with model context window
            await this.contextManager.initialize();

            // Fetch manowarCard if URI provided
            if (manowarCardUri) {
                this.manowarCard = await fetchManowarCard(manowarCardUri);
                if (this.manowarCard) {
                    this.systemPrompt = buildSystemPromptFromCard(this.manowarCard);
                } else {
                    this.systemPrompt = this.buildPromptFromWorkflow();
                }
            } else {
                // Build prompt from workflow if no card
                this.systemPrompt = this.buildPromptFromWorkflow();
            }

            this.initialized = true;
            console.log(`[orchestrator] Initialized with ${this.workflow.steps.filter(s => s.type === "agent").length} agents, context: ${this.contextManager.getState().maxTokens} tokens`);
        } catch (error) {
            console.error("[orchestrator] Initialization failed:", error);
            // Fall back to workflow-based prompt
            this.systemPrompt = this.buildPromptFromWorkflow();
            this.initialized = true;
        }
    }

    /**
     * Build system prompt from workflow (fallback if no manowarCard)
     */
    private buildPromptFromWorkflow(): string {
        const agentSteps = this.workflow.steps.filter(s => s.type === "agent");
        const agentDescriptions = agentSteps
            .map((s, i) => {
                const meta = s.inputTemplate || {};
                return `${i + 1}. **${s.name}**
  - Model: ${meta.model || "default"}
  - Tools: ${Array.isArray(meta.plugins) ? meta.plugins.join(", ") : "none"}`;
            })
            .join("\n\n");

        return `You are the coordinator for manowar "${this.manowarCard?.title}".

## GOAL
${this.manowarCard?.description}

## COMPONENT AGENTS
${this.manowarCard?.agents?.map((agentCard: { name: string; model: string; plugins?: Array<{ name: string }> }, i: number) => {
            return `${i + 1}. **${agentCard.name}**
  - Model: ${agentCard.model}
  - Tools: ${Array.isArray(agentCard.plugins) ? agentCard.plugins.map(p => p.name).join(", ") : "none"}`;
        }).join("\n\n")}

## COORDINATION RULES
1. You must NEVER modify any agent's model or tools.
2. Break the goal into atomic tasks and delegate to agents.
3. Maintain efficient context via embeddings.
4. Only complete when all tasks are done.`;
    }

    /**
     * Execute the workflow with a user request
     */
    async execute(
        userRequest: string,
        options: Partial<ExecutorOptions> = {}
    ): Promise<OrchestratorResult> {
        this.onProgress = options.onProgress;

        // Ensure initialized
        await this.initialize(options.manowarCardUri);

        if (!this.manowarCard?.walletAddress) {
            throw new Error("[Orchestrator] manowarCard.walletAddress is required - ensure manowarCardUri is provided");
        }
        const walletAddress = this.manowarCard.walletAddress;
        const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        // Create LangSmith token tracker for this run (contextManager implements TokenLedgerInterface)
        this.tokenTracker = new LangSmithTokenTracker(walletAddress, runId, this.contextManager);
        this.tokenTracker.setCurrentAgent("coordinator", "planning");
        this.tokenTracker.setCurrentModel(this.coordinatorModel);

        // Create planner with callback for accurate token tracking
        this.planner = new TaskPlanner(this.workflow, this.coordinatorModel, [this.tokenTracker]);

        this.emitProgress("start", { runId, message: "Starting manowar execution" });

        // Messages array - starts with system prompt + user request
        const messages: Message[] = [
            { role: "system", content: this.systemPrompt },
            { role: "user", content: userRequest },
        ];

        // Store user request for retrieval (using walletAddress as agent_id for Mem0)
        await recordConversationTurn(walletAddress, "user", userRequest, 0);

        try {
            // 1. Create execution plan
            this.emitProgress("progress", { progress: 10, message: "Creating execution plan" });

            // Build edges context for planner if available
            const edgesContext = this.manowarCard?.edges?.length
                ? `Workflow execution order: ${this.manowarCard.edges.map(e =>
                    `Agent ${e.source} → Agent ${e.target}${e.label ? ` (${e.label})` : ""}`
                ).join(", ")}`
                : undefined;

            // Attachment URL handling:
            // Orchestrator only sees the URL (from Pinata), never the actual content.
            // The URL is passed to planner for context-aware planning.
            // Agents that need the actual content will access it at delegation time.
            if (options.attachmentUrl) {
                console.log(`[orchestrator] Attachment URL received: ${options.attachmentUrl} (content accessed by delegated agent)`);
            }

            // Build prior context combining edges and any prior context
            const priorContext = [edgesContext].filter(Boolean).join("\n");

            const plan = await this.planner.createPlan(userRequest, {
                priorContext: priorContext || undefined,
                attachmentUrl: options.attachmentUrl,
            });

            if (!plan || plan.steps.length === 0) {
                return {
                    success: false,
                    result: "",
                    stepResults: [],
                    totalTokensUsed: 0,
                    error: "Failed to create execution plan",
                };
            }

            console.log(`[orchestrator] Created plan with ${plan.steps.length} steps`);
            this.emitProgress("progress", {
                progress: 15,
                message: `Plan created: ${plan.steps.length} steps`
            });

            // 2. Execute each step
            const stepResults: OrchestratorResult["stepResults"] = [];
            const previousOutputs: Array<{ agentName: string; summary: string }> = [];
            let totalTokensUsed = 0;

            for (let i = 0; i < plan.steps.length; i++) {
                const step = plan.steps[i];
                const stepProgress = 20 + (i / plan.steps.length) * 70;

                this.emitProgress("step", {
                    stepName: step.agentName,
                    stepIndex: i + 1,
                    totalSteps: plan.steps.length,
                    message: `Executing step ${i + 1}: ${step.task}`,
                });

                // Get relevant context from embeddings
                const relevantContext = await getRelevantContext(
                    walletAddress,
                    step.task,
                    3
                );

                // Delegate to agent
                this.emitProgress("agent", {
                    agentName: step.agentName,
                    message: `Delegating to ${step.agentName}`,
                });

                const result = await delegatePlanStep(
                    {
                        agentName: step.agentName,
                        task: step.task,
                        stepNumber: i + 1,
                        expectedOutput: step.expectedOutput || "Task result",
                        dependsOn: step.dependsOn || [],
                        estimatedTokens: step.estimatedTokens,
                        priority: step.priority || "medium",
                    },
                    this.manowarCard?.agents?.find((a: { name: string }) => a.name === step.agentName),
                    { priorOutputs: previousOutputs.map(p => `${p.agentName}: ${p.summary}`) }
                );

                // Record result
                stepResults.push({
                    stepNumber: i + 1,
                    agentName: step.agentName,
                    success: result.success,
                    output: result.output,
                });

                // === TOKEN TRACKING ===
                // Record actual token usage to context manager
                if (result.tokensUsed && result.tokensUsed > 0) {
                    totalTokensUsed += result.tokensUsed;

                    // Use input/output tokens from agent response when available
                    // Only fall back to estimation if agent doesn't provide breakdown
                    const inputTokens = result.inputTokens ?? Math.floor(result.tokensUsed * 0.4);
                    const outputTokens = result.outputTokens ?? Math.floor(result.tokensUsed * 0.6);

                    // Build TokenUsage and record to context manager
                    const tokenUsage: TokenUsage = {
                        agentId: step.agentName,
                        model: this.coordinatorModel,
                        inputTokens,
                        outputTokens,
                        totalTokens: result.tokensUsed,
                        timestamp: Date.now(),
                    };
                    this.contextManager.recordUsage(tokenUsage);

                    // Check if context window cleanup needed (70% threshold)
                    const contextState = this.contextManager.getState();
                    if (contextState.needsCleanup) {
                        console.log(`[orchestrator] Context at ${contextState.usagePercent.toFixed(1)}% - triggering safe wipe`);

                        // Perform safe wipe with real token count
                        const agentSummaries: Record<string, string> = {};
                        previousOutputs.forEach(p => {
                            agentSummaries[p.agentName] = p.summary;
                        });

                        await performSafeWipe(
                            walletAddress,
                            runId,
                            this.coordinatorModel,
                            {
                                goal: userRequest,
                                agentSummaries,
                                messageCount: messages.length,
                                completedActions: [],
                                lastOutcome: ""
                            }
                        );

                        this.emitProgress("progress", {
                            message: `Context optimized: ${contextState.currentTokens} tokens compressed`,
                        });
                    }
                }

                // Store output for future retrieval
                const outputSummary = this.summarizeOutput(result.output);
                previousOutputs.push({
                    agentName: step.agentName,
                    summary: outputSummary,
                });

                await recordConversationTurn(
                    walletAddress,
                    "assistant",
                    `${step.agentName}: ${outputSummary}`,
                    i + 1
                );

                // Add to messages (sliding window handled at coordinator level)
                messages.push({
                    role: "assistant",
                    content: `[${step.agentName}] ${outputSummary}`,
                });

                // === STEP REFLECTION ===
                // Reflect on the completed step for multi-loop learning
                if (result.success) {
                    try {
                        const reflection = await this.planner.reflectOnStep(
                            i + 1,
                            result.output,
                            result.tokensUsed || 0
                        );

                        // Store reflection insights in memory for future runs
                        if (reflection.learnings.length > 0) {
                            await addMemoryWithGraph({
                                messages: [
                                    { role: "system", content: `Step ${i + 1} reflection for ${walletAddress}` },
                                    {
                                        role: "assistant", content: JSON.stringify({
                                            step: i + 1,
                                            agent: step.agentName,
                                            qualityScore: reflection.qualityScore,
                                            learnings: reflection.learnings,
                                        })
                                    },
                                ],
                                agent_id: walletAddress,
                                run_id: runId,
                                metadata: { type: "step_reflection", step: i + 1, quality: reflection.qualityScore },
                            });
                        }
                    } catch (reflectError) {
                        console.warn(`[orchestrator] Reflection failed for step ${i + 1}:`, reflectError);
                    }
                }

                this.emitProgress("progress", {
                    progress: stepProgress,
                    message: `Completed step ${i + 1}/${plan.steps.length}`,
                });

                // Early exit on critical failure
                if (!result.success && step.priority === "critical") {
                    return {
                        success: false,
                        result: "",
                        stepResults,
                        totalTokensUsed,
                        error: `Critical step failed: ${result.error || "Unknown error"}`,
                    };
                }
            }

            // 3. Generate final result
            const finalResult = this.compileFinalResult(stepResults);

            // Store final result in memory
            await addMemoryWithGraph({
                messages: [
                    { role: "system", content: `Manowar ${walletAddress} completed` },
                    { role: "assistant", content: finalResult },
                ],
                agent_id: walletAddress,
                run_id: runId,
                metadata: {
                    type: "workflow_completion",
                    step_count: stepResults.length,
                    success_count: stepResults.filter(s => s.success).length,
                },
            });

            // === EVALUATION STORAGE ===
            // Store workflow evaluation for multi-loop improvement
            const successRate = stepResults.filter(s => s.success).length / stepResults.length;
            const evaluation = {
                runId,
                goal: userRequest,
                successRate,
                totalTokensUsed,
                stepCount: stepResults.length,
                qualityScore: Math.round(successRate * 10), // 0-10 scale
                timestamp: Date.now(),
            };

            await addMemoryWithGraph({
                messages: [
                    { role: "system", content: `Workflow evaluation for ${walletAddress}` },
                    { role: "assistant", content: JSON.stringify(evaluation) },
                ],
                agent_id: walletAddress,
                run_id: runId,
                metadata: {
                    type: "workflow_evaluation",
                    quality_score: evaluation.qualityScore,
                    success_rate: successRate,
                },
            });

            console.log(`[orchestrator] Evaluation stored: quality=${evaluation.qualityScore}/10, tokens=${totalTokensUsed}`);

            this.emitProgress("result", { output: finalResult });
            this.emitProgress("done", { message: "Workflow completed successfully" });

            return {
                success: true,
                result: finalResult,
                stepResults,
                totalTokensUsed,
            };

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error("[orchestrator] Execution error:", error);

            this.emitProgress("error", { error: errorMessage });
            this.emitProgress("done", { message: "Workflow failed" });

            return {
                success: false,
                result: "",
                stepResults: [],
                totalTokensUsed: 0,
                error: errorMessage,
            };
        }
    }

    /**
     * Summarize output for context (max 300 chars)
     */
    private summarizeOutput(output: string): string {
        if (output.length <= 300) return output;
        return output.slice(0, 297) + "...";
    }

    /**
     * Compile final result from step outputs
     */
    private compileFinalResult(
        stepResults: OrchestratorResult["stepResults"]
    ): string {
        const successfulSteps = stepResults.filter(s => s.success);

        if (successfulSteps.length === 0) {
            return "No steps completed successfully.";
        }

        // Return the last successful output as the final result
        const lastOutput = successfulSteps[successfulSteps.length - 1].output;

        if (successfulSteps.length === stepResults.length) {
            return lastOutput;
        }

        // Include summary of all steps if some failed
        const summary = stepResults
            .map(s => `${s.agentName}: ${s.success ? "✓" : "✗"}`)
            .join(", ");

        return `${lastOutput}\n\n[Steps: ${summary}]`;
    }

    /**
     * Emit SSE progress event
     */
    private emitProgress(
        type: SSEProgressEvent["type"],
        data: Partial<SSEProgressEvent["data"]>
    ): void {
        if (this.onProgress) {
            this.onProgress({
                type,
                timestamp: Date.now(),
                data,
            });
        }
    }
}

// =============================================================================
// Convenience Export
// =============================================================================

/**
 * Execute a workflow with the simplified orchestrator
 */
export async function executeWithOrchestrator(
    workflow: Workflow,
    userRequest: string,
    options: Partial<ExecutorOptions> = {}
): Promise<OrchestratorResult> {
    const coordinatorModel = options.coordinatorModel || "gpt-4o";
    const orchestrator = new ManowarOrchestrator(workflow, coordinatorModel);
    return orchestrator.execute(userRequest, options);
}
