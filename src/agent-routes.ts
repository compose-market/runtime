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
    uploadAgentKnowledge,
    listAgentKnowledgeKeys,
    uploadBase64ToPinata,
} from "./frameworks/runtime.js";
import { executeMultimodal, detectModelTask, isChatModel } from "./frameworks/multimodal.js";
import { executeAgent, streamAgent } from "./frameworks/langchain.js";
import { executeOpenClawAgent, streamOpenClawAgent } from "./frameworks/openclaw.js";
import { createComposeRunId, executeAgentRun, getAgentRunState } from "./temporal/service.js";
import { extractRuntimeSessionHeaders } from "./auth.js";

const router = Router();
const JSON_KEEPALIVE_INTERVAL_MS = 5000; // 5 seconds - keeps proxies alive, prevents 504s
const AGENT_WARMUP_TIMEOUT_MS = 12000;

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
    userId: z.string().optional(),
    // New attachment format (Pinata URL)
    attachment: z.object({
        type: z.enum(["image", "audio", "video"]),
        url: z.string().url(),
    }).optional(),
    grantedPermissions: z.array(z.string()).optional(), // Permissions granted by user (from Backpack)
    permissionPolicy: z.record(z.string(), z.enum(["allow", "ask", "deny"])).optional(),
    backpackAccounts: z.array(z.object({
        slug: z.string(),
        name: z.string(),
        connected: z.boolean(),
        accountId: z.string().optional(),
        status: z.string().optional(),
    })).optional(),
});

const MultimodalSchema = z.object({
    prompt: z.string().min(1, "prompt is required"),
    image: z.string().optional(), // base64 encoded image data
    audio: z.string().optional(), // base64 encoded audio data
    threadId: z.string().optional(),
});

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
// Knowledge Management
// =============================================================================

const KnowledgeUploadSchema = z.object({
    key: z.string().min(1, "key is required"),
    content: z.string().min(1, "content is required"),
    metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * POST /agent/:id/knowledge
 * Upload knowledge to an agent's knowledge base
 */
router.post(
    "/:walletAddress/knowledge",
    asyncHandler(async (req: Request, res: Response) => {
        const identifier = getParam(req.params.walletAddress);
        const agent = await resolveAgentForRequest(identifier);

        if (!agent) {
            res.status(404).json({ error: `Agent ${identifier} not found` });
            return;
        }

        const parseResult = KnowledgeUploadSchema.safeParse(req.body);
        if (!parseResult.success) {
            res.status(400).json({
                error: "Invalid request body",
                details: parseResult.error.issues,
            });
            return;
        }

        const { key, content, metadata } = parseResult.data;

        const success = await uploadAgentKnowledge(identifier, key, content, metadata);

        res.json({
            success,
            agentId: agent.agentId.toString(),
            walletAddress: agent.walletAddress,
            key,
            contentLength: content.length,
        });
    })
);

/**
 * GET /agent/:id/knowledge
 * List all knowledge items for an agent
 */
router.get(
    "/:walletAddress/knowledge",
    asyncHandler(async (req: Request, res: Response) => {
        const identifier = getParam(req.params.walletAddress);
        const agent = await resolveAgentForRequest(identifier);

        if (!agent) {
            res.status(404).json({ error: `Agent ${identifier} not found` });
            return;
        }

        const keys = await listAgentKnowledgeKeys(identifier);

        res.json({
            agentId: agent.agentId.toString(),
            walletAddress: agent.walletAddress,
            count: keys.length,
            keys,
        });
    })
);

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
            grantedPermissions,
            permissionPolicy,
            backpackAccounts,
            userId: bodyUserId,
        } = parseResult.data;
        const { sessionActive, sessionBudgetRemaining, sessionUserAddress } = extractRuntimeSessionHeaders(req);
        if (bodyUserId && sessionUserAddress && bodyUserId.toLowerCase() !== sessionUserAddress.toLowerCase()) {
            res.status(400).json({ error: "userId does not match authenticated session user" });
            return;
        }
        const userId = sessionUserAddress || bodyUserId;

        // Detect if this is a multimodal model
        const task = await detectModelTask(agent.model);
        console.log(`[agent] Model ${agent.model} detected task: ${task}`);

        // For multimodal models, use multimodal handler instead of LangChain
        if (!isChatModel(task)) {
            console.log(`[agent] Routing to multimodal handler for ${agent.name} (${task})`);
            try {
                // Pass image or audio data if provided
                const mediaData = attachment?.url;
                const result = await executeMultimodal(agent.model, task, message, mediaData);
                markAgentExecuted(identifier);

                // For binary outputs (image/audio/video), upload to Pinata and return URL
                // This prevents bloating the orchestrator memory with huge base64 strings
                let mediaUrl: string | null = null;
                if (result.success && result.data && (result.type === "image" || result.type === "audio" || result.type === "video")) {
                    mediaUrl = await uploadBase64ToPinata(result.data, result.type, agent.walletAddress);
                    if (mediaUrl) {
                        console.log(`[agent] Uploaded ${result.type} to Pinata: ${mediaUrl}`);
                    }
                }

                res.json({
                    agentId: agent.agentId.toString(),
                    walletAddress: agent.walletAddress,
                    name: agent.name,
                    model: agent.model,
                    task,
                    success: result.success,
                    type: result.type,
                    // Return URL instead of base64 data if upload succeeded
                    url: mediaUrl || undefined,
                    data: mediaUrl ? undefined : result.data, // Only include base64 as fallback
                    content: result.content,
                    mimeType: result.mimeType,
                    usage: result.usage,
                    media: result.media,
                    error: result.error,
                    executionTime: result.executionTime,
                });
                return;
            } catch (error) {
                throw error;
            }
        }

        // For chat/text models, use framework-specific execution
        const framework = agent.framework || "langchain";

        // Route to OpenClaw runtime if framework is openclaw
        if (framework === "openclaw") {
            console.log(`[agent] Routing to OpenClaw runtime for ${agent.name}`);

            try {
                const result = await executeOpenClawAgent({
                    agentWallet: agent.walletAddress,
                    model: agent.model,
                    message,
                    userId,
                    threadId,
                    grantedPermissions: grantedPermissions || [],
                    permissionPolicy,
                    backpackAccounts,
                });

                markAgentExecuted(identifier);

                res.json({
                    walletAddress: agent.walletAddress,
                    name: agent.name,
                    model: agent.model,
                    framework: "openclaw",
                    success: result.success,
                    output: result.output,
                    usage: result.usage,
                    promptTokens: result.promptTokens,
                    completionTokens: result.completionTokens,
                    runtimeId: result.runtimeId,
                    containerName: result.containerName,
                    sessionKey: result.sessionKey,
                    toolCalls: result.toolCalls,
                });
                return;
            } catch (error) {
                console.error(`[agent] OpenClaw execution failed:`, error);
                res.status(500).json({
                    error: error instanceof Error ? error.message : String(error),
                    framework: "openclaw",
                });
                return;
            }
        }

        // LangChain execution (default for langchain + eliza)
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
            console.log(`[agent] Executing ${agent.name} (${identifier}) run=${composeRunId}: "${message.slice(0, 50)}..." [User: ${userId || 'anon'}, MW: ${workflowWallet || 'none'}, Session: ${sessionActive}]`);

            const result = await executeAgentRun({
                composeRunId,
                agentWallet: agent.walletAddress,
                message,
                options: {
                    threadId,
                    userId,
                    workflowWallet,
                    attachment,
                    sessionContext: {
                        sessionActive,
                        sessionBudgetRemaining,
                        grantedPermissions: grantedPermissions || [],
                        permissionPolicy,
                        backpackAccounts,
                    },
                },
            });

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
            grantedPermissions,
            permissionPolicy,
            backpackAccounts,
            userId: bodyUserId,
        } = parseResult.data;
        const composeRunId = requestedRunId || createComposeRunId();
        res.setHeader("x-compose-run-id", composeRunId);

        const runtimeSession = extractRuntimeSessionHeaders(req);
        if (bodyUserId && runtimeSession.sessionUserAddress && bodyUserId.toLowerCase() !== runtimeSession.sessionUserAddress.toLowerCase()) {
            res.status(400).json({ error: "userId does not match authenticated session user" });
            return;
        }
        const userId = runtimeSession.sessionUserAddress || bodyUserId;
        const sessionActive = runtimeSession.sessionActive;
        const sessionBudgetRemaining = runtimeSession.sessionBudgetRemaining;
        const framework = agent.framework || "langchain";

        let instance = resolveAgentInstance(identifier);
        if (framework !== "openclaw" && !instance) {
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

        console.log(`[agent] Streaming ${agent.name} (${identifier}): "${message.slice(0, 50)}..." [User: ${userId || 'anon'}]`);

        try {
            async function writeEvent(event: unknown): Promise<void> {
                res.write(`data: ${safeStringify(event)}\n\n`);
            }

            if (framework === "openclaw") {
                for await (const event of streamOpenClawAgent({
                    agentWallet: agent.walletAddress,
                    model: agent.model,
                    message,
                    userId,
                    threadId,
                    workflowWallet,
                    grantedPermissions: grantedPermissions || [],
                    permissionPolicy,
                    backpackAccounts,
                })) {
                    await writeEvent(event);
                }
            } else {
                // Stream agent responses directly (real-time streaming)
                for await (const event of streamAgent(instance!.id, message, {
                    threadId,
                    userId,
                    workflowWallet,
                    composeRunId,
                    sessionContext: {
                        sessionActive,
                        sessionBudgetRemaining,
                        grantedPermissions: grantedPermissions || [],
                        permissionPolicy,
                        backpackAccounts,
                    }
                })) {
                    await writeEvent(event);
                }
            }
        } catch (err) {
            res.write(`data: ${safeStringify({ type: "error", content: String(err) })}\n\n`);
        }

        markAgentExecuted(identifier);
        clearInterval(heartbeat);
        res.end();
    })
);

// =============================================================================
// Multimodal Agent Execution
// =============================================================================

/**
 * POST /agent/:id/multimodal
 * Execute multimodal inference (text-to-image, ASR, etc.) with an agent.
 */
router.post(
    "/:walletAddress/multimodal",
    asyncHandler(async (req: Request, res: Response) => {
        const identifier = getParam(req.params.walletAddress);

        // Validate agent exists
        const agent = await resolveAgentForRequest(identifier);
        if (!agent) {
            res.status(404).json({ error: `Agent ${identifier} not found` });
            return;
        }

        // Parse request
        const parseResult = MultimodalSchema.safeParse(req.body);
        if (!parseResult.success) {
            res.status(400).json({
                error: "Invalid request body",
                details: parseResult.error.issues,
                hint: "Body should be: { prompt: string, image?: string (base64), audio?: string (base64) }",
            });
            return;
        }

        const { prompt, image, audio } = parseResult.data;

        // Detect task type from model
        const task = await detectModelTask(agent.model);
        console.log(`[multimodal] Agent ${agent.name} model=${agent.model} task=${task}`);

        // For chat models, redirect to /chat endpoint
        if (isChatModel(task)) {
            res.status(400).json({
                error: `Model '${agent.model}' is a chat model. Use /agent/${identifier}/chat instead.`,
                task,
                suggestion: "Use /agent/:id/chat for text-generation models",
            });
            return;
        }

        // Execute multimodal inference
        // Use image for image-to-image, audio for ASR
        const mediaData = image || audio;

        console.log(`[multimodal] Executing ${agent.name} (${identifier}): "${prompt.slice(0, 50)}..." task=${task}`);
        try {
            const result = await executeMultimodal(agent.model, task, prompt, mediaData);
            markAgentExecuted(identifier);

            res.json({
                agentId: agent.agentId.toString(),
                walletAddress: agent.walletAddress,
                name: agent.name,
                model: agent.model,
                task,
                ...result,
            });
        } catch (error) {
            throw error;
        }
    })
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
