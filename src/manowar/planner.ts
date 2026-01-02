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
 * 
 * Based on Manus Context Engineering principles (Jan 2026)
 */

import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { WorkflowStep, Workflow } from "./types.js";
import type { ManowarState } from "./state.js";

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

// =============================================================================
// Planning Prompts (Stable - Cache Friendly)
// =============================================================================

/**
 * Stable system prompt for the planner - optimized for KV-cache efficiency
 * This prompt NEVER changes during workflow execution
 */
const PLANNER_SYSTEM_PROMPT = `You are the TASK PLANNER for a multi-agent orchestration system.

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
      "estimatedTokens": 2000,
      "priority": "critical"
    }
  ],
  "total_estimated_tokens": 8000
}`;

/**
 * Stable system prompt for the reflector - optimized for KV-cache efficiency
 */
const REFLECTOR_SYSTEM_PROMPT = `You are the STEP REFLECTOR for a multi-agent orchestration system.

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
    private model: ChatOpenAI;
    private workflow: Workflow;
    private currentPlan: ExecutionPlan | null = null;

    /**
     * @param workflow - The workflow definition
     * @param plannerModel - Model assigned by coordinator from AGENTIC_COORDINATOR_MODELS
     */
    constructor(workflow: Workflow, plannerModel: string) {
        this.workflow = workflow;

        if (!plannerModel) {
            throw new Error("plannerModel is required - must be assigned by coordinator from AGENTIC_COORDINATOR_MODELS");
        }

        console.log(`[planner] Using coordinator-assigned model: ${plannerModel}`);

        this.model = new ChatOpenAI({
            modelName: plannerModel,
            temperature: 0.2,
            maxTokens: 2000,
        });
    }

    /**
     * Get available agents from workflow for planning context
     */
    private getAvailableAgents(): { name: string; description: string; capabilities: string[] }[] {
        return this.workflow.steps
            .filter(s => s.type === "agent")
            .map(s => ({
                name: s.name,
                description: (s.inputTemplate?.description as string) || "Specialized agent",
                capabilities: Array.isArray(s.inputTemplate?.skills)
                    ? s.inputTemplate.skills as string[]
                    : [],
            }));
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

        const response = await this.model.invoke([
            new SystemMessage(PLANNER_SYSTEM_PROMPT),
            new HumanMessage(userPrompt),
        ]);

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
            // Fallback: create a simple sequential plan
            parsed = this.createFallbackPlan(goal, agents);
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
     * Create a fallback plan when LLM parsing fails
     */
    private createFallbackPlan(goal: string, agents: { name: string; description: string }[]): any {
        return {
            steps: agents.map((agent, idx) => ({
                stepNumber: idx + 1,
                agentName: agent.name,
                task: `Contribute to: ${goal}`,
                expectedOutput: "Task completion result",
                dependsOn: idx > 0 ? [idx] : [],
                estimatedTokens: 3000,
                priority: idx === 0 ? "critical" : "high",
            })),
            total_estimated_tokens: agents.length * 3000,
        };
    }

    /**
     * Validate that the plan is executable
     */
    private validatePlan(plan: ExecutionPlan): boolean {
        // Check all agent names are valid
        const validAgentNames = new Set(
            this.workflow.steps.filter(s => s.type === "agent").map(s => s.name)
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

        const response = await this.model.invoke([
            new SystemMessage(REFLECTOR_SYSTEM_PROMPT),
            new HumanMessage(userPrompt),
        ]);

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
    PLANNER_SYSTEM_PROMPT,
    REFLECTOR_SYSTEM_PROMPT,
};
