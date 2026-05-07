/**
 * Tests for the tightened discipline footer (Phase 2.3)
 * `runtime/src/manowar/framework.ts:buildPromptContext`
 *
 * The single-line footer was insufficient for SOTA models running
 * multi-step plans across the agent fabric. The new footer is a
 * 6-rule directive list (~140 tokens) honoring the three contracts:
 *   1. Tools are how you act.
 *   2. Memory is ranker-curated; no recall tool.
 *   3. Peer agents are specialists callable via a2a.
 *   4. Writes require verifiable result.
 *   5. Halt only on complete answer or budget exhaustion.
 *   6. Stop retrying on repeated same-arg failures.
 */
import { describe, expect, it } from "vitest";

describe("discipline footer (Phase 2.3)", () => {
    it("contains all six contract-aware rules", async () => {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const src = await fs.readFile(
            path.resolve(__dirname, "../src/manowar/framework.ts"),
            "utf8",
        );
        // The single-line legacy footer is gone.
        expect(src).not.toMatch(/Use tools when the task needs live data, on-chain action, or memory\. Continue calling tools/);

        // Each of the six rules must appear in the new footer.
        expect(src).toMatch(/Operating rules:/);
        expect(src).toMatch(/1\. Tools are how you act/);
        expect(src).toMatch(/2\. Memory above is curated for you by the ranker/);
        expect(src).toMatch(/3\. Peer agents are specialists.*a2a/);
        expect(src).toMatch(/4\. State changes \(writes, payments, deploys\) require a verifiable result/);
        expect(src).toMatch(/5\. Stop only when you have a complete final answer/);
        expect(src).toMatch(/6\. If a tool fails repeatedly with the same arguments/);
    });

    it("does not leak removed memory_recall guidance", async () => {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const src = await fs.readFile(
            path.resolve(__dirname, "../src/manowar/framework.ts"),
            "utf8",
        );
        expect(src).not.toMatch(/memory_recall/);
    });
});
