import { Context } from "@temporalio/activity";
import { executeAgent } from "../frameworks/langchain.js";
import { getManowar, resolveAgent } from "../frameworks/runtime.js";
import { ManowarOrchestrator } from "../manowar/orchestrator.js";
import type { ExecutionRunStateProjection, StepApprovalDecision, StepApprovalRequest, WorkflowStep, ExecutorOptions } from "../manowar/types.js";
import {
    APPROVAL_BLOCKED_POLL_INTERVAL_MS,
    APPROVAL_POLL_INTERVAL_MS,
    APPROVAL_TIMEOUT_MS,
    QUERY_GET_APPROVAL_DECISION,
    SIGNAL_REPORT_PROGRESS,
} from "./constants.js";
import { getTemporalClient } from "./client.js";
import type { ExecuteAgentWorkflowInput, ExecuteManowarWorkflowInput, ManowarWorkflowResult, ProgressSignalPayload } from "./types.js";

const ACTIVITY_HEARTBEAT_INTERVAL_MS = 30000; // Optimized: 30s instead of 5s (6x cost reduction)
const APPROVAL_MAX_WAIT_MS = 60 * 60 * 1000;

// Payload size limits per Temporal Cloud best practices
const MAX_PAYLOAD_SIZE_BYTES = 2 * 1024 * 1024; // 2MB limit for single payload
const MAX_TOTAL_PAYLOAD_SIZE_BYTES = 4 * 1024 * 1024; // 4MB limit for total gRPC message

function validatePayloadSize(payload: unknown, context: string): void {
    const serialized = JSON.stringify(payload);
    const sizeBytes = Buffer.byteLength(serialized, "utf8");
    
    if (sizeBytes > MAX_PAYLOAD_SIZE_BYTES) {
        const error = new Error(
            `${context} payload exceeds 2MB limit (${(sizeBytes / 1024 / 1024).toFixed(2)}MB). ` +
            `Consider storing large data externally and passing references.`
        );
        error.name = "ValidationError";
        throw error;
    }
}

function validateTotalPayloadSize(inputs: unknown[]): void {
    let totalSize = 0;
    for (const input of inputs) {
        totalSize += Buffer.byteLength(JSON.stringify(input), "utf8");
    }
    
    if (totalSize > MAX_TOTAL_PAYLOAD_SIZE_BYTES) {
        const error = new Error(
            `Total payload size exceeds 4MB limit (${(totalSize / 1024 / 1024).toFixed(2)}MB). ` +
            `Reduce batch size or store data externally.`
        );
        error.name = "ValidationError";
        throw error;
    }
}

function resolveWorkflow(input: ExecuteManowarWorkflowInput): NonNullable<ExecuteManowarWorkflowInput["workflow"]> {
    if (input.workflow) {
        return input.workflow;
    }
    const walletAddress = input.walletAddress;
    if (!walletAddress) {
        const error = new Error("walletAddress or workflow is required");
        error.name = "ValidationError";
        throw error;
    }

    const manowar = getManowar(walletAddress);
    if (!manowar) {
        const error = new Error(`Manowar not found for wallet ${walletAddress}`);
        error.name = "ValidationError";
        throw error;
    }

    const steps: WorkflowStep[] = [];
    for (const agentWallet of (manowar.agentWalletAddresses || [])) {
        const agent = resolveAgent(agentWallet);
        steps.push({
            id: `agent-${agentWallet.slice(0, 8)}`,
            name: agent?.name || `Agent ${agentWallet.slice(0, 8)}`,
            type: "agent",
            agentAddress: agentWallet,
            inputTemplate: {
                agentAddress: agentWallet,
                agentCardUri: agent?.agentCardUri,
            },
            saveAs: `agent_${agentWallet.slice(0, 8)}_output`,
        });
    }

    return {
        id: `manowar-${walletAddress}`,
        name: manowar.title || `Manowar ${walletAddress.slice(0, 8)}`,
        description: manowar.description || "",
        steps,
    };
}

function isRetryableError(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
        normalized.includes("timeout") ||
        normalized.includes("aborted") ||
        normalized.includes("429") ||
        normalized.includes("500") ||
        normalized.includes("502") ||
        normalized.includes("503") ||
        normalized.includes("504") ||
        normalized.includes("econnreset") ||
        normalized.includes("enotfound") ||
        normalized.includes("network") ||
        normalized.includes("temporarily unavailable") ||
        normalized.includes("rate limit")
    );
}

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

function startPeriodicHeartbeat(details: Record<string, unknown>): NodeJS.Timeout {
    return setInterval(() => {
        try {
            Context.current().heartbeat(details);
        } catch {
            // Ignore heartbeat errors here; Temporal will handle cancellation/timeouts.
        }
    }, ACTIVITY_HEARTBEAT_INTERVAL_MS);
}

async function signalWorkflowProgress(payload: ProgressSignalPayload): Promise<void> {
    const info = Context.current().info;
    try {
        const client = await getTemporalClient();
        const handle = client.workflow.getHandle(info.workflowExecution.workflowId);
        await handle.signal(SIGNAL_REPORT_PROGRESS, payload);
    } catch (error) {
        console.warn("[temporal/activity] Failed to signal workflow progress:", error);
    }
}

async function waitForApproval(
    request: StepApprovalRequest,
    timeoutMs: number,
): Promise<StepApprovalDecision> {
    const info = Context.current().info;
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(info.workflowExecution.workflowId);

    const startedAt = Date.now();
    let blocked = false;
    let failedPreconditionCount = 0;
    let consecutiveQueryErrors = 0;
    const MAX_FAILED_PRECONDITION_RETRIES = 3;
    const MAX_CONSECUTIVE_QUERY_ERRORS = 10;

    while (true) {
        try {
            const decision = await handle.query(
                QUERY_GET_APPROVAL_DECISION,
                request.stepKey,
            ) as StepApprovalDecision | null;
            failedPreconditionCount = 0;
            consecutiveQueryErrors = 0;
            if (decision) {
                return decision;
            }
        } catch (error) {
            consecutiveQueryErrors += 1;
            const message = error instanceof Error ? error.message : String(error);
            const normalized = message.toLowerCase();
            if (normalized.includes("failed_precondition") || normalized.includes("workflow task in failed state")) {
                failedPreconditionCount += 1;
                if (failedPreconditionCount >= MAX_FAILED_PRECONDITION_RETRIES) {
                    const stateError = new Error(
                        `Approval query failed for step ${request.stepKey}: workflow task is not queryable`,
                    );
                    stateError.name = "ApprovalStateError";
                    throw stateError;
                }
            }
            if (consecutiveQueryErrors >= MAX_CONSECUTIVE_QUERY_ERRORS) {
                const stateError = new Error(
                    `Approval query failed repeatedly for step ${request.stepKey}`,
                );
                stateError.name = "ApprovalStateError";
                throw stateError;
            }
            console.warn("[temporal/activity] Approval query failed, retrying:", error);
        }

        if (!blocked && Date.now() - startedAt >= timeoutMs) {
            blocked = true;
            await signalWorkflowProgress({
                event: {
                    type: "progress",
                    timestamp: Date.now(),
                    data: {
                        runId: request.runId,
                        message: `Approval timeout reached for step ${request.stepNumber}. Waiting for async approval signal.`,
                    },
                },
                runState: {
                    status: "blocked_approval",
                    message: `Blocked on step approval (${request.stepKey})`,
                    pendingApprovalStepKey: request.stepKey,
                } satisfies Partial<ExecutionRunStateProjection>,
            });
        }

        if (blocked && Date.now() - startedAt >= APPROVAL_MAX_WAIT_MS) {
            const timeoutError = new Error(
                `Approval timed out for step ${request.stepNumber} (${request.stepKey})`,
            );
            timeoutError.name = "ApprovalTimeoutError";
            throw timeoutError;
        }

        Context.current().heartbeat({
            waitingApproval: request.stepKey,
            blocked,
            failedPreconditionCount,
            consecutiveQueryErrors,
        });
        await sleep(blocked ? APPROVAL_BLOCKED_POLL_INTERVAL_MS : APPROVAL_POLL_INTERVAL_MS);
    }
}

export async function runManowarExecutionActivity(
    input: ExecuteManowarWorkflowInput & { approvalTimeoutMs?: number },
): Promise<ManowarWorkflowResult> {
    // Validate payload sizes per Temporal Cloud best practices
    validatePayloadSize(input, "Manowar execution input");
    validatePayloadSize(input.userRequest, "User request");
    validatePayloadSize(input.options, "Execution options");
    
    if (!input.composeRunId) {
        const error = new Error("composeRunId is required");
        error.name = "ValidationError";
        throw error;
    }
    const composeRunId = input.composeRunId;
    const workflow = resolveWorkflow(input);
    if (!workflow.id) {
        const error = new Error("workflow.id is required");
        error.name = "ValidationError";
        throw error;
    }
    if (!input.walletAddress) {
        const error = new Error("walletAddress is required");
        error.name = "ValidationError";
        throw error;
    }
    const expectedPrefix = `manowar-${input.walletAddress}`;
    if (!workflow.id.startsWith(expectedPrefix)) {
        const error = new Error(`workflow.id mismatch: expected to start with ${expectedPrefix}, got ${workflow.id}`);
        error.name = "ValidationError";
        throw error;
    }
    const orchestrator = new ManowarOrchestrator(
        workflow,
        input.options.coordinatorModel || "gpt-4o",
    );

    const heartbeatInterval = startPeriodicHeartbeat({
        runId: composeRunId,
        activity: "runManowarExecutionActivity",
    });

    let result;
    try {
        result = await orchestrator.execute(input.userRequest, {
            ...input.options,
            runId: composeRunId,
            onProgress: (event) => {
                void signalWorkflowProgress({
                    event,
                    runState: {
                        progress: event.data.progress,
                        message: event.data.message || event.data.error,
                        currentStep: event.data.stepIndex,
                        totalSteps: event.data.totalSteps,
                        error: event.data.error,
                    },
                });
                Context.current().heartbeat({
                    eventType: event.type,
                    timestamp: event.timestamp,
                });
            },
            onRunStateUpdate: (state) => {
                const syntheticEvent = {
                    type: state.status === "error" ? "error" : "progress",
                    timestamp: Date.now(),
                    data: {
                        runId: state.runId,
                        progress: state.progress,
                        message: state.message,
                        error: state.error,
                    },
                } as const;
                void signalWorkflowProgress({
                    event: syntheticEvent,
                    runState: state,
                });
            },
            requestStepApproval: async (request) => {
                await signalWorkflowProgress({
                    event: {
                        type: "progress",
                        timestamp: Date.now(),
                        data: {
                            runId: request.runId,
                            stepIndex: request.stepNumber,
                            message: `Approval requested for step ${request.stepNumber}: ${request.riskReason}`,
                        },
                    },
                    runState: {
                        status: "blocked_approval",
                        pendingApprovalStepKey: request.stepKey,
                        message: `Waiting approval for step ${request.stepNumber}`,
                    },
                });
                return waitForApproval(request, input.approvalTimeoutMs || APPROVAL_TIMEOUT_MS);
            },
        });
    } finally {
        clearInterval(heartbeatInterval);
    }

    if (!result.success && result.error && !isRetryableError(result.error)) {
        const nonRetryableError = new Error(result.error);
        nonRetryableError.name = "ValidationError";
        throw nonRetryableError;
    }

    return {
        ...result,
        runId: composeRunId,
        workflowId: workflow.id,
    };
}

export async function runAgentExecutionActivity(input: ExecuteAgentWorkflowInput) {
    // Validate payload sizes per Temporal Cloud best practices
    validatePayloadSize(input, "Agent execution input");
    validatePayloadSize(input.message, "Agent message");
    
    const heartbeatInterval = startPeriodicHeartbeat({
        composeRunId: input.composeRunId,
        agentWallet: input.agentWallet,
        activity: "runAgentExecutionActivity",
    });

    let result;
    try {
        result = await executeAgent(
            input.agentWallet,
            input.message,
            {
                ...input.options,
                composeRunId: input.composeRunId,
            },
        );
    } finally {
        clearInterval(heartbeatInterval);
    }

    Context.current().heartbeat({
        executionTime: result.executionTime,
        success: result.success,
    });

    if (!result.success && result.error && !isRetryableError(result.error)) {
        const nonRetryableError = new Error(result.error);
        nonRetryableError.name = "ValidationError";
        throw nonRetryableError;
    }

    return result;
}

// =============================================================================
// Tool Execution Activities (Phase 2: Durable tool calls with retry)
// =============================================================================

interface ExecuteMcpToolActivityInput {
    serverId: string;
    toolName: string;
    args: Record<string, unknown>;
    composeRunId: string;
}

interface ExecuteGoatToolActivityInput {
    pluginId: string;
    toolName: string;
    args: Record<string, unknown>;
    composeRunId: string;
}

interface ToolExecutionResult {
    success: boolean;
    result?: unknown;
    error?: string;
    executionTimeMs: number;
}

const RUNTIME_SERVICE_URL = process.env.RUNTIME_SERVICE_URL || process.env.RUNTIME_URL || "https://runtime.compose.market";
const MANOWAR_INTERNAL_SECRET = process.env.MANOWAR_INTERNAL_SECRET || "";

/**
 * Execute MCP tool via HTTP with Temporal durability
 * Wrapped in Activity for automatic retry on transient failures
 */
export async function executeMcpToolActivity(
    input: ExecuteMcpToolActivityInput,
): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    
    const heartbeatInterval = startPeriodicHeartbeat({
        activity: "executeMcpToolActivity",
        serverId: input.serverId,
        toolName: input.toolName,
        composeRunId: input.composeRunId,
    });

    try {
        const response = await fetch(
            `${RUNTIME_SERVICE_URL}/mcp/servers/${input.serverId}/tools/${input.toolName}`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-manowar-internal": MANOWAR_INTERNAL_SECRET,
                    "x-compose-run-id": input.composeRunId,
                    "x-tool-price": "1000",
                },
                body: JSON.stringify({ args: input.args }),
            },
        );

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`MCP tool execution failed: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        const executionTimeMs = Date.now() - startTime;

        Context.current().heartbeat({
            serverId: input.serverId,
            toolName: input.toolName,
            success: true,
            executionTimeMs,
        });

        return {
            success: true,
            result: data.result,
            executionTimeMs,
        };
    } catch (error) {
        const executionTimeMs = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : String(error);

        Context.current().heartbeat({
            serverId: input.serverId,
            toolName: input.toolName,
            success: false,
            error: errorMessage,
            executionTimeMs,
        });

        // Determine if error is retryable
        const isRetryable = isRetryableError(errorMessage);
        if (!isRetryable) {
            const nonRetryableError = new Error(errorMessage);
            nonRetryableError.name = "ToolNonRetryableError";
            throw nonRetryableError;
        }

        throw error;
    } finally {
        clearInterval(heartbeatInterval);
    }
}

/**
 * Execute GOAT tool via HTTP with Temporal durability
 * Wrapped in Activity for automatic retry on transient failures
 */
export async function executeGoatToolActivity(
    input: ExecuteGoatToolActivityInput,
): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    
    const heartbeatInterval = startPeriodicHeartbeat({
        activity: "executeGoatToolActivity",
        pluginId: input.pluginId,
        toolName: input.toolName,
        composeRunId: input.composeRunId,
    });

    try {
        const response = await fetch(
            `${RUNTIME_SERVICE_URL}/goat/plugins/${input.pluginId}/tools/${input.toolName}`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-manowar-internal": MANOWAR_INTERNAL_SECRET,
                    "x-compose-run-id": input.composeRunId,
                    "x-tool-price": "1000",
                },
                body: JSON.stringify({ args: input.args }),
            },
        );

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`GOAT tool execution failed: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        const executionTimeMs = Date.now() - startTime;

        Context.current().heartbeat({
            pluginId: input.pluginId,
            toolName: input.toolName,
            success: true,
            executionTimeMs,
        });

        return {
            success: true,
            result: data.result,
            executionTimeMs,
        };
    } catch (error) {
        const executionTimeMs = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : String(error);

        Context.current().heartbeat({
            pluginId: input.pluginId,
            toolName: input.toolName,
            success: false,
            error: errorMessage,
            executionTimeMs,
        });

        // Determine if error is retryable
        const isRetryable = isRetryableError(errorMessage);
        if (!isRetryable) {
            const nonRetryableError = new Error(errorMessage);
            nonRetryableError.name = "ToolNonRetryableError";
            throw nonRetryableError;
        }

        throw error;
    } finally {
        clearInterval(heartbeatInterval);
    }
}
