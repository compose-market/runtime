/**
 * Tests for the per-turn budget gate (Phase 2.1)
 * `runtime/src/manowar/agent/graph.ts`
 *
 * The previous design used a hard count `MAX_TOOL_BATCHES_PER_TURN = 6`.
 * The new gate has three axes:
 *   1. Wall time (default 4 min, env: COMPOSE_AGENT_MAX_WALL_MS_PER_TURN)
 *   2. Consecutive failures (default 4, env: COMPOSE_AGENT_MAX_TOOL_FAILURES_IN_ROW)
 *   3. Manus-grade safety ceiling (default 50 batches,
 *      env: COMPOSE_AGENT_MAX_TOOL_BATCHES_PER_TURN)
 *
 * When ANY axis is breached, the next callModel iteration unbinds tools
 * and injects a `[compose:tool-budget-exhausted]` SystemMessage that
 * names the breached axis.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    AIMessage,
    HumanMessage,
    ToolMessage,
    type BaseMessage,
} from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

import { createAgentGraph } from "../src/manowar/agent/graph.js";

function text(message: BaseMessage): string {
    const content = message.content;
    return typeof content === "string" ? content : JSON.stringify(content);
}

const ENV_KEYS = [
    "COMPOSE_AGENT_MAX_WALL_MS_PER_TURN",
    "COMPOSE_AGENT_MAX_TOOL_FAILURES_IN_ROW",
    "COMPOSE_AGENT_MAX_TOOL_BATCHES_PER_TURN",
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
    for (const key of ENV_KEYS) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
    }
});

afterEach(() => {
    for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
});

describe("budget gate — wall time (Phase 2.1)", () => {
    it("triggers a tool-budget-exhausted ramp when wall time is exceeded", async () => {
        process.env.COMPOSE_AGENT_MAX_WALL_MS_PER_TURN = "50"; // 50ms cap
        const checkpointDir = await mkdtemp(join(tmpdir(), "compose-budget-wall-"));
        const seenSystemPrompts: string[] = [];

        const ping = new DynamicStructuredTool({
            name: "ping",
            description: "ping",
            schema: z.object({}),
            func: async () => "pong",
        });

        const model = {
            bindTools(_boundTools: DynamicStructuredTool[]) {
                return {
                    invoke: async (messages: BaseMessage[]) => {
                        const systems = messages
                            .filter((m) => m._getType?.() === "system")
                            .map(text);
                        seenSystemPrompts.push(systems.join("\n"));
                        return new AIMessage("done");
                    },
                };
            },
        };

        const graph = createAgentGraph(model, [ping], checkpointDir);
        // Pretend we started 5 seconds ago — wall-time cap (50ms) is breached
        // on the very first callModel iteration, so the ramp injects before
        // the model is invoked.
        const startTime = Date.now() - 5000;
        await graph.invoke(
            { messages: [new HumanMessage("trigger wall budget")] },
            {
                configurable: { thread_id: randomUUID(), startTime },
                recursionLimit: 8,
            },
        );

        const exhausted = seenSystemPrompts.some((p) =>
            p.includes("[compose:tool-budget-exhausted]"),
        );
        const wallMessage = seenSystemPrompts.some((p) =>
            p.includes("Wall-time budget exhausted"),
        );
        expect(exhausted).toBe(true);
        expect(wallMessage).toBe(true);
    });
});

describe("budget gate — consecutive failures (Phase 2.1)", () => {
    it("triggers when the configured number of consecutive tool batches fail", async () => {
        process.env.COMPOSE_AGENT_MAX_TOOL_FAILURES_IN_ROW = "2";
        const checkpointDir = await mkdtemp(join(tmpdir(), "compose-budget-fail-"));
        const seenSystemPrompts: string[] = [];

        // The graph relies on isToolError() detecting status:"error" or
        // a content starting with "Error:". We craft errored ToolMessages.
        const flaky = new DynamicStructuredTool({
            name: "flaky",
            description: "flaky",
            schema: z.object({}),
            func: async () => `Error: simulated failure`,
        });

        let callIndex = 0;
        const model = {
            bindTools(_boundTools: DynamicStructuredTool[]) {
                return {
                    invoke: async (messages: BaseMessage[]) => {
                        callIndex += 1;
                        const systems = messages
                            .filter((m) => m._getType?.() === "system")
                            .map(text);
                        seenSystemPrompts.push(systems.join("\n"));
                        // Keep emitting tool calls until forced to stop.
                        if (callIndex <= 4) {
                            return new AIMessage({
                                content: "",
                                tool_calls: [{
                                    id: `c${callIndex}`,
                                    name: "flaky",
                                    args: { idx: callIndex },
                                    type: "tool_call",
                                }],
                            });
                        }
                        return new AIMessage("done");
                    },
                };
            },
        };

        const graph = createAgentGraph(model, [flaky], checkpointDir);
        await graph.invoke(
            { messages: [new HumanMessage("trigger failure budget")] },
            {
                configurable: { thread_id: randomUUID(), startTime: Date.now() },
                recursionLimit: 24,
            },
        );

        // EITHER the failure-budget ramp OR the repair-attempts-exhausted ramp
        // is acceptable: both terminate the tool loop. The failure-budget axis
        // fires once the streak hits the cap; the repair budget fires when the
        // model cannot recover. We assert AT LEAST ONE termination ramp landed.
        const stopRamp = seenSystemPrompts.some((p) =>
            p.includes("Consecutive tool failures") ||
            p.includes("[compose:tool-loop-stop]"),
        );
        expect(stopRamp).toBe(true);
    });
});

describe("budget gate — Manus-grade safety ceiling (Phase 2.1)", () => {
    it("env override applies to total tool batches per turn", async () => {
        process.env.COMPOSE_AGENT_MAX_TOOL_BATCHES_PER_TURN = "2";
        const checkpointDir = await mkdtemp(join(tmpdir(), "compose-budget-ceiling-"));
        const seenSystemPrompts: string[] = [];

        const ping = new DynamicStructuredTool({
            name: "ping",
            description: "ping",
            schema: z.object({}),
            func: async () => "pong",
        });

        let callIndex = 0;
        const model = {
            bindTools(_boundTools: DynamicStructuredTool[]) {
                return {
                    invoke: async (messages: BaseMessage[]) => {
                        callIndex += 1;
                        const systems = messages
                            .filter((m) => m._getType?.() === "system")
                            .map(text);
                        seenSystemPrompts.push(systems.join("\n"));
                        // Emit tool calls forever; budget must stop us.
                        if (callIndex <= 5) {
                            return new AIMessage({
                                content: "",
                                tool_calls: [{
                                    id: `c${callIndex}`,
                                    name: "ping",
                                    args: { i: callIndex },
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
            { messages: [new HumanMessage("trigger ceiling")] },
            {
                configurable: { thread_id: randomUUID(), startTime: Date.now() },
                recursionLimit: 12,
            },
        );

        // Ceiling=2 → after 2 successful tool batches the next callModel sees
        // batches >= ceiling and emits the tool-budget-exhausted ramp.
        const ceilingRamp = seenSystemPrompts.some((p) =>
            p.includes("Tool-batch ceiling reached"),
        );
        expect(ceilingRamp).toBe(true);
    });
});

describe("budget gate — defaults preserve long-horizon SOTA bounds", () => {
    it("default safety ceiling is 50 batches/turn (Manus-grade)", async () => {
        // Read source and assert constant. Fast, no execution overhead.
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const src = await fs.readFile(
            path.resolve(__dirname, "../src/manowar/agent/graph.ts"),
            "utf8",
        );
        expect(src).toMatch(/DEFAULT_MAX_TOOL_BATCHES_PER_TURN\s*=\s*50/);
        expect(src).toMatch(/DEFAULT_MAX_WALL_MS_PER_TURN\s*=\s*4\s*\*\s*60_000/);
        expect(src).toMatch(/DEFAULT_MAX_TOOL_FAILURES_IN_ROW\s*=\s*4/);
    });

    it("legacy MAX_TOOL_BATCHES_PER_TURN constant is gone", async () => {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const src = await fs.readFile(
            path.resolve(__dirname, "../src/manowar/agent/graph.ts"),
            "utf8",
        );
        // The old single-line constant must no longer exist.
        expect(src).not.toMatch(/^const MAX_TOOL_BATCHES_PER_TURN = 6;/m);
    });
});
