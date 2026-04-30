import { createServer, type Server } from "node:http";
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
  McpRuntimeError: class MockMcpRuntimeError extends Error {
    statusCode = 500;
    code = "MCP_ERROR";
    retryable = false;
  },
  executeServerTool: vi.fn(async () => ({ ok: true })),
  getServerTools: vi.fn(async () => []),
}));

const contextMock = vi.hoisted(() => {
  let lastContext: Record<string, unknown> | null = null;

  return {
    getLastContext: () => lastContext,
    reset: () => {
      lastContext = null;
    },
    runWithAgentExecutionContext: vi.fn(async (context: Record<string, unknown>, fn: () => Promise<unknown>) => {
      lastContext = context;
      return await fn();
    }),
  };
});

const toolsMock = vi.hoisted(() => ({
  createMemoryTools: vi.fn(() => [
    {
      name: "search_memory",
      invoke: vi.fn(async (args: Record<string, unknown>) => ({
        ok: true,
        args,
      })),
    },
    {
      name: "save_memory",
      invoke: vi.fn(async (args: Record<string, unknown>) => ({
        ok: true,
        args,
      })),
    },
    {
      name: "search_all_memory",
      invoke: vi.fn(async (args: Record<string, unknown>) => ({
        ok: true,
        args,
      })),
    },
  ]),
}));

const haiMock = vi.hoisted(() => ({
  registerHai: vi.fn((input: Record<string, unknown>) => ({
    haiId: "abc123",
  })),
  verifyAnchor: vi.fn(async () => undefined),
  isA409: vi.fn((error: unknown) => error instanceof Error && error.message.startsWith("a409:")),
}));

const anchorMock = vi.hoisted(() => ({
  anchorMeshState: vi.fn(async () => ({
    haiId: "abc123",
    updateNumber: 7,
    path: "compose-abc123-7",
    fileName: "compose-abc123-7",
    latestAlias: "compose-abc123:latest",
    stateRootHash: "0x" + "ab".repeat(32),
    pdpPieceCid: "baga6ea4seaqmeshstatepiececid",
    pdpAnchoredAt: 1_710_240_000_000,
    payloadSize: 512,
    providerId: "provider-1",
    dataSetId: "dataset-1",
    pieceId: "piece-1",
    retrievalUrl: "https://example.com/retrieve",
    source: "compose",
  })),
}));

const filecoinMock = vi.hoisted(() => ({
  pinMeshArtifact: vi.fn(async () => ({
    haiId: "abc123",
    artifactKind: "learning",
    artifactNumber: 4,
    path: "compose-abc123-retry-strategy-#4",
    fileName: "compose-abc123-retry-strategy-#4",
    latestAlias: "compose-abc123:latest",
    rootCid: "bafybeigdyrztxsamplelearningcid",
    pieceCid: "baga6ea4seaexamplelearningpiececid",
    payloadSize: 128,
    copyCount: 2,
    providerId: "provider-1",
    dataSetId: "dataset-1",
    pieceId: "piece-1",
    retrievalUrl: "https://example.com/learning",
    source: "compose",
    collection: "learnings",
  })),
}));

const reputationMock = vi.hoisted(() => ({
  readMeshReputationSummary: vi.fn(async () => ({
    score: 0.72,
    successRate: 0.75,
    qualityMultiplier: 0.96,
    activityMultiplier: 1,
    totalConclaves: 8,
    successfulConclaves: 6,
    lastConclaveAt: 1_710_240_000_000,
    daysSinceLastConclave: 1.5,
    successfulLearningPublications: 3,
    lastLearningAt: 1_710_250_000_000,
    lastManifestAt: 1_710_260_000_000,
  })),
}));

const sandboxMock = vi.hoisted(() => ({
  loadDaytonaConfig: vi.fn(() => ({
    apiKey: "test-key",
    apiUrl: "https://app.daytona.io/api",
    target: undefined,
    snapshotId: null,
    language: "typescript",
    timeoutMs: 300_000,
    autoDeleteInterval: 5,
  })),
  createDaytonaClient: vi.fn(() => ({ client: true })),
  runConclaveSandbox: vi.fn(async () => ({
    sandboxId: "sandbox-123",
    snapshotId: null,
    imageRef: "daytona:compose",
    startedAt: 1_710_240_000_000,
    finishedAt: 1_710_240_030_000,
    exitCode: 0,
    stdout: "{\"type\":\"meter\",\"agentWallet\":\"0x1111111111111111111111111111111111111111\"}",
    stderr: "",
    meteringRecords: [],
    artifactRootHash: "0x" + "ab".repeat(32),
    meteringRootHash: "0x" + "cd".repeat(32),
  })),
  persistConclaveReceipt: vi.fn(async () => "/tmp/conclave-123.json"),
}));

vi.mock("../src/mcps/goat.js", () => goatMock);
vi.mock("../src/mcps/mcp.js", () => mcpMock);
vi.mock("../src/manowar/agent/context.js", () => contextMock);
vi.mock("../src/manowar/agent/tools.js", () => toolsMock);
vi.mock("../src/mesh/hai.js", () => haiMock);
vi.mock("../src/mesh/anchor.js", () => anchorMock);
vi.mock("../src/mesh/filecoin-pin.js", () => filecoinMock);
vi.mock("../src/mesh/reputation.js", () => reputationMock);
vi.mock("../src/mesh/sandbox.js", () => sandboxMock);

import app from "../src/server.js";

describe("local mesh runtime routes", () => {
  let server: Server;

  beforeEach(async () => {
    vi.clearAllMocks();
    contextMock.reset();
    vi.stubEnv("RUNTIME_HOST_MODE", "local");
    vi.stubEnv("COMPOSE_LOCAL_RUNTIME_AUTH_TOKEN", "local-runtime-token");
    vi.stubEnv("RUNTIME_DISABLE_TEMPORAL_WORKERS", "true");
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    vi.unstubAllEnvs();
  });

  it("requires the local runtime auth token for mesh tool execution", async () => {
    const response = await request(server)
      .post("/mesh/tools/execute")
      .send({
        agentWallet: "0x1111111111111111111111111111111111111111",
        toolName: "search_memory",
        args: { query: "recent goals" },
      });

    expect(response.status).toBe(401);
    expect(response.body.error).toContain("local runtime authorization");
  });

  it("executes runtime memory tools with a local haiId scope", async () => {
    const response = await request(server)
      .post("/mesh/tools/execute")
      .set("x-compose-local-runtime-token", "local-runtime-token")
      .send({
        agentWallet: "0x1111111111111111111111111111111111111111",
        userAddress: "0x2222222222222222222222222222222222222222",
        toolName: "search_memory",
        haiId: "abc123",
        threadId: "local-agent:abc123:chat:thread-1",
        args: { query: "recent goals" },
      });

    expect(response.status).toBe(200);
    expect(response.body.result).toEqual({
      ok: true,
      args: { query: "recent goals" },
    });
    expect(contextMock.getLastContext()).toEqual({
      mode: "local",
      haiId: "abc123",
      threadId: "local-agent:abc123:chat:thread-1",
      agentWallet: "0x1111111111111111111111111111111111111111",
      userAddress: "0x2222222222222222222222222222222222222222",
      workflowWallet: undefined,
    });
    expect(toolsMock.createMemoryTools).toHaveBeenCalledWith(
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
      undefined,
    );
  });

  it("requires explicit haiId and threadId for local memory scope", async () => {
    const response = await request(server)
      .post("/mesh/tools/execute")
      .set("x-compose-local-runtime-token", "local-runtime-token")
      .send({
        agentWallet: "0x1111111111111111111111111111111111111111",
        toolName: "search_memory",
        args: { query: "recent goals" },
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Invalid local mesh tool payload");
    expect(response.body.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "haiId" }),
      expect.objectContaining({ path: "threadId" }),
    ]));
  });

  it("routes OpenClaw-facing mesh memory calls through the dedicated memory endpoint", async () => {
    const response = await request(server)
      .post("/mesh/memory")
      .set("x-compose-local-runtime-token", "local-runtime-token")
      .send({
        agentWallet: "0x1111111111111111111111111111111111111111",
        userAddress: "0x2222222222222222222222222222222222222222",
        haiId: "abc123",
        threadId: "local-agent:abc123:chat:thread-1",
        operation: "searchAll",
        query: "Check the workspace and help",
        layers: ["vectors", "graph"],
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      operation: "searchAll",
      haiId: "abc123",
      threadId: "local-agent:abc123:chat:thread-1",
      result: {
        ok: true,
        args: {
          query: "Check the workspace and help",
          layers: ["vectors", "graph"],
        },
      },
    });
    expect(contextMock.getLastContext()).toMatchObject({
      mode: "local",
      agentWallet: "0x1111111111111111111111111111111111111111",
      userAddress: "0x2222222222222222222222222222222222222222",
      haiId: "abc123",
      threadId: "local-agent:abc123:chat:thread-1",
    });
  });

  it("registers HAI rows through the local mesh route", async () => {
    const response = await request(server)
      .post("/mesh/hai/register")
      .set("x-compose-local-runtime-token", "local-runtime-token")
      .send({
        agentWallet: "0x1111111111111111111111111111111111111111",
        userAddress: "0x2222222222222222222222222222222222222222",
        deviceId: "device-12345678",
      });

    expect(response.status).toBe(200);
    expect(response.body.haiId).toBe("abc123");
    expect(haiMock.registerHai).toHaveBeenCalled();
  });

  it("anchors mesh state through the local mesh route", async () => {
    const response = await request(server)
      .post("/mesh/synapse/anchor")
      .set("x-compose-local-runtime-token", "local-runtime-token")
      .send({
        apiUrl: "https://api.compose.market",
        composeKeyToken: "compose-key-token",
        userAddress: "0x2222222222222222222222222222222222222222",
        agentWallet: "0x1111111111111111111111111111111111111111",
        deviceId: "device-12345678",
        chainId: 43113,
        targetSynapseExpiry: 1_710_250_000_000,
        haiId: "abc123",
        updateNumber: 7,
        path: "compose-abc123-7",
        canonicalSnapshotJson: "{\"hello\":\"world\"}",
        stateRootHash: "0x" + "ab".repeat(32),
        envelopeJson: "{\"signed\":true}",
        sessionKeyPrivateKey: "0x" + "aa".repeat(32),
      });

    expect(response.status).toBe(200);
    expect(response.body.haiId).toBe("abc123");
    expect(haiMock.verifyAnchor).toHaveBeenCalled();
    expect(anchorMock.anchorMeshState).toHaveBeenCalled();
  });

  it("pins mesh learnings through the local mesh route", async () => {
    const response = await request(server)
      .post("/mesh/filecoin/pin")
      .set("x-compose-local-runtime-token", "local-runtime-token")
      .send({
        apiUrl: "https://api.compose.market",
        composeKeyToken: "compose-key-token",
        userAddress: "0x2222222222222222222222222222222222222222",
        agentWallet: "0x1111111111111111111111111111111111111111",
        deviceId: "device-12345678",
        chainId: 43113,
        targetSessionExpiry: 1_710_250_000_000,
        signedRequestJson: "{\"signed\":true}",
        haiId: "abc123",
        artifactKind: "learning",
        artifactNumber: 4,
        path: "compose-abc123-retry-strategy-#4",
        payloadJson: "{\"version\":1,\"kind\":\"compose.mesh.learning\",\"createdAt\":1710250000000,\"title\":\"Retry strategy\",\"summary\":\"Retry transient failures with bounded backoff.\",\"content\":\"Use bounded backoff for transient failures.\",\"accessPriceUsdc\":\"0.10\",\"publisherAddress\":\"0x2222222222222222222222222222222222222222\"}",
        filecoinPinSessionKeyPrivateKey: "0x" + "aa".repeat(32),
      });

    expect(response.status).toBe(200);
    expect(response.body.collection).toBe("learnings");
    expect(filecoinMock.pinMeshArtifact).toHaveBeenCalled();
  });

  it("summarizes mesh reputation through the local mesh route", async () => {
    const response = await request(server)
      .get("/mesh/reputation/summary")
      .set("x-compose-local-runtime-token", "local-runtime-token")
      .query({
        agentWallet: "0x1111111111111111111111111111111111111111",
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      reputationScore: 0.72,
      totalConclaves: 8,
      successfulConclaves: 6,
      successfulLearningPublications: 3,
    });
    expect(reputationMock.readMeshReputationSummary).toHaveBeenCalledWith({
      agentWallet: "0x1111111111111111111111111111111111111111",
    });
  });

  it("runs Daytona conclaves through the local runtime route and persists the receipt", async () => {
    const response = await request(server)
      .post("/mesh/conclave/run")
      .set("x-compose-local-runtime-token", "local-runtime-token")
      .send({
        agentWallet: "0x1111111111111111111111111111111111111111",
        conclaveId: "mesh-conclave-1",
        command: "python -c \"print('ok')\"",
        timeoutMs: 120000,
        networkBlockAll: true,
      });

    expect(response.status).toBe(200);
    expect(sandboxMock.runConclaveSandbox).toHaveBeenCalledWith(
      { client: true },
      expect.any(Object),
      expect.objectContaining({
        conclaveId: "mesh-conclave-1",
        command: "python -c \"print('ok')\"",
        timeoutMs: 120000,
        networkBlockAll: true,
        labels: expect.objectContaining({
          agentWallet: "0x1111111111111111111111111111111111111111",
        }),
      }),
    );
    expect(sandboxMock.persistConclaveReceipt).toHaveBeenCalledWith({
      conclaveId: "mesh-conclave-1",
      agentWallet: "0x1111111111111111111111111111111111111111",
      receipt: expect.objectContaining({
        sandboxId: "sandbox-123",
        exitCode: 0,
      }),
    });
    expect(response.body.storedAt).toBe("/tmp/conclave-123.json");
    expect(response.body.sandboxId).toBe("sandbox-123");
  });
});
