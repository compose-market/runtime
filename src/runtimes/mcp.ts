/**
 * MCP Runtime - On-Demand Server Spawning
 * 
 * Spawns individual MCP servers on-demand with multi-transport support:
 * - stdio: Traditional npm/npx packages (StdioClientTransport)
 * - http: Remote SSE/Streamable HTTP servers (HttpSseClientTransport)
 * - docker: Containerized servers (DockerClientTransport)
 * 
 * Each server gets its own session with isolated state.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { HttpSseClientTransport } from "./transports/http.js";
import { DockerClientTransport } from "./transports/docker.js";
import { NpxClientTransport } from "./transports/npx.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ComposeTool } from "../types.js";
import { randomUUID } from "crypto";
import { execSync } from "child_process";
import { existsSync, readdirSync, statSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export type McpRuntimeErrorCode =
  | "MCP_CONFIG_NOT_FOUND"
  | "MCP_SPAWN_TIMEOUT"
  | "MCP_SPAWN_FAILED"
  | "MCP_SESSION_NOT_FOUND"
  | "MCP_SESSION_INVALID"
  | "MCP_TOOL_FAILED"
  | "MCP_RUNTIME_UNAVAILABLE";

export class McpRuntimeError extends Error {
  code: McpRuntimeErrorCode;
  retryable: boolean;
  statusCode: number;

  constructor(code: McpRuntimeErrorCode, message: string, retryable: boolean, statusCode = 500) {
    super(message);
    this.name = "McpRuntimeError";
    this.code = code;
    this.retryable = retryable;
    this.statusCode = statusCode;
  }
}

function isMcpRuntimeError(error: unknown): error is McpRuntimeError {
  return error instanceof McpRuntimeError;
}

// Spawn timeout to prevent hanging on failed MCP servers
const SPAWN_TIMEOUT_MS = 20000;  // 20s - NPX packages need time to download on cold start

// Disk health thresholds
const MIN_DISK_MB = 500;         // Refuse spawns below 500MB free
const NPX_CACHE_MAX_MB = 2048;   // Auto-clean npx cache above 2GB
const NPX_CACHE_DIR = join(homedir(), ".npm", "_npx");

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise
      .then((result) => { clearTimeout(timer); resolve(result); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}

/**
 * Check available disk space. Returns MB free, or -1 on error.
 */
function getFreeDiskMB(): number {
  try {
    const output = execSync("df -m / | tail -1", { encoding: "utf8", timeout: 5000 });
    const parts = output.trim().split(/\s+/);
    // df -m output: Filesystem 1M-blocks Used Available Use% Mounted
    const available = parseInt(parts[3], 10);
    return isNaN(available) ? -1 : available;
  } catch {
    return -1;
  }
}

/**
 * Get total size of npx cache directory in MB.
 */
function getNpxCacheSizeMB(): number {
  try {
    if (!existsSync(NPX_CACHE_DIR)) return 0;
    const output = execSync(`du -sm "${NPX_CACHE_DIR}" 2>/dev/null`, { encoding: "utf8", timeout: 10000 });
    return parseInt(output.trim().split("\t")[0], 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Clean oldest npx cache entries until total size is under target.
 * Called after session termination to prevent unbounded cache growth.
 */
function cleanNpxCacheIfNeeded(): void {
  try {
    const sizeMB = getNpxCacheSizeMB();
    if (sizeMB < NPX_CACHE_MAX_MB) return;

    console.log(`[mcp] npx cache at ${sizeMB}MB (limit: ${NPX_CACHE_MAX_MB}MB), cleaning oldest entries...`);

    if (!existsSync(NPX_CACHE_DIR)) return;

    // List cache dirs sorted by access time (oldest first)
    const entries = readdirSync(NPX_CACHE_DIR)
      .map(name => {
        const fullPath = join(NPX_CACHE_DIR, name);
        try {
          const stat = statSync(fullPath);
          return { name, fullPath, atime: stat.atimeMs };
        } catch {
          return null;
        }
      })
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .sort((a, b) => a.atime - b.atime);

    // Remove oldest half
    const toRemove = Math.ceil(entries.length / 2);
    let removed = 0;
    for (let i = 0; i < toRemove && i < entries.length; i++) {
      try {
        rmSync(entries[i].fullPath, { recursive: true, force: true });
        removed++;
      } catch {
        // Skip entries that can't be removed
      }
    }

    const newSize = getNpxCacheSizeMB();
    console.log(`[mcp] npx cache cleanup: removed ${removed} entries, ${sizeMB}MB → ${newSize}MB`);
  } catch (err) {
    console.warn(`[mcp] npx cache cleanup failed:`, err);
  }
}

/**
 * Classify spawn errors for actionable diagnostics.
 */
function classifySpawnError(error: unknown, serverId: string): McpRuntimeError {
  if (isMcpRuntimeError(error)) {
    return error;
  }

  const msg = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack || "" : "";
  const combined = `${msg} ${stack}`;

  if (combined.includes("ENOSPC")) {
    return new McpRuntimeError(
      "MCP_SPAWN_FAILED",
      `Server "${serverId}" failed: disk full (ENOSPC). The runtime server has no disk space for package installation.`,
      true,
      503
    );
  }
  if (combined.includes("E404") || combined.includes("404 Not Found")) {
    return new McpRuntimeError(
      "MCP_CONFIG_NOT_FOUND",
      `Server "${serverId}" failed: npm package not found (404). The package name may be incorrect or the server has been removed from the npm registry.`,
      false,
      404
    );
  }
  if (combined.includes("environment variable required") || combined.includes("env") && combined.includes("required")) {
    // Extract the env var name if possible
    const envMatch = combined.match(/([A-Z_]+)\s+environment variable required/i);
    const envVar = envMatch ? envMatch[1] : "unknown";
    return new McpRuntimeError(
      "MCP_CONFIG_NOT_FOUND",
      `Server "${serverId}" requires credentials: ${envVar}. Add your API key via the Backpack credentials to use this server.`,
      false,
      401
    );
  }
  if (combined.includes("Connection closed") || combined.includes("-32000")) {
    return new McpRuntimeError(
      "MCP_SPAWN_FAILED",
      `Server "${serverId}" crashed on startup (connection closed). Check server logs or required environment variables.`,
      true,
      503
    );
  }
  if (combined.includes("Request timed out") || combined.includes("-32001")) {
    return new McpRuntimeError(
      "MCP_SPAWN_TIMEOUT",
      `Server "${serverId}" timed out during initialization. The server may be overloaded or require more time to start.`,
      true,
      504
    );
  }

  return new McpRuntimeError(
    "MCP_SPAWN_FAILED",
    `Server "${serverId}" spawn failed: ${msg}`,
    true,
    503
  );
}

export interface McpRuntimeConfig {
  logLevel?: 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';
  maxSessions?: number;
  sessionTimeoutMs?: number;
}

interface McpServerSession {
  sessionId: string;
  serverId: string;
  client: Client;
  transport: Transport; // Generic transport interface
  transportType: "stdio" | "http" | "docker" | "npx";
  tools: any[];
  createdAt: Date;
  lastUsedAt: Date;
}

export interface ServerSpawnConfig {
  transport: "stdio" | "http" | "docker" | "npx";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  image?: string;
  remoteUrl?: string;
  /** Protocol hint for HTTP transport: "sse" or "streamable-http" */
  protocol?: "sse" | "streamable-http";
  package?: string;
}



/**
 * Failure tracking for exponential backoff
 */
interface ServerFailure {
  count: number;
  lastFailure: Date;
  backoffUntil: Date | null;
}

const MAX_FAILURES = 3;
const FAILURE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const BASE_BACKOFF_MS = 30 * 1000; // 30 seconds
const MAX_BACKOFF_MS = 10 * 60 * 1000; // 10 minutes

/**
 * MCP Runtime Manager
 */
export class McpRuntime {
  private sessions = new Map<string, McpServerSession>();
  private failures = new Map<string, ServerFailure>(); // Track spawn failures
  private config: McpRuntimeConfig;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: McpRuntimeConfig = {}) {
    this.config = {
      logLevel: 'INFO',
      maxSessions: 100,
      sessionTimeoutMs: 30 * 60 * 1000, // 30 mins
      ...config
    };
  }

  /**
   * Initialize the runtime
   */
  async initialize(): Promise<void> {
    console.log("[MCP Runtime] Initialized");

    // Start cleanup interval
    this.cleanupInterval = setInterval(() => {
      this.cleanupIdleSessions();
    }, 60 * 1000); // Check every minute
  }

  /**
   * Spawn an MCP server and create a session
   */
  async spawnServer(serverId: string, config: ServerSpawnConfig): Promise<string> {
    // Check if server is in backoff cooldown
    const failure = this.failures.get(serverId);
    if (failure && failure.backoffUntil && failure.backoffUntil > new Date()) {
      const remainingMs = failure.backoffUntil.getTime() - Date.now();
      throw new McpRuntimeError(
        "MCP_RUNTIME_UNAVAILABLE",
        `Server ${serverId} temporarily unavailable (${failure.count} failures, retry in ${Math.ceil(remainingMs / 1000)}s)`,
        true,
        503
      );
    }

    // Check session limit
    if (this.sessions.size >= this.config.maxSessions!) {
      throw new McpRuntimeError(
        "MCP_RUNTIME_UNAVAILABLE",
        `Session limit reached (${this.config.maxSessions})`,
        true,
        503
      );
    }

    // Disk space pre-check for transports that write to disk (npx, stdio)
    if (config.transport === "npx" || config.transport === "stdio") {
      const freeMB = getFreeDiskMB();
      if (freeMB !== -1 && freeMB < MIN_DISK_MB) {
        // Try emergency cleanup first
        console.warn(`[MCP Runtime] Low disk space (${freeMB}MB), running emergency npx cache cleanup`);
        cleanNpxCacheIfNeeded();
        const freeAfter = getFreeDiskMB();
        if (freeAfter !== -1 && freeAfter < MIN_DISK_MB) {
          throw new McpRuntimeError(
            "MCP_SPAWN_FAILED",
            `Cannot spawn "${serverId}": disk critically low (${freeAfter}MB free, need ${MIN_DISK_MB}MB). ` +
            `Clear space on the runtime server or use an HTTP-transport MCP server.`,
            true,
            503
          );
        }
      }
    }

    console.log(`[MCP Runtime] Spawning server: ${serverId} (transport: ${config.transport})`);

    let transport: Transport;
    let transportType: "stdio" | "http" | "docker" | "npx";

    // Create appropriate transport based on config
    if (config.transport === "http") {
      if (!config.remoteUrl) {
        throw new McpRuntimeError("MCP_CONFIG_NOT_FOUND", "remoteUrl required for HTTP transport", false, 400);
      }
      transport = new HttpSseClientTransport({
        baseUrl: config.remoteUrl,
        protocol: config.protocol,
      });
      transportType = "http";
    } else if (config.transport === "docker") {
      if (!config.image) {
        throw new McpRuntimeError("MCP_CONFIG_NOT_FOUND", "image required for Docker transport", false, 400);
      }
      transport = new DockerClientTransport({ image: config.image });
      transportType = "docker";
    } else if (config.transport === "npx") {
      if (!config.package) {
        throw new McpRuntimeError("MCP_CONFIG_NOT_FOUND", "package required for npx transport", false, 400);
      }
      transport = new NpxClientTransport({
        package: config.package,
        args: config.args,
        env: config.env,
      });
      transportType = "npx";
    } else {
      // stdio transport
      if (!config.command || !config.args) {
        throw new McpRuntimeError("MCP_CONFIG_NOT_FOUND", "command and args required for stdio transport", false, 400);
      }
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([_, v]) => v !== undefined) as [string, string][]
          ),
          ...config.env,
        },
      });
      transportType = "stdio";
    }

    const client = new Client({
      name: "compose-mcp-runtime",
      version: "1.0.0",
    }, {
      capabilities: {},
    });

    try {
      await client.connect(transport);

      // List available tools
      const { tools } = await client.listTools();

      const sessionId = randomUUID();
      const session: McpServerSession = {
        sessionId,
        serverId,
        client,
        transport,
        transportType,
        tools,
        createdAt: new Date(),
        lastUsedAt: new Date(),
      };

      this.sessions.set(sessionId, session);

      // Clear failure record on success
      this.failures.delete(serverId);

      console.log(`[MCP Runtime] Server spawned: ${serverId} (${transportType}, session: ${sessionId}, tools: ${tools.length})`);

      return sessionId;
    } catch (error) {
      // Classify the error for actionable diagnostics
      const diagnosis = classifySpawnError(error, serverId);
      console.error(`[MCP Runtime] Failed to spawn ${serverId}: ${diagnosis.message}`);

      // Record failure for backoff
      const now = new Date();
      const existing = this.failures.get(serverId);

      // Reset count if last failure was outside the window
      const count = (existing && (now.getTime() - existing.lastFailure.getTime() < FAILURE_WINDOW_MS))
        ? existing.count + 1
        : 1;

      // Calculate backoff: exponential with cap
      let backoffUntil: Date | null = null;
      if (count >= MAX_FAILURES) {
        const backoffMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, count - MAX_FAILURES), MAX_BACKOFF_MS);
        backoffUntil = new Date(now.getTime() + backoffMs);
        console.warn(`[MCP Runtime] Server ${serverId} marked unavailable for ${backoffMs / 1000}s after ${count} failures`);
      }

      this.failures.set(serverId, { count, lastFailure: now, backoffUntil });

      // Cleanup transport on error
      try {
        await transport.close();
      } catch {
        // Ignore cleanup errors
      }

      // Throw the classified error instead of the raw MCP error
      throw diagnosis;
    }
  }

  /**
   * Get tools from a spawned session
   */
  getSessionTools(sessionId: string): any[] {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new McpRuntimeError("MCP_SESSION_NOT_FOUND", `Session not found: ${sessionId}`, true, 404);
    }

    session.lastUsedAt = new Date();
    return session.tools;
  }

  /**
   * Verify that a session is still responsive.
   */
  async isSessionAlive(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    try {
      await withTimeout(
        session.client.listTools(),
        5000,
        `Session liveness check timed out for ${session.serverId}`
      );
      session.lastUsedAt = new Date();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Execute a tool on a spawned server
   */
  async executeTool(sessionId: string, toolName: string, args: Record<string, unknown>): Promise<any> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new McpRuntimeError("MCP_SESSION_NOT_FOUND", `Session not found: ${sessionId}`, true, 404);
    }

    session.lastUsedAt = new Date();

    console.log(`[MCP Runtime] Executing ${toolName} on session ${sessionId}`);

    let result;
    try {
      result = await session.client.callTool({
        name: toolName,
        arguments: args,
      });
    } catch (error) {
      const classified = classifySpawnError(error, session.serverId);
      if (classified.code === "MCP_SPAWN_TIMEOUT" || classified.code === "MCP_SPAWN_FAILED") {
        throw new McpRuntimeError("MCP_SESSION_INVALID", classified.message, true, classified.statusCode);
      }
      throw classified;
    }

    if (result.isError) {
      const errorMsg = (result.content as any)[0]?.text || 'Tool execution failed';
      throw new McpRuntimeError("MCP_TOOL_FAILED", errorMsg, true, 500);
    }

    // Try to parse as JSON, fallback to text
    const resultText = (result.content as any)[0]?.text || '{}';
    try {
      return JSON.parse(resultText);
    } catch {
      // Not JSON, return as-is
      return resultText;
    }
  }

  /**
   * Terminate a session
   */
  async terminateSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const transportType = session.transportType;
    const serverId = session.serverId;

    try {
      await session.client.close();
      this.sessions.delete(sessionId);
      console.log(`[MCP Runtime] Session terminated: ${sessionId} (${serverId})`);
    } catch (error) {
      console.error(`[MCP Runtime] Error terminating session ${sessionId}:`, error);
      this.sessions.delete(sessionId); // Remove from map even on error
    }

    // Auto-clean npx cache after npx session closes to prevent disk fill
    if (transportType === "npx") {
      // Run cleanup asynchronously to not block the termination
      setImmediate(() => cleanNpxCacheIfNeeded());
    }
  }

  /**
   * List all active sessions
   */
  listSessions(): Array<{ sessionId: string; serverId: string; toolCount: number; createdAt: Date; lastUsedAt: Date }> {
    return Array.from(this.sessions.values()).map(s => ({
      sessionId: s.sessionId,
      serverId: s.serverId,
      toolCount: s.tools.length,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
    }));
  }

  /**
   * Cleanup idle sessions
   */
  private cleanupIdleSessions(): void {
    const now = Date.now();
    const timeout = this.config.sessionTimeoutMs!;

    for (const [sessionId, session] of this.sessions) {
      const idleTime = now - session.lastUsedAt.getTime();
      if (idleTime > timeout) {
        console.log(`[MCP Runtime] Cleaning up idle session: ${sessionId} (idle: ${Math.round(idleTime / 1000 / 60)}min)`);
        this.terminateSession(sessionId);
      }
    }
  }

  /**
   * Load tools for agent (on-demand spawning)
   * Spawns servers and returns ComposeTool[] for agent consumption
   */
  async loadTools(serverIds: string[]): Promise<ComposeTool[]> {
    if (!serverIds || serverIds.length === 0) return [];

    const tools: ComposeTool[] = [];

    // Normalize server IDs (remove mcp: prefix, registry prefixes, and -server suffix)
    const normalizeId = (id: string): string => {
      let normalized = id;

      // Remove mcp: or mcp- prefix
      while (normalized.match(/^mcp[-:]/)) {
        normalized = normalized.replace(/^mcp[-:]/, '');
      }

      // Remove common registry prefixes (e.g., awesome-mark3labs-mcp-)
      normalized = normalized.replace(/^awesome-[^-]+-mcp-/, '');
      normalized = normalized.replace(/^[^-]+-mcp-/, ''); // Generic prefix-mcp-

      // Remove -server suffix
      normalized = normalized.replace(/-server$/, '');

      return normalized;
    };

    console.log(`[MCP Runtime] loadTools called with ${serverIds.length} server IDs: ${serverIds.join(", ")}`);

    const normalized = serverIds.map(id => {
      const norm = normalizeId(id);
      if (norm !== id) {
        console.log(`[MCP Runtime] Normalized "${id}" → "${norm}"`);
      }
      return norm;
    });

    let successCount = 0;
    let failCount = 0;

    for (const serverId of normalized) {
      try {
        // Get spawn config (on-demand, from connector)
        console.log(`[MCP Runtime] → Loading server "${serverId}"...`);
        const config = await getMcpServerConfig(serverId);
        if (!config) {
          console.warn(`[MCP Runtime] ✗ Unknown server: ${serverId} (no spawn config found)`);
          failCount++;
          continue;
        }

        // Spawn server
        console.log(`[MCP Runtime] ✓ Got config for "${serverId}", spawning...`);
        const sessionId = await this.spawnServer(serverId, config);
        const sessionTools = this.getSessionTools(sessionId);

        // Convert to ComposeTool format
        for (const tool of sessionTools) {
          tools.push({
            name: tool.name,
            description: tool.description || `MCP tool: ${tool.name}`,
            source: 'mcp',
            inputSchema: tool.inputSchema as Record<string, unknown>,
            execute: async (args) => {
              return await this.executeTool(sessionId, tool.name, args);
            },
          });
        }

        console.log(`[MCP Runtime] ✓ Loaded ${sessionTools.length} tools from "${serverId}"`);
        successCount++;
      } catch (error) {
        console.error(`[MCP Runtime] ✗ Failed to load ${serverId}:`, error);
        failCount++;
      }
    }

    console.log(`[MCP Runtime] loadTools complete: ${tools.length} tools from ${successCount} servers (${failCount} failed)`);
    return tools;
  }

  async cleanup(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    const sessions = Array.from(this.sessions.keys());
    await Promise.all(sessions.map(id => this.terminateSession(id)));

    console.log("[MCP Runtime] Cleanup complete");
  }
}

// ============================================================================
// On-Demand Server Spawning (Public API)
// ============================================================================

// Session cache to avoid re-spawning servers
const serverSessions = new Map<string, { sessionId: string; runtime: McpRuntime; createdAt: Date }>();
const spawnLocks = new Map<string, Promise<string>>();
const SESSION_TTL = 30 * 60 * 1000; // 30 minutes

// Singleton runtime for on-demand spawning
let sharedRuntime: McpRuntime | null = null;

/**
 * Get or create the shared MCP runtime instance
 */
async function getSharedRuntime(): Promise<McpRuntime> {
  if (!sharedRuntime) {
    sharedRuntime = new McpRuntime();
    await sharedRuntime.initialize();
  }
  return sharedRuntime;
}

async function withSpawnLock(serverId: string, fn: () => Promise<string>): Promise<string> {
  const existing = spawnLocks.get(serverId);
  if (existing) {
    return existing;
  }

  const spawned = (async () => {
    try {
      return await fn();
    } finally {
      spawnLocks.delete(serverId);
    }
  })();

  spawnLocks.set(serverId, spawned);
  return spawned;
}

async function spawnSession(
  runtime: McpRuntime,
  serverId: string,
  config: ServerSpawnConfig
): Promise<string> {
  return withSpawnLock(serverId, async () => {
    let sessionId: string;
    try {
      sessionId = await withTimeout(
        runtime.spawnServer(serverId, config),
        SPAWN_TIMEOUT_MS,
        `MCP server "${serverId}" spawn timed out after ${SPAWN_TIMEOUT_MS / 1000}s`
      );
    } catch (error) {
      if (isMcpRuntimeError(error)) {
        throw error;
      }
      throw new McpRuntimeError(
        "MCP_SPAWN_TIMEOUT",
        `MCP server "${serverId}" spawn timed out after ${SPAWN_TIMEOUT_MS / 1000}s`,
        true,
        504
      );
    }

    serverSessions.set(serverId, {
      sessionId,
      runtime,
      createdAt: new Date(),
    });

    return sessionId;
  });
}

/**
 * Get tools for an MCP server (spawns on-demand, uses cached session if available)
 */
export async function getServerTools(serverId: string): Promise<{
  serverId: string;
  sessionId: string;
  cached: boolean;
  toolCount: number;
  tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
}> {
  const runtime = await getSharedRuntime();

  // Check for cached session
  const cached = serverSessions.get(serverId);
  if (cached) {
    const age = Date.now() - cached.createdAt.getTime();
    if (age < SESSION_TTL) {
      const alive = await cached.runtime.isSessionAlive(cached.sessionId);
      if (alive) {
        const tools = cached.runtime.getSessionTools(cached.sessionId);
        console.log(`[mcp] Using cached session for ${serverId}: ${cached.sessionId}`);
        return {
          serverId,
          sessionId: cached.sessionId,
          cached: true,
          toolCount: tools.length,
          tools,
        };
      }

      console.log(`[mcp] Cached session ${cached.sessionId} for ${serverId} is stale, terminating and re-spawning`);
      serverSessions.delete(serverId);
      try {
        await cached.runtime.terminateSession(cached.sessionId);
      } catch {
        // Ignore cleanup errors
      }
    } else {
      // Session expired, clean up
      console.log(`[mcp] Session for ${serverId} expired (${Math.round(age / 1000)}s old)`);
      serverSessions.delete(serverId);
      try {
        await cached.runtime.terminateSession(cached.sessionId);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }

  // No valid cached session, spawn new server
  const config = await getMcpServerConfig(serverId);
  if (!config) {
    throw new McpRuntimeError("MCP_CONFIG_NOT_FOUND", `Unknown MCP server: ${serverId}`, false, 404);
  }

  console.log(`[mcp] Spawning new session for ${serverId}: ${config.command} ${config.args?.join(' ') || ''}`);
  const sessionId = await spawnSession(runtime, serverId, config);

  const tools = runtime.getSessionTools(sessionId);

  return {
    serverId,
    sessionId,
    cached: false,
    toolCount: tools.length,
    tools,
  };
}

/**
 * Execute a tool on an MCP server (uses cached session or spawns on-demand)
 */
export async function executeServerTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<any> {
  const runtime = await getSharedRuntime();

  // Check for cached session with explicit liveness check
  let sessionId: string | null = null;
  const cached = serverSessions.get(serverId);

  if (cached) {
    const age = Date.now() - cached.createdAt.getTime();
    if (age < SESSION_TTL) {
      const alive = await cached.runtime.isSessionAlive(cached.sessionId);
      if (alive) {
        sessionId = cached.sessionId;
        console.log(`[mcp] Using cached session for ${serverId}: ${cached.sessionId}`);
      } else {
        console.log(`[mcp] Cached session stale for ${serverId}, terminating and respawning`);
        serverSessions.delete(serverId);
        try {
          await cached.runtime.terminateSession(cached.sessionId);
        } catch {
          // ignore cleanup errors
        }
      }
    } else {
      serverSessions.delete(serverId);
      try {
        await cached.runtime.terminateSession(cached.sessionId);
      } catch {
        // ignore cleanup errors
      }
    }
  }

  // Spawn if no valid session
  if (!sessionId) {
    const config = await getMcpServerConfig(serverId);
    if (!config) {
      throw new McpRuntimeError("MCP_CONFIG_NOT_FOUND", `Unknown MCP server: ${serverId}`, false, 404);
    }

    console.log(`[mcp] Spawning session for tool execution on ${serverId}`);
    sessionId = await spawnSession(runtime, serverId, config);
  }

  // Execute tool; if stale session slips through, respawn once and retry.
  try {
    return await runtime.executeTool(sessionId, toolName, args);
  } catch (error) {
    const classified = classifySpawnError(error, serverId);
    if (classified.code !== "MCP_SESSION_INVALID" && classified.code !== "MCP_SESSION_NOT_FOUND") {
      throw classified;
    }

    const config = await getMcpServerConfig(serverId);
    if (!config) {
      throw new McpRuntimeError("MCP_CONFIG_NOT_FOUND", `Unknown MCP server: ${serverId}`, false, 404);
    }

    console.log(`[mcp] Session invalid for ${serverId}, respawning once and retrying ${toolName}`);
    const stale = serverSessions.get(serverId);
    if (stale) {
      serverSessions.delete(serverId);
      try {
        await stale.runtime.terminateSession(stale.sessionId);
      } catch {
        // ignore cleanup errors
      }
    }

    const respawnedSessionId = await spawnSession(runtime, serverId, config);
    return await runtime.executeTool(respawnedSessionId, toolName, args);
  }
}

/**
 * Get MCP server configuration from Connector Service
 * Connector enforces strict resolution on spawn path (no partial execution matches).
 */
async function getMcpServerConfig(serverId: string): Promise<ServerSpawnConfig | null> {
  const CONNECTOR_URL = process.env.CONNECTOR_URL || "https://services.compose.market/connector";
  const url = `${CONNECTOR_URL}/registry/servers/${encodeURIComponent(serverId)}/spawn`;

  try {
    console.log(`[mcp] Fetching config for "${serverId}"`);
    const response = await fetch(url);

    if (response.ok) {
      const config = await response.json();
      console.log(`[mcp] ✓ Found config for "${serverId}"`);
      return config as ServerSpawnConfig;
    }

    if (response.status === 404) {
      console.warn(`[mcp] ✗ Server "${serverId}" not found`);
      return null;
    }

    throw new McpRuntimeError(
      "MCP_RUNTIME_UNAVAILABLE",
      `Connector returned ${response.status} while resolving "${serverId}"`,
      true,
      response.status
    );
  } catch (error) {
    if (isMcpRuntimeError(error)) {
      throw error;
    }
    console.error(`[mcp] ✗ Error fetching "${serverId}":`, error);
    throw new McpRuntimeError(
      "MCP_RUNTIME_UNAVAILABLE",
      `Connector request failed for "${serverId}"`,
      true,
      503
    );
  }
}

/**
 * Test helper: reset singleton/shared session state between test cases.
 */
export async function __resetMcpRuntimeForTests(): Promise<void> {
  for (const [, cached] of serverSessions) {
    try {
      await cached.runtime.terminateSession(cached.sessionId);
    } catch {
      // Ignore cleanup errors in test reset path
    }
  }
  serverSessions.clear();
  spawnLocks.clear();

  if (sharedRuntime) {
    try {
      await sharedRuntime.cleanup();
    } catch {
      // Ignore cleanup errors in test reset path
    }
    sharedRuntime = null;
  }
}
