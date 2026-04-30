import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CHAIN_IDS } from "../src/chains.js";

describe("runtime chain support", () => {
  it("excludes cronos chain ids", () => {
    expect(Object.values(CHAIN_IDS)).not.toContain(338);
    expect(Object.values(CHAIN_IDS)).not.toContain(25);
  });

  it("runtime package no longer depends on the cronos facilitator client", () => {
    const packageJson = JSON.parse(
      readFileSync("/Users/jabyl/Downloads/compose-market/runtime/package.json", "utf8"),
    ) as {
      dependencies?: Record<string, string>;
    };

    expect(Boolean(packageJson.dependencies?.["@crypto.com/facilitator-client"])).toBe(false);
  });
});
