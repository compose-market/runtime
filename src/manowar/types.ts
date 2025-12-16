/**
 * Manowar Types
 * 
 * Type definitions for Manowar workflow execution.
 * A Manowar is a collection of agents orchestrated to complete a task.
 */

// =============================================================================
// Workflow Step Types
// =============================================================================

export type StepType = "inference" | "mcpTool" | "connectorTool" | "agent" | "condition" | "loop";

export interface WorkflowStep {
    id: string;
    name: string;
    type: StepType;

    // For inference steps
    modelId?: string;
    systemPrompt?: string;

    // For MCP tool steps
    connectorId?: string;
    toolName?: string;

    // For agent steps
    agentId?: number;
    agentAddress?: string;

    // Input mapping - can reference previous step outputs
    inputTemplate: Record<string, unknown>;

    // Where to store output for later steps
    saveAs: string;

    // Optional conditions for execution
    condition?: string;
}

export interface Workflow {
    id: string;
    name: string;
    description: string;
    steps: WorkflowStep[];
    // Execution graph edges (source -> target step connections)
    edges?: Array<{
        source: string; // step id
        target: string; // step id
        label?: string;
    }>;
}

// =============================================================================
// Manowar (On-Chain Workflow NFT)
// =============================================================================

export interface ManowarMetadata {
    manowarId: number;
    title: string;
    description: string;
    banner?: string;
    manowarCardUri: string;
    totalPrice: string; // Price in USDC wei (6 decimals)
    units: number;
    leaseEnabled: boolean;
    leaseDuration: number;
    leasePercent: number;
    hasCoordinator: boolean;
    coordinatorModel: string;
    agentIds: number[];
}

// =============================================================================
// Execution State
// =============================================================================

export interface StepExecutionResult {
    stepId: string;
    stepName: string;
    status: "pending" | "running" | "success" | "error";
    startTime: number;
    endTime?: number;
    output?: unknown;
    error?: string;
    costWei?: string;
    txHash?: string;
}

export interface WorkflowExecutionState {
    workflowId: string;
    manowarId?: number;
    status: "pending" | "running" | "success" | "error";
    startTime: number;
    endTime?: number;
    steps: StepExecutionResult[];
    context: Record<string, unknown>; // Accumulated step outputs
    totalCostWei: string;
    error?: string;
}

// =============================================================================
// Payment Context
// =============================================================================

export interface PaymentContext {
    /** x-payment header value from client */
    paymentData: string | null;
    /** Whether a session budget is active */
    sessionActive: boolean;
    /** Remaining session budget in USDC wei - null if no session */
    sessionBudgetRemaining: number | null;
    /** Resource URL base for x402 */
    resourceUrlBase: string;
    /** Authenticated user address (if known) */
    userId?: string;
}

// =============================================================================
// Executor Options
// =============================================================================

export interface ExecutorOptions {
    /** Payment context for x402 */
    payment: PaymentContext;
    /** Initial input to the workflow */
    input: Record<string, unknown>;
    /** Callback for step status updates */
    onStepUpdate?: (result: StepExecutionResult) => void;
    /** Whether to continue on step errors */
    continueOnError?: boolean;
    /** Maximum execution time in ms */
    timeout?: number;
}

// =============================================================================
// Pricing
// =============================================================================

export const MANOWAR_PRICES = {
    /** Orchestration fee per workflow execution */
    ORCHESTRATION: "10000", // $0.01
    /** Per-agent invocation within workflow */
    AGENT_STEP: "5000", // $0.005
    /** Per-inference call within agent */
    INFERENCE: "5000", // $0.005
    /** Per-MCP tool call within agent */
    MCP_TOOL: "1000", // $0.001
} as const;
