/**
 * Planner Tests
 * 
 * Unit tests for the TaskPlanner component of the Shadow Orchestra.
 * Tests plan creation, validation, reflection, and task prompt generation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TaskPlanner, type ExecutionPlan, type PlanStep } from "../planner.js";
import type { Workflow } from "../types.js";

// Mock ChatOpenAI with a class-like constructor
vi.mock("@langchain/openai", () => {
    return {
        ChatOpenAI: class MockChatOpenAI {
            constructor() { }
            async invoke() {
                return {
                    content: JSON.stringify({
                        goal_understanding: "Test goal",
                        steps: [
                            {
                                stepNumber: 1,
                                agentName: "TestAgent",
                                task: "Test task",
                                expectedOutput: "Test output",
                                dependsOn: [],
                                estimatedTokens: 2000,
                                priority: "high",
                            },
                        ],
                        total_estimated_tokens: 2000,
                    }),
                };
            }
        },
    };
});

describe("TaskPlanner", () => {
    let planner: TaskPlanner;
    let mockWorkflow: Workflow;

    beforeEach(() => {
        mockWorkflow = {
            id: "test-workflow",
            name: "Test Workflow",
            description: "A test workflow for unit testing",
            steps: [
                {
                    id: "step-1",
                    name: "TestAgent",
                    type: "agent",
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

            // Check that all steps reference valid agents
            for (const step of plan.steps) {
                const validNames = mockWorkflow.steps
                    .filter(s => s.type === "agent")
                    .map(s => s.name);
                expect(validNames).toContain(step.agentName);
            }
        });
    });

    describe("getNextStep", () => {
        it("should return the first uncompleted step", async () => {
            await planner.createPlan("Test goal");

            const nextStep = planner.getNextStep([]);
            expect(nextStep).toBeDefined();
            expect(nextStep?.stepNumber).toBe(1);

            const afterFirstStep = planner.getNextStep([1]);
            expect(afterFirstStep).toBeNull(); // Only one step in mock
        });

        it("should return null when all steps are completed", async () => {
            await planner.createPlan("Test goal");

            const plan = planner.getCurrentPlan();
            const allSteps = plan?.steps.map(s => s.stepNumber) || [];
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
            await planner.createPlan("Multi-step goal");
            const plan = planner.getCurrentPlan()!;

            // Simulate first step having output
            const previousOutputs = new Map<number, string>();
            previousOutputs.set(1, "First step completed with results...");

            // Check if plan has a step that depends on step 1
            const dependentStep = plan.steps.find(s => s.dependsOn.includes(1));
            if (dependentStep) {
                const prompt = planner.generateTaskPrompt(dependentStep, previousOutputs);
                expect(prompt).toContain("CONTEXT FROM PREVIOUS STEPS");
            }
        });
    });

    describe("reflectOnStep", () => {
        it("should generate a reflection for completed step", async () => {
            await planner.createPlan("Test goal");

            const reflection = await planner.reflectOnStep(
                1,
                "Step completed successfully with output...",
                1500
            );

            expect(reflection).toBeDefined();
            expect(reflection.stepNumber).toBe(1);
            expect(reflection.success).toBe(true);
            expect(reflection.qualityScore).toBeGreaterThanOrEqual(0);
            expect(reflection.qualityScore).toBeLessThanOrEqual(10);
            expect(reflection.actualTokensUsed).toBe(1500);
        });

        it("should throw error when no plan exists", async () => {
            await expect(
                planner.reflectOnStep(1, "output", 1000)
            ).rejects.toThrow("No plan exists");
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
            validated: true,
        };

        expect(plan.planId).toBe("plan-123-abc");
        expect(plan.version).toBe(1);
        expect(plan.validated).toBe(true);
    });
});
