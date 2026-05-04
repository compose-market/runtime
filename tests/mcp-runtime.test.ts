import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("connectors client", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.CONNECTORS_URL = "http://connectors.test";
    process.env.RUNTIME_INTERNAL_SECRET = "test-secret";
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("getServerTools issues GET /tools/:slug/tools and returns the broker payload", async () => {
    const fetchMock = vi.mocked(fetch);
    const payload = {
      serverId: "github",
      sessionId: "sess-1",
      cached: false,
      toolCount: 1,
      tools: [{ name: "search", description: "Search", inputSchema: {} }],
    };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    } as Response);

    const { getServerTools } = await import("../src/connectors/index.js");
    const result = await getServerTools("github");

    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://connectors.test/tools/github/tools");
    const initObj = init as RequestInit;
    expect(initObj.method).toBe("GET");
    expect(((initObj.headers as Record<string, string>) || {})["Authorization"]).toBe("Bearer test-secret");
  });

  it("executeServerTool POSTs /tools/:slug/execute/:tool with body args", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        ok: true,
        result: { ok: true },
        transportUsed: "http",
        latencyMs: 12,
      }),
    } as Response);

    const { executeServerTool } = await import("../src/connectors/index.js");
    const result = await executeServerTool("github", "search", { q: "compose" });

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://connectors.test/tools/github/execute/search");
    const initObj = init as RequestInit;
    expect(initObj.method).toBe("POST");
    const body = JSON.parse((initObj.body as string) || "{}");
    expect(body.args).toEqual({ q: "compose" });
  });

  it("CREDENTIALS_REQUIRED is surfaced as ConnectorsError with the canonical message prefix", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        ok: false,
        kind: "CREDENTIALS_REQUIRED",
        serverId: "notion",
        missing: [{ varName: "NOTION_API_KEY" }],
      }),
    } as Response);

    const { executeServerTool, ConnectorsError } = await import("../src/connectors/index.js");
    let caught: unknown = null;
    try {
      await executeServerTool("notion", "create_page", {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConnectorsError);
    expect((caught as InstanceType<typeof ConnectorsError>).code).toBe("CREDENTIALS_REQUIRED");
    expect((caught as Error).message).toBe("MCP credentials required: NOTION_API_KEY");
    expect((caught as InstanceType<typeof ConnectorsError>).retryable).toBe(false);
  });

  it("404 from the broker is mapped to MCP_CONFIG_NOT_FOUND", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: { message: "not found" } }),
    } as Response);

    const { getServerTools, ConnectorsError } = await import("../src/connectors/index.js");

    await expect(getServerTools("unknown-server")).rejects.toBeInstanceOf(ConnectorsError);
    await expect(getServerTools("unknown-server")).rejects.toMatchObject({
      code: "MCP_CONFIG_NOT_FOUND",
      statusCode: 404,
    });
  });

  it("typed broker failure (RATE_LIMITED) round-trips with retryable=true", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        ok: false,
        kind: "RATE_LIMITED",
        message: "upstream limit",
        retryable: true,
      }),
    } as Response);

    const { executeServerTool, ConnectorsError } = await import("../src/connectors/index.js");
    let caught: unknown = null;
    try {
      await executeServerTool("github", "search", {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConnectorsError);
    expect((caught as InstanceType<typeof ConnectorsError>).code).toBe("RATE_LIMITED");
    expect((caught as InstanceType<typeof ConnectorsError>).retryable).toBe(true);
  });

  it("missing CONNECTORS_URL raises a non-retryable error", async () => {
    delete process.env.CONNECTORS_URL;
    const { getServerTools, ConnectorsError } = await import("../src/connectors/index.js");
    await expect(getServerTools("github")).rejects.toBeInstanceOf(ConnectorsError);
    await expect(getServerTools("github")).rejects.toMatchObject({
      code: "MCP_RUNTIME_UNAVAILABLE",
      retryable: false,
    });
  });
});
