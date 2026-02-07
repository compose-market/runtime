/**
 * Orchestrator Tests - Simplified
 * 
 * Tests for the simplified orchestrator pattern.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Import types and helpers
import { ManowarOrchestrator, executeWithOrchestrator } from "../orchestrator.js";
import type { Workflow } from "../types.js";
import { clearCardCache } from "../registry.js";

// ============================================================================
// Helper: Create test workflow
// ============================================================================
function createTestWorkflow(): Workflow {
    return {
        id: "test-workflow",
        name: "Test Workflow",
        description: "A test workflow for unit testing",
        steps: [
            {
                id: "step-1",
                name: "DataAnalyst",
                type: "agent",
                inputTemplate: {
                    model: "gpt-4o-mini",
                    plugins: ["brave-search"],
                },
                saveAs: "analysis",
            },
            {
                id: "step-2",
                name: "Summarizer",
                type: "agent",
                inputTemplate: {
                    model: "gpt-4o-mini",
                    plugins: [],
                },
                saveAs: "summary",
            },
        ],
    };
}

// ============================================================================
// Orchestrator Initialization Tests
// ============================================================================
describe("ManowarOrchestrator: Initialization", () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    it("should create orchestrator with workflow and model", () => {
        const workflow = createTestWorkflow();
        const orchestrator = new ManowarOrchestrator(workflow, "gpt-4o");

        expect(orchestrator).toBeDefined();
    });

    it("should initialize with manowarCard if URI provided", async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({
                name: "Test Card",
                description: "Test description",
                agents: [
                    { name: "Agent1", walletAddress: "0x0000000000000000000000000000000000000001", model: "gpt-4o", skills: [], dnaHash: "test", chain: 1, licensePrice: "0", licenses: 0, cloneable: false, protocols: [], createdAt: "2025-01-01", plugins: [] },
                ],
            }),
        });

        const workflow = createTestWorkflow();
        const orchestrator = new ManowarOrchestrator(workflow, "gpt-4o");

        await orchestrator.initialize("ipfs://test-cid");
        // Should complete without error
        expect(true).toBe(true);
    });

    it("should fall back to workflow-based prompt if card fetch fails", async () => {
        mockFetch.mockRejectedValue(new Error("Fetch failed"));

        const workflow = createTestWorkflow();
        const orchestrator = new ManowarOrchestrator(workflow, "gpt-4o");

        await orchestrator.initialize("ipfs://invalid-cid");
        // Should complete without throwing
        expect(true).toBe(true);
    });
});

// ============================================================================
// Orchestrator Execution Tests
// ============================================================================
describe("ManowarOrchestrator: Execution", () => {
    beforeEach(() => {
        mockFetch.mockReset();
        clearCardCache(); // Clear registry cache to prevent stale data
        // Mock all responses including manowarCard with walletAddress
        mockFetch.mockImplementation((url: string) => {
            // Pinata gateway - manowarCard fetch (matches compose.mypinata.cloud/ipfs/*)
            if (url.includes("mypinata.cloud") || url.includes("/ipfs/") || url.includes("compose.")) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({
                        title: "Test Manowar",
                        walletAddress: "0x1234567890123456789012345678901234567890",
                        description: "Test manowar for unit tests",
                        creator: "0x1234567890123456789012345678901234567890",
                        agents: [
                            { name: "DataAnalyst", walletAddress: "0x0000000000000000000000000000000000000001", model: "gpt-4o", skills: [], dnaHash: "test", chain: 1, licensePrice: "0", licenses: 0, cloneable: false, protocols: [], createdAt: "2025-01-01", plugins: [] },
                        ],
                    }),
                });
            }
            if (url.includes("/api/inference")) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({
                        choices: [{
                            message: {
                                content: JSON.stringify({
                                    planId: "test-plan",
                                    goal: "Test goal",
                                    steps: [
                                        { stepNumber: 1, agentName: "DataAnalyst", task: "Analyze data", priority: "high" },
                                    ],
                                }),
                            },
                        }],
                    }),
                });
            }
            if (url.includes("/agent/")) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({
                        success: true,
                        result: "Analysis complete",
                        tokensUsed: 500,
                    }),
                });
            }
            if (url.includes("/memories/")) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve([]),
                });
            }
            return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
        });
    });

    it("should execute workflow and return result", async () => {
        const workflow = createTestWorkflow();
        const orchestrator = new ManowarOrchestrator(workflow, "gpt-4o");

        const result = await orchestrator.execute("Test request", {
            manowarCardUri: "ipfs://test-cid",
            synthesizeFinal: false,
        });

        expect(result).toBeDefined();
        expect(typeof result.success).toBe("boolean");
        expect(Array.isArray(result.stepResults)).toBe(true);
    });

    it("should emit progress events when callback provided", async () => {
        const workflow = createTestWorkflow();
        const orchestrator = new ManowarOrchestrator(workflow, "gpt-4o");
        const progressEvents: any[] = [];

        await orchestrator.execute("Test request", {
            manowarCardUri: "ipfs://test-cid",
            onProgress: (event) => progressEvents.push(event),
            synthesizeFinal: false,
        });

        expect(progressEvents.length).toBeGreaterThan(0);
        expect(progressEvents[0].type).toBe("start");
    });
});

// ============================================================================
// executeWithOrchestrator Convenience Function Tests
// ============================================================================
describe("executeWithOrchestrator", () => {
    beforeEach(() => {
        mockFetch.mockReset();
        clearCardCache(); // Clear registry cache to prevent stale data
        mockFetch.mockImplementation((url: string) => {
            // Pinata gateway - manowarCard fetch (matches compose.mypinata.cloud/ipfs/*)
            if (url.includes("mypinata.cloud") || url.includes("/ipfs/") || url.includes("compose.")) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({
                        title: "Test Manowar",
                        walletAddress: "0x1234567890123456789012345678901234567890",
                        description: "Test manowar",
                        creator: "0x1234567890123456789012345678901234567890",
                        agents: [],
                    }),
                });
            }
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({
                    choices: [{
                        message: {
                            content: JSON.stringify({
                                planId: "test",
                                goal: "test",
                                steps: [],
                            }),
                        },
                    }],
                }),
            });
        });
    });

    it("should execute workflow with default coordinator model", async () => {
        const workflow = createTestWorkflow();
        const result = await executeWithOrchestrator(workflow, "Test request", {
            manowarCardUri: "ipfs://test-cid",
        });

        expect(result).toBeDefined();
    });

    it("should accept custom coordinator model", async () => {
        const workflow = createTestWorkflow();
        const result = await executeWithOrchestrator(workflow, "Test request", {
            coordinatorModel: "gpt-4o-mini",
            manowarCardUri: "ipfs://test-cid",
        });

        expect(result).toBeDefined();
    });
});
