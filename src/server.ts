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
    executeManowar,
    MANOWAR_PRICES,
    type Workflow,
    type PaymentContext,
} from "./manowar/index.js";
import { buildManowarWorkflow, resolveManowarIdentifier } from "./onchain.js";
import {
    registerManowar,
    resolveManowar,
    listRegisteredManowars,
    markManowarExecuted,
    type RegisterManowarParams,
} from "./manowar-registry.js";

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

    // Parse manowar identifier
    const identifier = String(payload.manowarId || payload.workflow || payload.id);
    const resolved = await resolveManowarIdentifier(identifier);

    if (!resolved) {
        res.status(404).json({ error: `Manowar "${identifier}" not found` });
        return;
    }

    // Build workflow from on-chain data
    const workflow = await buildManowarWorkflow(resolved.manowarId);

    if (!workflow) {
        res.status(500).json({ error: "Failed to build workflow" });
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

    // Execute workflow
    const result = await executeManowar(workflow, {
        input: payload.input || {},
        payment: paymentContext,
    });

    // Mark as executed
    if (resolved.manowarId !== undefined) {
        markManowarExecuted(resolved.manowarId.toString());
    }

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
    const { payload } = req.body;

    // Extract payment info
    const paymentInfo = extractPaymentInfo(req.headers as Record<string, string>);

    // Handle x402 payment for registration
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

    // Resolve identifier
    const identifier = String(payload.identifier);
    const resolved = await resolveManowarIdentifier(identifier);

    if (!resolved) {
        res.status(404).json({ error: `Manowar "${identifier}" not found` });
        return;
    }

    const registrationResult = registerManowar({
        manowarId: resolved.manowarId,
        walletAddress: payload.walletAddress,
        title: resolved.data.title,
        description: resolved.data.description,
        creator: payload.creator || "0x0000000000000000000000000000000000000000",
    } as RegisterManowarParams);

    res.json({
        success: true,
        manowarId: registrationResult.manowarId,
        walletAddress: registrationResult.walletAddress,
    });
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
