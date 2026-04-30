import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const knowledgeMock = vi.hoisted(() => ({
  searchKnowledge: vi.fn(async () => [
    {
      content: "Knowledge document: autonomy-matrix.pdf\n\nThe Autonomy Matrix is a coordination model.",
      score: 0.97,
      scope: "identity",
    },
  ]),
}));

vi.mock("../src/manowar/knowledge/index.js", () => knowledgeMock);

import { createAgentTools } from "../src/manowar/agent/tools.js";

describe("knowledge tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("searches runtime knowledge without injecting knowledge into the prompt", async () => {
    const tools = await createAgentTools(
      [],
      { address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } as any,
      undefined,
      undefined,
      undefined,
      "0x1111111111111111111111111111111111111111",
    );
    const tool = tools.find((entry) => entry.name === "search_knowledge");

    expect(tool).toBeDefined();

    const output = await tool!.func({
      query: "autonomy matrix",
    });

    expect(knowledgeMock.searchKnowledge).toHaveBeenCalledWith({
      agentWallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      userAddress: "0x1111111111111111111111111111111111111111",
      query: "autonomy matrix",
      scope: undefined,
      limit: undefined,
    });
    expect(output).toContain("Autonomy Matrix");
  }, 20000);
});
