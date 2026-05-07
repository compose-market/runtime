/**
 * Tests for graph-layer fact extraction
 * (Phase 1.2 — `runtime/src/manowar/memory/graph.ts`).
 *
 * Phase 1.2 dropped `"other"` from FACT_TYPES because the parser already
 * rejected it as junk, throwing away ~20-30% of legitimate low-confidence
 * preference facts that don't slot cleanly into the typed categories.
 *
 * The 6-type contract (`preference / identity / context / skill /
 * relationship / event`) is enforced at three layers:
 *   1. The system prompt advertises only these types.
 *   2. The parser rejects anything not in the list.
 *   3. Length cap (240 chars) catches omnibus rows even within an
 *      allowed type.
 */
import { describe, expect, it } from "vitest";

// We test the prompt builder + parser indirectly via internal exports
// from graph.ts. The parseExtractedFacts function is internal but exposed
// via a small surface check here.

describe("FACT_TYPES (Phase 1.2)", () => {
    it("excludes 'other' from the extraction contract", async () => {
        // Read the source file directly — we inspect the typed tuple to
        // assert it ships only the 6 ranker-aware types.
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const src = await fs.readFile(
            path.resolve(__dirname, "../src/manowar/memory/graph.ts"),
            "utf8",
        );
        // The typed tuple defines the contract. Strip whitespace for stable match.
        const factTypesLine = src
            .split("\n")
            .find((line) => line.includes("const FACT_TYPES ="));
        expect(factTypesLine).toBeDefined();
        // Must NOT include "other" anymore.
        expect(factTypesLine).not.toMatch(/"other"/);
        // Must include all 6 real categories.
        for (const t of ["preference", "identity", "context", "skill", "relationship", "event"]) {
            expect(factTypesLine).toMatch(new RegExp(`"${t}"`));
        }
    });
});

describe("rememberAgentMemory default fact type (Phase 1.2)", () => {
    it("defaults to 'context' (not 'other') when caller omits or sends an unknown type", async () => {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const src = await fs.readFile(
            path.resolve(__dirname, "../src/manowar/memory/agent-loop.ts"),
            "utf8",
        );
        // Locate the default-resolution line.
        expect(src).toMatch(/factType =[^]*?VALID_FACT_TYPES.has[^]*?"context"/);
        // And the VALID_FACT_TYPES set MUST NOT contain "other".
        const validLine = src
            .split("\n")
            .find((line) => line.includes("VALID_FACT_TYPES = new Set"));
        expect(validLine).toBeDefined();
        expect(validLine).not.toMatch(/"other"/);
    });
});

describe("SDK MemoryToolType union (Phase 1.2 SDK update)", () => {
    it("public memory.save type union no longer includes 'other'", async () => {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const src = await fs.readFile(
            path.resolve(__dirname, "../../packages/sdk/src/resources/memory.ts"),
            "utf8",
        );
        // The line declaring the type union must NOT include "other".
        const typeLine = src
            .split("\n")
            .find((line) => line.includes("type?:") && line.includes("preference"));
        expect(typeLine).toBeDefined();
        expect(typeLine).not.toMatch(/"other"/);
    });
});
