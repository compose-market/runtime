import { describe, expect, it } from "vitest";
import { __test as graphTest } from "../../src/manowar/agent/graph.js";
import { __test as frameworkTest } from "../../src/manowar/framework.js";

describe("agent tool-call extraction", () => {
    it("dedupes the same LangChain tool call across alias fields", () => {
        const call = {
            id: "call_123",
            name: "coingecko_get_coin_prices",
            args: { coinIds: ["bitcoin"], vsCurrency: "usd" },
        };
        const message = {
            _getType: () => "ai",
            content: "",
            tool_calls: [call],
            lc_kwargs: { tool_calls: [call] },
            additional_kwargs: {
                tool_calls: [{
                    id: "call_123",
                    function: {
                        name: "coingecko_get_coin_prices",
                        arguments: JSON.stringify(call.args),
                    },
                }],
            },
        };

        expect(graphTest.extractToolCalls(message as never)).toEqual([call]);
    });

    it("dedupes stream output tool calls before serializing API responses", () => {
        const args = { coinIds: ["bitcoin"], vsCurrency: "usd" };
        const message = {
            type: "ai",
            content: "",
            tool_calls: [{ id: "call_123", name: "coingecko_get_coin_prices", args }],
            lc_kwargs: {
                tool_calls: [{ id: "call_123", name: "coingecko_get_coin_prices", args }],
            },
            additional_kwargs: {
                tool_calls: [{
                    id: "call_123",
                    function: {
                        name: "coingecko_get_coin_prices",
                        arguments: JSON.stringify(args),
                    },
                }],
            },
        };

        expect(frameworkTest.extractStreamToolCalls(message)).toEqual([
            { id: "call_123", name: "coingecko_get_coin_prices", args },
        ]);
    });
});
