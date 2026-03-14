/**
 * AlwaysOnAgent - Continuous Agent Execution
 * 
 * Implements continuous/multi-loop agent execution with:
 * - Automatic iteration with configurable delays
 * - State persistence between iterations
 * - Graceful degradation on failures
 * - Integration with Temporal for durable execution
 * 
 * Pattern: Both A (loop in existing) + B (AlwaysOnAgent class)
 */

import { v4 as uuidv4 } from "uuid";
import type { DynamicStructuredTool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import type { AgentWallet } from "../agent-wallet.js";
import { createAgentTools, createMem0Tools } from "./tools.js";
import { getRelevantContext, recordConversationTurn } from "../workflow/embeddings.js";

interface AlwaysOnAgentConfig {
    maxIterations: number;
    loopDelayMs: number;
    coordinatorModel?: string;
    temperature?: number;
}

interface AgentState {
    iteration: number;
    lastMessage: string;
    context: Record<string, unknown>;
    shouldContinue: boolean;
    reason?: string;
}

interface AgentIterationResult {
    success: boolean;
    output: string;
    state: AgentState;
    toolsUsed: string[];
    executionTimeMs: number;
}

const DEFAULT_CONFIG: AlwaysOnAgentConfig = {
    maxIterations: 10,
    loopDelayMs: 1000,
    coordinatorModel: "gpt-4o",
    temperature: 0.7,
};

/**
 * AlwaysOnAgent class for continuous agent execution
 */
export class AlwaysOnAgent {
    private config: AlwaysOnAgentConfig;
    private agentWallet: AgentWallet;
    private tools: DynamicStructuredTool[] = [];
    private model: ChatOpenAI;
    private state: AgentState;

    constructor(
        agentWallet: AgentWallet,
        config: Partial<AlwaysOnAgentConfig> = {},
    ) {
        this.agentWallet = agentWallet;
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.model = new ChatOpenAI({
            modelName: this.config.coordinatorModel,
            temperature: this.config.temperature,
        });
        this.state = {
            iteration: 0,
            lastMessage: "",
            context: {},
            shouldContinue: true,
        };
    }

    async initialize(pluginIds: string[]): Promise<void> {
        const agentTools = await createAgentTools(
            pluginIds,
            this.agentWallet,
            { sessionActive: true, sessionBudgetRemaining: 1000000 },
            {
                getComposeRunId: () => uuidv4(),
                getThreadId: () => this.agentWallet.address,
            },
        );

        const memoryTools = createMem0Tools(
            this.agentWallet.address,
            undefined,
            undefined,
        );

        this.tools = [...agentTools, ...memoryTools];
        console.log(`[AlwaysOnAgent] Initialized with ${this.tools.length} tools`);
    }

    async runContinuous(initialMessage: string): Promise<AgentIterationResult[]> {
        const results: AgentIterationResult[] = [];
        let currentMessage = initialMessage;

        console.log(`[AlwaysOnAgent] Starting continuous execution (max ${this.config.maxIterations} iterations)`);

        while (this.state.iteration < this.config.maxIterations && this.state.shouldContinue) {
            const iterationStart = Date.now();

            try {
                const result = await this.executeIteration(currentMessage);
                results.push(result);

                if (!result.success) {
                    console.warn(`[AlwaysOnAgent] Iteration ${this.state.iteration} failed:`, result.output);
                    break;
                }

                currentMessage = result.output;
                this.state.iteration++;

                // Check if we should continue
                this.state.shouldContinue = this.shouldContinueIteration(result);

                if (this.state.shouldContinue && this.config.loopDelayMs > 0) {
                    console.log(`[AlwaysOnAgent] Sleeping ${this.config.loopDelayMs}ms before next iteration`);
                    await this.sleep(this.config.loopDelayMs);
                }
            } catch (error) {
                const executionTimeMs = Date.now() - iterationStart;
                results.push({
                    success: false,
                    output: error instanceof Error ? error.message : String(error),
                    state: { ...this.state },
                    toolsUsed: [],
                    executionTimeMs,
                });
                console.error(`[AlwaysOnAgent] Iteration ${this.state.iteration} error:`, error);
                break;
            }
        }

        console.log(`[AlwaysOnAgent] Completed ${results.length} iterations`);
        return results;
    }

    private async executeIteration(message: string): Promise<AgentIterationResult> {
        const startTime = Date.now();
        const toolsUsed: string[] = [];

        try {
            // Get relevant context from memory
            const context = await this.getContext(message);

            // Build the prompt with tools and context
            const toolDescriptions = this.tools.map(t =>
                `- ${t.name}: ${t.description}`
            ).join("\n");

            const prompt = `You are an autonomous agent. You have access to these tools:
${toolDescriptions}

Context from previous interactions:
${context}

Current task: ${message}

Respond with what you want to do next, or say "COMPLETE: <summary>" if the task is finished.`;

            // Call the model
            const response = await this.model.invoke(prompt);
            const output = String(response.content);

            // Track tool usage if any would be used
            for (const tool of this.tools) {
                if (output.toLowerCase().includes(tool.name.toLowerCase())) {
                    toolsUsed.push(tool.name);
                }
            }

            // Store conversation turn
            await recordConversationTurn(
                this.agentWallet.address,
                "assistant",
                output,
                this.state.iteration,
                uuidv4(),
            );

            const executionTimeMs = Date.now() - startTime;

            return {
                success: true,
                output,
                state: { ...this.state, lastMessage: output },
                toolsUsed,
                executionTimeMs,
            };
        } catch (error) {
            const executionTimeMs = Date.now() - startTime;
            return {
                success: false,
                output: error instanceof Error ? error.message : String(error),
                state: this.state,
                toolsUsed,
                executionTimeMs,
            };
        }
    }

    private async getContext(message: string): Promise<string> {
        try {
            const relevant = await getRelevantContext(this.agentWallet.address, message, 5);
            if (!relevant || relevant.length === 0) {
                return "No prior relevant context found.";
            }
            return relevant;
        } catch {
            return "Context retrieval failed.";
        }
    }

    private shouldContinueIteration(result: AgentIterationResult): boolean {
        // Check if output indicates completion
        const output = result.output.toUpperCase();
        if (output.includes("COMPLETE:") || output.includes("FINISHED:") || output.includes("DONE:")) {
            this.state.reason = "Agent indicated task completion";
            return false;
        }

        // Check if no tools were used and output is repetitive
        if (result.toolsUsed.length === 0 && output === this.state.lastMessage) {
            this.state.reason = "No progress made (repetitive output)";
            return false;
        }

        return true;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    getState(): AgentState {
        return { ...this.state };
    }

    stop(): void {
        this.state.shouldContinue = false;
        this.state.reason = "Stopped by user/system";
    }
}

/**
 * Helper function to run an agent in continuous mode
 * This can be called from workflows or directly
 */
export async function runContinuousAgent(
    agentWallet: AgentWallet,
    message: string,
    pluginIds: string[],
    config?: Partial<AlwaysOnAgentConfig>,
): Promise<AgentIterationResult[]> {
    const agent = new AlwaysOnAgent(agentWallet, config);
    await agent.initialize(pluginIds);
    return await agent.runContinuous(message);
}

export type { AlwaysOnAgentConfig, AgentState, AgentIterationResult };
