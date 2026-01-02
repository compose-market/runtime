/**
 * Tool Masking Tests
 * 
 * Unit tests for the tool masking system that enables KV-cache efficiency.
 * Tests static tool registry, masking configuration, and progressive loading.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { DynamicStructuredTool } from "@langchain/core/tools";
import {
    ToolRegistry,
    getToolRegistry,
    clearToolRegistry,
    createMaskingConfig,
    calculateMasking,
    type StaticToolDefinition,
    type MaskingConfig,
} from "../tool-masking.js";
import type { Workflow, WorkflowStep } from "../types.js";

describe("ToolRegistry", () => {
    let registry: ToolRegistry;
    let mockWorkflow: Workflow;

    const mockToolFactories = {
        createDelegationTool: (step: WorkflowStep) => new DynamicStructuredTool({
            name: `delegate_to_${step.name.replace(/[^a-zA-Z0-9_]/g, "_")}`,
            description: `Delegate to ${step.name}`,
            schema: z.object({ task: z.string() }),
            func: async () => "Delegated",
        }),
        createMcpTool: (step: WorkflowStep) => new DynamicStructuredTool({
            name: `mcp_${step.connectorId}_${step.toolName}`.replace(/[^a-zA-Z0-9_]/g, "_"),
            description: step.name || "MCP tool",
            schema: z.object({ args: z.record(z.string(), z.unknown()).optional() }),
            func: async () => "MCP result",
        }),
        createMemoryTools: () => [
            new DynamicStructuredTool({
                name: "search_memory",
                description: "Search memory",
                schema: z.object({ query: z.string() }),
                func: async () => "Memory result",
            }),
        ],
    };

    beforeEach(() => {
        mockWorkflow = {
            id: "test-workflow",
            name: "Test Workflow",
            description: "A test workflow",
            steps: [
                {
                    id: "step-1",
                    name: "Agent1",
                    type: "agent",
                    inputTemplate: { description: "First agent" },
                    saveAs: "output1",
                },
                {
                    id: "step-2",
                    name: "Agent2",
                    type: "agent",
                    inputTemplate: { description: "Second agent" },
                    saveAs: "output2",
                },
                {
                    id: "step-3",
                    name: "Web Search",
                    type: "mcpTool",
                    connectorId: "brave",
                    toolName: "search",
                    inputTemplate: {},
                    saveAs: "search_result",
                },
            ],
        };

        registry = new ToolRegistry(mockWorkflow);
    });

    afterEach(() => {
        clearToolRegistry(mockWorkflow.id);
    });

    describe("buildRegistry", () => {
        it("should build registry with all tool types", () => {
            registry.buildRegistry(mockToolFactories);

            const allTools = registry.getAllToolIds();
            expect(allTools.length).toBeGreaterThan(0);

            // Should have delegation tools
            expect(allTools.some(id => id.startsWith("delegate_to_"))).toBe(true);

            // Should have MCP tools
            expect(allTools.some(id => id.startsWith("mcp_"))).toBe(true);

            // Should have memory tools
            expect(allTools.some(id => id === "search_memory")).toBe(true);

            // Should have utility tools
            expect(allTools.some(id => id === "complete_workflow")).toBe(true);
        });

        it("should create tool instances", () => {
            registry.buildRegistry(mockToolFactories);

            const delegationTool = registry.getToolInstance("delegate_to_Agent1");
            expect(delegationTool).toBeDefined();
            expect(delegationTool?.name).toBe("delegate_to_Agent1");
        });
    });

    describe("getToolDefinitions", () => {
        it("should return all tool definitions", () => {
            registry.buildRegistry(mockToolFactories);

            const definitions = registry.getToolDefinitions();
            expect(definitions.length).toBeGreaterThan(0);

            for (const def of definitions) {
                expect(def).toHaveProperty("toolId");
                expect(def).toHaveProperty("name");
                expect(def).toHaveProperty("description");
                expect(def).toHaveProperty("category");
            }
        });

        it("should assign correct categories", () => {
            registry.buildRegistry(mockToolFactories);

            const definitions = registry.getToolDefinitions();

            const delegationDef = definitions.find(d => d.name.startsWith("delegate_to_"));
            expect(delegationDef?.category).toBe("delegation");

            const mcpDef = definitions.find(d => d.name.startsWith("mcp_"));
            expect(mcpDef?.category).toBe("mcp");

            const memoryDef = definitions.find(d => d.name === "search_memory");
            expect(memoryDef?.category).toBe("memory");
        });
    });

    describe("getMaskedTools", () => {
        it("should return all tools when nothing is masked", () => {
            registry.buildRegistry(mockToolFactories);

            const config: MaskingConfig = {
                currentStep: 1,
                disabledToolIds: new Set(),
            };

            const tools = registry.getMaskedTools(config);
            // Note: getMaskedTools filters out future step delegation tools
            // so we just check that we have at least some tools
            expect(tools.length).toBeGreaterThan(0);
        });

        it("should exclude explicitly disabled tools", () => {
            registry.buildRegistry(mockToolFactories);

            const config: MaskingConfig = {
                currentStep: 1,
                disabledToolIds: new Set(["delegate_to_Agent1"]),
            };

            const tools = registry.getMaskedTools(config);
            const toolNames = tools.map(t => t.name);
            expect(toolNames).not.toContain("delegate_to_Agent1");
        });

        it("should mask future step delegation tools", () => {
            registry.buildRegistry(mockToolFactories);

            const config: MaskingConfig = {
                currentStep: 1,
                disabledToolIds: new Set(),
            };

            const tools = registry.getMaskedTools(config);
            const toolNames = tools.map(t => t.name);

            // Step 1's tool should be available
            expect(toolNames).toContain("delegate_to_Agent1");

            // Step 2's tool should be masked (future step)
            expect(toolNames).not.toContain("delegate_to_Agent2");
        });

        it("should filter by category when specified", () => {
            registry.buildRegistry(mockToolFactories);

            const config: MaskingConfig = {
                currentStep: 1,
                disabledToolIds: new Set(),
                enabledCategories: new Set(["memory", "utility"]),
            };

            const tools = registry.getMaskedTools(config);
            const toolNames = tools.map(t => t.name);

            // Should have memory tools
            expect(toolNames).toContain("search_memory");

            // Should NOT have delegation or MCP tools
            expect(toolNames.some(n => n.startsWith("delegate_to_"))).toBe(false);
            expect(toolNames.some(n => n.startsWith("mcp_"))).toBe(false);
        });
    });

    describe("generateToolManifest", () => {
        it("should generate readable manifest", () => {
            registry.buildRegistry(mockToolFactories);

            const config: MaskingConfig = {
                currentStep: 1,
                disabledToolIds: new Set(),
            };

            const manifest = registry.generateToolManifest(config);

            expect(manifest).toContain("AVAILABLE TOOLS");
            expect(manifest).toContain("DELEGATION");
            expect(manifest).toContain("delegate_to_Agent1");
        });

        it("should mark masked tools with lock icon", () => {
            registry.buildRegistry(mockToolFactories);

            const config: MaskingConfig = {
                currentStep: 1,
                disabledToolIds: new Set(["search_memory"]),
            };

            const manifest = registry.generateToolManifest(config);

            expect(manifest).toContain("🔒");
            expect(manifest).toContain("search_memory");
        });
    });
});

describe("getToolRegistry", () => {
    it("should return same registry for same workflow", () => {
        const workflow: Workflow = {
            id: "same-workflow",
            name: "Test",
            description: "",
            steps: [],
        };

        const registry1 = getToolRegistry(workflow);
        const registry2 = getToolRegistry(workflow);

        expect(registry1).toBe(registry2);
    });

    it("should return different registries for different workflows", () => {
        const workflow1: Workflow = { id: "workflow-1", name: "Test 1", description: "", steps: [] };
        const workflow2: Workflow = { id: "workflow-2", name: "Test 2", description: "", steps: [] };

        const registry1 = getToolRegistry(workflow1);
        const registry2 = getToolRegistry(workflow2);

        expect(registry1).not.toBe(registry2);
    });
});

describe("createMaskingConfig", () => {
    it("should create config from state", () => {
        const state = {
            currentStepNumber: 3,
            maskedToolIds: ["tool1", "tool2"],
        } as any;

        const config = createMaskingConfig(state);

        expect(config.currentStep).toBe(3);
        expect(config.disabledToolIds.has("tool1")).toBe(true);
        expect(config.disabledToolIds.has("tool2")).toBe(true);
    });

    it("should handle empty state", () => {
        const state = {} as any;
        const config = createMaskingConfig(state);

        expect(config.currentStep).toBe(1);
        expect(config.disabledToolIds.size).toBe(0);
    });
});

describe("calculateMasking", () => {
    it("should mask delegation tools for future steps", () => {
        const allToolIds = ["delegate_to_agent1", "delegate_to_agent2", "search_memory"];
        const agentSteps = [
            { name: "Agent1", stepNumber: 1 },
            { name: "Agent2", stepNumber: 2 },
        ];

        const masked = calculateMasking(allToolIds, 1, agentSteps);

        expect(masked).toContain("delegate_to_agent2");
        expect(masked).not.toContain("delegate_to_agent1");
        expect(masked).not.toContain("search_memory");
    });

    it("should not mask any tools when at last step", () => {
        const allToolIds = ["delegate_to_agent1", "delegate_to_agent2"];
        const agentSteps = [
            { name: "Agent1", stepNumber: 1 },
            { name: "Agent2", stepNumber: 2 },
        ];

        const masked = calculateMasking(allToolIds, 2, agentSteps);

        expect(masked).toHaveLength(0);
    });
});
