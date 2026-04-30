import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveAgent = vi.fn();
const resolveAgentInstance = vi.fn();
const ensureRegisteredAgentByWallet = vi.fn();
const markAgentExecuted = vi.fn();

const executeAgentRun = vi.fn();
const getAgentRunState = vi.fn();
const startAgentRun = vi.fn();
const createComposeRunId = vi.fn(() => "run-test-001");
const executeAgent = vi.fn();
const streamAgent = vi.fn();
const executeResponses = vi.fn();

vi.mock("../src/manowar/runtime.js", () => ({
  ensureAgentRuntimeReady: vi.fn(async () => ({ id: "agent-runtime-1" })),
  getAgentRuntimeWarmupError: vi.fn(() => undefined),
  isAgentRuntimeWarming: vi.fn(() => false),
  ensureRegisteredAgentByWallet,
  resolveAgent,
  resolveAgentInstance,
  markAgentExecuted,
}));

vi.mock("../src/temporal/service.js", () => ({
  createComposeRunId,
  executeAgentRun,
  getAgentRunState,
  startAgentRun,
}));

vi.mock("../src/auth.js", () => ({
  extractRuntimeSessionHeaders: vi.fn(() => ({
    sessionActive: true,
    sessionBudgetRemaining: 1000,
    sessionUserAddress: "0x1111111111111111111111111111111111111111",
  })),
}));

vi.mock("../src/manowar/framework.js", () => ({
  executeAgent,
  streamAgent,
  executeResponses,
}));

describe("agent routes manowar dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveAgent.mockReturnValue({
      agentId: 7n,
      walletAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      name: "Painter",
      model: "gpt-4o",
      framework: "langchain",
    });
    resolveAgentInstance.mockReturnValue({ id: "agent-runtime-1" });
    executeAgentRun.mockResolvedValue({
      success: true,
      output: "hello",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
      },
    });
    getAgentRunState.mockResolvedValue({
      runId: "run-test-001",
      workflowId: "agent-0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:thread:thread-1:run:run-test-001",
      agentWallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      threadId: "thread-1",
      status: "success",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      output: "hello",
    });
    startAgentRun.mockResolvedValue({
      result: vi.fn(async () => ({
        success: true,
        output: "hello",
        usage: {
          prompt_tokens: 10,
          completion_tokens: 4,
          total_tokens: 14,
        },
        promptTokens: 10,
        completionTokens: 4,
      })),
    });
    executeAgent.mockResolvedValue({
      success: true,
      output: "hello",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
      },
      promptTokens: 10,
      completionTokens: 4,
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hello" },
      ],
      executionTime: 12,
    });
    streamAgent.mockImplementation(async function* () {
      yield {
        type: "thinking_start",
        message: "Thinking...",
      };
      yield {
        choices: [{ delta: { content: "hello" } }],
      };
      yield {
        type: "done",
        usage: {
          prompt_tokens: 10,
          completion_tokens: 4,
          total_tokens: 14,
        },
        promptTokens: 10,
        completionTokens: 4,
        totalTokens: 14,
      };
    });
    executeResponses.mockResolvedValue({
      id: "resp_123",
      object: "response",
      model: "gpt-4o",
      status: "completed",
      output: [
        {
          type: "output_image",
          role: "assistant",
          image_url: "https://cdn.compose.market/generated.png",
        },
      ],
      usage: {
        input_tokens: 14,
        output_tokens: 0,
        total_tokens: 14,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function createTestApp() {
    const app = express();
    app.use(express.json());
    return import("../src/agent-routes.js").then((module) => {
      app.use("/agent", module.default);
      return app;
    });
  }

  it("executes /chat without runtime-side model detection", async () => {
    const app = await createTestApp();

    const response = await request(app)
      .post("/agent/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/chat")
      .send({ message: "hello" });

    expect(response.status).toBe(200);
    expect(response.body.output).toBe("hello");
    expect(executeAgentRun).toHaveBeenCalledTimes(1);
  });

  it("uses the unified manowar chat path even when agent metadata says openclaw", async () => {
    resolveAgent.mockReturnValue({
      agentId: 7n,
      walletAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      name: "Painter",
      model: "gpt-4o",
      framework: "openclaw",
    });

    const app = await createTestApp();

    const response = await request(app)
      .post("/agent/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/chat")
      .send({ message: "hello" });

    expect(response.status).toBe(200);
    expect(response.body.output).toBe("hello");
    expect(executeAgentRun).toHaveBeenCalledTimes(1);
    expect(executeAgent).not.toHaveBeenCalled();
  });

  it("returns a runtime error status when execution fails instead of a 200 body without usage", async () => {
    executeAgentRun.mockResolvedValue({
      success: false,
      messages: [],
      error: "upstream provider failed",
      executionTime: 12,
    });

    const app = await createTestApp();

    const response = await request(app)
      .post("/agent/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/chat")
      .send({ message: "hello" });

    expect(response.status).toBe(500);
    expect(response.body.error).toContain("upstream provider failed");
    expect(markAgentExecuted).not.toHaveBeenCalled();
  });

  it("streams via streamAgent directly without forcing Temporal polling, and surfaces in-band SSE events", async () => {
    const app = await createTestApp();

    streamAgent.mockImplementation(async function* () {
      yield { type: "thinking_start", message: "Thinking..." };
      yield { choices: [{ delta: { content: "hello" } }] };
      yield { type: "done", model: "gpt-4o", usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } };
    });

    const response = await request(app)
      .post("/agent/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/stream")
      .send({
        message: "hello",
        threadId: "thread-1",
        attachment: {
          type: "image",
          url: "ipfs://bafyattachment",
        },
        cloudPermissions: ["camera", "filesystem"],
      });

    expect(response.status).toBe(200);
    expect(streamAgent).toHaveBeenCalledTimes(1);
    expect(streamAgent.mock.calls[0]).toMatchObject([
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "hello",
      expect.objectContaining({
        composeRunId: "run-test-001",
        threadId: "thread-1",
        userAddress: "0x1111111111111111111111111111111111111111",
        sessionContext: expect.objectContaining({
          cloudPermissions: ["camera", "filesystem"],
        }),
      }),
    ]);
    expect(response.text).toContain("\"type\":\"thinking_start\"");
    expect(response.text).toContain("\"content\":\"hello\"");
    expect(response.text).toContain("\"type\":\"done\"");
  });

  it("exposes dynamic /responses execution without hardcoded modality routes", async () => {
    const app = await createTestApp();

    const response = await request(app)
      .post("/agent/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/responses")
      .send({
        modalities: ["image"],
        input: [{ type: "input_text", text: "draw a lighthouse" }],
        size: "1024x1024",
      });

    expect(response.status).toBe(200);
    expect(executeResponses).toHaveBeenCalledWith("gpt-4o", {
      modalities: ["image"],
      input: [{ type: "input_text", text: "draw a lighthouse" }],
      size: "1024x1024",
    });
    expect(response.body.object).toBe("response");
    expect(response.body.output?.[0]?.image_url).toBe("https://cdn.compose.market/generated.png");
  });

  it("rejects caller attempts to override the fixed agent model on /responses", async () => {
    const app = await createTestApp();

    const response = await request(app)
      .post("/agent/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/responses")
      .send({
        model: "gemini-2.5-pro",
        modalities: ["embedding"],
        input: "index this text",
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("model");
    expect(executeResponses).not.toHaveBeenCalled();
  });
});
