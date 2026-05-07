import { describe, expect, it } from "vitest";

import { createMemoryTools } from "../src/manowar/agent/tools.js";

describe("createMemoryTools surface (Phase 1.5: memory_recall removed)", () => {
  it("exposes only memory_remember; ranker pre-injects context per Arazzo contract", () => {
    const tools = createMemoryTools("0x1111111111111111111111111111111111111111");
    const names = tools.map((tool) => tool.name).sort();

    // memory_recall was removed in Phase 1.5: the memory.arazzo.yaml contract
    // states "ranker picks for you" — pre-injection is sufficient.
    expect(names).toEqual(["memory_remember"]);

    // memory_remember persists explicit user-stated facts (orthogonal to
    // pre-injected recall — the auto-extractor sometimes misses).
    const remember = tools.find((tool) => tool.name === "memory_remember");
    expect(remember).toBeDefined();
    expect(remember?.description).toMatch(/Save a durable fact/i);
  });
});
