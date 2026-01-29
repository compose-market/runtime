/**
 * Agent API Routes
 * 
 * REST API endpoints for interacting with LangChain agents.
 * All execution endpoints are x402 payable.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
    registerAgent,
    resolveAgent,
    resolveAgentInstance,
    listRegisteredAgents,
    markAgentExecuted,
    uploadAgentKnowledge,
    listAgentKnowledgeKeys,
    uploadBase64ToPinata,
} from "./frameworks/runtime.js";
import { executeAgent, streamAgent } from "./frameworks/langchain.js";
import { executeMultimodal, detectModelTask, isChatModel } from "./frameworks/multimodal.js";
import { handleX402Payment, extractPaymentInfo, DEFAULT_PRICES } from "./payment.js";

const router = Router();

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

// =============================================================================
// Schemas
// =============================================================================

const RegisterAgentSchema = z.object({
    // walletAddress comes from IPFS metadata (single source of truth)
    walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    // walletTimestamp is OPTIONAL - only needed if agent needs to sign transactions
    // If not provided, agent works for chat but can't sign
    walletTimestamp: z.number().optional(),
    // dnaHash is still stored for potential future signing needs
    dnaHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/) as z.ZodType<`0x${string}`>,
    name: z.string().min(1),
    description: z.string(),
    agentCardUri: z.string().startsWith("ipfs://"),
    creator: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    model: z.string().min(1, "model is required from on-chain metadata"),
    // Plugins can be simple strings (legacy) or full Plugin objects (schema compliant)
    plugins: z.array(
        z.union([
            z.string(),
            z.object({
                registryId: z.string(),
                name: z.string(),
                origin: z.string()
            })
        ])
    ).default(["coingecko"]),
    systemPrompt: z.string().optional(),
});

const ChatSchema = z.object({
    message: z.string().min(1, "message is required"),
    threadId: z.string().optional(),
    manowarWallet: z.string().optional(), // Wallet address of the orchestrating Manowar (if any)
    // New attachment format (Pinata URL)
    attachment: z.object({
        type: z.enum(["image", "audio", "video"]),
        url: z.string().url(),
    }).optional(),
    grantedPermissions: z.array(z.string()).optional(), // Permissions granted by user (from Backpack)
});

const MultimodalSchema = z.object({
    prompt: z.string().min(1, "prompt is required"),
    image: z.string().optional(), // base64 encoded image data
    audio: z.string().optional(), // base64 encoded audio data
    threadId: z.string().optional(),
});

// =============================================================================
// Agent Registration
// =============================================================================

/**
 * POST /agent/register
 * Register a new agent (called after on-chain mint)
 * 
 * The walletAddress is derived from dnaHash and must match frontend derivation.
 */
router.post(
    "/register",
    asyncHandler(async (req: Request, res: Response) => {
        const parseResult = RegisterAgentSchema.safeParse(req.body);
        if (!parseResult.success) {
            res.status(400).json({
                error: "Invalid request body",
                details: parseResult.error.issues,
            });
            return;
        }

        const params = parseResult.data;

        try {
            // The walletAddress is derived from dnaHash and must match frontend derivation.
            const agent = await registerAgent({
                walletAddress: params.walletAddress, // From IPFS metadata
                walletTimestamp: params.walletTimestamp, // Optional - for signing capability
                dnaHash: params.dnaHash,
                name: params.name,
                description: params.description,
                agentCardUri: params.agentCardUri,
                creator: params.creator,
                model: params.model,
                plugins: params.plugins.map(p => typeof p === "string" ? p : p.registryId),
                systemPrompt: params.systemPrompt,
            });

            res.status(201).json({
                success: true,
                agent: {
                    name: agent.name,
                    walletAddress: agent.walletAddress,
                    dnaHash: agent.dnaHash,
                    apiUrl: `/agent/${agent.walletAddress}/chat`,
                },
            });
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            // 409 Conflict = agent already registered (which is fine)
            // 500 = other errors
            if (errorMsg.includes("already registered")) {
                res.status(409).json({ error: errorMsg });
            } else {
                console.error(`[agent-routes] Registration failed:`, errorMsg);
                res.status(500).json({ error: errorMsg });
            }
        }
    })
);

/**
 * GET /agent/list
 * List all registered agents
 */
router.get("/list", (_req: Request, res: Response) => {
    const agents = listRegisteredAgents();
    res.json({
        count: agents.length,
        agents: agents.map((a) => ({
            agentId: a.agentId.toString(),
            name: a.name,
            description: a.description,
            walletAddress: a.walletAddress,
            model: a.model,
            plugins: a.plugins,
            createdAt: a.createdAt.toISOString(),
            lastExecutedAt: a.lastExecutedAt?.toISOString(),
        })),
    });
});

// =============================================================================
// Agent Metadata
// =============================================================================

/**
 * GET /agent/:walletAddress
 * Get agent metadata
 */
router.get(
    "/:walletAddress",
    asyncHandler(async (req: Request, res: Response) => {
        const identifier = getParam(req.params.walletAddress);
        const agent = resolveAgent(identifier);

        if (!agent) {
            res.status(404).json({ error: `Agent ${identifier} not found` });
            return;
        }

        res.json({
            name: agent.name,
            description: agent.description,
            agentCardUri: agent.agentCardUri,
            creator: agent.creator,
            walletAddress: agent.walletAddress,
            dnaHash: agent.dnaHash,
            model: agent.model,
            plugins: agent.plugins,
            createdAt: agent.createdAt.toISOString(),
            lastExecutedAt: agent.lastExecutedAt?.toISOString(),
            endpoints: {
                chat: `/agent/${agent.walletAddress}/chat`,
                stream: `/agent/${agent.walletAddress}/stream`,
            },
        });
    })
);

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
        const agent = resolveAgent(identifier);

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
        const agent = resolveAgent(identifier);

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
// Agent Execution (x402 Payable)
// =============================================================================

/**
 * POST /agent/:id/chat
 * Chat with an agent (x402 payable)
 */
router.post(
    "/:walletAddress/chat",
    asyncHandler(async (req: Request, res: Response) => {
        const identifier = getParam(req.params.walletAddress);

        // x402 Payment Verification - always required, verified on-chain
        // For nested Manowar calls, x-manowar-internal header bypasses payment
        const paymentInfo = extractPaymentInfo(
            req.headers as Record<string, string | string[] | undefined>
        );
        const internalSecret = req.headers["x-manowar-internal"] as string | undefined;

        const resourceUrl = `https://${req.get("host")}${req.originalUrl}`;
        const paymentResult = await handleX402Payment(
            paymentInfo.paymentData,
            resourceUrl,
            "POST",
            DEFAULT_PRICES.AGENT_CHAT,
            internalSecret, // Pass internal secret for nested call bypass
            paymentInfo.chainId, // Multichain support
        );

        if (paymentResult.status !== 200) {
            // Payment failed or not provided - return 402 Payment Required
            Object.entries(paymentResult.responseHeaders).forEach(([key, value]) => {
                res.setHeader(key, value);
            });
            res.status(paymentResult.status).json(paymentResult.responseBody);
            return;
        }
        console.log(`[x402] Payment verified for agent ${identifier}`);

        // Validate agent exists
        const agent = resolveAgent(identifier);
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
                hint: "Body should be: { message: string, threadId?: string, manowarWallet?: string }",
            });
            return;
        }

        const { message, threadId, manowarWallet, attachment, grantedPermissions } = parseResult.data;

        // Detect if this is a multimodal model
        const task = await detectModelTask(agent.model);
        console.log(`[agent] Model ${agent.model} detected task: ${task}`);

        // For multimodal models, use multimodal handler instead of LangChain
        if (!isChatModel(task)) {
            console.log(`[agent] Routing to multimodal handler for ${agent.name} (${task})`);

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
                error: result.error,
                executionTime: result.executionTime,
            });
            return;
        }

        // For chat/text models, use LangChain
        const instance = resolveAgentInstance(identifier);
        if (!instance) {
            res.status(500).json({ error: `Agent ${identifier} runtime not available` });
            return;
        }


        // Extract user address from session/payment headers
        // x-session-user-address is populated by the Thirdweb client wrapper
        const userId = req.headers["x-session-user-address"] as string | undefined;

        // Extract session headers for tool execution
        const sessionActive = req.headers["x-session-active"] === "true";
        const sessionBudgetRemaining = parseInt(req.headers["x-session-budget-remaining"] as string || "0", 10);

        // Execute agent (non-streaming to avoid ChatMessageChunk checkpoint corruption)
        console.log(`[agent] Executing ${agent.name} (${identifier}): "${message.slice(0, 50)}..." [User: ${userId || 'anon'}, MW: ${manowarWallet || 'none'}, Session: ${sessionActive}]`);

        const result = await executeAgent(instance.id, message, {
            threadId,
            userId,
            manowarWallet,
            attachment,  // Pass attachment for vision models
            sessionContext: {
                sessionActive,
                sessionBudgetRemaining,
                grantedPermissions: grantedPermissions || []
            }
        });

        markAgentExecuted(identifier);

        res.json({
            walletAddress: agent.walletAddress,
            name: agent.name,
            ...result,
        });
    })
);

/**
 * POST /agent/:id/stream
 * Stream chat with an agent (x402 payable, SSE)
 */
router.post(
    "/:walletAddress/stream",
    asyncHandler(async (req: Request, res: Response) => {
        const identifier = getParam(req.params.walletAddress);

        // x402 Payment Verification - always required, no session bypass
        const paymentInfo = extractPaymentInfo(
            req.headers as Record<string, string | string[] | undefined>
        );

        const resourceUrl = `https://${req.get("host")}${req.originalUrl}`;
        const paymentResult = await handleX402Payment(
            paymentInfo.paymentData,
            resourceUrl,
            "POST",
            DEFAULT_PRICES.AGENT_CHAT,
            undefined, // internalSecret
            paymentInfo.chainId, // Multichain support
        );

        if (paymentResult.status !== 200) {
            Object.entries(paymentResult.responseHeaders).forEach(([key, value]) => {
                res.setHeader(key, value);
            });
            res.status(paymentResult.status).json(paymentResult.responseBody);
            return;
        }

        // Validate agent
        const agent = resolveAgent(identifier);
        if (!agent) {
            res.status(404).json({ error: `Agent ${identifier} not found` });
            return;
        }

        const instance = resolveAgentInstance(identifier);
        if (!instance) {
            res.status(500).json({ error: `Agent ${identifier} runtime not available` });
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

        const { message, threadId, manowarWallet, grantedPermissions } = parseResult.data;

        // Extract user address and session context (like /chat)
        const userId = req.headers["x-session-user-address"] as string | undefined;
        const sessionActive = req.headers["x-session-active"] === "true";
        const sessionBudgetRemaining = parseInt(req.headers["x-session-budget-remaining"] as string || "0", 10);

        // Set up SSE
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");

        console.log(`[agent] Streaming ${agent.name} (${identifier}): "${message.slice(0, 50)}..." [User: ${userId || 'anon'}]`);

        try {
            for await (const event of streamAgent(instance.id, message, {
                threadId,
                userId,
                manowarWallet,
                sessionContext: {
                    sessionActive,
                    sessionBudgetRemaining,
                    grantedPermissions: grantedPermissions || []
                }
            })) {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
            }
            res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
        } catch (err) {
            res.write(`data: ${JSON.stringify({ type: "error", content: String(err) })}\n\n`);
        }

        markAgentExecuted(identifier);
        res.end();
    })
);

// =============================================================================
// Multimodal Agent Execution (x402 Payable)
// =============================================================================

/**
 * POST /agent/:id/multimodal
 * Execute multimodal inference (text-to-image, ASR, etc.) with an agent (x402 payable)
 * 
 * Same x402 pattern as /chat but routes to multimodal handler instead of LangChain
 */
router.post(
    "/:walletAddress/multimodal",
    asyncHandler(async (req: Request, res: Response) => {
        const identifier = getParam(req.params.walletAddress);

        // x402 Payment Verification - always required, verified on-chain
        const paymentInfo = extractPaymentInfo(
            req.headers as Record<string, string | string[] | undefined>
        );

        const resourceUrl = `https://${req.get("host")}${req.originalUrl}`;
        const paymentResult = await handleX402Payment(
            paymentInfo.paymentData,
            resourceUrl,
            "POST",
            DEFAULT_PRICES.AGENT_CHAT, // Same price as chat
            undefined, // internalSecret
            paymentInfo.chainId, // Multichain support
        );

        if (paymentResult.status !== 200) {
            // Payment failed or not provided - return 402 Payment Required
            Object.entries(paymentResult.responseHeaders).forEach(([key, value]) => {
                res.setHeader(key, value);
            });
            res.status(paymentResult.status).json(paymentResult.responseBody);
            return;
        }
        console.log(`[x402] Payment verified for multimodal agent ${identifier}`);

        // Validate agent exists
        const agent = resolveAgent(identifier);
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
    })
);

export default router;
