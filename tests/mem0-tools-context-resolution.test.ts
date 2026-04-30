import { describe, expect, it } from "vitest";

import { runWithAgentExecutionContext } from "../src/manowar/agent/context.js";
import { createMemoryTools } from "../src/manowar/agent/tools.js";

describe("createMemoryTools context resolution", () => {
  it("reads local scope from the live execution context when the tool is invoked", async () => {
    const tool = createMemoryTools("0x1111111111111111111111111111111111111111")
      .find((candidate) => candidate.name === "search_memory");

    expect(tool).toBeDefined();

    await expect(runWithAgentExecutionContext(
      {
        mode: "local",
      },
      async () => await tool!.invoke({ query: "recent goals" }),
    )).resolves.toContain("Local memory scope requires haiId");
  });
});
