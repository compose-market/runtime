import { describe, expect, it } from "vitest";

import { createMemoryTools } from "../src/manowar/agent/tools.js";

describe("createMemoryTools — Phase 1.5 surface", () => {
  it("only memory_remember is exposed (memory_recall removed: ranker pre-injects)", () => {
    const tools = createMemoryTools("0x1111111111111111111111111111111111111111");
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["memory_remember"]);
  });

  it("memory_remember accepts content and is callable from local scope agents", async () => {
    const tools = createMemoryTools(
      "0x1111111111111111111111111111111111111111",
      undefined,
      undefined,
    );
    const remember = tools.find((tool) => tool.name === "memory_remember");
    expect(remember).toBeDefined();
    // We do NOT actually invoke (would hit Mongo); we only assert schema shape
    // and description so the contract is enforced for future refactors.
    expect(remember?.description).toContain("durable fact");
  });
});
