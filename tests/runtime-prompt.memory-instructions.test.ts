import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

describe("runtime prompt construction", () => {
  it("does NOT bake static identity/memory instructions into the registration-time persona blob", () => {
    const source = normalizeWhitespace(readFileSync(
      path.resolve(process.cwd(), "src/manowar/runtime.ts"),
      "utf8",
    ));

    // Identity, tool catalog, and memory discipline are rendered PER-TURN in manowar.ts
    // (buildPromptContext), keyed off the typed AgentIdentity hydrated from IPFS.
    // runtime.ts only carries the optional operator-supplied persona override.
    expect(source).toContain("resolvePersonaOverride");
    expect(source).not.toContain("buildEnhancedPrompt");
    expect(source).not.toContain("Memory discipline:");
  });

  it("renders identity per-turn from the hydrated AgentIdentity in manowar buildPromptContext", () => {
    const source = normalizeWhitespace(readFileSync(
      path.resolve(process.cwd(), "src/manowar/framework.ts"),
      "utf8",
    ));

    expect(source).toContain("buildPromptContext");
    expect(source).toContain("renderIdentitySection");
    expect(source).toContain("peekAgentIdentity");
    expect(source).toContain("resolveAgentIdentity");
  });
});
