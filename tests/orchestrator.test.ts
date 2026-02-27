/**
 * Orchestrator Tests
 *
 * Covers in-place orchestration behavior with strict workflow ID invariants,
 * approval gating, and progress execution paths.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import type { Workflow } from "../src/manowar/types.js";

const TEST_WALLET = "0x1234567890123456789012345678901234567890";

let plannerPayload: Record<string, unknown>;
let reflectionPayload: Record<string, unknown>;

const mockModelInvoke = vi.fn(async (messages: Array<{ content?: unknown }>) => {
    const systemPrompt = String(messages?.[0]?.content || "");

    if (systemPrompt.includes("TASK PLANNER")) {
        return { content: JSON.stringify(plannerPayload) };
    }

    if (systemPrompt.includes("STEP REFLECTOR")) {
        return { content: JSON.stringify(reflectionPayload) };
    }

    if (systemPrompt.includes("WORKFLOW REVIEWER")) {
        return {
            content: JSON.stringify({
                hasPastExecutions: false,
                suggestions: [],
                successPatterns: [],
                avoidPatterns: [],
                skipReview: true,
            }),
        };
    }

    return { content: "{}" };
});

const mockDelegatePlanStep = vi.fn(async () => ({
    success: true,
    output: "Analysis complete",
    tokensUsed: 500,
    inputTokens: 200,
    outputTokens: 300,
}));

const mockFetchManowarCard = vi.fn(async () => ({
    schemaVersion: "1.0.0",
    title: "Test Manowar",
    description: "Test orchestration flow",
    dnaHash: "hash",
    walletAddress: TEST_WALLET,
    walletTimestamp: Date.now(),
    agents: [
        {
            schemaVersion: "1.0.0",
            name: "DataAnalyst",
            description: "Analyzes data",
            skills: ["analysis"],
            dnaHash: "a",
            walletAddress: "0x0000000000000000000000000000000000000001",
            chain: 1,
            model: "gpt-4o",
            licensePrice: "0",
            licenses: 0,
            cloneable: false,
            protocols: [],
            plugins: [],
            createdAt: "2026-01-01",
        },
        {
            schemaVersion: "1.0.0",
            name: "Summarizer",
            description: "Summarizes outputs",
            skills: ["summarization"],
            dnaHash: "b",
            walletAddress: "0x0000000000000000000000000000000000000002",
            chain: 1,
            model: "gpt-4o-mini",
            licensePrice: "0",
            licenses: 0,
            cloneable: false,
            protocols: [],
            plugins: [],
            createdAt: "2026-01-01",
        },
    ],
    edges: [{ source: 0, target: 1 }],
    pricing: { totalAgentPrice: "0" },
    creator: TEST_WALLET,
    createdAt: "2026-01-01",
}));

const mockCreateRun = vi.fn((params: { runId?: string; workflowId: string; manowarWallet?: string; input: Record<string, unknown> }) => ({
    runId: params.runId || "run-test-001",
    workflowId: params.workflowId,
    manowarWallet: params.manowarWallet,
    status: "pending" as const,
    input: params.input,
    timing: { createdAt: Date.now() },
}));

class MockLangSmithTokenTracker {
    setCurrentAgent = vi.fn();
    setCurrentModel = vi.fn();
}

class MockContextWindowManager {
    async initialize() {
        return;
    }

    recordUsage() {
        return;
    }

    getState() {
        return {
            currentTokens: 0,
            maxTokens: 128000,
            usagePercent: 0,
            cleanupThreshold: 80,
            needsCleanup: false,
            agentUsage: new Map(),
        };
    }
}

vi.mock("../src/frameworks/langchain.js", () => ({
    createModel: vi.fn(() => ({ invoke: mockModelInvoke })),
}));

vi.mock("../src/manowar/delegation.js", () => ({
    delegatePlanStep: mockDelegatePlanStep,
}));

vi.mock("../src/manowar/registry.js", () => ({
    fetchManowarCard: mockFetchManowarCard,
    buildSystemPromptFromCard: vi.fn(() => "system prompt"),
    normalizeManowarCard: vi.fn((card) => card),
    assertManowarCard: vi.fn(() => undefined),
    clearCardCache: vi.fn(() => undefined),
    discoverAgentTools: vi.fn(async () => []),
}));

vi.mock("../src/manowar/embeddings.js", () => ({
    getRelevantContext: vi.fn(async () => []),
    recordConversationTurn: vi.fn(async () => undefined),
}));

vi.mock("../src/manowar/memory.js", () => ({
    addMemoryWithGraph: vi.fn(async () => []),
    performSafeWipe: vi.fn(async () => undefined),
    searchMemoryWithGraph: vi.fn(async () => ({ memories: [] })),
    getAgentReliability: vi.fn(async () => ({ avgQuality: 0, successRate: 0, totalRuns: 0 })),
}));

vi.mock("../src/manowar/langsmith.js", () => ({
    LangSmithTokenTracker: MockLangSmithTokenTracker,
    isLangSmithEnabled: vi.fn(() => false),
    recordLearning: vi.fn(async () => undefined),
    recordQualityScore: vi.fn(async () => undefined),
    getRelevantLearnings: vi.fn(async () => []),
}));

vi.mock("../src/manowar/checkpoint.js", () => ({
    persistCheckpoints: vi.fn(async () => undefined),
    recordInsight: vi.fn(() => undefined),
    recordObservation: vi.fn(() => undefined),
    recordDecision: vi.fn(() => undefined),
    recordError: vi.fn(() => undefined),
}));

vi.mock("../src/manowar/run-tracker.js", () => ({
    createRun: mockCreateRun,
    startRun: vi.fn(() => undefined),
    completeRun: vi.fn(() => undefined),
    failRun: vi.fn(() => undefined),
}));

vi.mock("../src/manowar/agentic.js", () => ({
    isAgenticCoordinatorModel: vi.fn(() => true),
}));

vi.mock("../src/manowar/context.js", () => ({
    ContextWindowManager: MockContextWindowManager,
}));

let ManowarOrchestrator: (new (workflow: Workflow, coordinatorModel: string) => {
    initialize: (manowarCardUri?: string) => Promise<void>;
    execute: (userRequest: string, options?: Record<string, unknown>) => Promise<any>;
});
let executeWithOrchestrator: (workflow: Workflow, userRequest: string, options?: Record<string, unknown>) => Promise<any>;
let clearCardCache: () => void;

function createTestWorkflow(workflowId: string = `manowar-${TEST_WALLET}`): Workflow {
    return {
        id: workflowId,
        name: "Test Workflow",
        description: "A test workflow for unit testing",
        chainId: 43113,
        steps: [
            {
                id: "step-1",
                name: "DataAnalyst",
                type: "agent",
                agentAddress: "0x0000000000000000000000000000000000000001",
                chainId: 43113,
                inputTemplate: {
                    model: "gpt-4o-mini",
                    plugins: [],
                },
                saveAs: "analysis",
            },
            {
                id: "step-2",
                name: "Summarizer",
                type: "agent",
                agentAddress: "0x0000000000000000000000000000000000000002",
                chainId: 43113,
                inputTemplate: {
                    model: "gpt-4o-mini",
                    plugins: [],
                },
                saveAs: "summary",
            },
        ],
    };
}

beforeAll(async () => {
    process.env.LAMBDA_API_URL = process.env.LAMBDA_API_URL || "https://api.compose.market";
    process.env.RUNTIME_SERVICE_URL = process.env.RUNTIME_SERVICE_URL || "https://runtime.compose.market";
    process.env.MANOWAR_INTERNAL_SECRET = process.env.MANOWAR_INTERNAL_SECRET || "test-secret";

    const orchestratorModule = await import("../src/manowar/orchestrator.js");
    ManowarOrchestrator = orchestratorModule.ManowarOrchestrator as typeof ManowarOrchestrator;
    executeWithOrchestrator = orchestratorModule.executeWithOrchestrator;

    const registryModule = await import("../src/manowar/registry.js");
    clearCardCache = registryModule.clearCardCache;
}, 30000);

describe("ManowarOrchestrator", () => {
    beforeEach(() => {
        plannerPayload = {
            goal_understanding: "Test goal",
            steps: [
                {
                    stepNumber: 1,
                    agentName: "DataAnalyst",
                    agentWallet: "0x0000000000000000000000000000000000000001",
                    task: "Analyze the request",
                    expectedOutput: "Structured analysis",
                    dependsOn: [],
                    estimatedTokens: 1200,
                    priority: "high",
                },
            ],
            total_estimated_tokens: 1200,
        };

        reflectionPayload = {
            success: true,
            qualityScore: 8,
            learnings: ["Good execution"],
            continueWithPlan: true,
        };

        mockModelInvoke.mockClear();
        mockDelegatePlanStep.mockClear();
        mockFetchManowarCard.mockClear();
        mockCreateRun.mockClear();
        clearCardCache();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it("initializes with manowar card", async () => {
        const workflow = createTestWorkflow();
        const orchestrator = new ManowarOrchestrator(workflow, "gpt-4o");

        await orchestrator.initialize("ipfs://test-cid");

        expect(mockFetchManowarCard).toHaveBeenCalledTimes(1);
    });

    it("executes workflow and returns result", async () => {
        const workflow = createTestWorkflow();
        const orchestrator = new ManowarOrchestrator(workflow, "gpt-4o");
        const progressEvents: any[] = [];

        const result = await orchestrator.execute("Test request", {
            manowarCardUri: "ipfs://test-cid",
            onProgress: (event: unknown) => progressEvents.push(event),
            synthesizeFinal: false,
        });

        expect(result.success).toBe(true);
        expect(result.stepResults).toHaveLength(1);
        expect(result.stepResults[0].agentName).toBe("DataAnalyst");
        expect(mockDelegatePlanStep).toHaveBeenCalledTimes(1);
        expect(progressEvents.length).toBeGreaterThan(0);
    });

    it("enforces workflow ID invariant manowar-wallet", async () => {
        const workflow = createTestWorkflow("manowar-0xwrongwallet");
        const orchestrator = new ManowarOrchestrator(workflow, "gpt-4o");

        await expect(orchestrator.execute("Test request", {
            manowarCardUri: "ipfs://test-cid",
        })).rejects.toThrow(`workflow.id mismatch: expected to start with manowar-${TEST_WALLET}`);
    });

    it("requires approval for high-risk steps and executes on approval", async () => {
        plannerPayload = {
            goal_understanding: "Risky goal",
            steps: [
                {
                    stepNumber: 1,
                    agentName: "DataAnalyst",
                    agentWallet: "0x0000000000000000000000000000000000000001",
                    task: "Transfer 10 USDC to target address",
                    expectedOutput: "Transaction hash",
                    dependsOn: [],
                    estimatedTokens: 1800,
                    priority: "high",
                },
            ],
            total_estimated_tokens: 1800,
        };

        const workflow = createTestWorkflow();
        const orchestrator = new ManowarOrchestrator(workflow, "gpt-4o");
        const requestStepApproval = vi.fn(async () => ({
            status: "approved" as const,
            approver: "qa",
            decidedAt: Date.now(),
        }));

        const result = await orchestrator.execute("Perform payment", {
            manowarCardUri: "ipfs://test-cid",
            requestStepApproval,
            synthesizeFinal: false,
        });

        expect(requestStepApproval).toHaveBeenCalledTimes(1);
        expect(mockDelegatePlanStep).toHaveBeenCalledTimes(1);
        expect(result.stepResults[0].success).toBe(true);
    });

    it("does not delegate when risky step is rejected", async () => {
        plannerPayload = {
            goal_understanding: "Risky goal",
            steps: [
                {
                    stepNumber: 1,
                    agentName: "DataAnalyst",
                    agentWallet: "0x0000000000000000000000000000000000000001",
                    task: "Execute on-chain transfer",
                    expectedOutput: "Transaction hash",
                    dependsOn: [],
                    estimatedTokens: 1800,
                    priority: "high",
                },
            ],
            total_estimated_tokens: 1800,
        };

        const workflow = createTestWorkflow();
        const orchestrator = new ManowarOrchestrator(workflow, "gpt-4o");
        const requestStepApproval = vi.fn(async () => ({
            status: "rejected" as const,
            approver: "qa",
            reason: "Policy denied",
            decidedAt: Date.now(),
        }));

        const result = await orchestrator.execute("Perform payment", {
            manowarCardUri: "ipfs://test-cid",
            requestStepApproval,
            synthesizeFinal: false,
        });

        expect(requestStepApproval).toHaveBeenCalledTimes(1);
        expect(mockDelegatePlanStep).toHaveBeenCalledTimes(0);
        expect(result.stepResults[0].success).toBe(false);
        expect(result.stepResults[0].output).toContain("rejected");
    });
});

describe("executeWithOrchestrator", () => {
    beforeEach(() => {
        plannerPayload = {
            goal_understanding: "Test goal",
            steps: [
                {
                    stepNumber: 1,
                    agentName: "DataAnalyst",
                    agentWallet: "0x0000000000000000000000000000000000000001",
                    task: "Analyze",
                    expectedOutput: "Output",
                    dependsOn: [],
                    estimatedTokens: 1000,
                    priority: "high",
                },
            ],
            total_estimated_tokens: 1000,
        };
        reflectionPayload = {
            success: true,
            qualityScore: 8,
            learnings: [],
            continueWithPlan: true,
        };
        mockDelegatePlanStep.mockClear();
        clearCardCache();
    });

    it("executes with default coordinator model", async () => {
        const workflow = createTestWorkflow();
        const result = await executeWithOrchestrator(workflow, "Test request", {
            manowarCardUri: "ipfs://test-cid",
        });

        expect(result.success).toBe(true);
    });

    it("accepts custom coordinator model", async () => {
        const workflow = createTestWorkflow();
        const result = await executeWithOrchestrator(workflow, "Test request", {
            coordinatorModel: "gpt-4o-mini",
            manowarCardUri: "ipfs://test-cid",
        });

        expect(result.success).toBe(true);
    });
});
