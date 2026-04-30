import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, streamEventsMock, chatOpenAiConfigs, executionContextMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  streamEventsMock: vi.fn(),
  chatOpenAiConfigs: [] as Array<Record<string, any>>,
  executionContextMock: vi.fn(),
}));

vi.mock("@langchain/openai", () => ({
  ChatOpenAI: class ChatOpenAI {
    constructor(config: Record<string, any>) {
      chatOpenAiConfigs.push(config);
    }
  },
}));

vi.mock("../src/manowar/agent/graph.js", () => ({
  createAgentGraph: vi.fn(() => ({
    invoke: invokeMock,
    streamEvents: streamEventsMock,
  })),
}));

vi.mock("../src/manowar/agent/tools.js", () => ({
  createAgentTools: vi.fn(async () => []),
  createMemoryTools: vi.fn(() => []),
}));

vi.mock("../src/manowar/agent/context.js", () => ({
  getAgentExecutionContext: executionContextMock,
  runWithAgentExecutionContext: vi.fn(async (_context, task: () => Promise<unknown>) => task()),
}));

vi.mock("../src/manowar/langsmith.js", () => ({
  AgentMemoryTracker: class AgentMemoryTracker {
    getMetrics() {
      return { contextMetrics: null };
    }
  },
  extractTokens: vi.fn(() => ({
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  })),
  resolveAuthoritativeTokens: vi.fn(() => ({
    inputTokens: 67,
    outputTokens: 947,
    reasoningTokens: 0,
    totalTokens: 1014,
  })),
}));

vi.mock("../src/manowar/mode.js", () => ({
  resolveRuntimeHostMode: vi.fn(() => "cloud"),
  shouldEnforceCloudPermissions: vi.fn(() => false),
}));

vi.mock("../src/auth.js", () => ({
  buildApiInternalHeaders: vi.fn(() => ({})),
  requireApiInternalToken: vi.fn(() => "runtime-internal-token"),
  requireApiInternalUrl: vi.fn(() => "http://api.compose.test"),
}));

vi.mock("../src/manowar/agent/identity.ts", () => ({
  peekAgentIdentity: vi.fn(() => undefined),
  resolveAgentIdentity: vi.fn(async () => ({
    name: "Test Agent",
    description: "test",
    walletAddress: "0xagent",
    model: "test-model",
    skills: [],
    plugins: [],
  })),
  renderIdentitySection: vi.fn(() => "You are Test Agent"),
}));

vi.mock("../src/manowar/agent/identity.js", () => ({
  peekAgentIdentity: vi.fn(() => undefined),
  resolveAgentIdentity: vi.fn(async () => ({
    name: "Test Agent",
    description: "test",
    walletAddress: "0xagent",
    model: "test-model",
    skills: [],
    plugins: [],
  })),
  renderIdentitySection: vi.fn(() => "You are Test Agent"),
}));

vi.mock("../src/manowar/knowledge/identity.js", () => ({
  ensureIdentityKnowledge: vi.fn(async () => undefined),
  searchIdentityKnowledge: vi.fn(async () => []),
}));

import {
  createAgent,
  createModel,
  deleteAgent,
  executeAgent,
  streamAgent,
} from "../src/manowar/framework.js";

describe("manowar output extraction", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    chatOpenAiConfigs.length = 0;
    executionContextMock.mockReturnValue(undefined);
    streamEventsMock.mockReset();
    deleteAgent("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns assistant output from response metadata when AIMessage content is empty", async () => {
    invokeMock.mockResolvedValue({
      messages: [
        {
          _getType: () => "human",
          content: "hello",
        },
        {
          _getType: () => "ai",
          content: [],
          additional_kwargs: {
            tool_outputs: [
              {
                type: "output_text",
                role: "assistant",
                text: "Recovered final answer",
              },
            ],
          },
          response_metadata: {
            output: [
              {
                type: "output_text",
                role: "assistant",
                text: "Recovered final answer",
              },
            ],
          },
        },
      ],
    });

    await createAgent({
      name: "Test Agent",
      agentWallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      model: "gpt-5.2-pro",
    });

    const result = await executeAgent(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "hello",
      { threadId: "thread-1" },
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe("Recovered final answer");
    expect(result.messages.at(-1)).toMatchObject({
      role: "ai",
      content: "Recovered final answer",
    });
  });

  it("creates streaming models against the internal inference gateway", async () => {
    createModel("gpt-5.2-pro");

    const config = chatOpenAiConfigs.at(-1);
    expect(config).toMatchObject({
      modelName: "gpt-5.2-pro",
      streaming: true,
      configuration: {
        baseURL: "http://api.compose.test/v1",
        apiKey: "runtime-internal-token",
      },
    });
  });

  it("isolates calls without an explicit threadId by composeRunId", async () => {
    invokeMock.mockResolvedValue({
      messages: [
        { _getType: () => "human", content: "hello" },
        { _getType: () => "ai", content: "hello back" },
      ],
    });

    await createAgent({
      name: "Test Agent",
      agentWallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      model: "gpt-4o",
      memory: false,
    });

    await executeAgent(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "hello",
      { composeRunId: "run_123" },
    );

    expect(invokeMock.mock.calls[0]?.[1]?.configurable?.thread_id)
      .toBe("run:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:run_123");
  });

  it("streams one concrete tool lifecycle and ignores model-chunk tool echoes", async () => {
    streamEventsMock.mockImplementation(async function* () {
      yield {
        event: "on_chat_model_stream",
        data: {
          chunk: {
            additional_kwargs: {
              tool_calls: [
                {
                  id: "call_echo",
                  type: "function",
                  function: {
                    name: "lookup_price",
                    arguments: "{\"id\":\"bitcoin\"}",
                  },
                },
              ],
            },
          },
        },
      };
      yield {
        event: "on_tool_start",
        run_id: "tool-run-1",
        name: "lookup_price",
        data: { input: { id: "bitcoin" } },
      };
      yield {
        event: "on_tool_end",
        run_id: "tool-run-1",
        name: "lookup_price",
        data: {
          output: {
            lc: 1,
            type: "constructor",
            kwargs: {
              content: "{\"bitcoin\":{\"usd\":76345}}",
              name: "lookup_price",
              tool_call_id: "call_123",
            },
          },
        },
      };
      yield {
        event: "on_chat_model_stream",
        data: { chunk: { content: "Bitcoin is $76,345." } },
      };
      yield {
        event: "on_chat_model_end",
        data: {
          output: {
            usage_metadata: {
              input_tokens: 10,
              output_tokens: 5,
              total_tokens: 15,
            },
          },
        },
      };
    });

    await createAgent({
      name: "Test Agent",
      agentWallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      model: "gpt-4o",
      memory: false,
    });

    const events: any[] = [];
    for await (const event of streamAgent(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "price",
      { threadId: "thread-1" },
    )) {
      events.push(event);
    }

    expect(events.filter((event) => event.type === "tool_start")).toHaveLength(1);
    const toolEndEvents = events.filter((event) => event.type === "tool_end");
    expect(toolEndEvents).toHaveLength(1);
    expect(toolEndEvents[0].message).toBe("{\"bitcoin\":{\"usd\":76345}}");
    expect(events.some((event) => event.choices?.[0]?.delta?.content === "Bitcoin is $76,345.")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });
});
