import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const goatMock = vi.hoisted(() => ({
  getRuntimeStatus: vi.fn(async () => ({
    initialized: true,
    plugins: [],
    totalTools: 0,
  })),
  peekRuntimeStatus: vi.fn(() => ({
    initialized: true,
    plugins: [],
    totalTools: 0,
  })),
  listPlugins: vi.fn(async () => []),
  getPluginTools: vi.fn(async () => []),
  listAllTools: vi.fn(async () => []),
  getTool: vi.fn(async () => null),
  hasTool: vi.fn(async () => true),
  getWalletAddress: vi.fn(() => "0x0000000000000000000000000000000000000000"),
  getPluginIds: vi.fn(async () => []),
  executeGoatTool: vi.fn(async () => ({
    success: true,
    result: { ok: true },
  })),
}));

const mcpMock = vi.hoisted(() => ({
  McpRuntime: class MockMcpRuntime {
    initialize = vi.fn(async () => undefined);
    spawnServer = vi.fn();
    getSessionTools = vi.fn(() => []);
    terminateSession = vi.fn();
  },
  McpRuntimeError: class McpRuntimeError extends Error {
    statusCode = 500;
    code = "MCP_ERROR";
    retryable = false;
  },
  executeServerTool: vi.fn(async () => ({ ok: true })),
  getServerTools: vi.fn(async () => []),
}));

vi.mock("../src/mcps/goat.js", () => goatMock);
vi.mock("../src/mcps/mcp.js", () => mcpMock);

import * as serverModule from "../src/server.js";

const app = serverModule.default;

describe("runtime server internal access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("RUNTIME_INTERNAL_SECRET", "runtime-internal-token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects public execution without internal auth", async () => {
    const response = await request(app)
      .post("/runtime/execute")
      .send({
        source: "mcp",
        serverId: "github",
        toolName: "search",
        args: { q: "compose" },
      });

    expect(response.status).toBe(401);
    expect(response.body.error).toContain("runtime internal authorization");
  });

  it("executes with valid internal auth", async () => {
    const response = await request(app)
      .post("/runtime/execute")
      .set("authorization", "Bearer runtime-internal-token")
      .send({
        source: "mcp",
        serverId: "github",
        toolName: "search",
        args: { q: "compose" },
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(mcpMock.executeServerTool).toHaveBeenCalledWith("github", "search", { q: "compose" });
  });

  it("auto-starts when running under PM2 wrapper env", () => {
    expect(typeof (serverModule as { shouldAutoStartRuntimeServer?: unknown }).shouldAutoStartRuntimeServer).toBe("function");

    const shouldAutoStart = (serverModule as {
      shouldAutoStartRuntimeServer: (options?: {
        argv?: string[];
        env?: NodeJS.ProcessEnv;
      }) => boolean;
    }).shouldAutoStartRuntimeServer;

    expect(shouldAutoStart({
      argv: ["/usr/bin/node", "/usr/lib/node_modules/pm2/lib/ProcessContainerFork.js"],
      env: {
        NODE_APP_INSTANCE: "0",
      },
    })).toBe(true);
  });

  it("does not auto-start during tests", () => {
    const shouldAutoStart = (serverModule as {
      shouldAutoStartRuntimeServer: (options?: {
        argv?: string[];
        env?: NodeJS.ProcessEnv;
      }) => boolean;
    }).shouldAutoStartRuntimeServer;

    expect(shouldAutoStart({
      argv: ["/usr/bin/node", "/Users/example/runtime/tests/server.test.ts"],
      env: {
        VITEST: "true",
      },
    })).toBe(false);
  });

  it("disables embedded workflow workers in local host mode and for explicit disable flags", () => {
    expect(typeof (serverModule as { shouldInitializeWorkflowRuntime?: unknown }).shouldInitializeWorkflowRuntime).toBe("function");

    const shouldInitializeWorkflowRuntime = (serverModule as {
      shouldInitializeWorkflowRuntime: (options?: {
        env?: NodeJS.ProcessEnv;
      }) => boolean;
    }).shouldInitializeWorkflowRuntime;

    expect(shouldInitializeWorkflowRuntime({
      env: {
        RUNTIME_HOST_MODE: "local",
      },
    })).toBe(false);

    expect(shouldInitializeWorkflowRuntime({
      env: {
        RUNTIME_DISABLE_TEMPORAL_WORKERS: "true",
      },
    })).toBe(false);
  });

  it("reports local mode from the health surface when local mode is requested", async () => {
    vi.stubEnv("RUNTIME_HOST_MODE", "local");
    vi.stubEnv("RUNTIME_DISABLE_TEMPORAL_WORKERS", "true");

    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body.hostMode).toBe("local");
    expect(response.body.temporalWorkersEnabled).toBe(false);
  });
});
