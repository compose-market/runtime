/**
 * Task Contracts Tests
 * 
 * Unit tests for the structured task contracts system.
 * Tests contract building, prompt generation, and output parsing.
 */

import { describe, it, expect } from "vitest";
import {
    TaskContractBuilder,
    generateStructuredPrompt,
    parseAgentOutput,
    summarizeOutput,
    createContractFromStep,
    createResearchContract,
    createImplementationContract,
    type ContextualTaskContract,
    type AgentOutput,
    BaseTaskContractSchema,
    ContextualTaskContractSchema,
    AgentOutputSchema,
} from "../task-contracts.js";
import type { WorkflowStep } from "../types.js";

describe("TaskContractBuilder", () => {
    it("should build a basic contract", () => {
        const contract = new TaskContractBuilder()
            .task("Analyze the data")
            .expectedOutput("Summary of findings")
            .build();

        expect(contract.task).toBe("Analyze the data");
        expect(contract.expectedOutput).toBe("Summary of findings");
        expect(contract.taskId).toMatch(/^task-\d+-[a-z0-9]+$/);
    });

    it("should set priority", () => {
        const contract = new TaskContractBuilder()
            .task("Critical task")
            .expectedOutput("Result")
            .priority("critical")
            .build();

        expect(contract.priority).toBe("critical");
    });

    it("should set step context", () => {
        const contract = new TaskContractBuilder()
            .task("Step task")
            .expectedOutput("Result")
            .stepContext(2, 5)
            .build();

        expect(contract.context.stepNumber).toBe(2);
        expect(contract.context.totalSteps).toBe(5);
    });

    it("should add previous outputs", () => {
        const contract = new TaskContractBuilder()
            .task("Follow-up task")
            .expectedOutput("Result")
            .stepContext(2, 3)
            .addPreviousOutput(1, "Agent1", "First step completed...")
            .build();

        expect(contract.context.previousOutputs).toHaveLength(1);
        expect(contract.context.previousOutputs![0].stepNumber).toBe(1);
        expect(contract.context.previousOutputs![0].agentName).toBe("Agent1");
    });

    it("should add facts", () => {
        const contract = new TaskContractBuilder()
            .task("Context task")
            .expectedOutput("Result")
            .stepContext(1, 1)
            .addFact("Important fact 1")
            .addFact("Important fact 2")
            .build();

        expect(contract.context.relevantFacts).toHaveLength(2);
    });

    it("should set attachment", () => {
        const contract = new TaskContractBuilder()
            .task("Image task")
            .expectedOutput("Analysis")
            .attachment("https://example.com/image.png", "image")
            .build();

        expect(contract.attachmentUrl).toBe("https://example.com/image.png");
        expect(contract.attachmentType).toBe("image");
    });

    it("should set token limit", () => {
        const contract = new TaskContractBuilder()
            .task("Limited task")
            .expectedOutput("Concise result")
            .maxTokens(500)
            .build();

        expect(contract.maxResponseTokens).toBe(500);
    });

    it("should set timeout", () => {
        const contract = new TaskContractBuilder()
            .task("Time-critical task")
            .expectedOutput("Fast result")
            .timeout(30000)
            .build();

        expect(contract.timeoutMs).toBe(30000);
    });
});

describe("generateStructuredPrompt", () => {
    it("should generate prompt with all sections", () => {
        const contract = new TaskContractBuilder()
            .task("Complete analysis")
            .expectedOutput("Full report with sections")
            .priority("high")
            .stepContext(2, 4)
            .addPreviousOutput(1, "Researcher", "Found relevant data...")
            .addFact("User prefers detailed explanations")
            .attachment("https://example.com/data.json", "document")
            .build();

        const prompt = generateStructuredPrompt(contract);

        expect(prompt).toContain("STRUCTURED TASK");
        expect(prompt).toContain("HIGH");
        expect(prompt).toContain("### TASK");
        expect(prompt).toContain("Complete analysis");
        expect(prompt).toContain("### EXPECTED OUTPUT FORMAT");
        expect(prompt).toContain("### CONTEXT FROM PREVIOUS STEPS");
        expect(prompt).toContain("### KEY FACTS");
        expect(prompt).toContain("### ATTACHMENT");
        expect(prompt).toContain("### WORKFLOW PROGRESS");
        expect(prompt).toContain("Step 2 of 4");
        expect(prompt).toContain("### CONSTRAINTS");
    });

    it("should omit optional sections when not provided", () => {
        const contract = new TaskContractBuilder()
            .task("Simple task")
            .expectedOutput("Simple result")
            .stepContext(1, 1)
            .build();

        const prompt = generateStructuredPrompt(contract);

        expect(prompt).not.toContain("### CONTEXT FROM PREVIOUS STEPS");
        expect(prompt).not.toContain("### KEY FACTS");
        expect(prompt).not.toContain("### ATTACHMENT");
    });
});

describe("parseAgentOutput", () => {
    it("should parse JSON response", () => {
        const jsonResponse = JSON.stringify({
            success: true,
            result: "Analysis complete",
            data: { key: "value" },
            insights: ["Insight 1", "Insight 2"],
            confidence: 95,
        });

        const output = parseAgentOutput(jsonResponse, "TestAgent");

        expect(output.success).toBe(true);
        expect(output.result).toBe("Analysis complete");
        expect(output.data).toEqual({ key: "value" });
        expect(output.insights).toHaveLength(2);
        expect(output.confidence).toBe(95);
    });

    it("should parse JSON wrapped in markdown", () => {
        const mdResponse = `Here is the result:\n\`\`\`json\n{"success": true, "result": "Done"}\n\`\`\``;

        const output = parseAgentOutput(mdResponse, "TestAgent");

        expect(output.success).toBe(true);
        expect(output.result).toBe("Done");
    });

    it("should handle plain text response", () => {
        const textResponse = "The analysis shows positive trends across all metrics.";

        const output = parseAgentOutput(textResponse, "TestAgent");

        expect(output.success).toBe(true);
        expect(output.result).toBe(textResponse);
        expect(output.outputType).toBe("text");
    });

    it("should detect failure keywords in text", () => {
        const errorResponse = "Error: Unable to process the request due to missing data.";

        const output = parseAgentOutput(errorResponse, "TestAgent");

        expect(output.success).toBe(false);
    });
});

describe("summarizeOutput", () => {
    it("should summarize output within limit", () => {
        const output: AgentOutput = {
            success: true,
            result: "A".repeat(1000),
            outputType: "text",
        };

        const summary = summarizeOutput(output, 500);

        expect(summary.length).toBeLessThanOrEqual(500);
        expect(summary.endsWith("...")).toBe(true);
    });

    it("should include insights in summary", () => {
        const output: AgentOutput = {
            success: true,
            result: "Main result text",
            outputType: "text",
            insights: ["Key insight 1", "Key insight 2"],
        };

        const summary = summarizeOutput(output);

        expect(summary).toContain("Key insight 1");
    });

    it("should return full result if under limit", () => {
        const output: AgentOutput = {
            success: true,
            result: "Short result",
            outputType: "text",
        };

        const summary = summarizeOutput(output, 500);

        expect(summary).toBe("Short result");
    });
});

describe("createContractFromStep", () => {
    it("should create contract from workflow step", () => {
        const step: WorkflowStep = {
            id: "step-1",
            name: "Analyzer",
            type: "agent",
            inputTemplate: { description: "Data analyzer" },
            saveAs: "analysis",
        };

        const contract = createContractFromStep(
            step,
            "Analyze the uploaded data",
            1,
            3,
            [],
            "https://example.com/data.csv"
        );

        expect(contract.task).toBe("Analyze the uploaded data");
        expect(contract.context.stepNumber).toBe(1);
        expect(contract.context.totalSteps).toBe(3);
        expect(contract.attachmentUrl).toBe("https://example.com/data.csv");
        expect(contract.priority).toBe("critical"); // First step
    });

    it("should include previous outputs", () => {
        const step: WorkflowStep = {
            id: "step-2",
            name: "Synthesizer",
            type: "agent",
            inputTemplate: {},
            saveAs: "synthesis",
        };

        const previousOutputs = [
            { stepNumber: 1, agentName: "Analyzer", summary: "Found 3 patterns..." },
        ];

        const contract = createContractFromStep(step, "Synthesize", 2, 3, previousOutputs);

        expect(contract.context.previousOutputs).toHaveLength(1);
        expect(contract.context.previousOutputs![0].summary).toContain("3 patterns");
    });
});

describe("createResearchContract", () => {
    it("should create research contract", () => {
        const contract = createResearchContract(
            "AI agent architectures",
            ["Focus on LangGraph"],
            { current: 1, total: 2 }
        );

        expect(contract.task).toContain("Research and analyze");
        expect(contract.task).toContain("AI agent architectures");
        expect(contract.priority).toBe("high");
    });
});

describe("createImplementationContract", () => {
    it("should create implementation contract", () => {
        const contract = createImplementationContract(
            "Rate limiting middleware",
            "TypeScript",
            { current: 2, total: 3 }
        );

        expect(contract.task).toContain("Implement in TypeScript");
        expect(contract.priority).toBe("critical");
        expect(contract.timeoutMs).toBe(120000);
    });
});

describe("Schema validation", () => {
    it("should validate BaseTaskContractSchema", () => {
        const valid = BaseTaskContractSchema.parse({
            taskId: "task-123",
            task: "Test task",
            expectedOutput: "Test output",
        });

        expect(valid.priority).toBe("medium"); // Default
    });

    it("should validate ContextualTaskContractSchema", () => {
        const valid = ContextualTaskContractSchema.parse({
            taskId: "task-123",
            task: "Test task",
            expectedOutput: "Test output",
            context: {
                stepNumber: 1,
                totalSteps: 3,
            },
        });

        expect(valid.context.stepNumber).toBe(1);
    });

    it("should validate AgentOutputSchema", () => {
        const valid = AgentOutputSchema.parse({
            success: true,
            result: "Test result",
        });

        expect(valid.outputType).toBe("text"); // Default
    });

    it("should reject invalid confidence score", () => {
        expect(() => AgentOutputSchema.parse({
            success: true,
            result: "Test",
            confidence: 150, // Invalid: > 100
        })).toThrow();
    });
});
