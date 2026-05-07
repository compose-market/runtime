/**
 * Regression guard for removed `resolve-model.ts` indirection
 * (Phase 3.1b — agent-only enforcement implication).
 *
 * After Phase 3.1, every `task` / `delegate` cal step targets a
 * registered on-chain agent whose card declares the model. The
 * `resolveModel` host-callback indirection was therefore dead weight
 * and got deleted along with the entire `harness/resolve-model.ts`
 * module. The interpreter now looks up models directly via
 * `peekAgentIdentity` / `resolveAgentIdentity`.
 *
 * These tests guard against the indirection sneaking back in.
 */
import { describe, expect, it } from "vitest";

describe("resolve-model removal (Phase 3.1)", () => {
    it("harness/resolve-model.ts no longer exists", async () => {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const filePath = path.resolve(__dirname, "../src/manowar/harness/resolve-model.ts");
        let exists = true;
        try {
            await fs.access(filePath);
        } catch {
            exists = false;
        }
        expect(exists).toBe(false);
    });

    it("harness/index.ts does not re-export agentCardModelResolver", async () => {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const src = await fs.readFile(
            path.resolve(__dirname, "../src/manowar/harness/index.ts"),
            "utf8",
        );
        expect(src).not.toMatch(/agentCardModelResolver/);
        expect(src).not.toMatch(/agentCardModelResolverSync/);
        expect(src).not.toMatch(/resolve-model/);
    });

    it("InterpreterContext no longer declares resolveModel", async () => {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const src = await fs.readFile(
            path.resolve(__dirname, "../src/manowar/harness/interpreter.ts"),
            "utf8",
        );
        // Grep-style: there must be no "resolveModel?:" in the InterpreterContext block.
        const interpreterCtxBlock = src.match(/export interface InterpreterContext[^]*?^}/m)?.[0];
        expect(interpreterCtxBlock).toBeDefined();
        expect(interpreterCtxBlock).not.toMatch(/resolveModel\??:/);
    });

    it("resolveStepModel signature dropped the StepCtx param", async () => {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const src = await fs.readFile(
            path.resolve(__dirname, "../src/manowar/harness/interpreter.ts"),
            "utf8",
        );
        // The new signature has 3 params (op, explicit, agentWallet).
        // The old 4-param signature with sctx must not appear.
        expect(src).not.toMatch(/resolveStepModel\(sctx[\s,]/);
    });

    it("orchestration.ts /cal/run no longer accepts directModel", async () => {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const src = await fs.readFile(
            path.resolve(__dirname, "../src/orchestration.ts"),
            "utf8",
        );
        // The body type for /cal/run should not declare directModel.
        const calRunHandler = src.match(/POST \/internal\/workflow\/cal\/run[^]*?const body = \(req\.body[^]*?\};/);
        expect(calRunHandler).toBeDefined();
        expect(calRunHandler![0]).not.toMatch(/directModel/);
    });

    it("agent/tools.ts no longer imports harnessAgentCardModelResolver", async () => {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const src = await fs.readFile(
            path.resolve(__dirname, "../src/manowar/agent/tools.ts"),
            "utf8",
        );
        expect(src).not.toMatch(/harnessAgentCardModelResolver/);
        expect(src).not.toMatch(/agentCardModelResolver as harnessAgentCardModelResolver/);
    });
});
