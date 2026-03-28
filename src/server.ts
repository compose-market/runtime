/**
 * Runtime Server - Tool & Runtime Service
 *
 * Runtime execution plane for tools and long-running agent/workflow execution.
 */
import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import cors, { type CorsOptions } from "cors";
import path from "path";
import { fileURLToPath } from "url";
import type { Server as HttpServer } from "http";
import { z } from "zod";
import { registerOrchestrationRoutes, initializeWorkflowRuntime, registerWorkspaceRoutes } from "./orchestration.js";
import { requireRuntimeInternalToken } from "./auth.js";
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
} from "./mcps/goat.js";
import {
  McpRuntime,
  McpRuntimeError,
  executeServerTool,
  getServerTools,
} from "./mcps/mcp.js";
import type { ServerSpawnConfig } from "./mcps/mcp.js";
import {
  resolveRuntimeHostMode,
  shouldInitializeWorkflowRuntime,
} from "./framework/mode.js";
import { runWithAgentExecutionContext } from "./framework/agent/context.js";
import { createMem0Tools } from "./framework/agent/tools.js";
import { ensureHai, isA409, verifyAnchor } from "./mesh/hai.js";
import { anchorMeshState } from "./mesh/anchor.js";
import { pinMeshArtifact } from "./mesh/filecoin-pin.js";
import type { MeshSharedArtifactPinRequest, MeshSynapseAnchorRequest } from "./mesh/types.js";

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
    "x-compose-run-id",
    "x-idempotency-key",
    "x-session-active",
    "x-session-user-address",
    "x-session-budget-remaining",
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

function getRequestHeader(req: Request, key: string): string | undefined {
  const value = req.headers[key.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === "string" ? value : undefined;
}

function isProtectedRuntimeRoute(pathname: string): boolean {
  return (
    pathname.startsWith("/goat/") ||
    pathname.startsWith("/mcp/") ||
    pathname.startsWith("/runtime/") ||
    pathname.startsWith("/internal/workflow/")
  );
}

app.use((req: Request, res: Response, next: NextFunction) => {
  if (!isProtectedRuntimeRoute(req.path)) {
    next();
    return;
  }

  if (req.path.startsWith("/internal/workflow/")) {
    if (getRequestHeader(req, "x-runtime-internal-token") !== requireRuntimeInternalToken()) {
      res.status(401).json({
        error: "Missing or invalid runtime internal token",
      });
      return;
    }
    next();
    return;
  }

  const expected = `Bearer ${requireRuntimeInternalToken()}`;
  if (getRequestHeader(req, "authorization") !== expected) {
    res.status(401).json({
      error: "Missing or invalid runtime internal authorization",
    });
    return;
  }

  next();
});

const LOCAL_RUNTIME_AUTH_HEADER = "x-compose-local-runtime-token";
const walletAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const hex32Pattern = /^0x[a-f0-9]{64}$/i;
const privateKeyPattern = /^0x[a-f0-9]{64}$/i;
const haiIdPattern = /^[a-z0-9]{6}$/i;
const statePathPattern = /^compose-[a-z0-9]{6}-#\d+$/i;
const learningPathPattern = /^learning-[a-z0-9]{6}-(learning|report|resource|ticket)-#\d+$/i;

const LocalMeshToolRequestSchema = z.object({
  agentWallet: walletAddressSchema,
  userAddress: walletAddressSchema.optional(),
  toolName: z.enum(["search_memory", "save_memory", "search_all_memory"]),
  args: z.record(z.string(), z.unknown()).optional(),
  haiId: z.string().trim().min(1).max(64).optional(),
  threadId: z.string().trim().min(1).max(128).optional(),
  workflowWallet: walletAddressSchema.optional(),
});

const RegisterHaiRequestSchema = z.object({
  agentWallet: walletAddressSchema.transform((value) => value.toLowerCase() as `0x${string}`),
  userAddress: walletAddressSchema.transform((value) => value.toLowerCase() as `0x${string}`),
  deviceId: z.string().trim().min(8).max(128),
  sessionKeyPrivateKey: z.string().regex(privateKeyPattern).transform((value) => value.toLowerCase() as `0x${string}`).nullable().optional(),
}).strict();

const AnchorRequestSchema = z.object({
  apiUrl: z.string().trim().url(),
  composeKeyToken: z.string().trim().min(1),
  userAddress: walletAddressSchema.transform((value) => value.toLowerCase() as `0x${string}`),
  agentWallet: walletAddressSchema.transform((value) => value.toLowerCase() as `0x${string}`),
  deviceId: z.string().trim().min(8).max(128),
  chainId: z.number().int().positive(),
  targetSynapseExpiry: z.number().int().positive(),
  haiId: z.string().regex(haiIdPattern).transform((value) => value.toLowerCase()),
  updateNumber: z.number().int().positive(),
  path: z.string().regex(statePathPattern),
  canonicalSnapshotJson: z.string().trim().min(2),
  stateRootHash: z.string().regex(hex32Pattern).transform((value) => value.toLowerCase() as `0x${string}`),
  envelopeJson: z.string().trim().min(2),
  sessionKeyPrivateKey: z.string().regex(privateKeyPattern).transform((value) => value.toLowerCase() as `0x${string}`),
  payerAddress: walletAddressSchema.transform((value) => value.toLowerCase() as `0x${string}`).nullable().optional(),
  sessionKeyExpiresAt: z.number().int().positive().nullable().optional(),
}).strict();

const FilecoinPinRequestSchema = z.object({
  apiUrl: z.string().trim().url(),
  composeKeyToken: z.string().trim().min(1),
  userAddress: walletAddressSchema.transform((value) => value.toLowerCase() as `0x${string}`),
  agentWallet: walletAddressSchema.transform((value) => value.toLowerCase() as `0x${string}`),
  deviceId: z.string().trim().min(8).max(128),
  chainId: z.number().int().positive(),
  targetSynapseExpiry: z.number().int().positive(),
  sessionKeyPrivateKey: z.string().regex(privateKeyPattern).transform((value) => value.toLowerCase() as `0x${string}`),
  payerAddress: walletAddressSchema.transform((value) => value.toLowerCase() as `0x${string}`).nullable().optional(),
  sessionKeyExpiresAt: z.number().int().positive().nullable().optional(),
  signedRequestJson: z.string().trim().min(2),
  haiId: z.string().regex(haiIdPattern).transform((value) => value.toLowerCase()),
  artifactKind: z.enum(["learning", "report", "resource", "ticket"]),
  artifactNumber: z.number().int().positive(),
  path: z.string().regex(learningPathPattern),
  payloadJson: z.string().trim().min(2),
  publisherAddress: walletAddressSchema.transform((value) => value.toLowerCase() as `0x${string}`).nullable().optional(),
  accessPriceUsdc: z.string().trim().min(1).nullable().optional(),
  title: z.string().trim().min(1).nullable().optional(),
  summary: z.string().trim().min(1).nullable().optional(),
  copies: z.number().int().positive().optional(),
}).strict();

function requireLocalRuntimeAuthToken(): string {
  const value = String(process.env.COMPOSE_LOCAL_RUNTIME_AUTH_TOKEN || "").trim();
  if (!value) {
    throw new Error("COMPOSE_LOCAL_RUNTIME_AUTH_TOKEN is required for local runtime mesh routes");
  }
  return value;
}

function isLocalMeshRouteEnabled(): boolean {
  return resolveRuntimeHostMode() === "local";
}

function authorizeLocalMeshRequest(req: Request, res: Response): boolean {
  if (!isLocalMeshRouteEnabled()) {
    res.status(404).json({ error: "Local mesh routes are only available in local runtime host mode" });
    return false;
  }

  if (getRequestHeader(req, LOCAL_RUNTIME_AUTH_HEADER) !== requireLocalRuntimeAuthToken()) {
    res.status(401).json({ error: "Missing or invalid local runtime authorization" });
    return false;
  }

  return true;
}

async function executeLocalMeshTool(input: z.infer<typeof LocalMeshToolRequestSchema>): Promise<unknown> {
  const tools = createMem0Tools(input.agentWallet, input.userAddress, input.workflowWallet);
  const tool = tools.find((candidate) => candidate.name === input.toolName);
  if (!tool) {
    throw new Error(`Unsupported local mesh tool: ${input.toolName}`);
  }

  return runWithAgentExecutionContext(
    {
      composeRunId: input.haiId,
      threadId: input.threadId || input.haiId || input.agentWallet,
      agentWallet: input.agentWallet,
      userAddress: input.userAddress,
      workflowWallet: input.workflowWallet,
    },
    async () => await tool.invoke(input.args || {}),
  );
}

function sendValidationError(res: Response, label: string, error: z.ZodError): void {
  res.status(400).json({
    error: label,
    details: error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
}

app.post("/mesh/tools/execute", asyncHandler(async (req: Request, res: Response) => {
  if (!authorizeLocalMeshRequest(req, res)) {
    return;
  }

  const parsed = LocalMeshToolRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, "Invalid local mesh tool payload", parsed.error);
    return;
  }

  try {
    const result = await executeLocalMeshTool(parsed.data);
    res.status(200).json({ result });
  } catch (error) {
    sendRuntimeError(res, error, "Failed to execute local mesh tool");
  }
}));

app.post("/mesh/hai/register", asyncHandler(async (req: Request, res: Response) => {
  if (!authorizeLocalMeshRequest(req, res)) {
    return;
  }

  const parsed = RegisterHaiRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, "Invalid HAI registration payload", parsed.error);
    return;
  }

  try {
    const row = await ensureHai(parsed.data);
    res.status(200).json(row);
  } catch (error) {
    if (isA409(error)) {
      res.status(409).json({
        error: error.message,
        code: error.code,
      });
      return;
    }

    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to register HAI",
    });
  }
}));

app.post("/mesh/synapse/anchor", asyncHandler(async (req: Request, res: Response) => {
  if (!authorizeLocalMeshRequest(req, res)) {
    return;
  }

  const parsed = AnchorRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, "Invalid mesh Synapse anchor payload", parsed.error);
    return;
  }

  try {
    const input = parsed.data as MeshSynapseAnchorRequest;
    await verifyAnchor(input);
    const result = await anchorMeshState(input);
    res.status(200).json(result);
  } catch (error) {
    if (isA409(error)) {
      res.status(409).json({
        error: error.message,
        code: error.code,
      });
      return;
    }

    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to anchor mesh state",
    });
  }
}));

app.post("/mesh/filecoin/pin", asyncHandler(async (req: Request, res: Response) => {
  if (!authorizeLocalMeshRequest(req, res)) {
    return;
  }

  const parsed = FilecoinPinRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, "Invalid mesh Filecoin pin payload", parsed.error);
    return;
  }

  try {
    const result = await pinMeshArtifact(parsed.data as MeshSharedArtifactPinRequest);
    res.status(200).json(result);
  } catch (error) {
    if (isA409(error)) {
      res.status(409).json({
        error: error.message,
        code: error.code,
      });
      return;
    }

    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to pin mesh artifact",
    });
  }
}));

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
  const hostMode = resolveRuntimeHostMode();
  const temporalWorkersEnabled = shouldInitializeWorkflowRuntime();

  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "runtime",
    version: "0.3.0",
    hostMode,
    temporalWorkersEnabled,
    runtimes: {
      goat: goatStatus.initialized,
      mcp: true,
    },
    stats: {
      goatPlugins: goatStatus.plugins.length,
      goatTools: goatStatus.totalTools,
    },
    orchestration: {
      durabilityBoundary: "runtime",
    }
  });
}));

const orchestrationRouter = express.Router();
registerOrchestrationRoutes(orchestrationRouter);
if (shouldInitializeWorkflowRuntime()) {
  initializeWorkflowRuntime();
}
app.use("/internal/workflow", orchestrationRouter);
registerWorkspaceRoutes(app);

app.get("/status", asyncHandler(async (req: Request, res: Response) => {
  // Alias for /health but explicitly requested by Connector
  // We can redirect or just reuse the logic
  const goatStatus = await getRuntimeStatus();
  const hostMode = resolveRuntimeHostMode();
  const temporalWorkersEnabled = shouldInitializeWorkflowRuntime();
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "mcp-runtime",
    version: "0.3.0",
    hostMode,
    temporalWorkersEnabled,
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

  try {
    const result = await executeServerTool(serverId, toolName, args || {});

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
 * Unified endpoint for tool execution from the API control plane and embedded runtime flows.
 */
app.post("/runtime/execute", asyncHandler(async (req: Request, res: Response) => {
  const { source, pluginId, serverId, toolName, args } = req.body;

  try {
    let resultData;

    if (source === 'goat') {
      const result = await executeGoatTool(pluginId, toolName, args || {});
      resultData = { success: result.success, result: result.result, error: result.error };

    } else if (source === 'mcp') {
      const result = await executeServerTool(serverId, toolName, args || {});
      resultData = { success: true, result };

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

app.use((req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next();
    return;
  }

  res.status(404).json({
    error: `Route not found: ${req.method} ${req.path}`,
    timestamp: new Date().toISOString(),
  });
});

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

type RuntimeAutostartOptions = {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  moduleUrl?: string;
};

export function shouldAutoStartRuntimeServer(options: RuntimeAutostartOptions = {}): boolean {
  const argv = options.argv || process.argv;
  const env = options.env || process.env;
  const modulePath = path.resolve(fileURLToPath(options.moduleUrl || import.meta.url));

  if (env.COMPOSE_RUNTIME_NO_AUTOSTART === "true" || env.VITEST === "true" || env.NODE_ENV === "test") {
    return false;
  }

  if (typeof env.NODE_APP_INSTANCE !== "undefined" || typeof env.pm_id !== "undefined" || typeof env.PM2_HOME !== "undefined") {
    return true;
  }

  const entryArgs = argv.slice(1).filter(Boolean);
  if (entryArgs.length === 0) {
    return false;
  }

  const normalizedEntryArgs = entryArgs.map((value) => path.resolve(value));
  if (normalizedEntryArgs.includes(modulePath)) {
    return true;
  }

  const validEntryBasenames = new Set([
    path.basename(modulePath),
    path.basename(modulePath).replace(/\.js$/i, ".ts"),
  ]);
  if (normalizedEntryArgs.some((value) => validEntryBasenames.has(path.basename(value)))) {
    return true;
  }

  const wrapperBasenames = new Set(["processcontainerfork.js", "processcontainer.js"]);
  return normalizedEntryArgs.some((value) => wrapperBasenames.has(path.basename(value).toLowerCase()));
}

let runtimeServerPromise: Promise<HttpServer> | null = null;

export async function startRuntimeServer(port?: number): Promise<HttpServer> {
  if (runtimeServerPromise) {
    return await runtimeServerPromise;
  }

  const resolvedPort = port || Number(process.env.MCP_PORT || process.env.PORT || 4003);
  runtimeServerPromise = new Promise<HttpServer>((resolve, reject) => {
    const server = app.listen(resolvedPort);

    server.once("listening", () => {
      console.log(`[mcp] Server listening on port ${resolvedPort}`);
      console.log(`[mcp] Runtime Service (GOAT + MCP Tools)`);
      resolve(server);
    });

    server.once("error", (error) => {
      runtimeServerPromise = null;
      reject(error);
    });
  });

  return await runtimeServerPromise;
}

export { resolveRuntimeHostMode, shouldInitializeWorkflowRuntime } from "./framework/mode.js";

if (shouldAutoStartRuntimeServer()) {
  startRuntimeServer().catch((error) => {
    console.error("[mcp] Failed to start server:", error);
    process.exit(1);
  });
}

export default app;
