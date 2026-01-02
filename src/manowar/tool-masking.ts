/**
 * Tool Masking System
 * 
 * Implements tool masking for KV-cache efficiency.
 * 
 * Instead of dynamically adding/removing tools (which destroys cache),
 * we maintain a static tool list and mask unavailable tools at runtime.
 * 
 * Key Benefits:
 * - Tool definitions stay constant → KV-cache preserved
 * - Progressive tool availability via masking
 * - Reduced token overhead from schema changes
 * 
 * Based on Manus Context Engineering principles (Jan 2026)
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { ManowarState } from "./state.js";
import type { Workflow, WorkflowStep } from "./types.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Static tool definition (immutable after creation)
 */
export interface StaticToolDefinition {
    /** Tool ID (stable identifier) */
    toolId: string;
    /** Tool name for LLM */
    name: string;
    /** Tool description */
    description: string;
    /** Tool category for filtering */
    category: "delegation" | "memory" | "mcp" | "utility";
    /** Target agent (for delegation tools) */
    targetAgent?: string;
    /** Step number this tool becomes available */
    availableFromStep?: number;
    /** Whether tool is always available */
    alwaysAvailable: boolean;
}

/**
 * Masking configuration
 */
export interface MaskingConfig {
    /** Current step number */
    currentStep: number;
    /** Explicitly disabled tool IDs */
    disabledToolIds: Set<string>;
    /** Only show these categories */
    enabledCategories?: Set<string>;
}

// =============================================================================
// Tool Registry
// =============================================================================

/**
 * Registry of all possible tools for a workflow
 * This is built once and never modified during execution
 */
export class ToolRegistry {
    private tools: Map<string, StaticToolDefinition> = new Map();
    private toolInstances: Map<string, DynamicStructuredTool> = new Map();
    private workflow: Workflow;

    constructor(workflow: Workflow) {
        this.workflow = workflow;
    }

    /**
     * Build the complete static tool registry
     * Called once at workflow start
     */
    buildRegistry(toolFactories: {
        createDelegationTool: (step: WorkflowStep) => DynamicStructuredTool;
        createMcpTool: (step: WorkflowStep) => DynamicStructuredTool | null;
        createMemoryTools: () => DynamicStructuredTool[];
    }): void {
        // 1. Add delegation tools for each agent
        const agentSteps = this.workflow.steps.filter(s => s.type === "agent");
        for (let i = 0; i < agentSteps.length; i++) {
            const step = agentSteps[i];
            const toolId = `delegate_to_${step.name.replace(/[^a-zA-Z0-9_]/g, "_")}`;

            this.tools.set(toolId, {
                toolId,
                name: toolId,
                description: `Delegate task to ${step.name}`,
                category: "delegation",
                targetAgent: step.name,
                availableFromStep: i + 1,
                alwaysAvailable: false,
            });

            const tool = toolFactories.createDelegationTool(step);
            this.toolInstances.set(toolId, tool);
        }

        // 2. Add MCP/connector tools
        for (const step of this.workflow.steps) {
            if (step.type === "mcpTool" || step.type === "connectorTool") {
                if (!step.connectorId || !step.toolName) continue;

                const toolId = `mcp_${step.connectorId}_${step.toolName}`.replace(/[^a-zA-Z0-9_]/g, "_");

                this.tools.set(toolId, {
                    toolId,
                    name: toolId,
                    description: step.name || `${step.toolName} via ${step.connectorId}`,
                    category: "mcp",
                    alwaysAvailable: true, // MCP tools always available
                });

                const tool = toolFactories.createMcpTool(step);
                if (tool) {
                    this.toolInstances.set(toolId, tool);
                }
            }
        }

        // 3. Add memory tools (always available)
        const memoryTools = toolFactories.createMemoryTools();
        for (const tool of memoryTools) {
            const toolId = tool.name;

            this.tools.set(toolId, {
                toolId,
                name: tool.name,
                description: tool.description,
                category: "memory",
                alwaysAvailable: true,
            });

            this.toolInstances.set(toolId, tool);
        }

        // 4. Add utility tools
        this.addUtilityTools();

        console.log(`[tool-masking] Built registry with ${this.tools.size} static tools`);
    }

    /**
     * Add utility tools that are always available
     */
    private addUtilityTools(): void {
        // Context retrieval tool
        const retrieveContextTool = new DynamicStructuredTool({
            name: "retrieve_context",
            description: "Retrieve content from a previously stored context file by its file ID",
            schema: z.object({
                fileId: z.string().describe("The file ID to retrieve"),
            }),
            func: async ({ fileId }) => {
                // This will be implemented by the orchestrator
                return `[Placeholder: Content of ${fileId} would be retrieved here]`;
            },
        });

        this.tools.set("retrieve_context", {
            toolId: "retrieve_context",
            name: "retrieve_context",
            description: "Retrieve content from a stored context file",
            category: "utility",
            alwaysAvailable: true,
        });
        this.toolInstances.set("retrieve_context", retrieveContextTool);

        // Complete workflow tool (signals completion)
        const completeWorkflowTool = new DynamicStructuredTool({
            name: "complete_workflow",
            description: "Signal that the workflow is complete and provide the final result to the user",
            schema: z.object({
                result: z.string().describe("The final result to present to the user"),
                summary: z.string().optional().describe("Brief summary of what was accomplished"),
            }),
            func: async ({ result, summary }) => {
                return JSON.stringify({ completed: true, result, summary });
            },
        });

        this.tools.set("complete_workflow", {
            toolId: "complete_workflow",
            name: "complete_workflow",
            description: "Signal workflow completion and return final result",
            category: "utility",
            alwaysAvailable: true,
        });
        this.toolInstances.set("complete_workflow", completeWorkflowTool);
    }

    /**
     * Get all tool IDs (for state initialization)
     */
    getAllToolIds(): string[] {
        return Array.from(this.tools.keys());
    }

    /**
     * Get tool definitions (for system prompt)
     */
    getToolDefinitions(): StaticToolDefinition[] {
        return Array.from(this.tools.values());
    }

    /**
     * Get a specific tool instance
     */
    getToolInstance(toolId: string): DynamicStructuredTool | undefined {
        return this.toolInstances.get(toolId);
    }

    /**
     * Get all tool instances (for binding)
     */
    getAllToolInstances(): DynamicStructuredTool[] {
        return Array.from(this.toolInstances.values());
    }

    /**
     * Get masked tool instances based on current configuration
     * Returns only the tools that should be available
     */
    getMaskedTools(config: MaskingConfig): DynamicStructuredTool[] {
        const result: DynamicStructuredTool[] = [];

        for (const [toolId, definition] of this.tools) {
            // Check if tool should be masked
            if (this.isToolMasked(toolId, definition, config)) {
                continue;
            }

            const instance = this.toolInstances.get(toolId);
            if (instance) {
                result.push(instance);
            }
        }

        return result;
    }

    /**
     * Determine if a tool should be masked (hidden)
     */
    private isToolMasked(
        toolId: string,
        definition: StaticToolDefinition,
        config: MaskingConfig
    ): boolean {
        // Explicitly disabled
        if (config.disabledToolIds.has(toolId)) {
            return true;
        }

        // Category filter
        if (config.enabledCategories && !config.enabledCategories.has(definition.category)) {
            return true;
        }

        // Step-based availability for delegation tools
        if (definition.availableFromStep !== undefined) {
            // For progressive loading: only show current step's delegation tool
            // This reduces the number of visible delegation tools
            if (definition.category === "delegation") {
                // Show delegation tools for current step and completed steps
                if (definition.availableFromStep > config.currentStep) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Generate tool manifest for system prompt (stable, cacheable)
     * Lists all tools but marks availability
     */
    generateToolManifest(config: MaskingConfig): string {
        const lines: string[] = ["## AVAILABLE TOOLS"];

        // Group by category
        const byCategory = new Map<string, StaticToolDefinition[]>();
        for (const def of this.tools.values()) {
            const cat = def.category;
            if (!byCategory.has(cat)) {
                byCategory.set(cat, []);
            }
            byCategory.get(cat)!.push(def);
        }

        for (const [category, defs] of byCategory) {
            lines.push(`\n### ${category.toUpperCase()}`);
            for (const def of defs) {
                const masked = this.isToolMasked(def.toolId, def, config);
                const status = masked ? "🔒" : "✓";
                lines.push(`- ${status} \`${def.name}\`: ${def.description}`);
            }
        }

        lines.push(`\nNote: 🔒 tools are not available in the current step.`);

        return lines.join("\n");
    }
}

// =============================================================================
// Masking Helpers
// =============================================================================

/**
 * Create masking config from state
 */
export function createMaskingConfig(state: ManowarState): MaskingConfig {
    return {
        currentStep: state.currentStepNumber || 1,
        disabledToolIds: new Set(state.maskedToolIds || []),
    };
}

/**
 * Update state with masking information
 */
export function updateMaskingState(
    state: Partial<ManowarState>,
    registry: ToolRegistry
): Partial<ManowarState> {
    return {
        ...state,
        staticToolIds: registry.getAllToolIds(),
    };
}

/**
 * Calculate tool masking for progressive loading
 * Returns tool IDs that should be masked at the current step
 */
export function calculateMasking(
    allToolIds: string[],
    currentStep: number,
    agentSteps: Array<{ name: string; stepNumber: number }>
): string[] {
    const masked: string[] = [];

    for (const toolId of allToolIds) {
        // Mask delegation tools for future steps (progressive loading)
        if (toolId.startsWith("delegate_to_")) {
            const agentName = toolId.replace("delegate_to_", "").toLowerCase();
            const stepDef = agentSteps.find(
                s => s.name.toLowerCase().replace(/[^a-z0-9]/g, "_") === agentName
            );

            if (stepDef && stepDef.stepNumber > currentStep) {
                masked.push(toolId);
            }
        }
    }

    return masked;
}

// =============================================================================
// Singleton Registry Manager
// =============================================================================

const registries = new Map<string, ToolRegistry>();

/**
 * Get or create a tool registry for a workflow
 */
export function getToolRegistry(workflow: Workflow): ToolRegistry {
    let registry = registries.get(workflow.id);
    if (!registry) {
        registry = new ToolRegistry(workflow);
        registries.set(workflow.id, registry);
    }
    return registry;
}

/**
 * Clear registry for a workflow (cleanup)
 */
export function clearToolRegistry(workflowId: string): void {
    registries.delete(workflowId);
}
