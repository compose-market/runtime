import { describe, expect, it } from "vitest";
import { buildVectorId } from "../../src/connectors/catalog/embeddings.js";

describe("connector embedding ids", () => {
    it("keeps Vectorize ids within the 64-byte limit for long reviewed slugs", () => {
        const id = buildVectorId("tech-skybridge-investigation-game-investigation-game", "1234567890abcdef");

        expect(new TextEncoder().encode(id).length).toBeLessThanOrEqual(64);
        expect(id).toContain("12345678");
    });

    it("preserves short ids for existing vectors", () => {
        expect(buildVectorId("payments", "card123")).toBe("payments:card123");
    });
});
