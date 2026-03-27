/**
 * Agent API Routes
 * 
 * REST API endpoints for interacting with LangChain agents.
 * These routes are internal execution endpoints owned by runtime.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
    ensureAgentRuntimeReady,
    getAgentRuntimeWarmupError,
    isAgentRuntimeWarming,
    ensureRegisteredAgentByWallet,
    resolveAgent,
    resolveAgentInstance,
    markAgentExecuted,
} from "./framework/runtime.js";
import {
    executeResponses,
    type ExecutionResult,
} from "./framework/manowar.js";
import { createComposeRunId, executeAgentRun, getAgentRunState, startAgentRun } from "./temporal/service.js";
import { extractRuntimeSessionHeaders } from "./auth.js";

const router = Router();
const JSON_KEEPALIVE_INTERVAL_MS = 5000; // 5 seconds - keeps proxies alive, prevents 504s
const AGENT_WARMUP_TIMEOUT_MS = 12000;
const AGENT_STREAM_POLL_INTERVAL_MS = 1000;
const AGENT_STREAM_STATE_MISS_LIMIT = 8;
const AGENT_STREAM_POLL_TIMEOUT_MS = 5 * 60 * 1000;

// =============================================================================
// Middleware
// =============================================================================

function asyncHandler(
    fn: (req: Request, res: Response) => Promise<void>
) {
    return (req: Request, res: Response) => {
        fn(req, res).catch((err) => {
            console.error(`[agent-routes] Error:`, err);
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        });
    };
}

/**
 * Helper to extract string from route params (Express v5 types them as string | string[])
 */
function getParam(value: string | string[] | undefined): string {
    if (Array.isArray(value)) return value[0] || "";
    return value || "";
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return JSON.stringify({ error: "Failed to serialize response" });
    }
}

async function warmAgentRuntimeOrTimeout(walletAddress: string): Promise<boolean> {
    const timeout = new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), AGENT_WARMUP_TIMEOUT_MS);
    });

    try {
        const result = await Promise.race([ensureAgentRuntimeReady(walletAddress), timeout]);
        return Boolean(result);
    } catch {
        return false;
    }
}

// =============================================================================
// Schemas
// =============================================================================

const ChatSchema = z.object({
    message: z.string().min(1, "message is required"),
    threadId: z.string().optional(),
    composeRunId: z.string().optional(),
    workflowWallet: z.string().optional(), // Wallet address of the orchestrating workflow (if any)
    userAddress: z.string().optional(),
    attachment: z.object({
        type: z.string().min(1, "attachment.type is required"),
    }).passthrough().optional(),
    sessionGrants: z.array(z.string()).optional(), // Runtime session capability grants
    cloudPermissions: z.array(z.string()).optional(), // Backpack/browser cloud permissions
    backpackAccounts: z.array(z.object({
        slug: z.string(),
        name: z.string(),
        connected: z.boolean(),
        accountId: z.string().optional(),
        status: z.string().optional(),
    })).optional(),
});

const ResponsesSchema = z.object({}).passthrough();

async function resolveAgentForRequest(identifier: string): Promise<ReturnType<typeof resolveAgent>> {
    const cached = resolveAgent(identifier);
    if (cached) {
        return cached;
    }

    if (identifier.startsWith("0x") && identifier.length === 42) {
        return await ensureRegisteredAgentByWallet(identifier);
    }

    return undefined;
}

// =============================================================================
// Agent Execution
// =============================================================================

/**
 * POST /agent/:id/chat
 * Chat with an agent
 */
router.post(
    "/:walletAddress/chat",
    asyncHandler(async (req: Request, res: Response) => {
        const identifier = getParam(req.params.walletAddress);

        // Validate agent exists
        const agent = await resolveAgentForRequest(identifier);
        if (!agent) {
            res.status(404).json({ error: `Agent ${identifier} not found` });
            return;
        }

        // Parse request
        const parseResult = ChatSchema.safeParse(req.body);
        if (!parseResult.success) {
            res.status(400).json({
                error: "Invalid request body",
                details: parseResult.error.issues,
                hint: "Body should be: { message: string, threadId?: string, workflowWallet?: string }",
            });
            return;
        }

        const {
            message,
            threadId,
            workflowWallet,
            attachment,
            sessionGrants,
            cloudPermissions,
            backpackAccounts,
            userAddress: bodyUserId,
        } = parseResult.data;
        const { sessionActive, sessionBudgetRemaining, sessionUserAddress } = extractRuntimeSessionHeaders(req);
        if (bodyUserId && sessionUserAddress && bodyUserId.toLowerCase() !== sessionUserAddress.toLowerCase()) {
            res.status(400).json({ error: "userAddress does not match authenticated session user" });
            return;
        }
        const userAddress = sessionUserAddress || bodyUserId;

        let instance = resolveAgentInstance(identifier);
        if (!instance) {
            const ready = await warmAgentRuntimeOrTimeout(agent.walletAddress);
            if (!ready) {
                res.status(503).json({
                    success: false,
                    code: "AGENT_WARMING",
                    status: "warming",
                    error: "Agent runtime is warming up. Retry shortly.",
                    retryAfterMs: AGENT_WARMUP_TIMEOUT_MS,
                    walletAddress: agent.walletAddress,
                    warmupError: getAgentRuntimeWarmupError(agent.walletAddress),
                });
                return;
            }
            instance = resolveAgentInstance(identifier);
            if (!instance) {
                res.status(503).json({
                    code: "AGENT_RUNTIME_UNAVAILABLE",
                    error: `Agent ${identifier} runtime unavailable after warmup`,
                    status: isAgentRuntimeWarming(agent.walletAddress) ? "warming" : "error",
                    warmupError: getAgentRuntimeWarmupError(agent.walletAddress),
                });
                return;
            }
        }

        const composeRunId = parseResult.data.composeRunId || createComposeRunId();
        res.setHeader("x-compose-run-id", composeRunId);

        try {
            console.log(`[agent] Executing ${agent.name} (${identifier}) run=${composeRunId}: "${message.slice(0, 50)}..." [User: ${userAddress || 'anon'}, MW: ${workflowWallet || 'none'}, Session: ${sessionActive}]`);
            const result = await executeAgentRun({
                composeRunId,
                agentWallet: agent.walletAddress,
                message,
                options: {
                    threadId,
                    userAddress,
                    workflowWallet,
                    attachment,
                    sessionContext: {
                        sessionActive,
                        sessionBudgetRemaining,
                        sessionGrants,
                        cloudPermissions,
                        backpackAccounts,
                    },
                },
            });

            if (!result.success) {
                res.status(500).json({
                    error: result.error || "Agent execution failed",
                    runId: composeRunId,
                    walletAddress: agent.walletAddress,
                    name: agent.name,
                    model: agent.model,
                });
                return;
            }

            markAgentExecuted(identifier);

            res.json({
                walletAddress: agent.walletAddress,
                name: agent.name,
                model: agent.model,
                runId: composeRunId,
                ...result,
            });
        } catch (error) {
            console.error(`[agent] Execution failed:`, error);
            res.status(500).json({
                error: error instanceof Error ? error.message : String(error),
                runId: composeRunId,
            });
        }
    }));

/**
 * POST /agent/:id/stream
 * Stream chat with an agent (SSE)
 */
router.post(
    "/:walletAddress/stream",
    asyncHandler(async (req: Request, res: Response) => {
        const identifier = getParam(req.params.walletAddress);

        // Validate agent
        const agent = await resolveAgentForRequest(identifier);
        if (!agent) {
            res.status(404).json({ error: `Agent ${identifier} not found` });
            return;
        }

        const parseResult = ChatSchema.safeParse(req.body);
        if (!parseResult.success) {
            res.status(400).json({
                error: "Invalid request body",
                details: parseResult.error.issues,
            });
            return;
        }

        const {
            message,
            threadId,
            composeRunId: requestedRunId,
            workflowWallet,
            attachment,
            sessionGrants,
            cloudPermissions,
            backpackAccounts,
            userAddress: bodyUserId,
        } = parseResult.data;
        const composeRunId = requestedRunId || createComposeRunId();
        res.setHeader("x-compose-run-id", composeRunId);

        const runtimeSession = extractRuntimeSessionHeaders(req);
        if (bodyUserId && runtimeSession.sessionUserAddress && bodyUserId.toLowerCase() !== runtimeSession.sessionUserAddress.toLowerCase()) {
            res.status(400).json({ error: "userAddress does not match authenticated session user" });
            return;
        }
        const userAddress = runtimeSession.sessionUserAddress || bodyUserId;
        const sessionActive = runtimeSession.sessionActive;
        const sessionBudgetRemaining = runtimeSession.sessionBudgetRemaining;

        let instance = resolveAgentInstance(identifier);
        if (!instance) {
            const ready = await warmAgentRuntimeOrTimeout(agent.walletAddress);
            if (!ready) {
                res.status(503).json({
                    code: "AGENT_WARMING",
                    error: "Agent runtime is warming up. Retry shortly.",
                    retryAfterMs: AGENT_WARMUP_TIMEOUT_MS,
                    warmupError: getAgentRuntimeWarmupError(agent.walletAddress),
                });
                return;
            }
            instance = resolveAgentInstance(identifier);
            if (!instance) {
                res.status(503).json({
                    code: "AGENT_RUNTIME_UNAVAILABLE",
                    error: `Agent ${identifier} runtime unavailable after warmup`,
                    warmupError: getAgentRuntimeWarmupError(agent.walletAddress),
                });
                return;
            }
        }

        // Set up SSE with optimized headers for long-running connections
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("Keep-Alive", "timeout=120"); // Tell proxies to wait 120s
        res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering for real-time streaming
        res.setHeader("X-Content-Type-Options", "nosniff"); // Prevent MIME sniffing

        const heartbeat = setInterval(() => {
            if (!res.writableEnded) {
                res.write(": ping\n\n");
            }
        }, JSON_KEEPALIVE_INTERVAL_MS);
        res.on("close", () => clearInterval(heartbeat));

        const effectiveThreadId = threadId || `thread-${agent.walletAddress}`;

        console.log(`[agent] Streaming ${agent.name} (${identifier}) run=${composeRunId}: "${message.slice(0, 50)}..." [User: ${userAddress || 'anon'}]`);

        try {
            async function writeEvent(event: unknown): Promise<void> {
                res.write(`data: ${safeStringify(event)}\n\n`);
            }

            await writeEvent({
                type: "thinking_start",
                message: "Thinking...",
            });

            const handle = await startAgentRun({
                composeRunId,
                agentWallet: agent.walletAddress,
                message,
                options: {
                    threadId,
                    userAddress,
                    workflowWallet,
                    attachment,
                    sessionContext: {
                        sessionActive,
                        sessionBudgetRemaining,
                        sessionGrants,
                        cloudPermissions,
                        backpackAccounts,
                    },
                },
            });

            let missingStateCount = 0;
            const pollStartedAt = Date.now();
            while (true) {
                const state = await getAgentRunState(agent.walletAddress, effectiveThreadId, composeRunId);
                if (!state) {
                    missingStateCount += 1;
                    const pollTimedOut = Date.now() - pollStartedAt >= AGENT_STREAM_POLL_TIMEOUT_MS;
                    if (missingStateCount >= AGENT_STREAM_STATE_MISS_LIMIT || pollTimedOut) {
                        throw new Error(pollTimedOut ? "Agent run state polling timed out" : "Agent run state unavailable");
                    }
                    await new Promise((resolve) => setTimeout(resolve, AGENT_STREAM_POLL_INTERVAL_MS));
                    continue;
                }

                missingStateCount = 0;
                if (state.status === "success" || state.status === "error" || state.status === "cancelled") {
                    break;
                }
                if (Date.now() - pollStartedAt >= AGENT_STREAM_POLL_TIMEOUT_MS) {
                    throw new Error("Agent run state polling timed out");
                }
                await new Promise((resolve) => setTimeout(resolve, AGENT_STREAM_POLL_INTERVAL_MS));
            }

            const result = await handle.result() as ExecutionResult;
            await writeEvent({ type: "thinking_end" });

            if (!result.success) {
                throw new Error(result.error || "Agent execution failed");
            }

            if (typeof result.output === "string" && result.output.length > 0) {
                await writeEvent({
                    choices: [{ delta: { content: result.output } }],
                });
            }

            await writeEvent({
                type: "done",
                model: agent.model,
                usage: result.usage,
                promptTokens: result.promptTokens,
                completionTokens: result.completionTokens,
                totalTokens: result.usage?.total_tokens,
            });
        } catch (err) {
            res.write(`data: ${safeStringify({ type: "error", content: String(err) })}\n\n`);
        }

        markAgentExecuted(identifier);
        clearInterval(heartbeat);
        res.end();
    })
);

/**
 * POST /agent/:id/responses
 * Execute a dynamic responses request with the agent's fixed model.
 */
router.post(
    "/:walletAddress/responses",
    asyncHandler(async (req: Request, res: Response) => {
        const identifier = getParam(req.params.walletAddress);
        const agent = await resolveAgentForRequest(identifier);
        if (!agent) {
            res.status(404).json({ error: `Agent ${identifier} not found` });
            return;
        }

        const parseResult = ResponsesSchema.safeParse(req.body);
        if (!parseResult.success) {
            res.status(400).json({
                error: "Invalid request body",
                details: parseResult.error.issues,
            });
            return;
        }

        const requestBody = parseResult.data;
        if (typeof requestBody.model === "string" && requestBody.model.trim().length > 0) {
            res.status(400).json({ error: "responses request must not override the fixed agent model" });
            return;
        }
        if (typeof requestBody.provider === "string" && requestBody.provider.trim().length > 0) {
            res.status(400).json({ error: "responses request must not override provider resolution" });
            return;
        }

        const result = await executeResponses(agent.model, requestBody);
        markAgentExecuted(identifier);
        res.json(result);
    }),
);

/**
 * GET /agent/:walletAddress/runs/:runId/state?threadId=<threadId>
 * Query durable state for a specific agent run for frontend reattach/resume flows.
 */
router.get(
    "/:walletAddress/runs/:runId/state",
    asyncHandler(async (req: Request, res: Response) => {
        const agentWallet = getParam(req.params.walletAddress);
        const runId = getParam(req.params.runId);
        const threadIdRaw = req.query.threadId;
        const threadId = Array.isArray(threadIdRaw) ? threadIdRaw[0] : threadIdRaw;

        if (!threadId) {
            res.status(400).json({ error: "threadId query parameter is required" });
            return;
        }

        const state = await getAgentRunState(agentWallet, String(threadId), runId);
        if (!state) {
            res.status(404).json({ error: "Run not found" });
            return;
        }

        res.json(state);
    }),
);

export default router;
