/**
 * Manowar Planner - Task Decomposition & Planning Node
 * 
 * Implements the Plan → Act → Reflect pattern for enterprise-grade orchestration.
 * 
 * Key Responsibilities:
 * - Decompose user goals into actionable steps
 * - Match steps to available agents
 * - Generate structured execution plans
 * - Support iterative plan refinement
 * - Review past executions before planning (multi-loop improvement)
 * 
 * Based on Manus Context Engineering principles (Jan 2026)
 */

import { createModel } from "../frameworks/langchain.js";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { Workflow, AgentCard, WorkflowStep } from "./types.js";
import { searchMemoryWithGraph, addMemoryWithGraph, getAgentReliability } from "./memory.js";
import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { discoverAgentTools, type DiscoveredTool } from "./registry.js";
import { isLangSmithEnabled, getRelevantLearnings } from "./langsmith.js";

// =============================================================================
// Planning Types
// =============================================================================

/**
 * A single step in the execution plan
 */
export interface PlanStep {
    /** Step number (1-indexed) */
    stepNumber: number;
    /** Target agent name */
    agentName: string;
    /** Agent wallet address (optional, for reliable lookup when name is fallback) */
    agentWallet?: string;
    /** Agent model ID (informational for routing/context) */
    agentModel?: string;
    /** Specific task to delegate */
    task: string;
    /** Expected output format */
    expectedOutput: string;
    /** Dependencies on previous steps (step numbers) */
    dependsOn: number[];
    /** Estimated token cost */
    estimatedTokens: number;
    /** Priority: critical | high | medium | low */
    priority: "critical" | "high" | "medium" | "low";
}

/**
 * Complete execution plan
 */
export interface ExecutionPlan {
    /** Unique plan ID */
    planId: string;
    /** Original user goal */
    goal: string;
    /** Plan version (for refinement) */
    version: number;
    /** Ordered steps */
    steps: PlanStep[];
    /** Total estimated tokens */
    totalEstimatedTokens: number;
    /** Plan generation timestamp */
    createdAt: number;
    /** Whether plan has been validated */
    validated: boolean;
    /** Validation notes */
    validationNotes?: string;
}

export interface PlanValidationIssue {
    type: "missing_agent" | "invalid_agent" | "invalid_dependency" | "cycle";
    message: string;
    stepNumber?: number;
}

/**
 * Reflection output after step completion
 */
export interface StepReflection {
    /** Step that was just completed */
    stepNumber: number;
    /** Whether step succeeded */
    success: boolean;
    /** Quality score 0-10 (calibrated with objective metrics) */
    qualityScore: number;
    /** Key learnings */
    learnings: string[];
    /** Whether to continue with original plan */
    continueWithPlan: boolean;
    /** Suggested plan modifications (if any) */
    planModifications?: string[];
    /** Tokens actually used (from LangSmith) */
    actualTokensUsed: number;
    /** Objective metrics from LangSmith for score calibration */
    objectiveMetrics?: ObjectiveMetrics;
}

/**
 * Objective metrics from LangSmith for reflection calibration
 */
export interface ObjectiveMetrics {
    /** Token efficiency: ratio of estimated to actual (1.0 = perfect) */
    tokenEfficiency: number;
    /** Whether output contains error indicators */
    hasErrors: boolean;
    /** Whether output matches expected format hints */
    matchesExpectedFormat: boolean;
    /** Output length in characters */
    outputLength: number;
}

/**
 * Reviewer suggestions from past executions (for multi-loop improvement)
 */
export interface ReviewerSuggestions {
    /** Whether there are past executions to review */
    hasPastExecutions: boolean;
    /** Quality score from past runs (average) */
    pastQualityScore?: number;
    /** Suggestions to improve this run */
    suggestions: string[];
    /** Patterns that worked well */
    successPatterns: string[];
    /** Patterns to avoid */
    avoidPatterns: string[];
    /** Skip planning delay (true on first run) */
    skipReview: boolean;
}

// =============================================================================
// Planning Prompts (Stable - Cache Friendly)
// =============================================================================

/**
 * Stable system prompt for the Reviewer - optimized for KV-cache efficiency
 * Reviews past executions and suggests improvements before planning
 */
const reviewerSystemPrompt = `You are the WORKFLOW REVIEWER for a multi-agent orchestration system.

Your role is to review past workflow evaluations and suggest improvements for the upcoming execution.

RULES:
1. Identify patterns from successful past runs (quality score > 7)
2. Identify anti-patterns from failed runs (quality score < 5)
3. Suggest concrete, actionable improvements
4. Be concise - the planner needs quick, actionable feedback
5. If no past evaluations, return empty suggestions

OUTPUT FORMAT (JSON):
{
  "hasPastExecutions": true,
  "pastQualityScore": 8.2,
  "suggestions": ["Use Agent X for research tasks - higher success rate"],
  "successPatterns": ["Breaking complex goals into 3-4 steps works best"],
  "avoidPatterns": ["Avoid chaining more than 5 steps without checkpoint"]
}`;

/**
 * Stable system prompt for the planner - optimized for KV-cache efficiency
 * This prompt NEVER changes during workflow execution
 */
const plannerSystemPrompt = `You are the TASK PLANNER for a multi-agent orchestration system.

Your role is to decompose a user's goal into specific, actionable steps that can be delegated to specialized agents.

RULES:
1. Each step must target exactly ONE agent
2. Steps must be atomic - completable in a single agent call
3. Order steps by dependency (earlier steps feed later steps)
4. Be specific about what each agent should produce
5. Estimate token cost based on task complexity (simple: 500-2000, medium: 2000-5000, complex: 5000-10000)
6. Mark critical steps that cannot fail
7. You MUST use an agent from the provided list (do not invent agents)
8. You MUST include the exact agentWallet for each step (from the provided list)
9. Prefer agents whose listed tools/plugins match the task requirements

OUTPUT FORMAT (JSON):
{
  "goal_understanding": "Brief restatement of the goal",
  "steps": [
    {
      "stepNumber": 1,
      "agentName": "ExactAgentName",
      "agentWallet": "0xAgentWallet",
      "task": "Specific task description",
      "expectedOutput": "What the agent should return",
      "dependsOn": [],
      "estimatedTokens": 20000,
      "priority": "critical"
    }
  ],
  "total_estimated_tokens": 80000
}`;

/**
 * Stable system prompt for the reflector - optimized for KV-cache efficiency
 */
const reflectorSystemPrompt = `You are the STEP REFLECTOR for a multi-agent orchestration system.

Your role is to evaluate the output of a completed step and determine:
1. Whether the step succeeded
2. Quality of the output (0-10)
3. Key learnings to carry forward
4. Whether to continue with the current plan or modify it

RULES:
1. Be objective in quality assessment
2. Identify actionable learnings
3. Only suggest plan modifications if truly necessary
4. Consider token efficiency in recommendations

OUTPUT FORMAT (JSON):
{
  "success": true,
  "qualityScore": 8,
  "learnings": ["Key finding 1", "Key finding 2"],
  "continueWithPlan": true,
  "planModifications": null
}`;

// =============================================================================
// Planner Class
// =============================================================================

export class TaskPlanner {
    private model: ReturnType<typeof createModel>;
    private workflow: Workflow;
    private agentCards?: AgentCard[];
    private coordinationContext?: string;
    private workflowEdges: Array<{ sourceKey: string; targetKey: string; label?: string }> = [];
    private currentPlan: ExecutionPlan | null = null;
    private callbacks: BaseCallbackHandler[];

    /**
     * @param workflow - The workflow definition
     * @param plannerModel - Model assigned by coordinator from coordinatorModels
     * @param callbacks - Optional LangChain callbacks for token tracking
     * @param agentCards - Optional agent cards from manowarCard (preferred source for agent info)
     */
    constructor(
        workflow: Workflow,
        plannerModel: string,
        callbacks: BaseCallbackHandler[] = [],
        agentCards?: AgentCard[]
    ) {
        this.workflow = workflow;
        this.callbacks = callbacks;
        this.agentCards = agentCards;

        if (!plannerModel) {
            throw new Error("plannerModel is required - must be assigned by coordinator from coordinatorModels");
        }

        console.log(`[planner] Using coordinator-assigned model: ${plannerModel}`);
        if (agentCards?.length) {
            console.log(`[planner] Received ${agentCards.length} agent cards: ${agentCards.map(a => a.name).join(", ")}`);
        }

        // Use createModel() for proper provider routing (OpenRouter, AI/ML, etc.)
        this.model = createModel(plannerModel, 0.2);
    }

    /**
     * Provide coordinator context (manowar card + workflow graph + user request)
     */
    setCoordinationContext(context: string): void {
        this.coordinationContext = context;
    }

    /**
     * Provide workflow graph constraints for planning (edges enforce order)
     */
    setWorkflowGraph(params: { agents?: AgentCard[]; steps?: WorkflowStep[]; edges?: Array<{ source: number; target: number; label?: string }> }): void {
        const agents = params.agents?.length ? params.agents : undefined;
        const steps = params.steps?.length ? params.steps : undefined;
        const edges = params.edges || [];

        const indexToKey = (idx: number): string | null => {
            const fromAgents = agents?.[idx];
            if (fromAgents?.walletAddress) return fromAgents.walletAddress.toLowerCase();
            if (fromAgents?.name) return fromAgents.name.toLowerCase();
            const fromSteps = steps?.[idx];
            if (fromSteps?.agentAddress) return fromSteps.agentAddress.toLowerCase();
            if (fromSteps?.name) return fromSteps.name.toLowerCase();
            return null;
        };

        this.workflowEdges = edges
            .map((e) => {
                const sourceKey = indexToKey(e.source);
                const targetKey = indexToKey(e.target);
                if (!sourceKey || !targetKey) return null;
                return { sourceKey, targetKey, label: e.label };
            })
            .filter(Boolean) as Array<{ sourceKey: string; targetKey: string; label?: string }>;
    }

    /**
     * Get available agents - prefers agentCards from manowarCard (IPFS source of truth),
     * falls back to workflow steps if not provided.
     */
    /**
     * Get available agents with discovered tools for planning visibility.
     * Tools are discovered via connector service on-demand.
     * Includes reliability scores from past execution learnings.
     * 
     * @param manowarWallet - Optional wallet for reliability lookups
     */
    private async getAvailableAgentsWithTools(manowarWallet?: string): Promise<{
        name: string;
        description: string;
        capabilities: string[];
        walletAddress?: string;
        model?: string;
        plugins?: Array<{ name: string; registryId?: string; origin?: string }>;
        protocols?: Array<{ name: string; version: string }>;
        tools: DiscoveredTool[];
        reliability?: { avgQuality: number; successRate: number; totalRuns: number };
    }[]> {
        // Prefer agentCards from manowarCard (contains correct names from IPFS)
        if (this.agentCards?.length) {
            return Promise.all(this.agentCards.map(async (agent) => {
                // Discover tools for this agent's plugins
                const tools = await discoverAgentTools(agent as any, "registry");

                // Get reliability from past executions (if manowarWallet provided)
                let reliability: { avgQuality: number; successRate: number; totalRuns: number } | undefined;
                if (manowarWallet) {
                    try {
                        const rel = await getAgentReliability(manowarWallet, agent.name);
                        if (rel.totalRuns > 0) {
                            reliability = {
                                avgQuality: Math.round(rel.avgQuality * 10) / 10,
                                successRate: Math.round(rel.successRate * 100) / 100,
                                totalRuns: rel.totalRuns,
                            };
                        }
                    } catch {
                        // Non-fatal: continue without reliability data
                    }
                }

                return {
                    name: agent.name,
                    description: agent.description || "Specialized agent",
                    capabilities: agent.skills || [],
                    walletAddress: agent.walletAddress,
                    model: agent.model,
                    plugins: agent.plugins || [],
                    protocols: agent.protocols || [],
                    tools,
                    reliability,
                };
            }));
        }

        // Fallback to workflow steps (may have fallback names) - no tool discovery
        return this.workflow.steps
            .filter(s => s.type === "agent")
            .map(s => ({
                name: s.name,
                description: (s.inputTemplate?.description as string) || "Specialized agent",
                capabilities: Array.isArray(s.inputTemplate?.skills)
                    ? s.inputTemplate.skills as string[]
                    : [],
                walletAddress: s.agentAddress || (s.inputTemplate as { agentAddress?: string })?.agentAddress,
                model: (s.inputTemplate as { model?: string })?.model,
                plugins: Array.isArray((s.inputTemplate as { plugins?: unknown })?.plugins)
                    ? (s.inputTemplate as { plugins?: Array<{ name: string; registryId?: string; origin?: string }> }).plugins
                    : [],
                protocols: Array.isArray((s.inputTemplate as { protocols?: unknown })?.protocols)
                    ? (s.inputTemplate as { protocols?: Array<{ name: string; version: string }> }).protocols
                    : [],
                tools: [] as DiscoveredTool[],
            }));
    }

    /**
     * Review past executions before planning (multi-loop improvement)
     * 
     * Skippable on first run when there are no past evaluations.
     * Returns suggestions to improve the upcoming execution.
     * 
     * @param manowarWallet - The manowar wallet for Mem0 lookup
     * @param goal - The current goal (for relevance matching)
     * @returns ReviewerSuggestions with improvements or skipReview=true
     */
    async reviewBeforePlanning(
        manowarWallet: string,
        goal: string
    ): Promise<ReviewerSuggestions> {
        // Query LangSmith datasets for past workflow evaluations (primary)
        let langsmithLearnings: Array<{ inputs: Record<string, unknown>; outputs: Record<string, unknown> }> = [];
        if (isLangSmithEnabled()) {
            langsmithLearnings = await getRelevantLearnings(
                "manowar-workflow-evaluations",
                5 // limit
            );
        }

        // Search Mem0 for past evaluations (fallback/supplementary)
        const pastEvaluations = await searchMemoryWithGraph({
            query: `workflow evaluation quality score success rate ${goal}`,
            agent_id: manowarWallet,
            limit: 5,
            options: {
                rerank: true,
                keyword_search: true,
            },
        });

        // If no past evaluations from either source, skip review (first run)
        const hasMem0Evaluations = pastEvaluations.memories && pastEvaluations.memories.length > 0;
        const hasLangSmithLearnings = langsmithLearnings.length > 0;

        if (!hasMem0Evaluations && !hasLangSmithLearnings) {
            console.log(`[planner] No past evaluations found - skipping review (first run)`);
            return {
                hasPastExecutions: false,
                suggestions: [],
                successPatterns: [],
                avoidPatterns: [],
                skipReview: true,
            };
        }

        // Combine evaluations from both sources
        const mem0Summary = hasMem0Evaluations
            ? pastEvaluations.memories!.map(m => m.memory).join("\n---\n")
            : "";
        const langsmithSummary = hasLangSmithLearnings
            ? langsmithLearnings.map(l => JSON.stringify({ ...l.inputs, ...l.outputs }, null, 2)).join("\n---\n")
            : "";

        const evaluationSummary = [
            mem0Summary && `### From Memory Store:\n${mem0Summary}`,
            langsmithSummary && `### From LangSmith Datasets:\n${langsmithSummary}`,
        ].filter(Boolean).join("\n\n");

        const response = await this.model.invoke(
            [
                new SystemMessage(reviewerSystemPrompt),
                new HumanMessage(`## PAST WORKFLOW EVALUATIONS
${evaluationSummary}

## UPCOMING GOAL
"${goal}"

Review the past evaluations and suggest improvements for the upcoming execution.`),
            ],
            { callbacks: this.callbacks }
        );

        // Parse the response
        const content = String(response.content);
        try {
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                throw new Error("No JSON found in reviewer response");
            }
            const parsed = JSON.parse(jsonMatch[0]);

            console.log(`[planner] Reviewer found ${pastEvaluations.memories.length} past evaluations, avg quality: ${parsed.pastQualityScore || "N/A"}`);

            return {
                hasPastExecutions: true,
                pastQualityScore: parsed.pastQualityScore,
                suggestions: parsed.suggestions || [],
                successPatterns: parsed.successPatterns || [],
                avoidPatterns: parsed.avoidPatterns || [],
                skipReview: false,
            };
        } catch (err) {
            console.warn("[planner] Failed to parse reviewer response, proceeding without suggestions");
            return {
                hasPastExecutions: true,
                pastQualityScore: undefined,
                suggestions: [],
                successPatterns: [],
                avoidPatterns: [],
                skipReview: false,
            };
        }
    }

    /**
     * Generate an execution plan for the given goal
     * 
     * @param goal - The user's stated goal
     * @param context - Additional context (attachments, prior results)
     * @param manowarWallet - Optional wallet for reliability lookups
     * @returns Complete execution plan
     */
    async createPlan(
        goal: string,
        context?: {
            attachmentUrl?: string;
            priorContext?: string;
            reviewerSuggestions?: ReviewerSuggestions;
            completedSteps?: string;
        },
        manowarWallet?: string
    ): Promise<ExecutionPlan> {
        const agents = await this.getAvailableAgentsWithTools(manowarWallet);

        const coordinationContext = this.coordinationContext
            ? `## COORDINATION CONTEXT (authoritative)
${this.coordinationContext}
`
            : "";

        const graphContext = this.workflowEdges.length > 0
            ? `## WORKFLOW GRAPH CONSTRAINTS
${this.workflowEdges.map((e, i) => `${i + 1}. ${e.sourceKey} -> ${e.targetKey}${e.label ? ` (${e.label})` : ""}`).join("\n")}
`
            : "";

        const reviewContext = context?.reviewerSuggestions && !context.reviewerSuggestions.skipReview
            ? `## REVIEWER SUGGESTIONS (from past runs)
Quality: ${context.reviewerSuggestions.pastQualityScore ?? "N/A"}
Suggestions: ${context.reviewerSuggestions.suggestions.join("; ") || "None"}
Success Patterns: ${context.reviewerSuggestions.successPatterns.join("; ") || "None"}
Avoid Patterns: ${context.reviewerSuggestions.avoidPatterns.join("; ") || "None"}
`
            : "";

        const completedContext = context?.completedSteps
            ? `## COMPLETED STEPS (do NOT redo these)
${context.completedSteps}
`
            : "";

        // Build the planning prompt with dynamic content AFTER stable prefix
        // This preserves KV-cache on the system prompt
        // Now includes discovered tools AND reliability scores for informed delegation
        const userPrompt = `${coordinationContext}${graphContext}${reviewContext}${completedContext}## AVAILABLE AGENTS
${agents.map((a, i) => {
            const reliabilityInfo = a.reliability
                ? `\n   Reliability: ${(a.reliability.successRate * 100).toFixed(0)}% success over ${a.reliability.totalRuns} runs (avg ${a.reliability.avgQuality}/10)`
                : "";
            const toolInfo = a.tools.length > 0
                ? a.tools.map(t => `\`${t.name}\`${t.description ? ` - ${t.description}` : ""}`).join(", ")
                : "none";
            const pluginInfo = a.plugins && a.plugins.length > 0
                ? a.plugins.map(p => `${p.name}${p.registryId ? ` (${p.registryId})` : ""}`).join(", ")
                : "none";
            const protocolInfo = a.protocols && a.protocols.length > 0
                ? a.protocols.map(p => `${p.name}@${p.version}`).join(", ")
                : "none";
            return `${i + 1}. **${a.name}** (${a.walletAddress || "no-wallet"})
   Model: ${a.model || "unknown"}
   Description: ${a.description}
   Capabilities: ${a.capabilities.length > 0 ? a.capabilities.join(", ") : "General purpose"}
   Tools: ${toolInfo}
   Plugins: ${pluginInfo}
   Protocols: ${protocolInfo}${reliabilityInfo}`;
        }).join("\n")}

## USER GOAL
"${goal}"
${context?.attachmentUrl ? `\n[Attachment: ${context.attachmentUrl}]` : ""}
${context?.priorContext ? `\n## PRIOR CONTEXT\n${context.priorContext}` : ""}

Create an execution plan for this goal`;

        const response = await this.model.invoke(
            [
                new SystemMessage(plannerSystemPrompt),
                new HumanMessage(userPrompt),
            ],
            { callbacks: this.callbacks }
        );

        // Parse the response
        const content = String(response.content);
        let parsed: any;

        try {
            // Extract JSON from response (may be wrapped in markdown)
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                throw new Error("No JSON found in planner response");
            }
            parsed = JSON.parse(jsonMatch[0]);
        } catch (err) {
            console.error("[planner] Failed to parse plan response:", content);
            throw err;
        }

        const agentByWallet = new Map<string, typeof agents[number]>();
        const agentByName = new Map<string, typeof agents[number]>();
        for (const agent of agents) {
            if (agent.walletAddress) {
                agentByWallet.set(agent.walletAddress.toLowerCase(), agent);
            }
            agentByName.set(agent.name.toLowerCase(), agent);
        }

        const normalizeEstimatedTokens = (value: number | undefined): number => {
            const numeric = Number.isFinite(value) ? Number(value) : 2000;
            return Math.min(20000, Math.max(200, Math.round(numeric)));
        };

        // Build the execution plan
        const plan: ExecutionPlan = {
            planId: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            goal,
            version: 1,
            steps: (parsed.steps || []).map((s: any, idx: number) => {
                const requestedWallet = typeof s.agentWallet === "string" ? s.agentWallet : undefined;
                const requestedName = typeof s.agentName === "string" ? s.agentName : undefined;
                const resolvedAgent = requestedWallet
                    ? agentByWallet.get(requestedWallet.toLowerCase())
                    : requestedName
                        ? agentByName.get(requestedName.toLowerCase())
                        : undefined;
                const agent = resolvedAgent;

                return {
                    stepNumber: s.stepNumber || idx + 1,
                    agentName: agent?.name || requestedName || "Unknown",
                    agentWallet: agent?.walletAddress || requestedWallet,
                    agentModel: agent?.model,
                    task: s.task || goal,
                    expectedOutput: s.expectedOutput || "Task result",
                    dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : [],
                    estimatedTokens: normalizeEstimatedTokens(s.estimatedTokens),
                    priority: s.priority || "medium",
                };
            }),
            totalEstimatedTokens: parsed.total_estimated_tokens ||
                (parsed.steps?.reduce((sum: number, s: any) => sum + normalizeEstimatedTokens(s.estimatedTokens), 0) || 10000),
            createdAt: Date.now(),
            validated: false,
        };

        // Enforce workflow graph constraints if available
        this.applyGraphConstraints(plan);

        // Validate the plan
        plan.validated = this.validatePlan(plan);
        this.currentPlan = plan;

        console.log(`[planner] Created plan with ${plan.steps.length} steps, estimated ${plan.totalEstimatedTokens} tokens`);
        return plan;
    }

    /**
     * Validate that the plan is executable
     */
    private validatePlan(plan: ExecutionPlan): boolean {
        const issues = this.getPlanValidationIssues(plan);
        if (issues.length === 0) return true;
        console.warn(`[planner] Plan validation failed: ${issues.map(i => i.message).join(" | ")}`);
        return false;
    }

    getPlanValidationIssues(plan: ExecutionPlan): PlanValidationIssue[] {
        const issues: PlanValidationIssue[] = [];
        const validAgentNames = new Set(
            this.agentCards?.length
                ? this.agentCards.map(a => a.name)
                : this.workflow.steps.filter(s => s.type === "agent").map(s => s.name)
        );
        const validAgentWallets = new Set(
            this.agentCards?.length
                ? this.agentCards.map(a => a.walletAddress?.toLowerCase()).filter(Boolean) as string[]
                : this.workflow.steps
                    .filter(s => s.type === "agent")
                    .map(s => (s.agentAddress || (s.inputTemplate as { agentAddress?: string })?.agentAddress)?.toLowerCase())
                    .filter(Boolean) as string[]
        );

        for (const step of plan.steps) {
            const wallet = step.agentWallet?.toLowerCase();
            if (!wallet) {
                issues.push({
                    type: "missing_agent",
                    message: `Missing agentWallet for step ${step.stepNumber} (${step.agentName})`,
                    stepNumber: step.stepNumber,
                });
                continue;
            }
            if (wallet && validAgentWallets.has(wallet)) {
                const byWallet = this.agentCards?.find(a => a.walletAddress?.toLowerCase() === wallet);
                if (byWallet && step.agentName !== byWallet.name) {
                    step.agentName = byWallet.name;
                }
                continue;
            }
            if (!validAgentNames.has(step.agentName)) {
                console.warn(`[planner] Invalid agent name in plan: ${step.agentName}`);
                issues.push({
                    type: "invalid_agent",
                    message: `Invalid agent name: ${step.agentName}`,
                    stepNumber: step.stepNumber,
                });
            }
        }

        // Check dependencies are valid
        const stepNumbers = new Set(plan.steps.map(s => s.stepNumber));
        for (const step of plan.steps) {
            for (const dep of step.dependsOn) {
                if (!stepNumbers.has(dep) || dep >= step.stepNumber) {
                    console.warn(`[planner] Invalid dependency in plan: step ${step.stepNumber} depends on ${dep}`);
                    issues.push({
                        type: "invalid_dependency",
                        message: `Invalid dependency: step ${step.stepNumber} depends on ${dep}`,
                        stepNumber: step.stepNumber,
                    });
                }
            }
        }

        return issues;
    }

    /**
     * Apply graph constraints to enforce required ordering dependencies
     */
    private applyGraphConstraints(plan: ExecutionPlan): void {
        if (this.workflowEdges.length === 0 || plan.steps.length === 0) {
            return;
        }

        const agentKeyForStep = (step: PlanStep): string =>
            (step.agentWallet || step.agentName).toLowerCase();

        const stepByKey = new Map<string, PlanStep>();
        const keyByStepNumber = new Map<number, string>();
        for (const step of plan.steps) {
            const key = agentKeyForStep(step);
            stepByKey.set(key, step);
            keyByStepNumber.set(step.stepNumber, key);
        }

        // Merge dependencies from workflow edges into plan
        for (const edge of this.workflowEdges) {
            const sourceStep = stepByKey.get(edge.sourceKey);
            const targetStep = stepByKey.get(edge.targetKey);
            if (!sourceStep || !targetStep) continue;
            if (!targetStep.dependsOn.includes(sourceStep.stepNumber)) {
                targetStep.dependsOn.push(sourceStep.stepNumber);
            }
        }

        // Topological sort by dependencies
        const inDegree = new Map<string, number>();
        const adjacency = new Map<string, Set<string>>();
        for (const step of plan.steps) {
            const key = agentKeyForStep(step);
            inDegree.set(key, 0);
            adjacency.set(key, new Set());
        }

        for (const step of plan.steps) {
            const targetKey = agentKeyForStep(step);
            for (const dep of step.dependsOn) {
                const sourceKey = keyByStepNumber.get(dep);
                if (!sourceKey || sourceKey === targetKey) continue;
                adjacency.get(sourceKey)?.add(targetKey);
                inDegree.set(targetKey, (inDegree.get(targetKey) || 0) + 1);
            }
        }

        const queue: string[] = [];
        for (const [key, degree] of inDegree.entries()) {
            if (degree === 0) queue.push(key);
        }

        const orderedKeys: string[] = [];
        while (queue.length > 0) {
            const key = queue.shift()!;
            orderedKeys.push(key);
            for (const neighbor of adjacency.get(key) || []) {
                const nextDegree = (inDegree.get(neighbor) || 0) - 1;
                inDegree.set(neighbor, nextDegree);
                if (nextDegree === 0) queue.push(neighbor);
            }
        }

        if (orderedKeys.length !== plan.steps.length) {
            console.warn("[planner] Graph constraint ordering detected a cycle; leaving original order");
            return;
        }

        const orderedSteps = orderedKeys
            .map(key => stepByKey.get(key))
            .filter(Boolean) as PlanStep[];

        const newStepNumberByKey = new Map<string, number>();
        orderedSteps.forEach((step, idx) => {
            const key = agentKeyForStep(step);
            newStepNumberByKey.set(key, idx + 1);
        });

        for (const step of orderedSteps) {
            const mappedDeps = step.dependsOn
                .map(dep => keyByStepNumber.get(dep))
                .filter(Boolean)
                .map(key => newStepNumberByKey.get(key as string)!)
                .filter(Boolean);
            step.dependsOn = Array.from(new Set(mappedDeps)).sort((a, b) => a - b);
        }

        orderedSteps.forEach((step, idx) => {
            step.stepNumber = idx + 1;
        });

        plan.steps = orderedSteps;
    }

    /**
     * Reflect on a completed step and determine next action
     * 
     * @param stepNumber - The step that just completed
     * @param stepOutput - The output from the step
     * @param tokensUsed - Actual tokens consumed
     * @returns Reflection with recommendations
     */
    async reflectOnStep(
        stepNumber: number,
        stepOutput: string,
        tokensUsed: number
    ): Promise<StepReflection> {
        if (!this.currentPlan) {
            throw new Error("No plan exists to reflect on");
        }

        const step = this.currentPlan.steps.find(s => s.stepNumber === stepNumber);
        if (!step) {
            throw new Error(`Step ${stepNumber} not found in plan`);
        }

        // Calculate OBJECTIVE metrics from real LangSmith data (no hardcoded estimates)
        const objectiveMetrics = this.calculateObjectiveMetrics(
            stepOutput,
            step.expectedOutput,
            tokensUsed,
            step.estimatedTokens
        );

        // Truncate output to save tokens for LLM reflection
        const truncatedOutput = stepOutput.length > 1000
            ? stepOutput.slice(0, 1000) + "... [truncated]"
            : stepOutput;

        // Include objective metrics in the reflection prompt
        const userPrompt = `## COMPLETED STEP
Step ${stepNumber}: ${step.agentName}
Task: ${step.task}
Expected: ${step.expectedOutput}

## ACTUAL OUTPUT
${truncatedOutput}

## OBJECTIVE METRICS (from LangSmith - use these for calibration)
- Token Efficiency: ${(objectiveMetrics.tokenEfficiency * 100).toFixed(1)}% (estimated: ${step.estimatedTokens}, actual: ${tokensUsed})
- Errors Detected: ${objectiveMetrics.hasErrors ? "YES - output contains error indicators" : "No"}
- Format Match: ${objectiveMetrics.matchesExpectedFormat ? "Yes" : "No match found"}
- Output Length: ${objectiveMetrics.outputLength} chars

## REMAINING STEPS
${this.currentPlan.steps
                .filter(s => s.stepNumber > stepNumber)
                .map(s => `${s.stepNumber}. ${s.agentName}: ${s.task}`)
                .join("\n") || "None - this was the last step"}

Evaluate this step. Your quality score MUST be calibrated against the objective metrics above.`;

        const response = await this.model.invoke(
            [
                new SystemMessage(reflectorSystemPrompt),
                new HumanMessage(userPrompt),
            ],
            { callbacks: this.callbacks }
        );

        const content = String(response.content);
        let parsed: any;

        try {
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error("No JSON");
            parsed = JSON.parse(jsonMatch[0]);
        } catch {
            // Calculate an objective score instead of hardcoded
            const objectiveScore = this.calculateObjectiveScore(objectiveMetrics);
            parsed = {
                success: !objectiveMetrics.hasErrors,
                qualityScore: objectiveScore,
                learnings: objectiveMetrics.hasErrors
                    ? ["Step completed with errors"]
                    : ["Step completed successfully"],
                continueWithPlan: !objectiveMetrics.hasErrors,
            };
        }

        // Calibrate LLM score with objective metrics (prevent inflation)
        const calibratedScore = this.calibrateScore(
            parsed.qualityScore ?? 6,
            objectiveMetrics
        );

        const rawSuccess = parsed.success ?? !objectiveMetrics.hasErrors;
        const calibratedSuccess = rawSuccess && !objectiveMetrics.hasErrors && objectiveMetrics.outputLength > 20;

        const reflection: StepReflection = {
            stepNumber,
            success: calibratedSuccess,
            qualityScore: calibratedScore,
            learnings: Array.isArray(parsed.learnings) ? parsed.learnings : [],
            continueWithPlan: parsed.continueWithPlan ?? calibratedSuccess,
            planModifications: Array.isArray(parsed.planModifications) ? parsed.planModifications : undefined,
            actualTokensUsed: tokensUsed,
            objectiveMetrics,
        };

        console.log(`[planner] Reflection on step ${stepNumber}: score=${reflection.qualityScore} (objective=${this.calculateObjectiveScore(objectiveMetrics)}), continue=${reflection.continueWithPlan}`);
        return reflection;
    }

    /**
     * Calculate objective metrics from real LangSmith data
     * NO hardcoded values - all derived from actual performance data
     */
    private calculateObjectiveMetrics(
        output: string,
        expectedOutput: string,
        actualTokens: number,
        estimatedTokens: number
    ): ObjectiveMetrics {
        // Token efficiency: ratio of estimated to actual (capped at 1.0)
        const tokenEfficiency = actualTokens > 0
            ? Math.min(1, estimatedTokens / Math.max(actualTokens, 1))
            : 0.5;

        // Error detection: look for error patterns in output
        const errorPatterns = /\b(error|failed|exception|timeout|cannot|unable|invalid|refused|denied|forbidden|unauthorized|missing|required|not\s+found|tbd|todo)\b/i;
        const hasErrors = errorPatterns.test(output) || output.trim().length < 20;

        // Format matching: check if output matches expected format hints
        const matchesExpectedFormat = this.checkFormatMatch(output, expectedOutput);

        return {
            tokenEfficiency,
            hasErrors,
            matchesExpectedFormat,
            outputLength: output.length,
        };
    }

    /**
     * Check if output matches expected format hints
     */
    private checkFormatMatch(output: string, expectedFormat: string): boolean {
        const lower = expectedFormat.toLowerCase();
        const trimmedOutput = output.trim();

        if (lower.includes("json") || lower.includes("object")) {
            if (!(/^\{[\s\S]*\}$|^\[[\s\S]*\]$/.test(trimmedOutput))) return false;
            try {
                JSON.parse(trimmedOutput);
                return true;
            } catch {
                return false;
            }
        }
        if (lower.includes("list") || lower.includes("array")) {
            return /^[\s]*[-*\d]|^\[/.test(trimmedOutput);
        }
        if (lower.includes("code") || lower.includes("script")) {
            return /```|def |function |class |const |let |var /.test(output);
        }
        if (lower.includes("url") || lower.includes("link")) {
            return /https?:\/\//.test(output);
        }
        if (lower.includes("markdown") || lower.includes("document")) {
            return /^#|\*\*|__|`/.test(trimmedOutput);
        }

        // Default: has substantial content (>50 chars)
        return trimmedOutput.length > 50;
    }

    /**
     * Calculate pure objective score from metrics (0-10)
     */
    private calculateObjectiveScore(metrics: ObjectiveMetrics): number {
        let score = 0;

        // Token efficiency: 0-3 points
        score += metrics.tokenEfficiency * 3;

        // No errors: 0-3 points
        score += metrics.hasErrors ? 0 : 3;

        // Format match: 0-2 points
        score += metrics.matchesExpectedFormat ? 2 : 0;

        // Has substantial output: 0-2 points
        score += metrics.outputLength > 150 ? 2 : (metrics.outputLength > 60 ? 1 : 0);

        return Math.round(Math.min(10, Math.max(0, score)));
    }

    /**
     * Calibrate LLM score with objective metrics to prevent inflation
     * LLM score is weighted against objective score
     */
    private calibrateScore(llmScore: number, metrics: ObjectiveMetrics): number {
        const objectiveScore = this.calculateObjectiveScore(metrics);

        // If LLM gives high score but objective metrics are poor, pull it down
        // If LLM gives low score but objective metrics are good, pull it up slightly
        // Weight: 30% LLM, 70% objective
        const calibrated = (llmScore * 0.3) + (objectiveScore * 0.7);
        const capHigh = Math.min(10, objectiveScore + 1);
        const capLow = Math.max(0, objectiveScore - 3);

        return Math.round(Math.min(capHigh, Math.max(capLow, calibrated)));
    }

    /**
     * Refine the plan based on reflection feedback
     * 
     * @param reflection - The reflection from the last step
     * @returns Updated plan (incremented version)
     */
    async refinePlan(reflection: StepReflection): Promise<ExecutionPlan> {
        if (!this.currentPlan || !reflection.planModifications?.length) {
            return this.currentPlan!;
        }

        const remainingSteps = this.currentPlan.steps.filter(
            s => s.stepNumber > reflection.stepNumber
        );

        if (remainingSteps.length === 0) {
            return this.currentPlan;
        }

        // Apply modifications
        console.log(`[planner] Refining plan based on ${reflection.planModifications.length} suggestions`);

        const refinedPlan: ExecutionPlan = {
            ...this.currentPlan,
            version: this.currentPlan.version + 1,
            validationNotes: `Refined after step ${reflection.stepNumber}: ${reflection.planModifications.join("; ")}`,
        };

        this.currentPlan = refinedPlan;
        return refinedPlan;
    }

    /**
     * Get the current execution plan
     */
    getCurrentPlan(): ExecutionPlan | null {
        return this.currentPlan;
    }

    /**
     * Get the next step to execute
     */
    getNextStep(completedSteps: number[]): PlanStep | null {
        if (!this.currentPlan) return null;

        const completedSet = new Set(completedSteps);
        for (const step of this.currentPlan.steps) {
            if (completedSet.has(step.stepNumber)) continue;

            // Check if all dependencies are met
            const depsmet = step.dependsOn.every(dep => completedSet.has(dep));
            if (depsmet) {
                return step;
            }
        }

        return null;
    }

    /**
     * Generate a structured task prompt for delegation
     * This provides the agent with clear context and expectations
     */
    generateTaskPrompt(step: PlanStep, previousOutputs: Map<number, string>): string {
        const dependencyContext = step.dependsOn
            .map(dep => {
                const output = previousOutputs.get(dep);
                if (!output) return null;
                return `[Step ${dep} Output]: ${output.slice(0, 500)}${output.length > 500 ? "..." : ""}`;
            })
            .filter(Boolean)
            .join("\n\n");

        return `## TASK
${step.task}

## EXPECTED OUTPUT
${step.expectedOutput}

${dependencyContext ? `## CONTEXT FROM PREVIOUS STEPS\n${dependencyContext}` : ""}

## CONSTRAINTS
- Complete this specific task only
- Return structured, actionable output
- Priority: ${step.priority}`;
    }
}

// =============================================================================
// State Extensions for Planning
// =============================================================================

/**
 * Planning-related state additions
 * These are added to ManowarState via extension
 */
export interface PlanningState {
    /** Current execution plan */
    currentPlan: ExecutionPlan | null;
    /** Completed step outputs (stepNumber -> output) */
    stepOutputs: Record<number, string>;
    /** Step reflections */
    reflections: StepReflection[];
    /** Current step being executed */
    currentStepNumber: number;
    /** Planning phase completed */
    planningComplete: boolean;
}

/**
 * Create initial planning state
 */
export function createInitialPlanningState(): PlanningState {
    return {
        currentPlan: null,
        stepOutputs: {},
        reflections: [],
        currentStepNumber: 0,
        planningComplete: false,
    };
}

// =============================================================================
// Export
// =============================================================================

export {
    plannerSystemPrompt,
    reflectorSystemPrompt,
    reviewerSystemPrompt,
};
