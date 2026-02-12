/**
 * MCP Server - Tool & Runtime Service
 *
 * Simplified MCP server focused on tool/runtime management.
 * Handles GOAT plugins and MCP tools only.
 * Agent/Framework orchestration moved to Manowar service.
 */
import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { handleX402Payment, extractPaymentInfo, DEFAULT_PRICES } from "./payment.js";
import {
  executeGoatTool,
  getRuntimeStatus,
  listPlugins,
  getPlugin,
  getPluginTools,
  listAllTools,
  getTool,
  hasTool,
  getWalletAddress,
  getPluginIds,
} from "./runtimes/goat.js";
import { McpRuntime, getServerTools, executeServerTool, McpRuntimeError } from "./runtimes/mcp.js";

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
    "PAYMENT-SIGNATURE",
    "payment-signature",
    "x-session-user-address",
    "x-session-active",
    "x-session-budget-remaining",
    "x-manowar-internal",
    "x-chain-id",
    "access-control-expose-headers"
  ],
  exposedHeaders: ["*", "PAYMENT-RESPONSE", "payment-response", "x-session-id"]
}));
app.use(express.json({ limit: '10mb' }));

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

function sendRuntimeError(res: Response, error: unknown, fallback: string): void {
  if (error instanceof McpRuntimeError) {
    res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      },
    });
    return;
  }

  res.status(500).json({
    error: {
      code: "UNKNOWN",
      message: error instanceof Error ? error.message : fallback,
      retryable: false,
    },
  });
}

// ============================================================================
// Health Check
// ============================================================================

app.get("/health", asyncHandler(async (_req: Request, res: Response) => {
  const goatStatus = await getRuntimeStatus();

  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "mcp-runtime",
    version: "0.3.0",
    runtimes: {
      goat: goatStatus.initialized,
      mcp: true,
    },
    stats: {
      goatPlugins: goatStatus.plugins.length,
      goatTools: goatStatus.totalTools,
    }
  });
}));

app.get("/status", asyncHandler(async (req: Request, res: Response) => {
  // Alias for /health but explicitly requested by Connector
  // We can redirect or just reuse the logic
  const goatStatus = await getRuntimeStatus();
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "mcp-runtime",
    version: "0.3.0",
    runtimes: {
      goat: goatStatus.initialized,
      mcp: true,
    },
  });
}));

// ============================================================================
// GOAT Plugin Routes (Tool Execution)
// ============================================================================

app.get("/goat/status", asyncHandler(async (_req: Request, res: Response) => {
  const status = await getRuntimeStatus();
  res.json({
    ...status,
    note: status.initialized
      ? "GOAT runtime operational"
      : "GOAT runtime initialization failed"
  });
}));

app.get("/goat/plugins", asyncHandler(async (_req: Request, res: Response) => {
  const plugins = await listPlugins();
  res.json({
    plugins: plugins.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      toolCount: p.toolCount,
      requiresApiKey: p.requiresApiKey,
      apiKeyConfigured: p.apiKeyConfigured,
    })),
    total: plugins.length,
  });
}));

app.get("/goat/tools", asyncHandler(async (_req: Request, res: Response) => {
  const tools = await listAllTools();
  res.json({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      pluginId: t.pluginId,
    })),
    total: tools.length,
  });
}));

app.get("/goat/plugins/:pluginId", asyncHandler(async (req: Request, res: Response) => {
  const pluginId = req.params.pluginId as string;
  const pluginIds = await getPluginIds();

  if (!pluginIds.includes(pluginId)) {
    res.status(404).json({ error: `Plugin "${pluginId}" not found` });
    return;
  }

  const tools = await getPluginTools(pluginId);
  const walletAddress = getWalletAddress();
  res.json({
    pluginId,
    walletAddress,
    toolCount: tools.length,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  });
}));

app.get("/goat/plugins/:pluginId/tools/:toolName", asyncHandler(async (req: Request, res: Response) => {
  const pluginId = req.params.pluginId as string;
  const toolName = req.params.toolName as string;
  const pluginIds = await getPluginIds();

  if (!pluginIds.includes(pluginId)) {
    res.status(404).json({ error: `Plugin "${pluginId}" not found` });
    return;
  }

  const tool = await getTool(toolName);
  if (!tool) {
    const tools = await getPluginTools(pluginId);
    res.status(404).json({
      error: `Tool "${toolName}" not found in plugin "${pluginId}"`,
      availableTools: tools.map((t) => t.name),
    });
    return;
  }

  res.json(tool);
}));

// Execute GOAT tool with x402 payment
app.post("/goat/plugins/:pluginId/tools/:toolName", asyncHandler(async (req: Request, res: Response) => {
  const pluginId = req.params.pluginId as string;
  const toolName = req.params.toolName as string;
  const { args } = req.body;

  // Extract payment info and internal bypass header (includes chainId from X-CHAIN-ID)
  const paymentInfo = extractPaymentInfo(req.headers as Record<string, string>);
  const internalSecret = req.headers["x-manowar-internal"] as string | undefined;

  // Handle x402 payment (with internal bypass support + multichain)
  const paymentResult = await handleX402Payment(
    paymentInfo.paymentData,
    `${req.protocol}://${req.get("host")}${req.path}`,
    req.method,
    DEFAULT_PRICES.GOAT_EXECUTE,
    internalSecret,
    paymentInfo.chainId,
  );

  if (paymentResult.status !== 200) {
    res.status(paymentResult.status).json(paymentResult.responseBody);
    return;
  }

  // Phase 1: Extract pricing metadata for usage logging
  const toolPrice = req.headers["x-tool-price"] as string | undefined;

  const pluginIds = await getPluginIds();
  if (!pluginIds.includes(pluginId)) {
    res.status(404).json({ error: `Plugin "${pluginId}" not found` });
    return;
  }

  const toolExists = await hasTool(toolName);
  if (!toolExists) {
    const tools = await getPluginTools(pluginId);
    res.status(404).json({
      error: `Tool "${toolName}" not found`,
      availableTools: tools.map((t) => ({ name: t.name, description: t.description })),
    });
    return;
  }

  const result = await executeGoatTool(pluginId, toolName, args || {});

  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }

  const walletAddress = getWalletAddress();

  // Phase 1: Log usage with pricing for analytics
  console.log(`[usage] GOAT tool executed: ${pluginId}/${toolName}, price: ${toolPrice || 'unknown'}, bypass: internal`);

  res.json({
    success: true,
    result: result.result,
    txHash: result.txHash,
    gasUsed: result.gasUsed,
    executor: walletAddress,
  });
}));

// ============================================================================
// MCP Server Spawning Routes (On-Demand)
// ============================================================================

const mcpRuntime = new McpRuntime();
mcpRuntime.initialize().catch(console.error);


/**
 * POST /mcp/spawn
 * Explicitly spawn an MCP server and return session details
 */
app.post("/mcp/spawn", asyncHandler(async (req: Request, res: Response) => {
  const { serverId } = req.body;
  if (!serverId) {
    res.status(400).json({ error: "serverId is required" });
    return;
  }

  // Extract payment info and internal bypass header (includes chainId from X-CHAIN-ID)
  const paymentInfo = extractPaymentInfo(req.headers as Record<string, string>);
  const internalSecret = req.headers["x-manowar-internal"] as string | undefined;

  // Handle x402 payment (with internal bypass support + multichain) - use CALL price for spawning
  const paymentResult = await handleX402Payment(
    paymentInfo.paymentData,
    `${req.protocol}://${req.get("host")}${req.path}`,
    req.method,
    DEFAULT_PRICES.MCP_TOOL_CALL,
    internalSecret,
    paymentInfo.chainId,
  );

  if (paymentResult.status !== 200) {
    res.status(paymentResult.status).json(paymentResult.responseBody);
    return;
  }

  try {
    // getServerTools handles spawning on-demand and caching logic
    const result = await getServerTools(serverId);
    console.log(`[mcp] Spawned server ${serverId} via /mcp/spawn`);
    res.json(result);
  } catch (error) {
    sendRuntimeError(res, error, `Failed to spawn ${serverId}`);
  }
}));

/**
 * GET /mcp/servers/:serverId/tools
 * Get tools for an MCP server (spawns on-demand, uses cached session)
 */
app.get("/mcp/servers/:serverId/tools", asyncHandler(async (req: Request, res: Response) => {
  const serverId = req.params.serverId as string;

  try {
    const result = await getServerTools(serverId);
    res.json(result);
  } catch (error) {
    sendRuntimeError(res, error, `Failed to get tools for ${serverId}`);
  }
}));

/**
 * POST /mcp/servers/:serverId/tools/:toolName
 * Execute a tool on an MCP server
 */
app.post("/mcp/servers/:serverId/tools/:toolName", asyncHandler(async (req: Request, res: Response) => {
  const serverId = req.params.serverId as string;
  const toolName = req.params.toolName as string;
  const { args } = req.body;

  // Extract payment info and internal bypass header (includes chainId from X-CHAIN-ID)
  const paymentInfo = extractPaymentInfo(req.headers as Record<string, string>);
  const internalSecret = req.headers["x-manowar-internal"] as string | undefined;

  // Handle x402 payment (with internal bypass support + multichain)
  const paymentResult = await handleX402Payment(
    paymentInfo.paymentData,
    `${req.protocol}://${req.get("host")}${req.path}`,
    req.method,
    DEFAULT_PRICES.MCP_TOOL_CALL,
    internalSecret,
    paymentInfo.chainId,
  );

  if (paymentResult.status !== 200) {
    res.status(paymentResult.status).json(paymentResult.responseBody);
    return;
  }

  // Phase 1: Extract pricing metadata for usage logging
  const toolPrice = req.headers["x-tool-price"] as string | undefined;

  try {
    const result = await executeServerTool(serverId, toolName, args || {});

    // Phase 1: Log usage with pricing for analytics
    console.log(`[usage] MCP tool executed: ${serverId}/${toolName}, price: ${toolPrice || 'unknown'}, bypass: internal`);

    res.json({
      success: true,
      serverId,
      tool: toolName,
      result,
    });
  } catch (error) {
    sendRuntimeError(res, error, `Failed to execute tool ${toolName} on ${serverId}`);
  }
}));

// ============================================================================
// Runtime Execution Endpoint (Unified)
// ============================================================================

/**
 * POST /runtime/execute
 * Unified endpoint for tool execution from Manowar service
 */
app.post("/runtime/execute", asyncHandler(async (req: Request, res: Response) => {
  const { source, pluginId, serverId, toolName, args } = req.body;

  // Extract payment info and internal bypass header (includes chainId from X-CHAIN-ID)
  const paymentInfo = extractPaymentInfo(req.headers as Record<string, string>);
  const internalSecret = req.headers["x-manowar-internal"] as string | undefined;

  // Handle x402 payment (with internal bypass support + multichain)
  const paymentResult = await handleX402Payment(
    paymentInfo.paymentData,
    `${req.protocol}://${req.get("host")}${req.path}`,
    req.method,
    source === 'goat' ? DEFAULT_PRICES.GOAT_EXECUTE : DEFAULT_PRICES.MCP_TOOL_CALL,
    internalSecret,
    paymentInfo.chainId,
  );

  if (paymentResult.status !== 200) {
    res.status(paymentResult.status).json(paymentResult.responseBody);
    return;
  }

  // Phase 1: Extract pricing metadata for usage logging
  const toolPrice = req.headers["x-tool-price"] as string | undefined;

  try {
    let resultData;

    if (source === 'goat') {
      const result = await executeGoatTool(pluginId, toolName, args || {});
      resultData = { success: result.success, result: result.result, error: result.error };

      // Phase 1: Log usage
      console.log(`[usage] GOAT runtime executed: ${pluginId}/${toolName}, price: ${toolPrice || 'unknown'}, bypass: internal`);

    } else if (source === 'mcp') {
      const result = await executeServerTool(serverId, toolName, args || {});
      resultData = { success: true, result };

      // Phase 1: Log usage
      console.log(`[usage] MCP runtime executed: ${serverId}/${toolName}, price: ${toolPrice || 'unknown'}, bypass: internal`);

    } else {
      res.status(400).json({ error: 'Invalid source. Must be "goat" or "mcp"' });
      return;
    }

    res.json(resultData);
  } catch (error) {
    sendRuntimeError(res, error, "Tool execution failed");
  }
}));

// ============================================================================
// Error Handling
// ==================================================================== ========

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

const PORT = process.env.MCP_PORT || process.env.PORT || 4003;

app.listen(PORT, () => {
  console.log(`[mcp] Server listening on port ${PORT}`);
  console.log(`[mcp] Runtime Service (GOAT + MCP Tools)`);
});

export default app;
