/**
 * Planner Tests
 *
 * Unit tests for the TaskPlanner component of the Shadow Orchestra.
 * Tests plan creation, validation, reflection, and task prompt generation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TaskPlanner, type ExecutionPlan, type PlanStep } from "../src/manowar/planner.js";
import type { Workflow } from "../src/manowar/types.js";

let plannerPayload: Record<string, unknown>;
let reflectionPayload: Record<string, unknown>;
let reviewerPayload: Record<string, unknown>;

const mockModelInvoke = vi.fn(async (messages: Array<{ content?: unknown }>) => {
    const systemPrompt = String(messages?.[0]?.content || "");

    if (systemPrompt.includes("TASK PLANNER")) {
        return { content: JSON.stringify(plannerPayload) };
    }

    if (systemPrompt.includes("STEP REFLECTOR")) {
        return { content: JSON.stringify(reflectionPayload) };
    }

    if (systemPrompt.includes("WORKFLOW REVIEWER")) {
        return { content: JSON.stringify(reviewerPayload) };
    }

    return { content: "{}" };
});

vi.mock("../../src/manowar/frameworks/langchain.js", () => ({
    createModel: vi.fn(() => ({
        invoke: mockModelInvoke,
    })),
}));

vi.mock("../src/manowar/memory.js", () => ({
    searchMemoryWithGraph: vi.fn(async () => ({ memories: [] })),
    addMemoryWithGraph: vi.fn(async () => []),
    getAgentReliability: vi.fn(async () => ({
        avgQuality: 8.2,
        successRate: 0.91,
        totalRuns: 12,
    })),
}));

vi.mock("../src/manowar/registry.js", () => ({
    discoverAgentTools: vi.fn(async () => []),
}));

vi.mock("../src/manowar/langsmith.js", () => ({
    isLangSmithEnabled: vi.fn(() => false),
    getRelevantLearnings: vi.fn(async () => []),
}));

describe("TaskPlanner", () => {
    let planner: TaskPlanner;
    let mockWorkflow: Workflow;

    beforeEach(() => {
        plannerPayload = {
            goal_understanding: "Test goal",
            steps: [
                {
                    stepNumber: 1,
                    agentName: "TestAgent",
                    agentWallet: "0x0000000000000000000000000000000000000001",
                    task: "Test task",
                    expectedOutput: "Test output",
                    dependsOn: [],
                    estimatedTokens: 2000,
                    priority: "high",
                },
            ],
            total_estimated_tokens: 2000,
        };

        reflectionPayload = {
            success: true,
            qualityScore: 8,
            learnings: ["Good output"],
            continueWithPlan: true,
        };

        reviewerPayload = {
            hasPastExecutions: true,
            pastQualityScore: 8.1,
            suggestions: ["Use the reliable agent first"],
            successPatterns: ["Atomic tasks"],
            avoidPatterns: ["Ambiguous prompts"],
        };

        mockWorkflow = {
            id: "test-workflow",
            name: "Test Workflow",
            description: "A test workflow for unit testing",
            chainId: 43113,
            steps: [
                {
                    id: "step-1",
                    name: "TestAgent",
                    type: "agent",
                    agentAddress: "0x0000000000000000000000000000000000000001",
                    inputTemplate: {
                        description: "A test agent",
                        skills: ["testing", "analysis"],
                        model: "gpt-4o",
                    },
                    saveAs: "test_output",
                },
                {
                    id: "step-2",
                    name: "SecondAgent",
                    type: "agent",
                    agentAddress: "0x0000000000000000000000000000000000000002",
                    inputTemplate: {
                        description: "A second test agent",
                        skills: ["synthesis"],
                        model: "gpt-4o-mini",
                    },
                    saveAs: "second_output",
                },
            ],
        };

        planner = new TaskPlanner(mockWorkflow, "gpt-4o-mini");
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe("createPlan", () => {
        it("should create a valid execution plan", async () => {
            const plan = await planner.createPlan("Analyze test data and provide insights");

            expect(plan).toBeDefined();
            expect(plan.planId).toMatch(/^plan-\d+-[a-z0-9]+$/);
            expect(plan.goal).toBe("Analyze test data and provide insights");
            expect(plan.version).toBe(1);
            expect(plan.steps.length).toBeGreaterThan(0);
            expect(plan.validated).toBe(true);
        });

        it("should include context when provided", async () => {
            const plan = await planner.createPlan("Process image", {
                attachmentUrl: "https://example.com/image.png",
                priorContext: "Previous analysis showed...",
            });

            expect(plan).toBeDefined();
            expect(plan.goal).toBe("Process image");
        });

        it("should validate agent names against workflow", async () => {
            const plan = await planner.createPlan("Test goal");

            for (const step of plan.steps) {
                const validNames = mockWorkflow.steps
                    .filter((s) => s.type === "agent")
                    .map((s) => s.name);
                expect(validNames).toContain(step.agentName);
            }
        });

        it("should enforce workflow graph dependencies", async () => {
            plannerPayload = {
                goal_understanding: "Two-step goal",
                steps: [
                    {
                        stepNumber: 1,
                        agentName: "SecondAgent",
                        agentWallet: "0x0000000000000000000000000000000000000002",
                        task: "Summarize results",
                        expectedOutput: "Summary",
                        dependsOn: [],
                        estimatedTokens: 1200,
                        priority: "medium",
                    },
                    {
                        stepNumber: 2,
                        agentName: "TestAgent",
                        agentWallet: "0x0000000000000000000000000000000000000001",
                        task: "Analyze input",
                        expectedOutput: "Analysis",
                        dependsOn: [],
                        estimatedTokens: 1800,
                        priority: "high",
                    },
                ],
                total_estimated_tokens: 3000,
            };

            planner.setWorkflowGraph({
                steps: mockWorkflow.steps,
                edges: [{ source: 0, target: 1 }],
            });

            const plan = await planner.createPlan("Respect graph ordering");

            expect(plan.validated).toBe(true);
            expect(plan.steps[0].agentName).toBe("TestAgent");
            expect(plan.steps[1].agentName).toBe("SecondAgent");
            expect(plan.steps[1].dependsOn).toContain(1);
        });
    });

    describe("getNextStep", () => {
        it("should return the first uncompleted step", async () => {
            await planner.createPlan("Test goal");

            const nextStep = planner.getNextStep([]);
            expect(nextStep).toBeDefined();
            expect(nextStep?.stepNumber).toBe(1);

            const afterFirstStep = planner.getNextStep([1]);
            expect(afterFirstStep).toBeNull();
        });

        it("should return null when all steps are completed", async () => {
            await planner.createPlan("Test goal");

            const plan = planner.getCurrentPlan();
            const allSteps = plan?.steps.map((s) => s.stepNumber) || [];
            const nextStep = planner.getNextStep(allSteps);

            expect(nextStep).toBeNull();
        });
    });

    describe("generateTaskPrompt", () => {
        it("should generate a structured task prompt", async () => {
            await planner.createPlan("Test goal");
            const plan = planner.getCurrentPlan()!;
            const step = plan.steps[0];

            const previousOutputs = new Map<number, string>();
            const prompt = planner.generateTaskPrompt(step, previousOutputs);

            expect(prompt).toContain("## TASK");
            expect(prompt).toContain(step.task);
            expect(prompt).toContain("## EXPECTED OUTPUT");
            expect(prompt).toContain("## CONSTRAINTS");
            expect(prompt).toContain(step.priority);
        });

        it("should include context from previous steps", async () => {
            plannerPayload = {
                goal_understanding: "Two-step goal",
                steps: [
                    {
                        stepNumber: 1,
                        agentName: "TestAgent",
                        agentWallet: "0x0000000000000000000000000000000000000001",
                        task: "Analyze",
                        expectedOutput: "Analysis",
                        dependsOn: [],
                        estimatedTokens: 1200,
                        priority: "high",
                    },
                    {
                        stepNumber: 2,
                        agentName: "SecondAgent",
                        agentWallet: "0x0000000000000000000000000000000000000002",
                        task: "Summarize",
                        expectedOutput: "Summary",
                        dependsOn: [1],
                        estimatedTokens: 1200,
                        priority: "medium",
                    },
                ],
                total_estimated_tokens: 2400,
            };

            await planner.createPlan("Multi-step goal");
            const plan = planner.getCurrentPlan()!;

            const previousOutputs = new Map<number, string>();
            previousOutputs.set(1, "First step completed with results...");

            const dependentStep = plan.steps.find((s) => s.dependsOn.includes(1));
            expect(dependentStep).toBeDefined();

            const prompt = planner.generateTaskPrompt(dependentStep!, previousOutputs);
            expect(prompt).toContain("CONTEXT FROM PREVIOUS STEPS");
        });
    });

    describe("reflectOnStep", () => {
        it("should generate a reflection for completed step", async () => {
            await planner.createPlan("Test goal");

            const reflection = await planner.reflectOnStep(
                1,
                "Step completed successfully with output...",
                1500,
            );

            expect(reflection).toBeDefined();
            expect(reflection.stepNumber).toBe(1);
            expect(reflection.success).toBe(true);
            expect(reflection.qualityScore).toBeGreaterThanOrEqual(0);
            expect(reflection.qualityScore).toBeLessThanOrEqual(10);
            expect(reflection.actualTokensUsed).toBe(1500);
        });

        it("should throw error when no plan exists", async () => {
            await expect(planner.reflectOnStep(1, "output", 1000)).rejects.toThrow("No plan exists");
        });
    });

    describe("getCurrentPlan", () => {
        it("should return null before plan creation", () => {
            expect(planner.getCurrentPlan()).toBeNull();
        });

        it("should return the plan after creation", async () => {
            await planner.createPlan("Test goal");
            const plan = planner.getCurrentPlan();

            expect(plan).not.toBeNull();
            expect(plan?.goal).toBe("Test goal");
        });
    });
});

describe("PlanStep interface", () => {
    it("should have correct structure", () => {
        const step: PlanStep = {
            stepNumber: 1,
            agentName: "TestAgent",
            task: "Perform test task",
            expectedOutput: "Expected output format",
            dependsOn: [],
            estimatedTokens: 2000,
            priority: "critical",
        };

        expect(step.stepNumber).toBe(1);
        expect(step.priority).toBe("critical");
        expect(step.dependsOn).toEqual([]);
    });
});

describe("ExecutionPlan interface", () => {
    it("should have correct structure", () => {
        const plan: ExecutionPlan = {
            planId: "plan-123-abc",
            goal: "Test goal",
            version: 1,
            steps: [],
            totalEstimatedTokens: 5000,
            createdAt: Date.now(),
            chainId: 43113,
            validated: true,
        };

        expect(plan.planId).toBe("plan-123-abc");
        expect(plan.version).toBe(1);
        expect(plan.validated).toBe(true);
    });
});
