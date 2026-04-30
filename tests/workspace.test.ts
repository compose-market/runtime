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

const memoryMock = vi.hoisted(() => ({
  addKnowledge: vi.fn(async () => []),
  indexMemoryContent: vi.fn(async () => ({ success: true, vectorId: "vec_1" })),
  indexVector: vi.fn(async () => ({ vectorId: "vec_1" })),
  searchMemory: vi.fn(async () => []),
  getEmbedding: vi.fn(async () => ({
    embedding: [0.1, 0.2],
    provider: "voyage",
    cached: false,
    dimensions: 2,
  })),
  getMemoryVectorsCollection: vi.fn(async () => ({
    aggregate: vi.fn(() => ({
      toArray: vi.fn(async () => []),
    })),
    find: vi.fn(() => ({
      sort: vi.fn(() => ({
        limit: vi.fn(() => ({
          toArray: vi.fn(async () => []),
        })),
      })),
    })),
  })),
}));

vi.mock("../src/mcps/goat.js", () => goatMock);
vi.mock("../src/mcps/mcp.js", () => mcpMock);
vi.mock("../src/manowar/memory/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/manowar/memory/index.js")>();
  return {
    ...actual,
    addKnowledge: memoryMock.addKnowledge,
    indexMemoryContent: memoryMock.indexMemoryContent,
    indexVector: memoryMock.indexVector,
    searchMemory: memoryMock.searchMemory,
    getEmbedding: memoryMock.getEmbedding,
    getMemoryVectorsCollection: memoryMock.getMemoryVectorsCollection,
  };
});

import app from "../src/server.js";

describe("workspace routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("COMPOSE_RUNTIME_NO_AUTOSTART", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects workspace access without an active session", async () => {
    const response = await request(app)
      .post("/api/workspace/search")
      .send({
        agentWallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        query: "private note",
      });

    expect(response.status).toBe(401);
    expect(response.body.error).toContain("active session");
  });

  it("indexes workspace documents against the session user", async () => {
    const response = await request(app)
      .post("/api/workspace/index")
      .set("x-session-active", "true")
      .set("x-session-user-address", "0x1111111111111111111111111111111111111111")
      .send({
        agentWallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        documents: [{ content: "private workspace note" }],
      });

    expect(response.status).toBe(200);
    expect(memoryMock.addKnowledge).toHaveBeenCalledWith(expect.objectContaining({
      agent_id: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      user_id: "0x1111111111111111111111111111111111111111",
      metadata: expect.objectContaining({
        scope: "workspace",
        type: "knowledge",
      }),
    }));
    expect(memoryMock.indexMemoryContent).toHaveBeenCalledWith(expect.objectContaining({
      agentWallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      userAddress: "0x1111111111111111111111111111111111111111",
      source: "knowledge",
    }));
    expect(response.body.indexed).toBe(1);
  });

  it("searches workspace documents for the session user", async () => {
    memoryMock.searchMemory.mockResolvedValueOnce([
      { memory: "Private workspace note" },
    ]);
    memoryMock.getMemoryVectorsCollection.mockResolvedValueOnce({
      aggregate: vi.fn(() => ({
        toArray: vi.fn(async () => [
          { content: "Vector workspace note", rawScore: 0.91 },
        ]),
      })),
      find: vi.fn(() => ({
        sort: vi.fn(() => ({
          limit: vi.fn(() => ({
            toArray: vi.fn(async () => []),
          })),
        })),
      })),
    });

    const response = await request(app)
      .post("/api/workspace/search")
      .set("x-session-active", "true")
      .set("x-session-user-address", "0x1111111111111111111111111111111111111111")
      .send({
        agentWallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        query: "workspace note",
        limit: 4,
      });

    expect(response.status).toBe(200);
    expect(memoryMock.searchMemory).toHaveBeenCalledWith(expect.objectContaining({
      agent_id: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      user_id: "0x1111111111111111111111111111111111111111",
    }));
    expect(response.body.results).toEqual([
      { content: "Vector workspace note", score: 0.91, scope: "workspace" },
      { content: "Private workspace note", score: 0.68, scope: "workspace" },
    ]);
  });
});
