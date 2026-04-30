import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

describe("embedding provider endpoint", () => {
  it("uses the MongoDB Voyage embeddings endpoint instead of the direct Voyage API", () => {
    const source = normalizeWhitespace(readFileSync(
      path.resolve(process.cwd(), "src/manowar/memory/embedding.ts"),
      "utf8",
    ));

    expect(source).toContain("https://ai.mongodb.com/v1");
    expect(source).not.toContain("https://api.voyageai.com/v1/embeddings");
  });
});
