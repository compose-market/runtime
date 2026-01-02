/**
 * Structured Task Contracts
 * 
 * Defines explicit input/output schemas for agent delegation.
 * Eliminates ambiguity in inter-agent communication.
 * 
 * Key Benefits:
 * - Clear expectations between coordinator and agents
 * - Type-safe task definitions
 * - Reduced miscommunication and retries
 * - Better token efficiency through structured outputs
 * 
 * Based on CrewAI and OpenAI Agents SDK patterns (Jan 2026)
 */

import { z } from "zod";
import type { WorkflowStep } from "./types.js";

// =============================================================================
// Core Schema Types
// =============================================================================

/**
 * Base task contract that all structured tasks implement
 */
export const BaseTaskContractSchema = z.object({
    /** Unique task ID for tracking */
    taskId: z.string(),
    /** Human-readable task description */
    task: z.string(),
    /** Expected output format description */
    expectedOutput: z.string(),
    /** Priority level */
    priority: z.enum(["critical", "high", "medium", "low"]).default("medium"),
    /** Maximum allowed tokens for response */
    maxResponseTokens: z.number().optional(),
    /** Timeout in ms */
    timeoutMs: z.number().optional(),
});

export type BaseTaskContract = z.infer<typeof BaseTaskContractSchema>;

/**
 * Task with context from previous steps
 */
export const ContextualTaskContractSchema = BaseTaskContractSchema.extend({
    /** Context from previous steps */
    context: z.object({
        /** Current step number in workflow */
        stepNumber: z.number(),
        /** Total steps in workflow */
        totalSteps: z.number(),
        /** Output summaries from previous steps */
        previousOutputs: z.array(z.object({
            stepNumber: z.number(),
            agentName: z.string(),
            summary: z.string(),
        })).optional(),
        /** Relevant facts extracted from earlier */
        relevantFacts: z.array(z.string()).optional(),
    }),
    /** Attachment URL (if any) */
    attachmentUrl: z.string().optional(),
    /** Attachment type */
    attachmentType: z.enum(["image", "audio", "video", "document"]).optional(),
});

export type ContextualTaskContract = z.infer<typeof ContextualTaskContractSchema>;

/**
 * Expected output structure from agents
 */
export const AgentOutputSchema = z.object({
    /** Whether task was completed successfully */
    success: z.boolean(),
    /** Main result content */
    result: z.string(),
    /** Structured data output (if applicable) */
    data: z.record(z.string(), z.unknown()).optional(),
    /** Output type */
    outputType: z.enum(["text", "json", "image", "audio", "video"]).default("text"),
    /** URL to generated artifact (if any) */
    artifactUrl: z.string().optional(),
    /** Key insights or findings */
    insights: z.array(z.string()).optional(),
    /** Suggestions for next steps */
    nextSteps: z.array(z.string()).optional(),
    /** Token usage for this task */
    tokensUsed: z.number().optional(),
    /** Confidence score 0-100 */
    confidence: z.number().min(0).max(100).optional(),
});

export type AgentOutput = z.infer<typeof AgentOutputSchema>;

// =============================================================================
// Task Contract Builder
// =============================================================================

/**
 * Builder for creating structured task contracts
 */
export class TaskContractBuilder {
    private contract: Partial<ContextualTaskContract> = {};

    /**
     * Set the task description
     */
    task(description: string): this {
        this.contract.task = description;
        return this;
    }

    /**
     * Set expected output format
     */
    expectedOutput(format: string): this {
        this.contract.expectedOutput = format;
        return this;
    }

    /**
     * Set priority
     */
    priority(level: "critical" | "high" | "medium" | "low"): this {
        this.contract.priority = level;
        return this;
    }

    /**
     * Set step context
     */
    stepContext(current: number, total: number): this {
        this.contract.context = {
            ...this.contract.context,
            stepNumber: current,
            totalSteps: total,
        };
        return this;
    }

    /**
     * Add previous step output
     */
    addPreviousOutput(stepNumber: number, agentName: string, summary: string): this {
        if (!this.contract.context) {
            this.contract.context = { stepNumber: 0, totalSteps: 0 };
        }
        if (!this.contract.context.previousOutputs) {
            this.contract.context.previousOutputs = [];
        }
        this.contract.context.previousOutputs.push({ stepNumber, agentName, summary });
        return this;
    }

    /**
     * Add relevant fact
     */
    addFact(fact: string): this {
        if (!this.contract.context) {
            this.contract.context = { stepNumber: 0, totalSteps: 0 };
        }
        if (!this.contract.context.relevantFacts) {
            this.contract.context.relevantFacts = [];
        }
        this.contract.context.relevantFacts.push(fact);
        return this;
    }

    /**
     * Set attachment
     */
    attachment(url: string, type: "image" | "audio" | "video" | "document"): this {
        this.contract.attachmentUrl = url;
        this.contract.attachmentType = type;
        return this;
    }

    /**
     * Set token limit
     */
    maxTokens(limit: number): this {
        this.contract.maxResponseTokens = limit;
        return this;
    }

    /**
     * Set timeout
     */
    timeout(ms: number): this {
        this.contract.timeoutMs = ms;
        return this;
    }

    /**
     * Build the final contract
     */
    build(): ContextualTaskContract {
        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

        return ContextualTaskContractSchema.parse({
            taskId,
            ...this.contract,
            context: this.contract.context || { stepNumber: 1, totalSteps: 1 },
        });
    }
}

// =============================================================================
// Task Prompt Generator
// =============================================================================

/**
 * Generate a structured task prompt from a contract
 * This is what gets sent to the agent
 */
export function generateStructuredPrompt(contract: ContextualTaskContract): string {
    const lines: string[] = [];

    // Header
    lines.push(`## STRUCTURED TASK [${contract.taskId}]`);
    lines.push(`Priority: ${contract.priority?.toUpperCase() || "MEDIUM"}`);
    lines.push("");

    // Task description
    lines.push("### TASK");
    lines.push(contract.task);
    lines.push("");

    // Expected output
    lines.push("### EXPECTED OUTPUT FORMAT");
    lines.push(contract.expectedOutput);
    lines.push("");

    // Context from previous steps
    if (contract.context.previousOutputs?.length) {
        lines.push("### CONTEXT FROM PREVIOUS STEPS");
        for (const prev of contract.context.previousOutputs) {
            lines.push(`**Step ${prev.stepNumber} (${prev.agentName}):**`);
            lines.push(prev.summary);
            lines.push("");
        }
    }

    // Relevant facts
    if (contract.context.relevantFacts?.length) {
        lines.push("### KEY FACTS");
        for (const fact of contract.context.relevantFacts) {
            lines.push(`- ${fact}`);
        }
        lines.push("");
    }

    // Attachment
    if (contract.attachmentUrl) {
        lines.push("### ATTACHMENT");
        lines.push(`Type: ${contract.attachmentType || "file"}`);
        lines.push(`URL: ${contract.attachmentUrl}`);
        lines.push("");
    }

    // Progress indicator
    lines.push("### WORKFLOW PROGRESS");
    lines.push(`Step ${contract.context.stepNumber} of ${contract.context.totalSteps}`);
    lines.push("");

    // Constraints
    lines.push("### CONSTRAINTS");
    lines.push("- Complete ONLY this specific task");
    lines.push("- Return structured, actionable output");
    lines.push("- Do not ask clarifying questions");
    if (contract.maxResponseTokens) {
        lines.push(`- Keep response under ${contract.maxResponseTokens} tokens`);
    }

    return lines.join("\n");
}

/**
 * Parse an agent response into structured output
 * Handles both JSON and plain text responses
 */
export function parseAgentOutput(response: string, agentName: string): AgentOutput {
    // Try to parse as JSON first
    try {
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return AgentOutputSchema.parse({
                success: parsed.success ?? true,
                result: parsed.result || parsed.output || parsed.message || response,
                data: parsed.data,
                outputType: parsed.outputType || parsed.type || "text",
                artifactUrl: parsed.artifactUrl || parsed.url,
                insights: parsed.insights,
                nextSteps: parsed.nextSteps,
                tokensUsed: parsed.tokensUsed,
                confidence: parsed.confidence,
            });
        }
    } catch {
        // Not valid JSON, continue with plain text parsing
    }

    // Plain text response
    return {
        success: !response.toLowerCase().includes("error") &&
            !response.toLowerCase().includes("failed"),
        result: response,
        outputType: "text",
    };
}

/**
 * Create a summary of agent output for inclusion in next step's context
 * Truncates to save tokens
 */
export function summarizeOutput(output: AgentOutput, maxLength: number = 500): string {
    let summary = output.result;

    // Add insights if available
    if (output.insights?.length) {
        summary += `\nKey findings: ${output.insights.slice(0, 3).join("; ")}`;
    }

    // Truncate if needed
    if (summary.length > maxLength) {
        summary = summary.slice(0, maxLength - 3) + "...";
    }

    return summary;
}

// =============================================================================
// Agent-Specific Contract Templates
// =============================================================================

/**
 * Create a contract for a research/analysis agent
 */
export function createResearchContract(
    topic: string,
    constraints: string[],
    stepContext: { current: number; total: number }
): ContextualTaskContract {
    return new TaskContractBuilder()
        .task(`Research and analyze: ${topic}`)
        .expectedOutput("Structured analysis with key findings, data points, and sources")
        .priority("high")
        .stepContext(stepContext.current, stepContext.total)
        .maxTokens(2000)
        .build();
}

/**
 * Create a contract for a code/implementation agent
 */
export function createImplementationContract(
    requirement: string,
    language: string,
    stepContext: { current: number; total: number }
): ContextualTaskContract {
    return new TaskContractBuilder()
        .task(`Implement in ${language}: ${requirement}`)
        .expectedOutput("Working code with comments and usage example")
        .priority("critical")
        .stepContext(stepContext.current, stepContext.total)
        .timeout(120000) // 2 minute timeout for code generation
        .build();
}

/**
 * Create a contract for a design/creative agent
 */
export function createDesignContract(
    brief: string,
    format: string,
    stepContext: { current: number; total: number }
): ContextualTaskContract {
    return new TaskContractBuilder()
        .task(`Design ${format}: ${brief}`)
        .expectedOutput(`${format} artifact with description of design choices`)
        .priority("high")
        .stepContext(stepContext.current, stepContext.total)
        .build();
}

// =============================================================================
// Contract from Workflow Step
// =============================================================================

/**
 * Create a task contract from a workflow step and current state
 */
export function createContractFromStep(
    step: WorkflowStep,
    task: string,
    stepNumber: number,
    totalSteps: number,
    previousOutputs: Array<{ stepNumber: number; agentName: string; summary: string }> = [],
    attachmentUrl?: string
): ContextualTaskContract {
    const builder = new TaskContractBuilder()
        .task(task)
        .expectedOutput(`Complete result for: ${task}`)
        .priority(stepNumber === 1 ? "critical" : "high")
        .stepContext(stepNumber, totalSteps);

    // Add previous outputs
    for (const prev of previousOutputs) {
        builder.addPreviousOutput(prev.stepNumber, prev.agentName, prev.summary);
    }

    // Add attachment if present
    if (attachmentUrl) {
        const type = attachmentUrl.match(/\.(png|jpg|jpeg|gif|webp)/i) ? "image" :
            attachmentUrl.match(/\.(mp3|wav|ogg)/i) ? "audio" :
                attachmentUrl.match(/\.(mp4|webm)/i) ? "video" : "document";
        builder.attachment(attachmentUrl, type);
    }

    return builder.build();
}

// All exports are inline with declarations above
