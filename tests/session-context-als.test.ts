/**
 * Tests for AsyncLocalStorage-based session context propagation
 * (Phase 2.5 — `runtime/src/manowar/agent/context.ts`).
 *
 * Phase 2.5 fixed a real concurrency bug: `agent.config.sessionContext`
 * was mutated per-request on a module-cached AgentInstance, so two
 * concurrent users on the same agent would race over each other's
 * session view (cloud permissions, budget, backpack accounts).
 *
 * The fix moves sessionContext onto the `AgentExecutionContext`
 * AsyncLocalStorage and lets concurrent runs each see their own.
 */
import { describe, expect, it } from "vitest";

import {
    getAgentExecutionContext,
    runWithAgentExecutionContext,
} from "../src/manowar/agent/context.js";
import type { AgentSessionContext } from "../src/manowar/framework.js";

describe("AgentExecutionContext.sessionContext (Phase 2.5)", () => {
    it("is readable inside runWithAgentExecutionContext", async () => {
        const session: AgentSessionContext = {
            sessionActive: true,
            sessionBudgetRemaining: 1234,
            cloudPermissions: ["filesystem"],
            backpackAccounts: [],
        };
        await runWithAgentExecutionContext(
            { sessionContext: session, agentWallet: "0xabc" },
            async () => {
                const ctx = getAgentExecutionContext();
                expect(ctx?.sessionContext?.sessionActive).toBe(true);
                expect(ctx?.sessionContext?.sessionBudgetRemaining).toBe(1234);
                expect(ctx?.sessionContext?.cloudPermissions).toEqual(["filesystem"]);
            },
        );
    });

    it("isolates concurrent runs (no race between users on the same agent)", async () => {
        // Simulate two requests on the same module-cached agent; AsyncLocalStorage
        // must give each its own view of sessionContext.
        const sessionA: AgentSessionContext = {
            sessionActive: true,
            sessionBudgetRemaining: 100,
        };
        const sessionB: AgentSessionContext = {
            sessionActive: true,
            sessionBudgetRemaining: 999,
        };

        const observed: Array<{ user: string; budget?: number }> = [];

        async function userTurn(user: string, session: AgentSessionContext) {
            await runWithAgentExecutionContext(
                { sessionContext: session, agentWallet: "0xshared" },
                async () => {
                    // Simulate async work mid-turn (memory recall, tool call, etc.)
                    await new Promise((r) => setTimeout(r, 10));
                    const ctx = getAgentExecutionContext();
                    observed.push({
                        user,
                        budget: ctx?.sessionContext?.sessionBudgetRemaining,
                    });
                },
            );
        }

        await Promise.all([
            userTurn("A", sessionA),
            userTurn("B", sessionB),
        ]);

        const a = observed.find((o) => o.user === "A");
        const b = observed.find((o) => o.user === "B");
        expect(a?.budget).toBe(100);
        expect(b?.budget).toBe(999);
    });

    it("undefined when no run scope is active (no leaked global state)", () => {
        expect(getAgentExecutionContext()?.sessionContext).toBeUndefined();
    });

    it("does NOT leak after the run scope completes", async () => {
        await runWithAgentExecutionContext(
            {
                sessionContext: { sessionActive: true, sessionBudgetRemaining: 42 },
                agentWallet: "0xleak",
            },
            async () => {
                expect(getAgentExecutionContext()?.sessionContext?.sessionBudgetRemaining).toBe(42);
            },
        );
        // Outside the scope: gone.
        expect(getAgentExecutionContext()?.sessionContext).toBeUndefined();
    });

    it("source no longer mutates agent.config.sessionContext (regression guard)", async () => {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const src = await fs.readFile(
            path.resolve(__dirname, "../src/manowar/framework.ts"),
            "utf8",
        );
        // The two former mutation sites must be gone.
        expect(src).not.toMatch(/agent\.config\.sessionContext\s*=\s*options\.sessionContext/);
    });
});
