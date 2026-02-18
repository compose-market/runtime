/**
 * MCP Server - Tool & Runtime Service
 *
 * Simplified MCP server focused on tool/runtime management.
 * Handles GOAT plugins and MCP tools only.
 * Agent/Framework orchestration moved to Manowar service.
 */
import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import cors, { type CorsOptions } from "cors";
import path from "path";
import { fileURLToPath } from "url";
import type { Server as HttpServer } from "http";
import { z } from "zod";
import { handleX402Payment, extractPaymentInfo, DEFAULT_PRICES } from "./payment.js";
import {
  getRuntimeStatus,
  listPlugins,
  getPluginTools,
  listAllTools,
  getTool,
  hasTool,
  getWalletAddress,
  getPluginIds,
  executeGoatTool,
} from "./runtimes/goat.js";
import {
  McpRuntime,
  McpRuntimeError,
  executeServerTool,
  getServerTools,
} from "./runtimes/mcp.js";
import type { ServerSpawnConfig } from "./runtimes/mcp.js";

const app = express();

// CORS Configuration
const corsOptions: CorsOptions = {
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
    "x-compose-run-id",
    "x-idempotency-key",
    "x-tool-price",
    "access-control-expose-headers"
  ],
  exposedHeaders: ["*", "PAYMENT-RESPONSE", "payment-response", "x-session-id"]
};
app.use(cors(corsOptions));
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
// MCP Inspect (Ephemeral Spawn + Tool Introspection)
// ============================================================================

function isInspectEnabled(): boolean {
  return String(process.env.MCP_INSPECT_ENABLED || "").toLowerCase() === "true";
}

function isPlaceholderUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.includes("your-") ||
    lower.includes("your_") ||
    lower.includes("localhost") ||
    lower.includes("127.0.0.1") ||
    lower.includes("0.0.0.0") ||
    lower.includes("example.com") ||
    lower.includes("placeholder") ||
    lower.includes("your-deployment") ||
    lower.includes("your-server") ||
    lower.includes("your-mcp")
  );
}

function isSafeAbsoluteHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (!parsed.hostname) return false;
    if (isPlaceholderUrl(url)) return false;
    // Defensive: avoid connecting to local/private hosts.
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0") return false;
    return true;
  } catch {
    return false;
  }
}

function isSafeNpmPackageName(pkg: string): boolean {
  // Accept: name, name@version, @scope/name, @scope/name@version
  // Reject whitespace and shell metacharacters.
  if (!pkg || pkg.length > 214) return false;
  if (/\s/.test(pkg)) return false;
  if (/[;&|`$<>]/.test(pkg)) return false;

  const scoped = pkg.startsWith("@");
  if (scoped) {
    const slash = pkg.indexOf("/");
    if (slash <= 1) return false;
    const scope = pkg.slice(1, slash);
    const rest = pkg.slice(slash + 1);
    if (!/^[a-zA-Z0-9._-]+$/.test(scope)) return false;
    const [name, version] = rest.split("@", 2);
    if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) return false;
    if (version && !/^[a-zA-Z0-9._+-]+$/.test(version)) return false;
    return true;
  }

  const [name, version] = pkg.split("@", 2);
  if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) return false;
  if (version && !/^[a-zA-Z0-9._+-]+$/.test(version)) return false;
  return true;
}

const InspectCandidateSchema = z.object({
  transport: z.enum(["stdio", "http", "docker", "npx"]),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  image: z.string().optional(),
  remoteUrl: z.string().optional(),
  protocol: z.enum(["sse", "streamable-http"]).optional(),
  package: z.string().optional(),
}).strict();

const InspectRequestSchema = z.object({
  serverId: z.string().min(1),
  candidates: z.array(InspectCandidateSchema).min(1).max(6),
}).strict();

function validateInspectCandidate(candidate: z.infer<typeof InspectCandidateSchema>): { ok: true; value: ServerSpawnConfig } | { ok: false; error: string } {
  if (candidate.transport === "http") {
    if (!candidate.remoteUrl) return { ok: false, error: "remoteUrl is required for http transport" };
    if (!isSafeAbsoluteHttpUrl(candidate.remoteUrl)) return { ok: false, error: `unsafe remoteUrl: ${candidate.remoteUrl}` };
    return { ok: true, value: { transport: "http", remoteUrl: candidate.remoteUrl, protocol: candidate.protocol } };
  }

  if (candidate.transport === "docker") {
    if (!candidate.image) return { ok: false, error: "image is required for docker transport" };
    if (/\s/.test(candidate.image) || /[;&|`$<>]/.test(candidate.image)) {
      return { ok: false, error: `unsafe image: ${candidate.image}` };
    }
    return { ok: true, value: { transport: "docker", image: candidate.image } };
  }

  if (candidate.transport === "npx") {
    if (!candidate.package) return { ok: false, error: "package is required for npx transport" };
    if (!isSafeNpmPackageName(candidate.package)) return { ok: false, error: `unsafe npm package: ${candidate.package}` };
    return { ok: true, value: { transport: "npx", package: candidate.package, args: candidate.args, env: candidate.env } };
  }

  // stdio transport
  if (!candidate.command) return { ok: false, error: "command is required for stdio transport" };
  const allowed = new Set(["uvx", "docker"]);
  if (!allowed.has(candidate.command)) {
    return { ok: false, error: `stdio command not allowed: ${candidate.command}` };
  }

  const args = candidate.args || [];
  // Basic args safety: no shell metacharacters.
  if (args.some((a) => /[;&|`$<>]/.test(a))) {
    return { ok: false, error: "stdio args contain unsafe characters" };
  }

  return { ok: true, value: { transport: "stdio", command: candidate.command, args, env: candidate.env } };
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
    },
    orchestration: {
      durabilityBoundary: "manowar",
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

const inspectRuntime = new McpRuntime({ maxSessions: 5, sessionTimeoutMs: 60 * 1000 });
inspectRuntime.initialize().catch(console.error);

/**
 * POST /mcp/inspect
 * Internal-only: Spawn a server with candidate configs, list tools, then immediately terminate the session.
 */
app.post("/mcp/inspect", asyncHandler(async (req: Request, res: Response) => {
  if (!isInspectEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const internalSecret = req.headers["x-manowar-internal"] as string | undefined;
  const expectedSecret = process.env.MANOWAR_INTERNAL_SECRET;
  if (!internalSecret || !expectedSecret || internalSecret !== expectedSecret) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const parsed = InspectRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
    return;
  }

  const { serverId, candidates } = parsed.data;

  const validCandidates: ServerSpawnConfig[] = [];
  const errors: Array<{ transport: string; code: string; message: string; retryable: boolean; statusCode?: number }> = [];

  for (const candidate of candidates) {
    const validated = validateInspectCandidate(candidate);
    if (!validated.ok) {
      errors.push({
        transport: candidate.transport,
        code: "INVALID_CANDIDATE",
        message: validated.error,
        retryable: false,
        statusCode: 400,
      });
      continue;
    }
    validCandidates.push(validated.value);
  }

  if (validCandidates.length === 0) {
    res.status(200).json({ ok: false, serverId, errors });
    return;
  }

  for (const candidate of validCandidates) {
    let sessionId: string | null = null;
    try {
      sessionId = await inspectRuntime.spawnServer(serverId, candidate);
      const tools = inspectRuntime.getSessionTools(sessionId);

      // Return a capped, minimal tool payload (name + description only).
      const MAX_TOOLS = 500;
      const trimmedTools = tools.slice(0, MAX_TOOLS).map((t: any) => ({
        name: String(t?.name || ""),
        description: typeof t?.description === "string" ? t.description : undefined,
      })).filter((t: any) => t.name.length > 0);

      res.status(200).json({
        ok: true,
        serverId,
        transportUsed: candidate.transport,
        toolCount: trimmedTools.length,
        tools: trimmedTools,
      });
      return;
    } catch (error) {
      if (error instanceof McpRuntimeError) {
        errors.push({
          transport: candidate.transport,
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          statusCode: error.statusCode,
        });
      } else {
        errors.push({
          transport: candidate.transport,
          code: "UNKNOWN",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        });
      }
    } finally {
      if (sessionId) {
        try {
          await inspectRuntime.terminateSession(sessionId);
        } catch {
          // Ignore cleanup errors.
        }
      }
    }
  }

  res.status(200).json({ ok: false, serverId, errors });
}));


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

export async function startRuntimeServer(port?: number): Promise<HttpServer> {
  const resolvedPort = port || Number(process.env.MCP_PORT || process.env.PORT || 4003);
  const server = app.listen(resolvedPort, () => {
    console.log(`[mcp] Server listening on port ${resolvedPort}`);
    console.log(`[mcp] Runtime Service (GOAT + MCP Tools)`);
  });
  return server;
}

const isMainModule = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  startRuntimeServer().catch((error) => {
    console.error("[mcp] Failed to start server:", error);
    process.exit(1);
  });
}

export default app;
