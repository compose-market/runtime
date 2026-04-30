import { describe, expect, it } from "vitest";

import { runWithAgentExecutionContext } from "../src/manowar/agent/context.js";
import { createMemoryTools } from "../src/manowar/agent/tools.js";

describe("createMemoryTools", () => {
  it("allows local agents to invoke runtime memory tools with haiId-only scope", async () => {
    const tool = createMemoryTools("0x1111111111111111111111111111111111111111")
      .find((candidate) => candidate.name === "search_memory");

    expect(tool).toBeDefined();

    const result = await runWithAgentExecutionContext(
      {
        mode: "local",
        haiId: "abc123",
        threadId: "local-agent:abc123:chat:thread-1",
      },
      async () => await tool!.invoke({ query: "recent goals" }),
    );

    expect(typeof result).toBe("string");
  });

  it("recovers from empty memory-tool arguments by falling back to the latest user message", async () => {
    const tool = createMemoryTools("0x1111111111111111111111111111111111111111")
      .find((candidate) => candidate.name === "save_memory");

    expect(tool).toBeDefined();

    const result = await runWithAgentExecutionContext(
      {
        mode: "local",
        haiId: "abc123",
        threadId: "local-agent:abc123:chat:thread-2",
        lastUserMessage: "Remember that my name is Alex.",
      },
      async () => await tool!.invoke({}),
    );

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toContain("expected string");
    expect(result).not.toContain("received undefined");
  });
});
