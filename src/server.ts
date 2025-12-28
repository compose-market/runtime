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
    resolveManowar,
    listRegisteredManowars,
    markManowarExecuted,
} from "./manowar-registry.js";
import { resolveAgent } from "./agent-registry.js";
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
        "x-payment",
        "x-session-user-address",
        "x-session-active",
        "x-session-budget-remaining",
        "x-manowar-internal",
        "access-control-expose-headers"
    ],
    exposedHeaders: ["x-payment-response", "x-session-id"]
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

    // Extract payment info
    const paymentInfo = extractPaymentInfo(req.headers as Record<string, string>);

    // Handle x402 payment
    const paymentResult = await handleX402Payment(
        paymentInfo.paymentData,
        `${req.protocol}://${req.get("host")}${req.path}`,
        req.method,
        DEFAULT_PRICES.WORKFLOW_RUN
    );

    if (paymentResult.status !== 200) {
        res.status(paymentResult.status).json(paymentResult.responseBody);
        return;
    }

    // Parse manowar identifier and resolve from registry (matches agent pattern)
    const identifier = String(payload.manowarId || payload.workflow || payload.id);
    const manowar = resolveManowar(identifier);

    if (!manowar) {
        res.status(404).json({ error: `Manowar "${identifier}" not found` });
        return;
    }

    console.log(`[manowar] Executing manowar: ${manowar.title} (${manowar.walletAddress})`);

    // Build workflow steps from agent wallet addresses (using agent-registry for lookup)
    const steps: WorkflowStep[] = [];
    for (const agentWallet of (manowar.agentWalletAddresses || [])) {
        const agent = resolveAgent(agentWallet);
        steps.push({
            id: `agent-${agentWallet.slice(0, 8)}`,
            name: agent?.name || `Agent ${agentWallet.slice(0, 8)}`,
            type: "agent",
            agentAddress: agentWallet,
            inputTemplate: { agentAddress: agentWallet },
            saveAs: `agent_${agentWallet.slice(0, 8)}_output`,
        });
    }
    console.log(`[manowar] Built ${steps.length} agent steps from wallets: [${manowar.agentWalletAddresses?.join(", ") || "none"}]`);

    // Build workflow from registry data
    const workflow: Workflow = {
        id: `manowar-${manowar.manowarId}`,
        name: manowar.title || `Manowar #${manowar.manowarId}`,
        description: manowar.description || "",
        steps,
    };

    // Prepare payment context
    const paymentContext: PaymentContext = {
        paymentData: req.headers["x-payment"] as string || null,
        sessionActive: paymentInfo.sessionActive,
        sessionBudgetRemaining: paymentInfo.sessionBudgetRemaining,
        resourceUrlBase: `${req.protocol}://${req.get("host")}`,
        userId: req.headers["x-session-user-address"] as string | undefined,
    };

    // Execute workflow with Shadow Orchestra (new orchestrator)
    const result = await executeWithOrchestrator(workflow, {
        input: payload.input || {},
        payment: paymentContext,
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
    const { walletAddress, manowarId, dnaHash, title, description, creator,
        hasCoordinator, coordinatorModel, totalPrice, image, agentWalletAddresses } = req.body;

    // Validate walletAddress (primary identifier - matches agent pattern)
    if (!walletAddress || !walletAddress.startsWith("0x") || walletAddress.length !== 42) {
        res.status(400).json({ error: "walletAddress is required and must be a valid Ethereum address" });
        return;
    }

    try {
        // Register directly from frontend data (matches agent pattern)
        const registrationResult = registerManowar({
            manowarId: manowarId || 0,
            walletAddress,
            dnaHash,
            title: title || `Manowar #${manowarId}`,
            description: description || "",
            banner: image,
            creator: creator || "0x0000000000000000000000000000000000000000",
            hasCoordinator,
            coordinatorModel,
            totalPrice,
            agentWalletAddresses: agentWalletAddresses || [],
        });

        res.status(201).json({
            success: true,
            manowarId: registrationResult.manowarId,
            walletAddress: registrationResult.walletAddress,
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
            manowarId: m.manowarId,
            walletAddress: m.walletAddress,
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

app.post("/manowar/:id/chat", asyncHandler(async (req: Request, res: Response) => {
    const identifier = req.params.id;

    // x402 Payment Verification
    const paymentInfo = extractPaymentInfo(req.headers as Record<string, string>);
    const internalSecret = req.headers["x-manowar-internal"] as string | undefined;

    const resourceUrl = `https://${req.get("host")}${req.originalUrl}`;
    const paymentResult = await handleX402Payment(
        paymentInfo.paymentData,
        resourceUrl,
        "POST",
        DEFAULT_PRICES.WORKFLOW_RUN,
        internalSecret
    );

    if (paymentResult.status !== 200) {
        Object.entries(paymentResult.responseHeaders).forEach(([key, value]) => {
            res.setHeader(key, value);
        });
        res.status(paymentResult.status).json(paymentResult.responseBody);
        return;
    }

    // Resolve manowar from in-memory registry (matches agent pattern)
    // Agent uses: const agent = resolveAgent(identifier);
    // Manowar uses: const manowar = resolveManowar(identifier);
    const manowar = resolveManowar(identifier);
    if (!manowar) {
        res.status(404).json({ error: `Manowar "${identifier}" not found` });
        return;
    }

    console.log(`[manowar] Resolved manowar: ${manowar.title} (${manowar.walletAddress})`);

    // Build workflow steps from agent wallet addresses (using agent-registry for lookup)
    const steps: WorkflowStep[] = [];
    for (const agentWallet of (manowar.agentWalletAddresses || [])) {
        const agent = resolveAgent(agentWallet);
        steps.push({
            id: `agent-${agentWallet.slice(0, 8)}`,
            name: agent?.name || `Agent ${agentWallet.slice(0, 8)}`,
            type: "agent",
            agentAddress: agentWallet,
            inputTemplate: { agentAddress: agentWallet },
            saveAs: `agent_${agentWallet.slice(0, 8)}_output`,
        });
    }
    console.log(`[manowar] Built ${steps.length} agent steps from wallets: [${manowar.agentWalletAddresses?.join(", ") || "none"}]`);

    // Build workflow from registry data
    const workflow: Workflow = {
        id: `manowar-${manowar.manowarId}`,
        name: manowar.title || `Manowar #${manowar.manowarId}`,
        description: manowar.description || "",
        steps,
    };

    // Parse request
    const { message, threadId, image, audio } = req.body;
    if (!message) {
        res.status(400).json({ error: "message is required" });
        return;
    }

    // Prepare payment context
    const paymentContext: PaymentContext = {
        paymentData: req.headers["x-payment"] as string || null,
        sessionActive: paymentInfo.sessionActive,
        sessionBudgetRemaining: paymentInfo.sessionBudgetRemaining,
        resourceUrlBase: `${req.protocol}://${req.get("host")}`,
        userId: req.headers["x-session-user-address"] as string | undefined,
    };

    // Execute workflow with orchestrator
    const result = await executeWithOrchestrator(workflow, {
        input: { message, threadId, image, audio },
        payment: paymentContext,
    });

    // Mark as executed
    markManowarExecuted(identifier);

    // Extract output from context (the orchestrator stores results in context)
    const output = result.context?.coordinatorResponse ||
        result.context?.message ||
        result.context?.output ||
        (result.status === "success" ? "Workflow completed" : result.error || "");

    if (typeof output === "string" && output.length > 0) {
        // Stream as text/plain for frontend compatibility (matches agent pattern)
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Transfer-Encoding", "chunked");
        res.write(output);
        res.end();
    } else {
        res.json({
            success: result.status === "success",
            output: result.context,
            manowarId: manowar.manowarId,
            walletAddress: manowar.walletAddress,
            tokenState: result.tokenState,
            error: result.error,
        });
    }
}));

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
