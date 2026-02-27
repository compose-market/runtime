/**
 * Manowar Server - Agent Orchestration & Workflow Execution
 *
 * Handles agent management, LangChain/Eliza framework integration, and Manowar workflows.
 * Calls MCP service for tool/runtime execution via HTTP.
 */
import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { handleX402Payment, extractPaymentInfo, DEFAULT_PRICES } from "./payment.js";
import agentRoutes from "./agent-routes.js";
import {
    MANOWAR_PRICES,
    type Workflow,
    type PaymentContext,
} from "./manowar/index.js";
import {
    cancelManowarRun,
    createComposeRunId,
    executeManowarRunWithFallback,
    getManowarRunState,
    sanitizeExecutorOptions,
    signalStepApproval,
    startManowarRun,
    TemporalRunNotFoundError,
} from "./temporal/service.js";
import {
    parseTriggerFromNL,
    retrieveTriggers,
    storeTrigger,
    deleteTriggerFromMemory,
    registerTrigger,
    unregisterTrigger,
} from "./manowar/triggers.js";
import { getTemporalWorkerPollers, startManowarTemporalWorkers } from "./temporal/worker.js";
import { isTemporalConfigured } from "./temporal/client.js";
import { executeWithOrchestrator } from "./manowar/orchestrator.js";
import {
    registerManowar,
    getManowar,
    listRegisteredManowars,
    markManowarExecuted,
    resolveAgent,
} from "./frameworks/runtime.js";
import { resolveManowarIdentifier } from "./onchain.js";
import type { WorkflowStep, TriggerDefinition } from "./manowar/types.js";
import {
    addMemory as addGraphMemory,
    cleanupExpiredMemories,
    consolidateAgentMemories,
    createMemoryArchive,
    extractExecutionPatterns,
    getAllMemories,
    getMemoryStats,
    getTranscriptBySessionId,
    getTranscriptByThreadId,
    hybridVectorSearch,
    indexVector,
    promotePatternToSkill,
    rerankDocuments,
    searchMemory as searchGraphMemory,
    searchMemoryLayers,
    searchVectors,
    storeTranscript,
    syncArchiveToPinata,
    updateMemoryDecayScores,
    validateExtractedPattern,
} from "./memory/index.js";

const app = express();
const activeRunIds = new Map<string, string>();
const SSE_HEARTBEAT_INTERVAL_MS = 10000;
const SSE_POLL_INTERVAL_MS = 1000;
const SSE_STATE_MISS_LIMIT = 8;
const SSE_POLL_TIMEOUT_MS = 5 * 60 * 1000;
let temporalWorkerState: "starting" | "ready" | "error" = "starting";
let temporalWorkerError: string | undefined;
const ALLOW_DIRECT_EXECUTION_FALLBACK = process.env.TEMPORAL_ALLOW_DIRECT_FALLBACK === "true";

function buildWorkflowFromManowar(manowar: {
    walletAddress: string;
    chainId: number;
    title?: string;
    description?: string;
    agentWalletAddresses?: string[];
}): Workflow {
    const steps: WorkflowStep[] = [];
    for (const agentWallet of (manowar.agentWalletAddresses || [])) {
        const agent = resolveAgent(agentWallet);
        steps.push({
            id: `agent-${agentWallet.slice(0, 8)}`,
            name: agent?.name || `Agent ${agentWallet.slice(0, 8)}`,
            type: "agent",
            agentAddress: agentWallet,
            // Pass the chainId to ensure tools use the correct chain
            chainId: manowar.chainId,
            inputTemplate: {
                agentAddress: agentWallet,
                agentCardUri: agent?.agentCardUri,
                chainId: manowar.chainId,
            },
            saveAs: `agent_${agentWallet.slice(0, 8)}_output`,
        });
    }

    return {
        id: `manowar-${manowar.walletAddress}`,
        name: manowar.title || `Manowar ${manowar.walletAddress.slice(0, 8)}`,
        description: manowar.description || "",
        steps,
        chainId: manowar.chainId,
    };
}

// CORS Configuration
app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (origin.startsWith("http://localhost:")) return callback(null, true);
        if (origin === "https://compose.market" ||
            origin === "https://www.compose.market" ||
            origin.endsWith(".compose.market")) {
            return callback(null, true);
        }
        callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    allowedHeaders: [
        "Content-Type",
        "Authorization",
        "PAYMENT-SIGNATURE",           // x402 V2 payment header (ThirdWeb)
        "payment-signature",           // x402 V2 payment header (lowercase)
        "X-PAYMENT",                   // x402 V1 payment header (Cronos)
        "x-payment",                   // x402 V1 payment header (lowercase)
        "X-CHAIN-ID",                  // Multichain support
        "x-session-user-address",
        "x-session-active",
        "x-session-budget-remaining",
        "x-manowar-internal",
        "x-chain-id",
        "x-compose-run-id",
        "x-idempotency-key",
        "x-tool-price",
        "access-control-expose-headers"
    ],
    exposedHeaders: [
        "*",                               // Expose ALL headers (required for ThirdWeb x402)
        "PAYMENT-RESPONSE",            // x402 V2 response header
        "payment-response",            // x402 V2 response header (lowercase)
        "X-Transaction-Hash",          // Cronos settlement response
        "X-PAYMENT-RESPONSE",          // Cronos payment response
        "x-session-id",
        "x-compose-key-budget-limit",
        "x-compose-key-budget-used",
        "x-compose-key-budget-remaining",
    ],
}));
app.use(express.json({ limit: '10mb' }));

// Request logging middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
    const timestamp = new Date().toISOString();
    const composeRunId = req.headers["x-compose-run-id"];
    const idempotencyKey = req.headers["x-idempotency-key"];
    console.log(
        `[${timestamp}] ${req.method} ${req.path} run=${String(composeRunId || "-")} idem=${String(idempotencyKey || "-")}`,
    );
    next();
});

// Mount agent routes
app.use("/agent", agentRoutes);

// Error handling wrapper
function asyncHandler(
    fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
    return (req: Request, res: Response, next: NextFunction) => {
        fn(req, res, next).catch(next);
    };
}

/**
 * Helper to extract string from route params (Express v5 types them as string | string[])
 */
function getParam(value: string | string[] | undefined): string {
    if (Array.isArray(value)) return value[0] || "";
    return value || "";
}

function isInternalRequest(req: Request): boolean {
    const configuredSecret = process.env.MANOWAR_INTERNAL_SECRET;
    if (!configuredSecret) {
        return false;
    }
    const providedSecret = req.headers["x-manowar-internal"];
    return typeof providedSecret === "string" && providedSecret === configuredSecret;
}

// ============================================================================
// Health Check
// ============================================================================

app.get("/health", asyncHandler(async (_req: Request, res: Response) => {
    const pollers = getTemporalWorkerPollers();
    const pollerTotal = Object.values(pollers).reduce((sum, count) => sum + count, 0);
    res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        service: "manowar-orchestration",
        version: "0.1.0",
        temporal: {
            state: temporalWorkerState,
            error: temporalWorkerError,
            fallbackMode: temporalFallbackMode,
            pollers,
            pollerTotal,
        },
    });
}));

// ============================================================================
// Manowar Routes (Workflow Orchestration)
// ============================================================================

// NOTE: Payment handling will be added - extractPaymentInfo and handleX402Payment
// need to be imported from lambda or implemented locally

app.post("/manowar/execute", asyncHandler(async (req: Request, res: Response) => {
    const { payload } = req.body;

    // Extract payment info (includes chainId from X-CHAIN-ID header)
    const paymentInfo = extractPaymentInfo(req.headers as Record<string, string>);

    // Handle x402 payment with multichain support
    const paymentResult = await handleX402Payment(
        paymentInfo.paymentData,
        `${req.protocol}://${req.get("host")}${req.path}`,
        req.method,
        DEFAULT_PRICES.WORKFLOW_RUN,
        undefined, // internalSecret
        paymentInfo.chainId,
        paymentInfo.authHeader, // Compose Key authentication
    );

    if (paymentResult.status !== 200) {
        res.status(paymentResult.status).json(paymentResult.responseBody);
        return;
    }
    Object.entries(paymentResult.responseHeaders).forEach(([key, value]) => {
        res.setHeader(key, value);
    });

    // Parse manowar identifier - must be wallet address
    const walletAddress = String(payload.walletAddress || payload.manowarWallet || payload.id);
    const manowar = getManowar(walletAddress);

    if (!manowar) {
        res.status(404).json({ error: `Manowar "${walletAddress}" not found` });
        return;
    }

    console.log(`[manowar] Executing manowar: ${manowar.title} (${manowar.walletAddress})`);

    // Build workflow steps from agent wallet addresses (using agent-registry for lookup)
    // Only pass agentCardUri - orchestrator resolves full metadata from IPFS
    const steps: WorkflowStep[] = [];
    for (const agentWallet of (manowar.agentWalletAddresses || [])) {
        const agent = resolveAgent(agentWallet);
        steps.push({
            id: `agent-${agentWallet.slice(0, 8)}`,
            name: agent?.name || `Agent ${agentWallet.slice(0, 8)}`,
            type: "agent",
            agentAddress: agentWallet,
            // Pass only agentCardUri - Orchestrator resolves full metadata (model, plugins, skills) at runtime
            inputTemplate: {
                agentAddress: agentWallet,
                agentCardUri: agent?.agentCardUri,
            },
            saveAs: `agent_${agentWallet.slice(0, 8)}_output`,
        });
    }
    console.log(`[manowar] Built ${steps.length} agent steps from wallets: [${manowar.agentWalletAddresses?.join(", ") || "none"}]`);

    // Build workflow from registry data - use wallet address as ID
    const workflow: Workflow = {
        id: `manowar-${manowar.walletAddress}`,
        name: manowar.title || `Manowar ${manowar.walletAddress.slice(0, 8)}`,
        description: manowar.description || "",
        steps,
        chainId: manowar.chainId,
    };

    // Prepare payment context
    const paymentContext: PaymentContext = {
        paymentData: req.headers["payment-signature"] as string || req.headers["PAYMENT-SIGNATURE"] as string || null,
        sessionActive: paymentInfo.sessionActive,
        sessionBudgetRemaining: paymentInfo.sessionBudgetRemaining,
        resourceUrlBase: `${req.protocol}://${req.get("host")}`,
        userId: req.headers["x-session-user-address"] as string | undefined,
    };

    // Execute workflow with orchestrator
    const userMessage = typeof payload.input === "string"
        ? payload.input
        : payload.input?.message || payload.message || "Execute workflow";
    const requestedThreadId =
        typeof payload.threadId === "string"
            ? payload.threadId
            : typeof payload.input?.threadId === "string"
                ? payload.input.threadId
                : undefined;

    if (!isTemporalReady() && !ALLOW_DIRECT_EXECUTION_FALLBACK) {
        res.status(503).json({
            error: "Temporal is not ready and direct fallback is disabled",
            temporal: {
                state: temporalWorkerState,
                pollers: getTemporalWorkerPollers(),
            },
        });
        return;
    }

    const runId = createComposeRunId();
    // Use executeManowarRunWithFallback for automatic circuit breaker protection
    // Falls back to direct execution if Temporal is unavailable
    const result = await executeManowarRunWithFallback(
        manowar.walletAddress,
        workflow,
        userMessage,
        sanitizeExecutorOptions({
            payment: paymentContext,
            coordinatorModel: manowar.coordinatorModel,
            manowarCardUri: manowar.manowarCardUri,
            userId: req.headers["x-session-user-address"] as string | undefined,
            threadId: requestedThreadId,
            manowarWallet: manowar.walletAddress,
        }),
        runId,
    );

    // Mark as executed
    markManowarExecuted(manowar.walletAddress);

    res.json(result);
}));

app.get("/manowar/prices", (_req: Request, res: Response) => {
    res.json({
        ORCHESTRATION: MANOWAR_PRICES.ORCHESTRATION,
        AGENT_STEP: MANOWAR_PRICES.AGENT_STEP,
        INFERENCE: MANOWAR_PRICES.INFERENCE,
        MCP_TOOL: MANOWAR_PRICES.MCP_TOOL,
    });
});

app.post("/manowar/register", asyncHandler(async (req: Request, res: Response) => {
    // NOTE: Registration is FREE (no x402 payment) - payment is collected during chat/execution
    // Parse body directly (matches agent pattern - no nested "payload" wrapper)
    const { walletAddress, manowarId, manowarCardUri, dnaHash, title, description, creator,
        hasCoordinator, coordinatorModel, totalPrice, image, agentWalletAddresses } = req.body;

    // Validate walletAddress (primary identifier - matches agent pattern)
    if (!walletAddress || !walletAddress.startsWith("0x") || walletAddress.length !== 42) {
        res.status(400).json({ error: "walletAddress is required and must be a valid Ethereum address" });
        return;
    }

    // Register directly from frontend data (matches agent pattern)
    const chainIdNum = parseInt(String(req.body.chainId || req.headers["x-chain-id"]));

    try {
        const registrationResult = await registerManowar({
            chainId: chainIdNum,
            walletAddress,
            onchainTokenId: manowarId,
            manowarCardUri,  // contains all metadata
            dnaHash,
            title: title || "",
            description: description || "",
            banner: image,
            creator,
            hasCoordinator,
            coordinatorModel,  // User-selected at mint time
            totalPrice,
            agentWalletAddresses: agentWalletAddresses || [],
        });

        res.status(201).json({
            success: true,
            walletAddress: registrationResult.walletAddress,
            onchainTokenId: registrationResult.onchainTokenId,
            chatUrl: `/manowar/${registrationResult.walletAddress}/chat`,
        });
    } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        // 409 Conflict = already registered (which is fine) - matches agent pattern
        if (errorMsg.includes("already registered") || errorMsg.includes("Already registered")) {
            res.status(409).json({ error: errorMsg });
        } else {
            console.error(`[manowar] Registration failed:`, errorMsg);
            res.status(500).json({ error: errorMsg });
        }
    }
}));

app.get("/manowar", (_req: Request, res: Response) => {
    const manowars = listRegisteredManowars();
    res.json({
        manowars: manowars.map((m) => ({
            walletAddress: m.walletAddress,
            onchainTokenId: m.onchainTokenId,
            title: m.title,
            description: m.description,
            creator: m.creator,
        })),
        total: manowars.length,
    });
});

// ============================================================================
// Trigger Routes (parse, list, create, update, delete)
// ============================================================================

app.post("/api/manowar/triggers/parse", asyncHandler(async (req: Request, res: Response) => {
    const { nlDescription } = req.body || {};
    if (!nlDescription) {
        res.status(400).json({ error: "nlDescription is required" });
        return;
    }
    const parsed = await parseTriggerFromNL(nlDescription);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error || "Could not parse schedule" });
        return;
    }
    res.json({ cronExpression: parsed.cronExpression, cronReadable: parsed.cronReadable });
}));

app.get("/api/manowar/:walletAddress/triggers", asyncHandler(async (req: Request, res: Response) => {
    const manowarWallet = getParam(req.params.walletAddress);
    const userId = req.headers["x-session-user-address"] as string | undefined;
    const triggers = await retrieveTriggers(manowarWallet, userId);
    res.json({ triggers });
}));

app.post("/api/manowar/:walletAddress/triggers", asyncHandler(async (req: Request, res: Response) => {
    const manowarWallet = getParam(req.params.walletAddress);
    const userId = req.headers["x-session-user-address"] as string | undefined;
    const trigger = req.body as TriggerDefinition;
    if (!trigger?.id || !trigger?.name || !trigger?.type) {
        res.status(400).json({ error: "Invalid trigger payload" });
        return;
    }
    trigger.manowarWallet = manowarWallet;
    const memoryId = await storeTrigger(trigger, userId);
    trigger.memoryId = memoryId || trigger.memoryId;

    if (trigger.enabled && trigger.cronExpression) {
        await registerTrigger(trigger, async () => {
            return;
        });
    }

    res.json(trigger);
}));

app.put("/api/manowar/:walletAddress/triggers/:triggerId", asyncHandler(async (req: Request, res: Response) => {
    const manowarWallet = getParam(req.params.walletAddress);
    const triggerId = getParam(req.params.triggerId);
    const userId = req.headers["x-session-user-address"] as string | undefined;
    const updates = req.body as Partial<TriggerDefinition>;

    const triggers = await retrieveTriggers(manowarWallet, userId);
    const existing = triggers.find(t => t.id === triggerId);
    if (!existing) {
        res.status(404).json({ error: "Trigger not found" });
        return;
    }

    const updated: TriggerDefinition = { ...existing, ...updates, id: triggerId, manowarWallet };
    await deleteTriggerFromMemory(triggerId, manowarWallet, userId);
    const memoryId = await storeTrigger(updated, userId);
    updated.memoryId = memoryId || updated.memoryId;

    if (updated.enabled && updated.cronExpression) {
        await registerTrigger(updated, async () => {
            return;
        });
    } else {
        await unregisterTrigger(triggerId, manowarWallet);
    }

    res.json(updated);
}));

app.delete("/api/manowar/:walletAddress/triggers/:triggerId", asyncHandler(async (req: Request, res: Response) => {
    const manowarWallet = getParam(req.params.walletAddress);
    const triggerId = getParam(req.params.triggerId);
    const userId = req.headers["x-session-user-address"] as string | undefined;
    const ok = await deleteTriggerFromMemory(triggerId, manowarWallet, userId);
    res.json({ success: ok });
}));

// ============================================================================
// Memory Routes (Manowar Local Authority)
// ============================================================================

app.post("/api/memory/add", asyncHandler(async (req: Request, res: Response) => {
    const { messages, agentWallet, agent_id, userId, user_id, runId, run_id, metadata, enableGraph, enable_graph } = req.body || {};
    const agentId = agentWallet || agent_id;
    const user = userId || user_id;
    const run = runId || run_id;
    const enableGraphValue = enableGraph ?? enable_graph ?? true;

    if (!Array.isArray(messages) || !agentId) {
        res.status(400).json({ error: "messages and (agentWallet or agent_id) are required" });
        return;
    }

    const result = await addGraphMemory({
        messages,
        agent_id: agentId,
        user_id: user,
        run_id: run,
        metadata,
        enable_graph: Boolean(enableGraphValue),
    });

    res.json(result);
}));

app.post("/api/memory/search", asyncHandler(async (req: Request, res: Response) => {
    const { query, agentWallet, agent_id, userId, user_id, runId, run_id, limit, filters, enableGraph, enable_graph, rerank } = req.body || {};
    const agentId = agentWallet || agent_id;
    const user = userId || user_id;
    const run = runId || run_id;

    if (typeof query !== "string" || !agentId) {
        res.status(400).json({ error: "query and (agentWallet or agent_id) are required" });
        return;
    }

    const result = await searchGraphMemory({
        query,
        agent_id: agentId,
        user_id: user,
        run_id: run,
        limit: typeof limit === "number" ? limit : 10,
        filters: typeof filters === "object" && filters ? filters : undefined,
        enable_graph: Boolean(enableGraph ?? enable_graph ?? true),
        rerank: Boolean(rerank ?? true),
    });

    res.json(result);
}));

app.get("/api/memory/:agentWallet", asyncHandler(async (req: Request, res: Response) => {
    const agentWallet = getParam(req.params.agentWallet);
    const userId = typeof req.query.userId === "string" ? req.query.userId : undefined;

    const memories = await getAllMemories({
        agent_id: agentWallet,
        user_id: userId,
        enable_graph: true,
    });

    res.json(memories);
}));

app.post("/api/memory/vector-search", asyncHandler(async (req: Request, res: Response) => {
    const {
        query,
        queryEmbedding,
        agentWallet,
        userId,
        threadId,
        limit,
        threshold,
    } = req.body || {};

    if (typeof query !== "string" || typeof agentWallet !== "string") {
        res.status(400).json({ error: "query and agentWallet are required" });
        return;
    }

    if (Array.isArray(queryEmbedding) && queryEmbedding.length > 0) {
        const results = await hybridVectorSearch({
            query,
            queryEmbedding,
            agentWallet,
            userId,
            threadId,
            limit: typeof limit === "number" ? limit : 10,
            threshold: typeof threshold === "number" ? threshold : undefined,
            applyDecay: true,
        });
        res.json({ results });
        return;
    }

    const results = await searchVectors({
        query,
        agentWallet,
        userId,
        threadId,
        limit: typeof limit === "number" ? limit : 10,
        threshold: typeof threshold === "number" ? threshold : undefined,
        options: {
            temporalDecay: true,
            rerank: true,
            mmr: true,
            mmrLambda: 0.7,
        },
    });

    res.json({ results });
}));

app.post("/api/memory/vector-index", asyncHandler(async (req: Request, res: Response) => {
    const { content, embedding, agentWallet, userId, threadId, source, metadata } = req.body || {};
    const validSources = new Set(["session", "knowledge", "pattern", "archive", "fact"]);

    if (
        typeof content !== "string"
        || !Array.isArray(embedding)
        || typeof agentWallet !== "string"
        || typeof source !== "string"
        || !validSources.has(source)
    ) {
        res.status(400).json({ error: "content, embedding, agentWallet, and source are required" });
        return;
    }

    const result = await indexVector({
        content,
        embedding,
        agentWallet,
        userId,
        threadId,
        source: source as "session" | "knowledge" | "pattern" | "archive" | "fact",
        metadata,
    });

    res.json({ success: true, vectorId: result.vectorId });
}));

app.post("/api/memory/transcript-store", asyncHandler(async (req: Request, res: Response) => {
    const { sessionId, threadId, agentWallet, userId, messages, tokenCount, summary, summaryEmbedding, metadata } = req.body || {};
    if (!sessionId || !threadId || !agentWallet || !Array.isArray(messages) || typeof tokenCount !== "number") {
        res.status(400).json({ error: "sessionId, threadId, agentWallet, messages, and tokenCount are required" });
        return;
    }

    const result = await storeTranscript({
        sessionId,
        threadId,
        agentWallet,
        userId,
        messages,
        tokenCount,
        summary,
        summaryEmbedding,
        metadata,
    });

    res.json(result);
}));

app.get("/api/memory/transcript-get/:id", asyncHandler(async (req: Request, res: Response) => {
    const id = getParam(req.params.id);
    const type = typeof req.query.type === "string" ? req.query.type : "sessionId";

    const transcript = type === "threadId"
        ? await getTranscriptByThreadId(id)
        : await getTranscriptBySessionId(id);

    if (!transcript) {
        res.status(404).json({ error: "Transcript not found" });
        return;
    }

    res.json(transcript);
}));

app.post("/api/memory/rerank", asyncHandler(async (req: Request, res: Response) => {
    const { query, documents, topK } = req.body || {};
    if (typeof query !== "string" || !Array.isArray(documents)) {
        res.status(400).json({ error: "query and documents are required" });
        return;
    }

    const results = await rerankDocuments({ query, documents, topK });
    res.json({ results });
}));

app.post("/api/memory/layers/search", asyncHandler(async (req: Request, res: Response) => {
    const { query, agentWallet, agent_id, userId, user_id, threadId, thread_id, layers, limit } = req.body || {};
    const wallet = agentWallet || agent_id;
    const user = userId || user_id;
    const thread = threadId || thread_id;

    if (typeof query !== "string" || typeof wallet !== "string") {
        res.status(400).json({ error: "query and (agentWallet or agent_id) are required" });
        return;
    }

    const result = await searchMemoryLayers({
        query,
        agentWallet: wallet,
        userId: user,
        threadId: thread,
        layers: Array.isArray(layers) ? layers : ["working", "scene", "graph", "patterns", "archives", "vectors"],
        limit: typeof limit === "number" ? limit : 5,
    });

    res.json(result);
}));

app.get("/api/memory/stats/:agentWallet", asyncHandler(async (req: Request, res: Response) => {
    const agentWallet = getParam(req.params.agentWallet);
    const stats = await getMemoryStats(agentWallet);
    res.json(stats);
}));

app.post("/internal/memory/consolidate", asyncHandler(async (req: Request, res: Response) => {
    if (!isInternalRequest(req)) {
        res.status(401).json({ success: false, error: "Unauthorized" });
        return;
    }

    const { agentWallets } = req.body || {};
    if (!Array.isArray(agentWallets)) {
        res.status(400).json({ success: false, error: "agentWallets is required" });
        return;
    }

    const data = await consolidateAgentMemories({ agentWallets });
    res.json({ success: true, data });
}));

app.post("/internal/memory/patterns/extract", asyncHandler(async (req: Request, res: Response) => {
    if (!isInternalRequest(req)) {
        res.status(401).json({ success: false, error: "Unauthorized" });
        return;
    }

    const { agentWallet, timeRange, confidenceThreshold } = req.body || {};
    if (typeof agentWallet !== "string" || !timeRange || typeof timeRange.start !== "number" || typeof timeRange.end !== "number") {
        res.status(400).json({ success: false, error: "agentWallet and valid timeRange are required" });
        return;
    }

    const data = await extractExecutionPatterns({
        agentWallet,
        timeRange,
        confidenceThreshold: typeof confidenceThreshold === "number" ? confidenceThreshold : 0.7,
    });
    res.json({ success: true, data });
}));

app.post("/internal/memory/archive/create", asyncHandler(async (req: Request, res: Response) => {
    if (!isInternalRequest(req)) {
        res.status(401).json({ success: false, error: "Unauthorized" });
        return;
    }

    const { agentWallet, dateRange, options } = req.body || {};
    if (typeof agentWallet !== "string" || !dateRange || typeof dateRange.start !== "number" || typeof dateRange.end !== "number") {
        res.status(400).json({ success: false, error: "agentWallet and valid dateRange are required" });
        return;
    }

    const data = await createMemoryArchive({
        agentWallet,
        dateRange,
        compress: options?.compress,
    });
    res.json({ success: true, data });
}));

app.post("/internal/memory/decay/update", asyncHandler(async (req: Request, res: Response) => {
    if (!isInternalRequest(req)) {
        res.status(401).json({ success: false, error: "Unauthorized" });
        return;
    }

    const { halfLifeDays } = req.body || {};
    const data = await updateMemoryDecayScores({
        halfLifeDays: typeof halfLifeDays === "number" ? halfLifeDays : 30,
    });
    res.json({ success: true, data });
}));

app.post("/internal/memory/patterns/validate", asyncHandler(async (req: Request, res: Response) => {
    if (!isInternalRequest(req)) {
        res.status(401).json({ success: false, error: "Unauthorized" });
        return;
    }

    const { patternId } = req.body || {};
    if (typeof patternId !== "string") {
        res.status(400).json({ success: false, error: "patternId is required" });
        return;
    }

    const data = await validateExtractedPattern({ patternId });
    res.json({ success: true, data });
}));

app.post("/internal/memory/patterns/promote", asyncHandler(async (req: Request, res: Response) => {
    if (!isInternalRequest(req)) {
        res.status(401).json({ success: false, error: "Unauthorized" });
        return;
    }

    const { patternId, skillName, validationData } = req.body || {};
    if (typeof patternId !== "string" || typeof skillName !== "string" || !validationData) {
        res.status(400).json({ success: false, error: "patternId, skillName, and validationData are required" });
        return;
    }

    const data = await promotePatternToSkill({ patternId, skillName, validationData });
    res.json({ success: true, data });
}));

app.post("/internal/memory/cleanup", asyncHandler(async (req: Request, res: Response) => {
    if (!isInternalRequest(req)) {
        res.status(401).json({ success: false, error: "Unauthorized" });
        return;
    }

    const { olderThanDays } = req.body || {};
    const data = await cleanupExpiredMemories({
        olderThanDays: typeof olderThanDays === "number" ? olderThanDays : 90,
    });
    res.json({ success: true, data });
}));

app.post("/internal/memory/archive/sync-pinata", asyncHandler(async (req: Request, res: Response) => {
    if (!isInternalRequest(req)) {
        res.status(401).json({ success: false, error: "Unauthorized" });
        return;
    }

    const { archiveId, agentWallet } = req.body || {};
    if (typeof archiveId !== "string" || typeof agentWallet !== "string") {
        res.status(400).json({ success: false, error: "archiveId and agentWallet are required" });
        return;
    }

    const data = await syncArchiveToPinata({ archiveId, agentWallet });
    res.json({ success: true, data });
}));

// ============================================================================
// Manowar Chat (x402 Payable, Streaming)
// ============================================================================

const manowarChatHandler = asyncHandler(async (req: Request, res: Response) => {
    const identifier = getParam(req.params.walletAddress);

    // x402 Payment Verification (includes chainId from X-CHAIN-ID header)
    const paymentInfo = extractPaymentInfo(req.headers as Record<string, string>);
    const internalSecret = req.headers["x-manowar-internal"] as string | undefined;

    const resourceUrl = `https://${req.get("host")}${req.originalUrl}`;
    const paymentResult = await handleX402Payment(
        paymentInfo.paymentData,
        resourceUrl,
        "POST",
        DEFAULT_PRICES.WORKFLOW_RUN,
        internalSecret,
        paymentInfo.chainId, // Multichain support
        paymentInfo.authHeader, // Compose Key authentication
    );

    if (paymentResult.status !== 200) {
        Object.entries(paymentResult.responseHeaders).forEach(([key, value]) => {
            res.setHeader(key, value);
        });
        res.status(paymentResult.status).json(paymentResult.responseBody);
        return;
    }
    Object.entries(paymentResult.responseHeaders).forEach(([key, value]) => {
        res.setHeader(key, value);
    });

    // Resolve manowar from in-memory registry - wallet address only
    let manowar = getManowar(identifier);
    if (!manowar) {
        const chainId = paymentInfo.chainId!;
        console.log(`[manowar] Manowar "${identifier}" not found in local registry, attempting on-chain resolution on chain ${chainId}...`);

        // On-chain fallback using resolveManowarIdentifier
        const onchainResult = await resolveManowarIdentifier(chainId, identifier);
        if (onchainResult) {
            console.log(`[manowar] Auto-registering Manowar ${identifier} from chain ${chainId}...`);
            manowar = await registerManowar({
                chainId: chainId,
                walletAddress: onchainResult.data.walletAddress,
                onchainTokenId: onchainResult.manowarId,
                manowarCardUri: onchainResult.data.manowarCardUri,
                dnaHash: onchainResult.data.dnaHash,
                title: onchainResult.data.title,
                description: onchainResult.data.description,
                banner: onchainResult.data.banner,
                creator: (req.headers["x-session-user-address"] as string) || "0x0000000000000000000000000000000000000000",
                hasCoordinator: onchainResult.data.hasCoordinator,
                coordinatorModel: onchainResult.data.coordinatorModel,
                agentWalletAddresses: onchainResult.data.agentWalletAddresses,
            });
        }
    }

    if (!manowar) {
        res.status(404).json({ error: `Manowar "${identifier}" not found` });
        return;
    }

    console.log(`[manowar] Resolved manowar: ${manowar.title} (${manowar.walletAddress})`);

    const workflow = buildWorkflowFromManowar(manowar);
    console.log(`[manowar] Built ${workflow.steps.length} agent steps from wallets: [${manowar.agentWalletAddresses?.join(", ") || "none"}]`);

    // Parse request - handle both legacy (image/audio) and new (attachment) formats
    const { message, threadId, image, audio, attachment, continuous, composeRunId, lastEventIndex: requestedLastEventIndex } = req.body;
    if (!message) {
        res.status(400).json({ error: "message is required" });
        return;
    }
    const cancellationKey = `${manowar.walletAddress}:${threadId || "default"}`;

    // Prepare payment context
    const paymentContext: PaymentContext = {
        paymentData: req.headers["payment-signature"] as string || req.headers["PAYMENT-SIGNATURE"] as string || null,
        sessionActive: paymentInfo.sessionActive,
        sessionBudgetRemaining: paymentInfo.sessionBudgetRemaining,
        resourceUrlBase: `${req.protocol}://${req.get("host")}`,
        userId: req.headers["x-session-user-address"] as string | undefined,
    };

    // Set up SSE response for long-running workflows
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering
    // Explicit CORS for SSE (browsers require this)
    const origin = req.headers.origin;
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.flushHeaders();
    let clientDisconnected = false;
    const heartbeat = setInterval(() => {
        if (!res.writableEnded) {
            res.write(": ping\n\n");
        }
    }, SSE_HEARTBEAT_INTERVAL_MS);
    res.on("close", () => {
        clientDisconnected = true;
        clearInterval(heartbeat);
    });

    const runId = typeof composeRunId === "string" && composeRunId.length > 0 ? composeRunId : createComposeRunId();
    res.setHeader("x-compose-run-id", runId);
    res.write(`event: start\ndata: ${JSON.stringify({ runId, message: "Starting workflow..." })}\n\n`);

    activeRunIds.set(cancellationKey, runId);

    let result: any;

    if (isTemporalReady()) {
        // Use Temporal workflow execution with polling for SSE
        const handle = await startManowarRun(
            manowar.walletAddress,
            workflow,
            message,
            sanitizeExecutorOptions({
                payment: paymentContext,
                coordinatorModel: manowar.coordinatorModel,
                manowarCardUri: manowar.manowarCardUri,
                continuous: Boolean(continuous),
                maxLoopIterations: Boolean(continuous) ? 5 : undefined,
                userId: req.headers["x-session-user-address"] as string | undefined,
                threadId,
                manowarWallet: manowar.walletAddress,
            }),
            runId,
        );

        let lastEventIndex = typeof requestedLastEventIndex === "number" && Number.isFinite(requestedLastEventIndex)
            ? Math.max(0, requestedLastEventIndex)
            : 0;
        let latestState = await getManowarRunState(manowar.walletAddress, runId);
        let missingStateCount = latestState ? 0 : 1;
        const pollStartedAt = Date.now();
        let pollFailed = false;

        while (true) {
            if (clientDisconnected) {
                return;
            }
            latestState = await getManowarRunState(manowar.walletAddress, runId);
            if (!latestState) {
                missingStateCount += 1;
                const pollTimedOut = Date.now() - pollStartedAt >= SSE_POLL_TIMEOUT_MS;
                if (missingStateCount >= SSE_STATE_MISS_LIMIT || pollTimedOut) {
                    pollFailed = true;
                    const reason = pollTimedOut
                        ? "Run state polling timed out"
                        : "Run state unavailable";
                    res.write(`event: error\ndata: ${JSON.stringify({ runId, error: reason })}\n\n`);
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, SSE_POLL_INTERVAL_MS));
                continue;
            }

            missingStateCount = 0;
            if (latestState?.events?.length) {
                while (lastEventIndex < latestState.events.length) {
                    const event = latestState.events[lastEventIndex];
                    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
                    lastEventIndex++;
                }
            }

            const status = latestState?.status;
            if (status === "success" || status === "error" || status === "cancelled") {
                break;
            }
            if (Date.now() - pollStartedAt >= SSE_POLL_TIMEOUT_MS) {
                pollFailed = true;
                res.write(`event: error\ndata: ${JSON.stringify({ runId, error: "Run state polling timed out" })}\n\n`);
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, SSE_POLL_INTERVAL_MS));
        }

        if (pollFailed) {
            result = {
                success: false,
                result: "",
                stepResults: [],
                totalTokensUsed: 0,
                error: latestState?.error || "Workflow state became unavailable",
            };
        } else {
            try {
                result = await handle.result();
            } catch (error) {
                if (clientDisconnected) {
                    return;
                }
                const errorMessage = error instanceof Error ? error.message : String(error);
                result = {
                    success: false,
                    result: "",
                    stepResults: [],
                    totalTokensUsed: 0,
                    error: latestState?.error || errorMessage,
                };
            }
        }
    } else {
        if (!ALLOW_DIRECT_EXECUTION_FALLBACK) {
            res.write(`event: error\ndata: ${JSON.stringify({ runId, error: "Temporal is unavailable and direct fallback is disabled" })}\n\n`);
            res.write("event: done\ndata: {}\n\n");
            clearInterval(heartbeat);
            res.end();
            return;
        }

        // Fallback to direct orchestrator execution with SSE callbacks
        console.log(`[manowar/chat] Using direct execution (Temporal unavailable or in fallback mode)`);

        try {
            result = await executeWithOrchestrator(workflow, message, {
                payment: paymentContext,
                coordinatorModel: manowar.coordinatorModel,
                manowarCardUri: manowar.manowarCardUri,
                continuous: Boolean(continuous),
                maxLoopIterations: Boolean(continuous) ? 5 : undefined,
                userId: req.headers["x-session-user-address"] as string | undefined,
                threadId,
                manowarWallet: manowar.walletAddress,
                runId,
                shouldCancel: () => {
                    // Check cancellation via activeRunIds (consistent with stop endpoint)
                    return !activeRunIds.has(cancellationKey);
                },
                onProgress: (event: any) => {
                    // Send SSE event for each progress update
                    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
                },
            });
        } catch (error) {
            if (clientDisconnected) {
                return;
            }
            const errorMessage = error instanceof Error ? error.message : String(error);
            result = {
                success: false,
                result: "",
                stepResults: [],
                totalTokensUsed: 0,
                error: errorMessage,
            };
        }
    }

    activeRunIds.delete(cancellationKey);

    // Mark as executed
    markManowarExecuted(manowar.walletAddress);

    // Extract output from result
    const output = result.result || (result.success ? "Workflow completed" : result.error || "");

    // Send final result as SSE event
    const finalData = {
        success: result.success,
        output: typeof output === "string" ? output : JSON.stringify(output),
        walletAddress: manowar.walletAddress,
        onchainTokenId: manowar.onchainTokenId,
        error: result.error,
    };
    res.write(`event: result\ndata: ${JSON.stringify(finalData)}\n\n`);
    res.write(`event: done\ndata: {}\n\n`);
    clearInterval(heartbeat);
    res.end();
});

app.post("/manowar/:walletAddress/chat", manowarChatHandler);

// Stop a running workflow (best-effort, cancels between steps)
app.post("/manowar/:walletAddress/stop", asyncHandler(async (req: Request, res: Response) => {
    const walletAddress = getParam(req.params.walletAddress);
    const { threadId, runId: requestedRunId } = req.body || {};
    const cancellationKey = `${walletAddress}:${threadId || "default"}`;
    const runId = typeof requestedRunId === "string" && requestedRunId.length > 0
        ? requestedRunId
        : activeRunIds.get(cancellationKey);
    if (!runId) {
        res.status(404).json({ success: false, error: "No active run found" });
        return;
    }

    try {
        await cancelManowarRun(walletAddress, runId);
        res.json({ success: true, runId });
        return;
    } catch (error) {
        if (error instanceof TemporalRunNotFoundError) {
            res.status(404).json({ success: false, error: error.message });
            return;
        }
        throw error;
    }
}));

app.get("/manowar/:walletAddress/runs/:runId/state", asyncHandler(async (req: Request, res: Response) => {
    const walletAddress = getParam(req.params.walletAddress);
    const runId = getParam(req.params.runId);
    const state = await getManowarRunState(walletAddress, runId);
    if (!state) {
        res.status(404).json({ success: false, error: "Run not found" });
        return;
    }
    res.json(state);
}));

app.post("/manowar/:walletAddress/runs/:runId/approval", asyncHandler(async (req: Request, res: Response) => {
    const walletAddress = getParam(req.params.walletAddress);
    const runId = getParam(req.params.runId);
    const { stepKey, status, approver, reason } = req.body || {};

    if (!stepKey || typeof stepKey !== "string") {
        res.status(400).json({ success: false, error: "stepKey is required" });
        return;
    }
    if (status !== "approved" && status !== "rejected") {
        res.status(400).json({ success: false, error: "status must be 'approved' or 'rejected'" });
        return;
    }

    try {
        await signalStepApproval(walletAddress, runId, stepKey, status, approver, reason);
        res.json({ success: true });
    } catch (error) {
        if (error instanceof TemporalRunNotFoundError) {
            res.status(404).json({ success: false, error: error.message });
            return;
        }
        throw error;
    }
}));

// Alias /run to /chat to match ManowarManifestSchema endpoint definition
app.post("/manowar/:id/run", (req, res, next) => {
    (req.params as Record<string, string>).walletAddress = getParam(req.params.id);
    return manowarChatHandler(req, res, next);
});

// ============================================================================
// Framework Routes (Summary - agents handle actual execution)
// ============================================================================

app.get("/frameworks", (_req: Request, res: Response) => {
    res.json({
        frameworks: [
            {
                id: "langchain",
                name: "LangChain",
                description: "LangChain agent framework with LangGraph support"
            },
            {
                id: "eliza",
                name: "ElizaOS",
                description: "ElizaOS agent framework"
            }
        ]
    });
});

// ============================================================================
// Error Handling
// ============================================================================

app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin) {
        res.header("Access-Control-Allow-Origin", origin);
        res.header("Access-Control-Allow-Credentials", "true");
    }
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", [
        "Content-Type",
        "Authorization",
        "PAYMENT-SIGNATURE",
        "payment-signature",
        "X-PAYMENT",
        "x-payment",
        "X-CHAIN-ID",
        "x-session-user-address",
        "x-session-active",
        "x-session-budget-remaining",
        "x-manowar-internal",
        "x-chain-id",
        "x-compose-run-id",
        "x-idempotency-key",
        "x-tool-price",
        "access-control-expose-headers",
    ].join(", "));
    res.header("Access-Control-Expose-Headers", [
        "PAYMENT-RESPONSE",
        "payment-response",
        "X-Transaction-Hash",
        "X-PAYMENT-RESPONSE",
        "x-session-id",
        "x-compose-key-budget-limit",
        "x-compose-key-budget-used",
        "x-compose-key-budget-remaining",
    ].join(", "));

    console.error(`[Server Error] ${req.method} ${req.path}:`, err.message);
    console.error(err.stack);

    let statusCode = 500;
    let errorMessage = err.message || "Internal server error";

    if (err.message.includes("timeout") || err.message.includes("ECONNRESET")) {
        statusCode = 504;
        errorMessage = "Request timed out. The run may still be processing. Check the run state endpoint.";
    } else if (err.message.includes("Recursion limit")) {
        statusCode = 508;
        errorMessage = "Agent reached maximum reasoning depth.";
    } else if (err.message.includes("not found") || err.message.includes("404")) {
        statusCode = 404;
    } else if (err.message.includes("payment") || err.message.includes("402")) {
        statusCode = 402;
    }

    res.status(statusCode).json({
        error: true,
        status: statusCode,
        message: errorMessage,
        path: req.path,
        timestamp: new Date().toISOString(),
        runId: req.headers["x-compose-run-id"] || undefined,
    });
});

// ============================================================================
// Desktop Agent Memory API (for local agents)
// ============================================================================

app.post("/api/desktop/memory/add", asyncHandler(async (req: Request, res: Response) => {
    const { agentWallet, userAddress, messages, metadata, runId, run_id } = req.body || {};
    const agentId = agentWallet;
    const user = userAddress;
    const run = runId || run_id || `desktop-${Date.now()}`;

    if (!agentId) {
        res.status(400).json({ error: "agentWallet is required" });
        return;
    }

    if (!Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({ error: "messages array is required" });
        return;
    }

    const result = await addGraphMemory({
        messages,
        agent_id: agentId,
        user_id: user,
        run_id: run,
        metadata: typeof metadata === "object" && metadata ? metadata : undefined,
    });

    console.log(`[Desktop Memory] Added ${result.length} memories for agent ${agentId}`);
    res.json({ success: true, count: result.length, memories: result });
}));

app.post("/api/desktop/memory/search", asyncHandler(async (req: Request, res: Response) => {
    const { query, agentWallet, userAddress, runId, run_id, limit } = req.body || {};
    const agentId = agentWallet;
    const user = userAddress;
    const run = runId || run_id;

    if (!query || !agentId) {
        res.status(400).json({ error: "query and agentWallet are required" });
        return;
    }

    const memories = await searchGraphMemory({
        query,
        agent_id: agentId,
        user_id: user,
        run_id: run,
        limit: typeof limit === "number" ? limit : 10,
    });

    res.json({
        memories,
        entities: [],
        relations: [],
    });
}));

app.get("/api/desktop/memory/:agentWallet", asyncHandler(async (req: Request, res: Response) => {
    const agentWallet = getParam(req.params.agentWallet);
    const userAddress = typeof req.query.userAddress === "string" ? req.query.userAddress : undefined;

    const memories = await getAllMemories({
        agent_id: agentWallet,
        user_id: userAddress,
    });

    res.json({
        agentWallet,
        memories,
        count: memories.length,
    });
}));

app.post("/api/desktop/memory/context", asyncHandler(async (req: Request, res: Response) => {
    const { agentWallet, userAddress, runId, run_id } = req.body || {};
    const agentId = agentWallet;
    const user = userAddress;
    const run = runId || run_id;

    if (!agentId) {
        res.status(400).json({ error: "agentWallet is required" });
        return;
    }

    const memories = await getAllMemories({
        agent_id: agentId,
        user_id: user,
        run_id: run,
    });

    const contextText = memories
        .slice(0, 10)
        .map(m => m.memory)
        .join("\n\n");

    res.json({
        context: contextText || "No prior context found.",
        memoryCount: memories.length,
    });
}));

// ============================================================================
// Desktop Agent Self-Learning API
// ============================================================================

app.get("/api/desktop/skills/recommended", asyncHandler(async (req: Request, res: Response) => {
    const { agentWallet, task } = req.query;
    
    if (!agentWallet) {
        res.status(400).json({ error: "agentWallet is required" });
        return;
    }

    const recentMemories = await searchGraphMemory({
        query: task as string || "agent capabilities tools",
        agent_id: agentWallet as string,
        limit: 5,
    });

    const recommendedSkills = recentMemories.map((m) => ({
        id: m.id,
        name: m.memory.slice(0, 50),
        relevance: "high",
    }));

    res.json({
        agentWallet,
        recommendedSkills,
        basedOn: "execution_history",
    });
}));

app.post("/api/desktop/skills/learn", asyncHandler(async (req: Request, res: Response) => {
    const { agentWallet, userAddress, task, outcome, toolSequence } = req.body || {};

    if (!agentWallet) {
        res.status(400).json({ error: "agentWallet is required" });
        return;
    }

    const runId = `learn-${Date.now()}`;
    
    const messages = [
        { role: "user", content: `Task: ${task}` },
        { role: "assistant", content: `Completed with: ${outcome}\nTools used: ${(toolSequence || []).join(" → ")}` },
    ];

    await addGraphMemory({
        messages,
        agent_id: agentWallet,
        user_id: userAddress,
        run_id: runId,
        metadata: {
            type: "execution_learning",
            task,
            outcome,
            toolSequence: toolSequence || [],
            timestamp: Date.now(),
        },
    });

    console.log(`[Self-Learning] Agent ${agentWallet} learned from task: ${task}`);
    
    res.json({
        success: true,
        task,
        learned: true,
    });
}));

// ============================================================================
// Temporal Integration Helpers
// ============================================================================

let temporalFallbackMode = false;

function isTemporalReady(): boolean {
    if (temporalWorkerState !== "ready" || temporalFallbackMode) {
        return false;
    }
    const pollers = getTemporalWorkerPollers();
    return Object.values(pollers).every((count) => count > 0);
}

// ============================================================================
// Server Startup
// ============================================================================

const PORT = process.env.PORT || 4003;

app.listen(PORT, () => {
    console.log(`[manowar] Server listening on port ${PORT}`);
    console.log(`[manowar] Agent Orchestration & Workflow Execution`);

    // Check if Temporal is configured
    if (!isTemporalConfigured()) {
        console.log(`[manowar] Temporal not configured`);
        temporalWorkerState = "error";
        temporalFallbackMode = ALLOW_DIRECT_EXECUTION_FALLBACK;
        temporalWorkerError = ALLOW_DIRECT_EXECUTION_FALLBACK
            ? "Temporal not configured - using direct execution fallback mode"
            : "Temporal not configured - fallback disabled";
        if (!ALLOW_DIRECT_EXECUTION_FALLBACK) {
            console.error("[manowar] Temporal is mandatory and fallback is disabled.");
        }
        return;
    }

    // Start Temporal workers non-blocking
    console.log(`[manowar] Starting Temporal workers...`);
    void startManowarTemporalWorkers()
        .then(() => {
            temporalWorkerState = "ready";
            temporalWorkerError = undefined;
            console.log(`[manowar] Temporal workers ready`);
        })
        .catch((error) => {
            temporalWorkerState = "error";
            temporalWorkerError = error instanceof Error ? error.message : String(error);
            temporalFallbackMode = ALLOW_DIRECT_EXECUTION_FALLBACK;
            if (ALLOW_DIRECT_EXECUTION_FALLBACK) {
                console.error("[manowar] Failed to start Temporal workers, falling back to direct execution:", error);
                console.log(`[manowar] Server continues in fallback mode - workflows will use direct execution`);
            } else {
                console.error("[manowar] Failed to start Temporal workers and fallback is disabled:", error);
            }
        });
});

export default app;
