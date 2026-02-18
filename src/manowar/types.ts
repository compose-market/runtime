/**
 * Manowar Types
 * 
 * Type definitions for Manowar workflow execution.
 * A Manowar is a collection of agents orchestrated to complete a task.
 */

// =============================================================================
// Workflow Step Types
// =============================================================================

export type StepType =
    | "inference"
    | "mcpTool"
    | "connectorTool"
    | "agent"
    | "condition"
    | "loop"
    | "trigger"
    | "hook"
    | "webhook"
    | "schedule";

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

    // For trigger/schedule steps
    triggerId?: string;
    /** Coordinator model (from manowar registry) */
    coordinatorModel?: string;
    triggerConfig?: TriggerDefinition;

    // For hook steps
    hookConfig?: HookDefinition;

    // Input mapping - can reference previous step outputs
    inputTemplate: Record<string, unknown>;

    // Where to store output for later steps
    saveAs: string;

    // Optional conditions for execution
    condition?: string;
}

// =============================================================================
// Trigger Definitions (n8n-inspired pattern)
// =============================================================================

export type TriggerType = "cron" | "webhook" | "event" | "manual";

export type RecurrenceInterval = "minutes" | "hours" | "days" | "weeks" | "months";

export interface RecurrenceRule {
    enabled: boolean;
    intervalSize: number;
    intervalType: RecurrenceInterval;
}

export interface TriggerDefinition {
    id: string;
    /** Reference to the Manowar workflow via wallet address */
    manowarWallet: string;
    /** Human-readable name */
    name: string;
    /** Trigger type */
    type: TriggerType;
    /** Original natural language input from user */
    nlDescription: string;
    /** Parsed cron expression (for cron/schedule triggers) */
    cronExpression?: string;
    /** Human-readable cron description */
    cronReadable?: string;
    /** Timezone for cron execution */
    timezone: string;
    /** Whether trigger is active */
    enabled: boolean;
    /** Recurrence rules for non-cron patterns */
    recurrence?: RecurrenceRule;
    /** Webhook URL (for webhook triggers) */
    webhookUrl?: string;
    /** Event filter pattern (for event triggers) */
    eventPattern?: string;
    /** Default input template when triggered */
    inputTemplate?: Record<string, unknown>;
    /** Last execution timestamp */
    lastRun?: number;
    /** Next scheduled run timestamp */
    nextRun?: number;
    /** Creation timestamp */
    createdAt: number;
    /** Last update timestamp */
    updatedAt: number;
    /** mem0 memory ID for persistence */
    memoryId?: string;
}

// =============================================================================
// Hook Definitions (lifecycle events)
// =============================================================================

export type HookType =
    | "pre-execution"      // Before workflow starts
    | "post-step"          // After each step completes
    | "on-error"           // When any step fails
    | "on-complete"        // When workflow completes successfully
    | "on-context-cleanup" // When context window cleanup is triggered
    | "on-restart";        // When workflow restarts after cleanup

export type HookActionType = "notify" | "webhook" | "agent" | "memory" | "log";

export interface HookAction {
    type: HookActionType;
    /** Webhook URL for webhook actions */
    webhookUrl?: string;
    /** Agent ID for agent actions */
    agentId?: number | string;
    /** Notification channel for notify actions */
    notifyChannel?: string;
    /** Memory operation for memory actions */
    memoryOperation?: "save" | "search" | "summarize";
    /** Additional config */
    config?: Record<string, unknown>;
}

export interface HookDefinition {
    id: string;
    /** Reference to the Manowar workflow via wallet address */
    manowarWallet: string;
    /** Human-readable name */
    name: string;
    /** When this hook fires */
    type: HookType;
    /** Optional condition expression for conditional execution */
    condition?: string;
    /** Step ID filter (for post-step hooks) */
    stepFilter?: string[];
    /** Action to perform */
    action: HookAction;
    /** Whether hook is active */
    enabled: boolean;
    /** Priority (lower = runs first) */
    priority: number;
    /** Creation timestamp */
    createdAt: number;
}

// =============================================================================
// Agent & Manowar Card Types (Canonical - matches pinata.ts)
// =============================================================================

/**
 * AgentCard - Canonical agent metadata from IPFS
 * Single source of truth for agent configuration.
 */
export interface AgentCard {
    /** Schema version for forward compatibility */
    schemaVersion: string;
    /** Agent display name */
    name: string;
    /** Agent description */
    description: string;
    /** Agent capabilities/skills */
    skills: string[];
    /** Avatar/banner image URL (gateway URL) */
    image?: string;
    /** DNA hash from on-chain */
    dnaHash: string;
    /** Agent's derived wallet address - SINGLE SOURCE OF TRUTH */
    walletAddress: string;
    /** Timestamp used in wallet derivation */
    walletTimestamp?: number;
    /** Chain ID */
    chain: number;
    /** Model ID for inference (used to fetch contextWindow from API) */
    model: string;
    /** Agent runtime framework */
    framework?: "eliza" | "langchain" | "openclaw";
    /** License price in USDC (6 decimals) */
    licensePrice: string;
    /** License supply cap (0 = infinite) */
    licenses: number;
    /** Whether agent can be cloned */
    cloneable: boolean;
    /** Agent API endpoint */
    endpoint?: string;
    /** Supported protocols */
    protocols: Array<{ name: string; version: string }>;
    /** Plugins/tools available to this agent */
    plugins?: Array<{
        registryId: string;
        name: string;
        origin: string;
    }>;
    /** Creation timestamp */
    createdAt: string;
    /** Creator wallet address */
    creator?: string;
}

/**
 * ManowarCard - Canonical manowar/workflow metadata from IPFS
 * Contains embedded AgentCards and workflow graph edges.
 */
export interface ManowarCard {
    /** Schema version */
    schemaVersion: string;
    /** Manowar title */
    title: string;
    /** Manowar description */
    description: string;
    /** Banner image URL */
    image?: string;
    /** DNA hash from on-chain */
    dnaHash: string;
    /** Manowar's derived wallet address - SINGLE SOURCE OF TRUTH */
    walletAddress: string;
    /** Timestamp used in wallet derivation */
    walletTimestamp: number;
    /** Embedded agent cards (full metadata, not just references) */
    agents: AgentCard[];
    /** Workflow graph edges (agent execution order) */
    edges?: Array<{
        /** Source agent index or ID */
        source: number;
        /** Target agent index or ID */
        target: number;
        /** Edge description */
        label?: string;
    }>;
    /** Coordinator configuration */
    coordinator?: {
        hasCoordinator: boolean;
        /** Coordinator model ID (only if hasCoordinator=true) */
        model: string;
    };
    /** Pricing information */
    pricing: {
        totalAgentPrice: string;
    };
    /** Lease configuration */
    lease?: {
        enabled: boolean;
        durationDays: number;
        creatorPercent: number;
    };
    /** Request-For-Agent configuration */
    rfa?: {
        title: string;
        description: string;
        skills: string[];
        offerAmount: string;
    };
    /** Creator wallet address */
    creator: string;
    /** Creation timestamp */
    createdAt: string;
}

// =============================================================================
// Token & Context Window Management
// =============================================================================

export interface TokenUsage {
    /** Agent or coordinator identifier */
    agentId: string;
    /** Model used for inference */
    model: string;
    /** Input tokens consumed */
    inputTokens: number;
    /** Output tokens generated */
    outputTokens: number;
    /** Total tokens (input + output) */
    totalTokens: number;
    /** Timestamp of measurement */
    timestamp: number;
}

export interface ContextWindowState {
    /** Total tokens currently in context */
    currentTokens: number;
    /** Maximum context window size for the model */
    maxTokens: number;
    /** Usage percentage (0-100) */
    usagePercent: number;
    /** Threshold percentage for cleanup trigger */
    cleanupThreshold: number;
    /** Whether cleanup is needed */
    needsCleanup: boolean;
    /** Token usage per agent */
    agentUsage: Map<string, TokenUsage>;
    /** Last cleanup timestamp */
    lastCleanup?: number;
}

export interface WorkflowStateSummary {
    /** Compressed summary of workflow state */
    summary: string;
    /** Key facts extracted for RAG retrieval */
    keyFacts: string[];
    /** Agent-specific context summaries */
    agentSummaries: Record<string, string>;
    /** Important results to preserve */
    preservedResults: Record<string, unknown>;
    /** Timestamp of summarization */
    createdAt: number;
    /** mem0 memory ID for this summary */
    memoryId?: string;
}

// =============================================================================
// Workflow (Extended with triggers/hooks)
// =============================================================================

export interface Workflow {
    id: string;
    name: string;
    description: string;
    steps: WorkflowStep[];
    /** Triggers that can start this workflow */
    triggers?: TriggerDefinition[];
    /** Lifecycle hooks */
    hooks?: HookDefinition[];
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
    manowarId: number; // On-chain token ID (kept for contract reference)
    walletAddress: string; // Primary identifier
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
// Execution State (Extended with token tracking)
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
    /** Token usage for this step */
    tokenUsage?: TokenUsage;
}

export interface WorkflowExecutionState {
    workflowId: string;
    manowarWallet?: string;
    status: "pending" | "running" | "success" | "error";
    startTime: number;
    endTime?: number;
    steps: StepExecutionResult[];
    context: Record<string, unknown>; // Accumulated step outputs
    totalCostWei: string;
    error?: string;
    /** Triggered by (trigger ID if auto-triggered) */
    triggeredBy?: string;
    /** Token tracking state */
    tokenState?: ContextWindowState;
    /** Summarized state for resumption */
    stateSummary?: WorkflowStateSummary;
    /** Whether this is a resumed execution */
    isResumed?: boolean;
    /** Previous execution ID if resumed */
    resumedFrom?: string;
}

// =============================================================================
// Payment Context
// =============================================================================

export interface PaymentContext {
    /** PAYMENT-SIGNATURE header value from client (v2) */
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

/** 
 * SSE Progress Event types for streaming
 * 
 * Event types:
 * - start: Workflow execution started
 * - progress: General progress update (percentage)
 * - step: Workflow step started/completed
 * - agent: Agent delegation event
 * - tool_start: Tool execution started
 * - tool_end: Tool execution completed
 * - response: Intermediate response from agent/tool
 * - result: Final workflow result
 * - error: Error occurred
 * - done: Workflow execution completed (success or failure)
 */
export interface SSEProgressEvent {
    type: "start" | "progress" | "step" | "agent" | "tool_start" | "tool_end" | "response" | "result" | "error" | "done";
    timestamp: number;
    data: {
        runId?: string;
        stepName?: string;
        stepIndex?: number;
        totalSteps?: number;
        agentName?: string;
        agentWallet?: string;
        toolName?: string;
        message?: string;
        output?: string;
        error?: string;
        tokenCount?: number;
        tokensUsed?: number;
        tokenBudget?: number;
        cost?: number;
        progress?: number; // 0-100
        duration?: number; // ms
    };
}

export type StepApprovalStatus = "approved" | "rejected";

export interface StepApprovalRequest {
    runId: string;
    workflowId: string;
    walletAddress: string;
    stepNumber: number;
    stepKey: string;
    agentName: string;
    agentWallet?: string;
    task: string;
    expectedOutput: string;
    priority: "critical" | "high" | "medium" | "low";
    riskReason: string;
    requestedAt: number;
}

export interface StepApprovalDecision {
    status: StepApprovalStatus;
    approver?: string;
    reason?: string;
    decidedAt: number;
}

export interface ExecutionRunStateProjection {
    runId: string;
    workflowId: string;
    walletAddress: string;
    status: "pending" | "running" | "continuous" | "blocked_approval" | "success" | "error" | "cancelled";
    startedAt: number;
    updatedAt: number;
    progress: number;
    message?: string;
    currentStep?: number;
    totalSteps?: number;
    error?: string;
    output?: string;
    pendingApprovalStepKey?: string;
}

export interface ExecutorOptions {
    /** Payment context for x402 */
    payment: PaymentContext;
    /** Initial input to the workflow */
    input: Record<string, unknown>;
    /** Callback for step status updates */
    onStepUpdate?: (result: StepExecutionResult) => void;
    /** SSE progress callback for real-time streaming */
    onProgress?: (event: SSEProgressEvent) => void;
    /** Whether to continue on step errors */
    continueOnError?: boolean;
    /** Maximum execution time in ms */
    timeout?: number;
    /** Token cleanup threshold (0-100, default 80) */
    tokenCleanupThreshold?: number;
    /** Callback for token state updates */
    onTokenStateUpdate?: (state: ContextWindowState) => void;
    /** Resumed state summary for continuation */
    resumeState?: WorkflowStateSummary;
    /** Trigger ID if auto-triggered */
    triggerId?: string;
    /** Coordinator model (user-selected at mint time via compose.tsx) */
    coordinatorModel?: string;
    /** IPFS URI to manowarCard */
    manowarCardUri?: string;
    /** Attachment URL (image, document, etc.) to include in context */
    attachmentUrl?: string;
    /** End-user identity for nested standalone-agent delegation */
    userId?: string;
    /** Conversation thread identifier propagated to delegated agents */
    threadId?: string;
    /** Orchestrating workflow wallet for delegated agent context */
    manowarWallet?: string;
    /** Whether to synthesize final response using coordinator model */
    synthesizeFinal?: boolean;
    /** Allow replanning on invalid plans or failed steps */
    replanOnFailure?: boolean;
    /** Maximum number of plan iterations (default 2) */
    maxPlanIterations?: number;
    /** Enable continuous/looping execution */
    continuous?: boolean;
    /** Maximum number of continuous loop iterations (default 3) */
    maxLoopIterations?: number;
    /** Delay between continuous loops (ms, default 0) */
    loopDelayMs?: number;
    /** Cancellation check for long-running workflows */
    shouldCancel?: () => boolean;
    /** Optional externally supplied run ID (used by Temporal routing) */
    runId?: string;
    /** Optional step approval callback for risky steps */
    requestStepApproval?: (request: StepApprovalRequest) => Promise<StepApprovalDecision>;
    /** Optional callback for projected run state updates */
    onRunStateUpdate?: (state: ExecutionRunStateProjection) => void;
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
