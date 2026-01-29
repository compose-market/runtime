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
    executeWithOrchestrator,
    MANOWAR_PRICES,
    type Workflow,
    type PaymentContext,
} from "./manowar/index.js";
import {
    registerManowar,
    getManowar,
    listRegisteredManowars,
    markManowarExecuted,
    resolveAgent,
} from "./frameworks/runtime.js";
import type { WorkflowStep } from "./manowar/types.js";

const app = express();

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
        "access-control-expose-headers"
    ],
    exposedHeaders: [
        "*",                               // Expose ALL headers (required for ThirdWeb x402)
        "PAYMENT-RESPONSE",            // x402 V2 response header
        "payment-response",            // x402 V2 response header (lowercase)
        "X-Transaction-Hash",          // Cronos settlement response
        "X-PAYMENT-RESPONSE",          // Cronos payment response
        "x-session-id"
    ]
}));
app.use(express.json({ limit: '10mb' }));

// Mount agent routes
app.use("/agent", agentRoutes);

// Request logging middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.path}`);
    next();
});

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

// ============================================================================
// Health Check
// ============================================================================

app.get("/health", asyncHandler(async (_req: Request, res: Response) => {
    res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        service: "manowar-orchestration",
        version: "0.1.0",
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
    );

    if (paymentResult.status !== 200) {
        res.status(paymentResult.status).json(paymentResult.responseBody);
        return;
    }

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

    const result = await executeWithOrchestrator(workflow, userMessage, {
        payment: paymentContext,
        coordinatorModel: manowar.coordinatorModel,
        manowarCardUri: manowar.manowarCardUri,
    });

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

    try {
        // Register directly from frontend data (matches agent pattern)
        const registrationResult = await registerManowar({
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
// Manowar Chat (x402 Payable, Streaming)
// ============================================================================

app.post("/manowar/:walletAddress/chat", asyncHandler(async (req: Request, res: Response) => {
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
    );

    if (paymentResult.status !== 200) {
        Object.entries(paymentResult.responseHeaders).forEach(([key, value]) => {
            res.setHeader(key, value);
        });
        res.status(paymentResult.status).json(paymentResult.responseBody);
        return;
    }

    // Resolve manowar from in-memory registry - wallet address only
    const manowar = getManowar(identifier);
    if (!manowar) {
        res.status(404).json({ error: `Manowar "${identifier}" not found` });
        return;
    }

    console.log(`[manowar] Resolved manowar: ${manowar.title} (${manowar.walletAddress})`);

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
            // Pass only agentCardUri - orchestrator resolves full metadata from IPFS
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
    };

    // Parse request - handle both legacy (image/audio) and new (attachment) formats
    const { message, threadId, image, audio, attachment } = req.body;
    if (!message) {
        res.status(400).json({ error: "message is required" });
        return;
    }

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

    // Send initial SSE event
    res.write(`event: start\ndata: ${JSON.stringify({ runId: `run-${Date.now()}`, message: "Starting workflow..." })}\n\n`);

    // Execute workflow with SSE progress callback
    const result = await executeWithOrchestrator(workflow, message, {
        payment: paymentContext,
        coordinatorModel: manowar.coordinatorModel,
        manowarCardUri: manowar.manowarCardUri,
        onProgress: (event: any) => {
            // Send SSE event for each progress update
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
        },
    });

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
    res.end();
}));

// Alias /run to /chat to match ManowarManifestSchema endpoint definition
app.post("/manowar/:id/run", (req, res, next) => {
    req.url = req.url.replace("/run", "/chat");
    app._router.handle(req, res, next);
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

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[error]", err);
    res.status(500).json({
        error: err.message || "Internal server error",
        timestamp: new Date().toISOString(),
    });
});

// ============================================================================
// Server Startup
// ============================================================================

const PORT = process.env.PORT || 4003;

app.listen(PORT, () => {
    console.log(`[manowar] Server listening on port ${PORT}`);
    console.log(`[manowar] Agent Orchestration & Workflow Execution`);
});

export default app;
