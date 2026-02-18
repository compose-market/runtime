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

import type {
    Workflow,
    ExecutorOptions,
    SSEProgressEvent,
    ExecutionRunStateProjection,
    StepApprovalRequest,
} from "./types.js";
import { TaskPlanner, type StepReflection, type PlanStep } from "./planner.js";
import { fetchManowarCard, buildSystemPromptFromCard, normalizeManowarCard, assertManowarCard, type ManowarCard } from "./registry.js";
import { delegatePlanStep } from "./delegation.js";
import { getRelevantContext, recordConversationTurn } from "./embeddings.js";
import { ContextWindowManager } from "./context.js";
import { addMemoryWithGraph, performSafeWipe } from "./memory.js";
import {
    LangSmithTokenTracker,
    isLangSmithEnabled,
    recordLearning,
    recordQualityScore,
} from "./langsmith.js";
import {
    persistCheckpoints,
    recordInsight,
    recordObservation,
    recordDecision,
    recordError,
} from "./checkpoint.js";
import {
    createRun,
    startRun,
    completeRun,
    failRun,
    type TrackedRun,
} from "./run-tracker.js";
import { isAgenticCoordinatorModel } from "./agentic.js";
import type { TokenUsage } from "./types.js";
import { createModel } from "../frameworks/langchain.js";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

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

        // Validate coordinator model against approved agentic models
        if (!isAgenticCoordinatorModel(coordinatorModel)) {
            console.warn(`[orchestrator] Model "${coordinatorModel}" is not in the approved agentic coordinator list. Performance may vary.`);
        }
    }

    private emitRunState(
        options: Partial<ExecutorOptions>,
        current: ExecutionRunStateProjection,
        updates: Partial<ExecutionRunStateProjection>
    ): ExecutionRunStateProjection {
        const next: ExecutionRunStateProjection = {
            ...current,
            ...updates,
            updatedAt: Date.now(),
        };
        options.onRunStateUpdate?.(next);
        return next;
    }

    private isHighRiskStep(step: PlanStep): { requiresApproval: boolean; reason: string } {
        const text = `${step.task} ${step.expectedOutput}`.toLowerCase();
        const highRiskPatterns = [
            /transfer/,
            /payment/,
            /pay\b/,
            /swap/,
            /sell/,
            /buy/,
            /approve/,
            /mint/,
            /burn/,
            /bridge/,
            /send/,
            /write/,
            /on[-\s]?chain/,
            /transaction/,
            /withdraw/,
            /deposit/,
            /webhook/,
            /delete/,
            /remove/,
            /revoke/,
        ];

        const matched = highRiskPatterns.find((pattern) => pattern.test(text));
        if (matched) {
            return {
                requiresApproval: true,
                reason: `High-risk task keyword matched: ${matched.source}`,
            };
        }
        if (step.priority === "critical") {
            return {
                requiresApproval: true,
                reason: "Critical priority step",
            };
        }
        return { requiresApproval: false, reason: "" };
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
                const fetched = await fetchManowarCard(manowarCardUri);
                if (fetched) {
                    this.manowarCard = normalizeManowarCard(fetched);
                    assertManowarCard(this.manowarCard);
                }
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
     * Build coordination context for planning/reflection (authoritative metadata)
     */
    private buildCoordinationContext(userRequest: string): string {
        const payload = {
            manowar: {
                walletAddress: this.manowarCard?.walletAddress,
                title: this.manowarCard?.title,
                description: this.manowarCard?.description,
                edges: this.manowarCard?.edges || [],
                agents: this.manowarCard?.agents?.map(a => ({
                    name: a.name,
                    walletAddress: a.walletAddress,
                    model: a.model,
                    skills: a.skills,
                    plugins: a.plugins?.map(p => ({ name: p.name, registryId: p.registryId, origin: p.origin })) || [],
                })) || [],
            },
            userMessage: userRequest,
        };

        return JSON.stringify(payload, null, 2);
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
        const workflowId = this.workflow.id;
        if (!workflowId) {
            throw new Error("[Orchestrator] workflow.id is required");
        }
        // Validate that workflow ID contains the wallet address (allows unique IDs per run)
        const expectedPrefix = `manowar-${walletAddress}`;
        if (!workflowId.startsWith(expectedPrefix)) {
            throw new Error(`[Orchestrator] workflow.id mismatch: expected to start with ${expectedPrefix}, got ${workflowId}`);
        }

        // Create tracked run via run-tracker (replaces inline runId generation)
        const trackedRun = createRun({
            runId: options.runId,
            workflowId,
            manowarWallet: walletAddress,
            input: { request: userRequest },
            triggeredBy: {
                type: options.triggerId ? "cron" : "manual",
                triggerId: options.triggerId,
            },
        });
        const runId = trackedRun.runId;

        // Mark run as started
        startRun(runId);

        let runState: ExecutionRunStateProjection = {
            runId,
            workflowId,
            walletAddress,
            status: "running",
            startedAt: Date.now(),
            updatedAt: Date.now(),
            progress: 0,
            message: "Starting manowar execution",
        };
        runState = this.emitRunState(options, runState, {});

        // Create LangSmith token tracker for this run (contextManager implements TokenLedgerInterface)
        this.tokenTracker = new LangSmithTokenTracker(walletAddress, runId, this.contextManager);
        this.tokenTracker.setCurrentAgent("coordinator", "planning");
        this.tokenTracker.setCurrentModel(this.coordinatorModel);

        // Create planner with callback for accurate token tracking
        // Pass manowarCard.agents for correct agent names (not fallback workflow step names)
        this.planner = new TaskPlanner(
            this.workflow,
            this.coordinatorModel,
            [this.tokenTracker],
            this.manowarCard?.agents
        );
        this.planner.setWorkflowGraph({
            agents: this.manowarCard?.agents,
            steps: this.workflow.steps,
            edges: this.manowarCard?.edges,
        });

        this.emitProgress("start", { runId, message: "Starting manowar execution" });
        runState = this.emitRunState(options, runState, {
            status: "running",
            progress: 2,
            message: "Initialized orchestrator and planner",
        });

        const runSystemPrompt = `${this.systemPrompt}\n\n## USER_MESSAGE\n${userRequest}`;

        // Messages array - starts with system prompt + user request
        const messages: Message[] = [
            { role: "system", content: runSystemPrompt },
            { role: "user", content: userRequest },
        ];

        // Provide authoritative coordination context to planner/reflection
        const coordinationContext = this.buildCoordinationContext(userRequest);
        this.planner.setCoordinationContext(coordinationContext);

        const planner = this.planner;
        if (!planner) {
            throw new Error("[orchestrator] Planner not initialized");
        }

        // Store user request for retrieval (using walletAddress as agent_id for Mem0)
        await recordConversationTurn(walletAddress, "user", userRequest, 0, runId);

        try {
            // 1. Create execution plan(s)
            this.emitProgress("progress", { progress: 10, message: "Creating execution plan" });
            runState = this.emitRunState(options, runState, {
                status: "running",
                progress: 10,
                message: "Creating execution plan",
            });

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

            const maxPlanIterations = options.maxPlanIterations ?? 2;
            const replanOnFailure = options.replanOnFailure ?? true;
            const continuous = options.continuous ?? false;
            const maxLoopIterations = options.maxLoopIterations ?? 3;
            const loopDelayMs = options.loopDelayMs ?? 0;

            let planIteration = 0;
            let loopIteration = 0;
            let finalResult = "";
            const completedStepsSummary: string[] = [];

            const allStepResults: OrchestratorResult["stepResults"] = [];
            const allReflections: StepReflection[] = [];
            let totalTokensUsed = 0;
            let lastOutputs: Array<{ agentName: string; summary: string }> = [];

            const runPlan = async (plan: Awaited<ReturnType<TaskPlanner["createPlan"]>>) => {
                const stepResults: OrchestratorResult["stepResults"] = [];
                const previousOutputs: Array<{ agentName: string; agentWallet?: string; summary: string }> = [];
                const reflections: StepReflection[] = [];
                let planTokensUsed = 0;
                let needsReplan = false;

                const successfulSteps = new Set<number>();
                const attemptedSteps = new Set<number>();

                while (true) {
                    if (options.shouldCancel?.()) {
                        console.warn("[orchestrator] Execution cancelled by user");
                        needsReplan = false;
                        break;
                    }

                    const nextStep = planner.getNextStep(Array.from(successfulSteps));
                    if (!nextStep) {
                        break;
                    }
                    if (attemptedSteps.has(nextStep.stepNumber)) {
                        console.warn(`[orchestrator] Step ${nextStep.stepNumber} already attempted - breaking to avoid loop`);
                        break;
                    }
                    attemptedSteps.add(nextStep.stepNumber);

                    const executedCount = attemptedSteps.size;
                    const stepProgress = 20 + ((executedCount - 1) / plan.steps.length) * 70;

                    this.emitProgress("step", {
                        stepName: nextStep.agentName,
                        stepIndex: executedCount,
                        totalSteps: plan.steps.length,
                        message: `Executing step ${nextStep.stepNumber}: ${nextStep.task}`,
                    });
                    runState = this.emitRunState(options, runState, {
                        status: "running",
                        currentStep: nextStep.stepNumber,
                        totalSteps: plan.steps.length,
                        progress: Math.min(95, Math.round(stepProgress)),
                        message: `Executing step ${nextStep.stepNumber}: ${nextStep.agentName}`,
                    });

                    const approvalRisk = this.isHighRiskStep(nextStep);
                    if (options.requestStepApproval && approvalRisk.requiresApproval) {
                        const stepKey = `${runId}:${nextStep.stepNumber}:${nextStep.agentName}`;
                        const approvalRequest: StepApprovalRequest = {
                            runId,
                            workflowId,
                            walletAddress,
                            stepNumber: nextStep.stepNumber,
                            stepKey,
                            agentName: nextStep.agentName,
                            agentWallet: nextStep.agentWallet,
                            task: nextStep.task,
                            expectedOutput: nextStep.expectedOutput,
                            priority: nextStep.priority,
                            riskReason: approvalRisk.reason,
                            requestedAt: Date.now(),
                        };

                        this.emitProgress("progress", {
                            progress: Math.min(95, Math.round(stepProgress)),
                            message: `Waiting approval for risky step ${nextStep.stepNumber}`,
                        });
                        runState = this.emitRunState(options, runState, {
                            status: "blocked_approval",
                            pendingApprovalStepKey: stepKey,
                            message: `Waiting approval for step ${nextStep.stepNumber}`,
                        });

                        const decision = await options.requestStepApproval(approvalRequest);
                        if (decision.status === "rejected") {
                            const rejectionOutput = `Step ${nextStep.stepNumber} rejected by approver${decision.reason ? `: ${decision.reason}` : ""}`;
                            stepResults.push({
                                stepNumber: nextStep.stepNumber,
                                agentName: nextStep.agentName,
                                success: false,
                                output: rejectionOutput,
                            });
                            recordError(runId, nextStep.agentName, nextStep.stepNumber, rejectionOutput);
                            runState = this.emitRunState(options, runState, {
                                status: "error",
                                error: rejectionOutput,
                                message: rejectionOutput,
                                pendingApprovalStepKey: undefined,
                            });
                            return {
                                stepResults,
                                reflections,
                                planTokensUsed,
                                needsReplan: false,
                                previousOutputs,
                            };
                        }

                        runState = this.emitRunState(options, runState, {
                            status: "running",
                            pendingApprovalStepKey: undefined,
                            message: `Approval granted for step ${nextStep.stepNumber}`,
                        });
                    }

                    const relevantContext = await getRelevantContext(
                        walletAddress,
                        nextStep.task,
                        3
                    );

                    this.emitProgress("agent", {
                        agentName: nextStep.agentName,
                        message: `Delegating to ${nextStep.agentName}`,
                    });

                    recordObservation(runId, nextStep.agentName, nextStep.stepNumber, `Task: ${nextStep.task}`);

                    let agentCard = this.manowarCard?.agents?.find((a: { walletAddress?: string; name: string }) =>
                        (nextStep.agentWallet && a.walletAddress === nextStep.agentWallet) || a.name === nextStep.agentName
                    );

                    const workflowStep = this.workflow.steps.find(s => s.name === nextStep.agentName);

                    let agentWallet = nextStep.agentWallet || (agentCard as { walletAddress?: string })?.walletAddress;
                    if (!agentWallet) {
                        agentWallet = workflowStep?.agentAddress || (workflowStep?.inputTemplate as { agentAddress?: string })?.agentAddress;
                    }

                    if (!agentCard && agentWallet) {
                        agentCard = this.manowarCard?.agents?.find((a: { walletAddress?: string }) => a.walletAddress === agentWallet);
                    }

                    const result = await delegatePlanStep(
                        {
                            agentName: nextStep.agentName,
                            task: nextStep.task,
                            stepNumber: nextStep.stepNumber,
                            expectedOutput: nextStep.expectedOutput || "Task result",
                            dependsOn: nextStep.dependsOn || [],
                            estimatedTokens: nextStep.estimatedTokens,
                            priority: nextStep.priority || "medium",
                            agentWallet,
                        },
                        agentCard,
                        {
                            priorOutputs: previousOutputs.map(p => `${p.agentName}: ${p.summary}`),
                            relevantContext: relevantContext || undefined,
                        },
                        {
                            composeRunId: runId,
                            idempotencyKey: `${runId}:${nextStep.stepNumber}:${nextStep.agentName}`,
                            userId: options.userId,
                            threadId: options.threadId,
                            manowarWallet: walletAddress,
                        },
                    );

                    stepResults.push({
                        stepNumber: nextStep.stepNumber,
                        agentName: nextStep.agentName,
                        success: result.success,
                        output: result.output,
                    });

                    if (result.tokensUsed && result.tokensUsed > 0) {
                        planTokensUsed += result.tokensUsed;

                        const inputTokens = result.inputTokens ?? Math.floor(result.tokensUsed * 0.4);
                        const outputTokens = result.outputTokens ?? Math.floor(result.tokensUsed * 0.6);

                        const tokenUsage: TokenUsage = {
                            agentId: nextStep.agentName,
                            model: nextStep.agentModel || agentCard?.model || this.coordinatorModel,
                            inputTokens,
                            outputTokens,
                            totalTokens: result.tokensUsed,
                            timestamp: Date.now(),
                        };
                        this.contextManager.recordUsage(tokenUsage);

                        const contextState = this.contextManager.getState();
                        if (contextState.needsCleanup) {
                            console.log(`[orchestrator] Context at ${contextState.usagePercent.toFixed(1)}% - triggering safe wipe`);

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

                    const outputSummary = this.summarizeOutput(result.output);
                    previousOutputs.push({
                        agentName: nextStep.agentName,
                        agentWallet,
                        summary: outputSummary,
                    });

                    await recordConversationTurn(
                        walletAddress,
                        "assistant",
                        `${nextStep.agentName}: ${outputSummary}`,
                        nextStep.stepNumber,
                        runId
                    );

                    const MAX_CONTEXT_STEPS = 3;
                    if (previousOutputs.length > MAX_CONTEXT_STEPS) {
                        const recentOutputs = previousOutputs.slice(-MAX_CONTEXT_STEPS);
                        messages.length = 2;
                        for (const output of recentOutputs) {
                            messages.push({
                                role: "assistant",
                                content: `[${output.agentName}] ${output.summary}`,
                            });
                        }
                        console.log(`[orchestrator] Context isolated: keeping last ${MAX_CONTEXT_STEPS} steps, older outputs available via embeddings`);
                    } else {
                        messages.push({
                            role: "assistant",
                            content: `[${nextStep.agentName}] ${outputSummary}`,
                        });
                    }

                    if (result.success) {
                        successfulSteps.add(nextStep.stepNumber);
                    }

                    try {
                        const reflection = await planner.reflectOnStep(
                            nextStep.stepNumber,
                            result.output,
                            result.tokensUsed || 0
                        );
                        reflections.push(reflection);
                        if (!reflection.continueWithPlan && replanOnFailure) {
                            needsReplan = true;
                            break;
                        }

                        if (reflection.learnings.length > 0 || reflection.objectiveMetrics) {
                            await addMemoryWithGraph({
                                messages: [
                                    { role: "system", content: `Step ${nextStep.stepNumber} execution learning for ${walletAddress}` },
                                    {
                                        role: "assistant", content: JSON.stringify({
                                            step: nextStep.stepNumber,
                                            agent: nextStep.agentName,
                                            task: nextStep.task,
                                            qualityScore: reflection.qualityScore,
                                            learnings: reflection.learnings,
                                            objectiveMetrics: reflection.objectiveMetrics,
                                            actualTokens: reflection.actualTokensUsed,
                                            estimatedTokens: nextStep.estimatedTokens,
                                        })
                                    },
                                ],
                                agent_id: walletAddress,
                                run_id: runId,
                                metadata: {
                                    type: "execution_learning",
                                    step: nextStep.stepNumber,
                                    agent: nextStep.agentName,
                                    quality: reflection.qualityScore,
                                    tokenEfficiency: reflection.objectiveMetrics?.tokenEfficiency ?? 1,
                                    hasErrors: reflection.objectiveMetrics?.hasErrors ?? false,
                                },
                            });

                            if (isLangSmithEnabled()) {
                                await recordLearning(
                                    "manowar-execution-learnings",
                                    {
                                        goal: nextStep.task,
                                        agent: nextStep.agentName,
                                        step: nextStep.stepNumber,
                                        manowarWallet: walletAddress,
                                    },
                                    {
                                        output: result.output,
                                        qualityScore: reflection.qualityScore,
                                        learnings: reflection.learnings,
                                        tokenEfficiency: reflection.objectiveMetrics?.tokenEfficiency ?? 1,
                                    },
                                    {
                                        runId,
                                        step: nextStep.stepNumber,
                                        agent: nextStep.agentName,
                                        type: "step_learning",
                                    }
                                );

                                for (const learning of reflection.learnings) {
                                    recordInsight(runId, nextStep.agentName, nextStep.stepNumber, learning);
                                }
                            }

                            recordDecision(
                                runId,
                                "coordinator",
                                nextStep.stepNumber,
                                reflection.continueWithPlan ? "Continue with plan" : "Modify plan",
                                `Quality: ${reflection.qualityScore}/10`
                            );
                        }
                    } catch (reflectError) {
                        console.warn(`[orchestrator] Reflection failed for step ${nextStep.stepNumber}:`, reflectError);
                    }

                    this.emitProgress("progress", {
                        progress: stepProgress,
                        message: `Completed step ${executedCount}/${plan.steps.length}`,
                    });
                    runState = this.emitRunState(options, runState, {
                        status: "running",
                        progress: Math.min(98, Math.round(stepProgress)),
                        message: `Completed step ${executedCount}/${plan.steps.length}`,
                    });

                    if (!result.success) {
                        recordError(runId, nextStep.agentName, nextStep.stepNumber, result.error || "Step failed");
                    }

                    if (!result.success && nextStep.priority === "critical") {
                        needsReplan = replanOnFailure;
                        return { stepResults, reflections, planTokensUsed, needsReplan, previousOutputs };
                    }

                    if (!result.success && replanOnFailure) {
                        needsReplan = true;
                        break;
                    }
                }

                const skippedSteps = plan.steps.filter(s => !successfulSteps.has(s.stepNumber));
                if (skippedSteps.length > 0) {
                    console.warn(`[orchestrator] ${skippedSteps.length} steps were skipped due to unmet dependencies or failures`);
                    if (replanOnFailure) {
                        needsReplan = true;
                    }
                }

                if (reflections.some(r => !r.continueWithPlan) && replanOnFailure) {
                    needsReplan = true;
                }

                return { stepResults, reflections, planTokensUsed, needsReplan, previousOutputs };
            };

            while (true) {
                if (options.shouldCancel?.()) {
                    console.warn("[orchestrator] Continuous execution cancelled by user");
                    break;
                }
                loopIteration += 1;
                planIteration = 0;

                while (planIteration < maxPlanIterations) {
                    if (options.shouldCancel?.()) {
                        console.warn("[orchestrator] Execution cancelled by user");
                        break;
                    }
                    planIteration += 1;
                    const reviewerSuggestions = await planner.reviewBeforePlanning(
                        walletAddress,
                        userRequest
                    );

                    const plan = await planner.createPlan(
                        userRequest,
                        {
                            priorContext: priorContext || undefined,
                            attachmentUrl: options.attachmentUrl,
                            reviewerSuggestions,
                            completedSteps: completedStepsSummary.join("\n"),
                        },
                        walletAddress
                    );

                    if (!plan || plan.steps.length === 0) {
                        runState = this.emitRunState(options, runState, {
                            status: "error",
                            error: "Failed to create execution plan",
                            message: "Failed to create execution plan",
                        });
                        return {
                            success: false,
                            result: "",
                            stepResults: [],
                            totalTokensUsed: 0,
                            error: "Failed to create execution plan",
                        };
                    }

                    const validationIssues = planner.getPlanValidationIssues(plan);
                    if (validationIssues.length > 0) {
                        if (!replanOnFailure) {
                            const validationError = `Plan validation failed: ${validationIssues.map(i => i.message).join("; ")}`;
                            runState = this.emitRunState(options, runState, {
                                status: "error",
                                error: validationError,
                                message: validationError,
                            });
                            return {
                                success: false,
                                result: "",
                                stepResults: [],
                                totalTokensUsed: 0,
                                error: validationError,
                            };
                        }
                        console.warn(`[orchestrator] Plan validation failed, replanning (${validationIssues.length} issues)`);
                        continue;
                    }

                    console.log(`[orchestrator] Created plan with ${plan.steps.length} steps (iteration ${planIteration}/${maxPlanIterations})`);
                    this.emitProgress("progress", {
                        progress: 15,
                        message: `Plan created: ${plan.steps.length} steps`,
                    });

                    const planResult = await runPlan(plan);
                    allStepResults.push(...planResult.stepResults);
                    allReflections.push(...planResult.reflections);
                    totalTokensUsed += planResult.planTokensUsed;
                    lastOutputs = planResult.previousOutputs.map(p => ({ agentName: p.agentName, summary: p.summary }));

                    for (const stepResult of planResult.stepResults) {
                        const summary = stepResult.success ? "Completed" : "Failed";
                        completedStepsSummary.push(`${summary}: ${stepResult.stepNumber}:${stepResult.agentName}`);
                    }

                    if (!planResult.needsReplan) {
                        break;
                    }
                }

                if (!continuous || loopIteration >= maxLoopIterations) {
                    break;
                }
                if (loopDelayMs > 0) {
                    await new Promise(resolve => setTimeout(resolve, loopDelayMs));
                }
            }

            if (!finalResult) {
                finalResult = this.compileFinalResult(allStepResults);
            }
            if (options.synthesizeFinal === true) {
                try {
                    finalResult = await this.synthesizeFinalResult(
                        userRequest,
                        allStepResults,
                        lastOutputs,
                        runSystemPrompt
                    );
                } catch (synthError) {
                    console.warn("[orchestrator] Synthesis failed, using last successful output:", synthError);
                }
            }

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
                    step_count: allStepResults.length,
                    success_count: allStepResults.filter(s => s.success).length,
                },
            });

            // === EVALUATION STORAGE ===
            // Store workflow evaluation for multi-loop improvement
            const successRate = allStepResults.filter(s => s.success).length / Math.max(1, allStepResults.length);
            const avgQuality = allReflections.length > 0
                ? allReflections.reduce((sum, r) => sum + r.qualityScore, 0) / allReflections.length
                : successRate * 10;
            const evaluation = {
                runId,
                goal: userRequest,
                successRate,
                totalTokensUsed,
                stepCount: allStepResults.length,
                qualityScore: Math.round(avgQuality),
                timestamp: Date.now(),
            };

            // Mem0 storage (for graph retrieval)
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

            // LangSmith evaluation recording
            if (isLangSmithEnabled()) {
                await recordLearning(
                    "manowar-workflow-evaluations",  // dataset name
                    {  // input
                        goal: userRequest,
                        manowarWallet: walletAddress,
                        stepCount: allStepResults.length,
                    },
                    {  // output
                        success: true,
                        successRate,
                        qualityScore: evaluation.qualityScore,
                        totalTokensUsed,
                        stepResults: allStepResults.map(s => ({
                            step: s.stepNumber,
                            agent: s.agentName,
                            success: s.success,
                        })),
                    },
                    {  // metadata
                        runId,
                        type: "workflow_evaluation",
                        qualityScore: evaluation.qualityScore,
                    }
                );

                // Persist all checkpoints to LangSmith feedback
                // Note: runId is used as langsmithRunId when LangSmith tracing is active
                await persistCheckpoints(runId, walletAddress, runId);
            }

            console.log(`[orchestrator] Evaluation stored: quality=${evaluation.qualityScore}/10, tokens=${totalTokensUsed}`);

            // Complete the tracked run with metrics
            completeRun(runId, { result: finalResult }, {
                totalTokens: totalTokensUsed,
                inputTokens: Math.floor(totalTokensUsed * 0.4),
                outputTokens: Math.floor(totalTokensUsed * 0.6),
                reasoningTokens: 0,
            });

            this.emitProgress("result", { output: finalResult });
            this.emitProgress("done", { message: "Workflow completed successfully" });
            runState = this.emitRunState(options, runState, {
                status: "success",
                progress: 100,
                message: "Workflow completed successfully",
                output: finalResult,
            });

            return {
                success: true,
                result: finalResult,
                stepResults: allStepResults,
                totalTokensUsed,
            };

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error("[orchestrator] Execution error:", error);

            // Fail the tracked run
            failRun(runId, errorMessage);

            this.emitProgress("error", { error: errorMessage });
            this.emitProgress("done", { message: "Workflow failed" });
            runState = this.emitRunState(options, runState, {
                status: "error",
                error: errorMessage,
                message: "Workflow failed",
            });

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
     * Synthesize a final response from step outputs using coordinator model
     */
    private async synthesizeFinalResult(
        goal: string,
        stepResults: OrchestratorResult["stepResults"],
        previousOutputs: Array<{ agentName: string; summary: string }>,
        systemPromptOverride?: string
    ): Promise<string> {
        const successfulSteps = stepResults.filter(s => s.success);
        if (successfulSteps.length === 0) {
            return "No steps completed successfully.";
        }

        const model = createModel(this.coordinatorModel, 0.2);
        const summaries = previousOutputs
            .map(p => `- ${p.agentName}: ${p.summary}`)
            .join("\n");

        const synthesisPrompt = `You are the workflow coordinator. Synthesize the final response for the user.

USER GOAL:
${goal}

STEP SUMMARIES:
${summaries || "No summaries available"}

RESPONSE RULES:
- Provide the final deliverable only (no internal process)
- If information is missing, explicitly note gaps
- Do NOT mention tools or internal agents
`;

        const response = await model.invoke(
            [
                new SystemMessage(systemPromptOverride || this.systemPrompt),
                new HumanMessage(synthesisPrompt),
            ]
        );

        const content = String(response.content || "").trim();
        return content || successfulSteps[successfulSteps.length - 1].output;
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
    return orchestrator.execute(userRequest, { synthesizeFinal: false, ...options });
}
