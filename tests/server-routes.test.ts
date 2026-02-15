import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const paymentMock = vi.hoisted(() => ({
  handleX402Payment: vi.fn(),
  extractPaymentInfo: vi.fn(() => ({ paymentData: "sig", chainId: 338 })),
  DEFAULT_PRICES: {
    MCP_TOOL_CALL: "1000",
    GOAT_EXECUTE: "1000",
  },
}));

const goatMock = vi.hoisted(() => ({
  getRuntimeStatus: vi.fn(),
  listPlugins: vi.fn(),
  getPlugin: vi.fn(),
  getPluginTools: vi.fn(),
  listAllTools: vi.fn(),
  getTool: vi.fn(),
  hasTool: vi.fn(),
  getWalletAddress: vi.fn(),
  getPluginIds: vi.fn(),
  executeGoatTool: vi.fn(),
}));

const mcpMock = vi.hoisted(() => {
  class MockMcpRuntimeError extends Error {
    code: string;
    retryable: boolean;
    statusCode: number;

    constructor(code: string, message: string, retryable: boolean, statusCode = 500) {
      super(message);
      this.code = code;
      this.retryable = retryable;
      this.statusCode = statusCode;
    }
  }

  const initialize = vi.fn(async () => undefined);
  const getServerTools = vi.fn();
  const executeServerTool = vi.fn();
  class MockMcpRuntime {
    initialize = initialize;
  }

  return {
    McpRuntimeError: MockMcpRuntimeError,
    McpRuntime: MockMcpRuntime,
    initialize,
    getServerTools,
    executeServerTool,
  };
});

vi.mock("../src/payment.js", () => paymentMock);
vi.mock("../src/runtimes/goat.js", () => goatMock);
vi.mock("../src/runtimes/mcp.js", () => ({
  McpRuntime: mcpMock.McpRuntime,
  McpRuntimeError: mcpMock.McpRuntimeError,
  getServerTools: mcpMock.getServerTools,
  executeServerTool: mcpMock.executeServerTool,
}));

import app from "../src/server.js";

describe("runtime server routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    paymentMock.handleX402Payment.mockResolvedValue({
      status: 200,
      responseBody: { ok: true },
      responseHeaders: {},
    });

    goatMock.getRuntimeStatus.mockResolvedValue({
      initialized: true,
      plugins: [{ id: "coingecko" }],
      totalTools: 7,
    });
    goatMock.getPluginIds.mockResolvedValue(["coingecko"]);
    goatMock.hasTool.mockResolvedValue(true);
    goatMock.getWalletAddress.mockReturnValue("0xwallet");

    mcpMock.getServerTools.mockResolvedValue({
      serverId: "github",
      sessionId: "session-1",
      cached: false,
      toolCount: 2,
      tools: [],
    });

    mcpMock.executeServerTool.mockResolvedValue({ result: { ok: true } });
    goatMock.executeGoatTool.mockResolvedValue({
      success: true,
      result: { symbol: "ETH", price: 4200 },
    });
  });

  it("reports manowar as the orchestration durability boundary", async () => {
    const response = await request(app).get("/health");
    expect(response.status).toBe(200);
    expect(response.body.orchestration.durabilityBoundary).toBe("manowar");
  });

  it("returns runtime health", async () => {
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(response.body.runtimes.goat).toBe(true);
    expect(response.body.stats.goatPlugins).toBe(1);
  });

  it("validates /mcp/spawn request body", async () => {
    const response = await request(app)
      .post("/mcp/spawn")
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("serverId is required");
  });

  it("returns payment error for /mcp/spawn when x402 fails", async () => {
    paymentMock.handleX402Payment.mockResolvedValueOnce({
      status: 402,
      responseBody: { error: "payment required" },
      responseHeaders: { "PAYMENT-RESPONSE": "challenge" },
    });

    const response = await request(app)
      .post("/mcp/spawn")
      .send({ serverId: "github" });

    expect(response.status).toBe(402);
    expect(response.body).toEqual({ error: "payment required" });
    expect(mcpMock.getServerTools).not.toHaveBeenCalled();
  });

  it("maps McpRuntimeError to structured response", async () => {
    mcpMock.getServerTools.mockRejectedValueOnce(
      new mcpMock.McpRuntimeError("MCP_SPAWN_FAILED", "spawn failed", true, 503),
    );

    const response = await request(app)
      .post("/mcp/spawn")
      .send({ serverId: "github" });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: {
        code: "MCP_SPAWN_FAILED",
        message: "spawn failed",
        retryable: true,
      },
    });
  });

  it("rejects invalid /runtime/execute source", async () => {
    const response = await request(app)
      .post("/runtime/execute")
      .send({ source: "invalid", toolName: "x" });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Invalid source");
  });

  it("executes GOAT tool through direct runtime path", async () => {
    const response = await request(app)
      .post("/runtime/execute")
      .send({
        source: "goat",
        pluginId: "coingecko",
        toolName: "get_price",
        args: { symbol: "ETH" },
      });

    expect(response.status).toBe(200);
    expect(goatMock.executeGoatTool).toHaveBeenCalledWith(
      "coingecko",
      "get_price",
      { symbol: "ETH" },
    );
    expect(response.body.success).toBe(true);
    expect(response.body.result).toEqual({ symbol: "ETH", price: 4200 });
  });

  it("returns 500 for failed GOAT tool execution", async () => {
    goatMock.executeGoatTool.mockResolvedValueOnce({
      success: false,
      error: "execution failed",
    });

    const response = await request(app)
      .post("/goat/plugins/coingecko/tools/get_price")
      .send({ args: { symbol: "ETH" } });

    expect(response.status).toBe(500);
    expect(response.body.error).toBe("execution failed");
  });

  it("returns structured unknown error for MCP tool execution", async () => {
    mcpMock.executeServerTool.mockRejectedValueOnce(new Error("network down"));

    const response = await request(app)
      .post("/mcp/servers/github/tools/search")
      .send({ args: { q: "compose" } });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: "UNKNOWN",
        message: "network down",
        retryable: false,
      },
    });
  });
});
