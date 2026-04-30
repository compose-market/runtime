import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

describe("manowar runtime memory integration", () => {
  it("keeps agent-memory helpers under the agent framework and wires retrieval plus persistence into standalone execution", () => {
    const source = normalizeWhitespace(readFileSync(
      path.resolve(process.cwd(), "src/manowar/framework.ts"),
      "utf8",
    ));

    expect(source).toContain('from "./agent/memory.js"');
    expect(source).toContain("loadConversationMemoryPrompt(");
    expect(source).toContain("persistConversationTurnSafely(");
    expect(source).not.toContain('from "./memory/agent.js"');
  });
});
