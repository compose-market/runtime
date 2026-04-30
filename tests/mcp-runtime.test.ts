import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientConnect = vi.fn();
const clientListTools = vi.fn();
const clientCallTool = vi.fn();
const clientClose = vi.fn();

const transportClose = vi.fn();

class MockClient {
  connect = clientConnect;
  listTools = clientListTools;
  callTool = clientCallTool;
  close = clientClose;

  constructor() {
    // no-op
  }
}

class MockTransport {
  close = transportClose;
}

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: MockClient,
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: MockTransport,
}));

vi.mock("../src/mcps/transports/http.js", () => ({
  HttpSseClientTransport: MockTransport,
}));

vi.mock("../src/mcps/transports/docker.js", () => ({
  DockerClientTransport: MockTransport,
}));

vi.mock("../src/mcps/transports/npx.js", () => ({
  NpxClientTransport: MockTransport,
}));

describe("runtime mcp runtime", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.CONNECTOR_URL = "http://connector.test";
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(async () => {
    const module = await import("../src/mcps/mcp.js");
    await module.__resetMcpRuntimeForTests();
    vi.unstubAllGlobals();
  });

  it("reuses cached session when still alive", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ transport: "http", remoteUrl: "http://remote.test" }),
    } as Response);

    clientListTools.mockResolvedValue({
      tools: [{ name: "search", description: "Search", inputSchema: {} }],
    });

    const { getServerTools } = await import("../src/mcps/mcp.js");

    const first = await getServerTools("github");
    const second = await getServerTools("github");

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.sessionId).toBe(first.sessionId);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(clientConnect).toHaveBeenCalledTimes(1);
  });

  it("respawns when cached session is stale", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ transport: "http", remoteUrl: "http://remote.test" }),
    } as Response);

    clientListTools
      .mockResolvedValueOnce({
        tools: [{ name: "search", description: "Search", inputSchema: {} }],
      })
      .mockRejectedValueOnce(new Error("Connection closed"))
      .mockResolvedValueOnce({
        tools: [{ name: "search", description: "Search", inputSchema: {} }],
      });

    const { getServerTools } = await import("../src/mcps/mcp.js");

    const first = await getServerTools("github");
    const second = await getServerTools("github");

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(false);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(clientConnect).toHaveBeenCalledTimes(2);
  });

  it("respawns once and retries tool execution on invalid session", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ transport: "http", remoteUrl: "http://remote.test" }),
    } as Response);

    clientListTools
      .mockResolvedValueOnce({
        tools: [{ name: "search", description: "Search", inputSchema: {} }],
      })
      .mockResolvedValueOnce({
        tools: [{ name: "search", description: "Search", inputSchema: {} }],
      });

    clientCallTool
      .mockRejectedValueOnce(new Error("Connection closed"))
      .mockResolvedValueOnce({
        isError: false,
        content: [{ text: "{\"ok\":true}" }],
      });

    const { executeServerTool, getServerTools } = await import("../src/mcps/mcp.js");

    await getServerTools("github");
    const result = await executeServerTool("github", "search", { q: "compose" });

    expect(result).toEqual({ ok: true });
    expect(clientCallTool).toHaveBeenCalledTimes(2);
    expect(clientConnect).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws MCP_CONFIG_NOT_FOUND when server is unknown", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    } as Response);

    const { getServerTools, McpRuntimeError } = await import("../src/mcps/mcp.js");

    await expect(getServerTools("unknown-server")).rejects.toBeInstanceOf(McpRuntimeError);
    await expect(getServerTools("unknown-server")).rejects.toMatchObject({
      code: "MCP_CONFIG_NOT_FOUND",
      statusCode: 404,
    });
  });
});
