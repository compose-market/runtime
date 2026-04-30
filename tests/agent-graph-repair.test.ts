import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

import { createAgentGraph } from "../src/manowar/agent/graph.js";

function text(message: BaseMessage): string {
    const content = message.content;
    return typeof content === "string" ? content : JSON.stringify(content);
}

describe("agent graph tool repair", () => {
    it("binds turn-relevant tools first while keeping the full executor tool set available", async () => {
        const checkpointDir = await mkdtemp(join(tmpdir(), "compose-agent-graph-"));
        const boundToolNames: string[][] = [];

        const tools = [
            new DynamicStructuredTool({
                name: "coingecko_get_coin_prices",
                description: "Get current prices for CoinGecko coin ids such as bitcoin.",
                schema: z.object({ coinIds: z.array(z.string()) }),
                func: async () => "{}",
            }),
            new DynamicStructuredTool({
                name: "coingecko_get_trending_coins",
                description: "Get trending coins from CoinGecko.",
                schema: z.object({}),
                func: async () => "{}",
            }),
            new DynamicStructuredTool({
                name: "coingecko_get_historical_data",
                description: "Get historical coin data for a date.",
                schema: z.object({ id: z.string(), date: z.string() }),
                func: async () => "{}",
            }),
            new DynamicStructuredTool({
                name: "search_knowledge",
                description: "Search creator identity and workspace knowledge.",
                schema: z.object({ query: z.string() }),
                func: async () => "{}",
            }),
            new DynamicStructuredTool({
                name: "backpack_execute_action",
                description: "Execute an authenticated Backpack action.",
                schema: z.object({ toolkit: z.string(), action: z.string() }),
                func: async () => "{}",
            }),
        ];

        const model = {
            bindTools(boundTools: DynamicStructuredTool[]) {
                boundToolNames.push(boundTools.map((tool) => tool.name));
                return {
                    invoke: async () => new AIMessage("BTC is 100000 USD."),
                };
            },
        };

        const graph = createAgentGraph(model, tools, checkpointDir);
        await graph.invoke(
            { messages: [new HumanMessage("what is the current bitcoin price?")] },
            { configurable: { thread_id: randomUUID() } },
        );

        // Coingecko price tool should be bound (highest relevance to bitcoin price query).
        expect(boundToolNames[0]).toContain("coingecko_get_coin_prices");
        // Cap is 12 by default; with only 5 tools all are eligible.
        expect(boundToolNames[0].length).toBeLessThanOrEqual(tools.length);
    });

    it("keeps tools bound across the entire turn so multi-step chains work (no kill-switch)", async () => {
        const checkpointDir = await mkdtemp(join(tmpdir(), "compose-agent-graph-"));
        const boundToolNames: string[][] = [];

        const priceTool = new DynamicStructuredTool({
            name: "coingecko_get_coin_prices",
            description: "Get current prices for CoinGecko coin ids such as bitcoin.",
            schema: z.object({ coinIds: z.array(z.string()) }),
            func: async () => JSON.stringify({ bitcoin: { usd: 100000 } }),
        });

        const model = {
            bindTools(boundTools: DynamicStructuredTool[]) {
                boundToolNames.push(boundTools.map((tool) => tool.name));
                return {
                    invoke: async (messages: BaseMessage[]) => {
                        const last = messages[messages.length - 1];
                        if (last?._getType?.() === "tool") {
                            return new AIMessage("BTC is 100000 USD.");
                        }
                        return new AIMessage({
                            content: "",
                            tool_calls: [{
                                id: "call-price",
                                name: "coingecko_get_coin_prices",
                                args: { coinIds: ["bitcoin"] },
                                type: "tool_call",
                            }],
                        });
                    },
                };
            },
        };

        const graph = createAgentGraph(model, [priceTool], checkpointDir);
        const result = await graph.invoke(
            { messages: [new HumanMessage("what is the current bitcoin price?")] },
            { configurable: { thread_id: randomUUID() }, recursionLimit: 4 },
        );

        // SOTA pattern: tools stay bound across the whole turn. The model decides exit by
        // emitting no tool_calls. Both binds should include the tool.
        expect(boundToolNames[0]).toEqual(["coingecko_get_coin_prices"]);
        expect(boundToolNames[1]).toEqual(["coingecko_get_coin_prices"]);
        expect(text((result.messages as BaseMessage[]).at(-1)!)).toBe("BTC is 100000 USD.");
    });

    it("injects one provider-neutral repair turn after repeated identical tool schema failures", async () => {
        const checkpointDir = await mkdtemp(join(tmpdir(), "compose-agent-graph-"));
        const seenPrompts: string[] = [];
        const toolArgs: unknown[] = [];

        const priceTool = new DynamicStructuredTool({
            name: "coingecko_get_coin_prices",
            description: "Get coin prices. Required: coinIds: string[].",
            schema: z.object({
                coinIds: z.array(z.string()).min(1),
            }),
            func: async (args: { coinIds: string[] }) => {
                toolArgs.push(args);
                return JSON.stringify({ [args.coinIds[0]]: { usd: 100000 } });
            },
        });

        const model = {
            bindTools() {
                return {
                    invoke: async (messages: BaseMessage[]) => {
                        const prompt = messages.map(text).join("\n");
                        seenPrompts.push(prompt);
                        const last = messages[messages.length - 1];
                        if (last?._getType?.() === "tool" && !text(last).startsWith("Error:")) {
                            return new AIMessage("BTC is 100000 USD.");
                        }
                        if (prompt.includes("[compose:tool-repair]")) {
                            return new AIMessage({
                                content: "",
                                tool_calls: [{
                                    id: `call-${seenPrompts.length}`,
                                    name: "coingecko_get_coin_prices",
                                    args: { coinIds: ["bitcoin"] },
                                    type: "tool_call",
                                }],
                            });
                        }
                        return new AIMessage({
                            content: "",
                            tool_calls: [{
                                id: `call-${seenPrompts.length}`,
                                name: "coingecko_get_coin_prices",
                                args: {},
                                type: "tool_call",
                            }],
                        });
                    },
                };
            },
        };

        const graph = createAgentGraph(model, [priceTool], checkpointDir);
        const result = await graph.invoke(
            { messages: [new HumanMessage("what's the price of $BTC now?")] },
            {
                configurable: { thread_id: randomUUID() },
                recursionLimit: 12,
            },
        );

        const messages = Array.isArray(result.messages) ? result.messages as BaseMessage[] : [];
        expect(messages.map(text).join("\n")).toContain("BTC is 100000 USD.");
        expect(seenPrompts.some((prompt) => prompt.includes("[compose:tool-repair]"))).toBe(true);
        expect(toolArgs).toEqual([{ coinIds: ["bitcoin"] }]);
    });
});
