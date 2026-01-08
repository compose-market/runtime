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
import type { Workflow } from "./types.js";
import { searchMemoryWithGraph, addMemoryWithGraph } from "./memory.js";
import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";

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

/**
 * Reflection output after step completion
 */
export interface StepReflection {
    /** Step that was just completed */
    stepNumber: number;
    /** Whether step succeeded */
    success: boolean;
    /** Quality score 0-10 */
    qualityScore: number;
    /** Key learnings */
    learnings: string[];
    /** Whether to continue with original plan */
    continueWithPlan: boolean;
    /** Suggested plan modifications (if any) */
    planModifications?: string[];
    /** Tokens actually used */
    actualTokensUsed: number;
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

OUTPUT FORMAT (JSON):
{
  "goal_understanding": "Brief restatement of the goal",
  "steps": [
    {
      "stepNumber": 1,
      "agentName": "ExactAgentName",
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
    private agentCards?: Array<{ name: string; description?: string; skills?: string[]; walletAddress?: string; model?: string; plugins?: Array<{ name: string }> }>;
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
        agentCards?: Array<{ name: string; description?: string; skills?: string[]; walletAddress?: string; model?: string; plugins?: Array<{ name: string }> }>
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
     * Get available agents - prefers agentCards from manowarCard (IPFS source of truth),
     * falls back to workflow steps if not provided.
     */
    private getAvailableAgents(): { name: string; description: string; capabilities: string[]; walletAddress?: string }[] {
        // Prefer agentCards from manowarCard (contains correct names from IPFS)
        if (this.agentCards?.length) {
            return this.agentCards.map(agent => ({
                name: agent.name,
                description: agent.description || "Specialized agent",
                capabilities: agent.skills || [],
                walletAddress: agent.walletAddress,
            }));
        }

        // Fallback to workflow steps (may have fallback names)
        return this.workflow.steps
            .filter(s => s.type === "agent")
            .map(s => ({
                name: s.name,
                description: (s.inputTemplate?.description as string) || "Specialized agent",
                capabilities: Array.isArray(s.inputTemplate?.skills)
                    ? s.inputTemplate.skills as string[]
                    : [],
                walletAddress: s.agentAddress || (s.inputTemplate as { agentAddress?: string })?.agentAddress,
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
        // Search for past evaluations in Mem0
        const pastEvaluations = await searchMemoryWithGraph({
            query: `workflow evaluation quality score success rate ${goal}`,
            agent_id: manowarWallet,
            limit: 5,
            options: {
                rerank: true,
                keyword_search: true,
            },
        });

        // If no past evaluations, skip review (first run)
        if (!pastEvaluations.memories || pastEvaluations.memories.length === 0) {
            console.log(`[planner] No past evaluations found - skipping review (first run)`);
            return {
                hasPastExecutions: false,
                suggestions: [],
                successPatterns: [],
                avoidPatterns: [],
                skipReview: true,
            };
        }

        // We have past evaluations - use LLM to generate suggestions
        const evaluationSummary = pastEvaluations.memories
            .map(m => m.memory)
            .join("\n---\n");

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
     * @returns Complete execution plan
     */
    async createPlan(goal: string, context?: { attachmentUrl?: string; priorContext?: string }): Promise<ExecutionPlan> {
        const agents = this.getAvailableAgents();

        // Build the planning prompt with dynamic content AFTER stable prefix
        // This preserves KV-cache on the system prompt
        const userPrompt = `## AVAILABLE AGENTS
${agents.map((a, i) => `${i + 1}. **${a.name}**: ${a.description}
   Capabilities: ${a.capabilities.length > 0 ? a.capabilities.join(", ") : "General purpose"}`).join("\n")}

## USER GOAL
"${goal}"
${context?.attachmentUrl ? `\n[Attachment: ${context.attachmentUrl}]` : ""}
${context?.priorContext ? `\n## PRIOR CONTEXT\n${context.priorContext}` : ""}

Create an execution plan for this goal.`;

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

        // Build the execution plan
        const plan: ExecutionPlan = {
            planId: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            goal,
            version: 1,
            steps: (parsed.steps || []).map((s: any, idx: number) => ({
                stepNumber: s.stepNumber || idx + 1,
                agentName: s.agentName || agents[Math.min(idx, agents.length - 1)]?.name || "Unknown",
                task: s.task || goal,
                expectedOutput: s.expectedOutput || "Task result",
                dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : [],
                estimatedTokens: s.estimatedTokens || 2000,
                priority: s.priority || "medium",
            })),
            totalEstimatedTokens: parsed.total_estimated_tokens ||
                (parsed.steps?.reduce((sum: number, s: any) => sum + (s.estimatedTokens || 2000), 0) || 10000),
            createdAt: Date.now(),
            validated: false,
        };

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
        // Check all agent names are valid - use same source as getAvailableAgents
        const validAgentNames = new Set(
            this.agentCards?.length
                ? this.agentCards.map(a => a.name)
                : this.workflow.steps.filter(s => s.type === "agent").map(s => s.name)
        );

        for (const step of plan.steps) {
            if (!validAgentNames.has(step.agentName)) {
                console.warn(`[planner] Invalid agent name in plan: ${step.agentName}`);
                // Try to find closest match
                const match = Array.from(validAgentNames).find(name =>
                    name.toLowerCase().includes(step.agentName.toLowerCase()) ||
                    step.agentName.toLowerCase().includes(name.toLowerCase())
                );
                if (match) {
                    step.agentName = match;
                } else {
                    return false;
                }
            }
        }

        // Check dependencies are valid
        const stepNumbers = new Set(plan.steps.map(s => s.stepNumber));
        for (const step of plan.steps) {
            for (const dep of step.dependsOn) {
                if (!stepNumbers.has(dep) || dep >= step.stepNumber) {
                    console.warn(`[planner] Invalid dependency in plan: step ${step.stepNumber} depends on ${dep}`);
                    return false;
                }
            }
        }

        return true;
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

        // Truncate output to save tokens
        const truncatedOutput = stepOutput.length > 1000
            ? stepOutput.slice(0, 1000) + "... [truncated]"
            : stepOutput;

        const userPrompt = `## COMPLETED STEP
Step ${stepNumber}: ${step.agentName}
Task: ${step.task}
Expected: ${step.expectedOutput}

## ACTUAL OUTPUT
${truncatedOutput}

## TOKEN USAGE
Estimated: ${step.estimatedTokens}
Actual: ${tokensUsed}

## REMAINING STEPS
${this.currentPlan.steps
                .filter(s => s.stepNumber > stepNumber)
                .map(s => `${s.stepNumber}. ${s.agentName}: ${s.task}`)
                .join("\n") || "None - this was the last step"}

Evaluate this step and provide recommendations.`;

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
            // Default to success if parsing fails
            parsed = {
                success: true,
                qualityScore: 7,
                learnings: ["Step completed"],
                continueWithPlan: true,
            };
        }

        const reflection: StepReflection = {
            stepNumber,
            success: parsed.success ?? true,
            qualityScore: Math.min(10, Math.max(0, parsed.qualityScore ?? 7)),
            learnings: Array.isArray(parsed.learnings) ? parsed.learnings : [],
            continueWithPlan: parsed.continueWithPlan ?? true,
            planModifications: Array.isArray(parsed.planModifications) ? parsed.planModifications : undefined,
            actualTokensUsed: tokensUsed,
        };

        console.log(`[planner] Reflection on step ${stepNumber}: score=${reflection.qualityScore}, continue=${reflection.continueWithPlan}`);
        return reflection;
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
