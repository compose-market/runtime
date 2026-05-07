/**
 * Tests for stable tool binding (Phase 2.2)
 * `runtime/src/manowar/agent/graph.ts`
 *
 * The previous design re-scored tools per turn and capped at 12, which
 * mutated the bound-tool set across iterations of the same turn and
 * invalidated the model's KV cache. Manus, deepagents, and Claude Code
 * all keep bound tools stable.
 *
 * Contract: every successful (non-budget-exhausted, non-repair) iteration
 * binds the SAME tool list given to `createAgentGraph`. The set is
 * mutated only by the two exit ramps (`[compose:tool-loop-stop]` and
 * `[compose:tool-budget-exhausted]`), which set boundTools = [].
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
    AIMessage,
    HumanMessage,
    type BaseMessage,
} from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

import { createAgentGraph } from "../src/manowar/agent/graph.js";

describe("stable tool bind — Phase 2.2", () => {
    it("binds the FULL tool list every iteration when budgets are healthy", async () => {
        const checkpointDir = await mkdtemp(join(tmpdir(), "compose-stable-bind-"));
        const boundToolNames: string[][] = [];

        // Eight tools, none of which token-overlap with the user query.
        const tools = Array.from({ length: 8 }, (_, i) =>
            new DynamicStructuredTool({
                name: `tool_${i}`,
                description: `description ${i}`,
                schema: z.object({}),
                func: async () => "ok",
            }),
        );

        let callIndex = 0;
        const model = {
            bindTools(boundTools: DynamicStructuredTool[]) {
                boundToolNames.push(boundTools.map((t) => t.name));
                return {
                    invoke: async () => {
                        callIndex += 1;
                        if (callIndex === 1) {
                            return new AIMessage({
                                content: "",
                                tool_calls: [{
                                    id: "c1",
                                    name: "tool_3",
                                    args: {},
                                    type: "tool_call",
                                }],
                            });
                        }
                        // After the tool returns, emit final answer.
                        return new AIMessage("ok");
                    },
                };
            },
        };

        const graph = createAgentGraph(model, tools, checkpointDir);
        await graph.invoke(
            { messages: [new HumanMessage("totally unrelated query")] },
            {
                configurable: { thread_id: randomUUID(), startTime: Date.now() },
                recursionLimit: 8,
            },
        );

        // bindTools called twice (model node fires once before tool, once after).
        expect(boundToolNames.length).toBeGreaterThanOrEqual(2);
        // Both calls bound the FULL list — no per-turn pruning.
        expect(boundToolNames[0]).toHaveLength(tools.length);
        expect(boundToolNames[1]).toHaveLength(tools.length);
        // Same set, stable order (KV-cache discipline).
        expect(boundToolNames[0]).toEqual(boundToolNames[1]);
    });

    it("binds the same set even with 50+ tools (no DEFAULT_MAX_BOUND_TOOLS cap)", async () => {
        const checkpointDir = await mkdtemp(join(tmpdir(), "compose-stable-bind-large-"));
        const boundCounts: number[] = [];

        const tools = Array.from({ length: 50 }, (_, i) =>
            new DynamicStructuredTool({
                name: `tool_${i}`,
                description: `tool number ${i}`,
                schema: z.object({}),
                func: async () => "ok",
            }),
        );

        const model = {
            bindTools(boundTools: DynamicStructuredTool[]) {
                boundCounts.push(boundTools.length);
                return {
                    invoke: async () => new AIMessage("done"),
                };
            },
        };

        const graph = createAgentGraph(model, tools, checkpointDir);
        await graph.invoke(
            { messages: [new HumanMessage("hello")] },
            {
                configurable: { thread_id: randomUUID(), startTime: Date.now() },
                recursionLimit: 4,
            },
        );

        // All 50 tools bound; no 12-tool cap from DEFAULT_MAX_BOUND_TOOLS.
        expect(boundCounts[0]).toBe(50);
    });

    it("source no longer references selectBoundTools / DEFAULT_MAX_BOUND_TOOLS", async () => {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const src = await fs.readFile(
            path.resolve(__dirname, "../src/manowar/agent/graph.ts"),
            "utf8",
        );
        // Any references must be in COMMENTS (e.g. discipline notes), not
        // active definitions or call sites. The simplest assertion: neither
        // identifier appears as a function decl / call.
        expect(src).not.toMatch(/^function selectBoundTools/m);
        expect(src).not.toMatch(/selectBoundTools\(/);
        expect(src).not.toMatch(/^const DEFAULT_MAX_BOUND_TOOLS/m);
    });

    it("bound tools = [] only when an exit ramp is active (Phase 2.1 budget OR repair)", async () => {
        process.env.COMPOSE_AGENT_MAX_TOOL_BATCHES_PER_TURN = "1";
        const checkpointDir = await mkdtemp(join(tmpdir(), "compose-stable-bind-ramp-"));
        const boundCounts: number[] = [];

        const ping = new DynamicStructuredTool({
            name: "ping",
            description: "ping",
            schema: z.object({}),
            func: async () => "pong",
        });

        let callIndex = 0;
        const model = {
            bindTools(boundTools: DynamicStructuredTool[]) {
                boundCounts.push(boundTools.length);
                return {
                    invoke: async (messages: BaseMessage[]) => {
                        callIndex += 1;
                        if (callIndex === 1) {
                            return new AIMessage({
                                content: "",
                                tool_calls: [{
                                    id: "c1",
                                    name: "ping",
                                    args: {},
                                    type: "tool_call",
                                }],
                            });
                        }
                        return new AIMessage("done");
                    },
                };
            },
        };

        const graph = createAgentGraph(model, [ping], checkpointDir);
        await graph.invoke(
            { messages: [new HumanMessage("ramp test")] },
            {
                configurable: { thread_id: randomUUID(), startTime: Date.now() },
                recursionLimit: 8,
            },
        );

        delete process.env.COMPOSE_AGENT_MAX_TOOL_BATCHES_PER_TURN;
        // Iteration 1 binds the full list; iteration 2 trips ceiling=1 and unbinds.
        expect(boundCounts[0]).toBe(1);
        expect(boundCounts[1]).toBe(0);
    });
});
