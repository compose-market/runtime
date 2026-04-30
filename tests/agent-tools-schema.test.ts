import { describe, expect, it, vi } from "vitest";

const goatMock = vi.hoisted(() => ({
    getPlugin: vi.fn(),
    executeGoatTool: vi.fn(),
}));

vi.mock("../src/mcps/goat.js", () => goatMock);

import { createAgentTools } from "../src/manowar/agent/tools.js";

describe("agent tool schema conversion", () => {
    it("preserves JSON Schema arrays, enums, nested objects, and integer bounds", async () => {
        goatMock.getPlugin.mockResolvedValue({
            tools: [{
                name: "get_coin_prices",
                description: "Get coin prices.",
                parameters: {
                    type: "object",
                    properties: {
                        coinIds: {
                            type: "array",
                            items: { type: "string" },
                            minItems: 1,
                            description: "Coin identifiers",
                        },
                        currency: {
                            type: "string",
                            enum: ["usd", "eur"],
                            description: "Quote currency",
                        },
                        options: {
                            type: "object",
                            additionalProperties: false,
                            properties: {
                                includeMarketCap: { type: "boolean" },
                                limit: { type: "integer", minimum: 1, maximum: 10 },
                            },
                            required: ["limit"],
                        },
                    },
                    required: ["coinIds", "currency"],
                },
            }],
        });
        goatMock.executeGoatTool.mockResolvedValue({
            success: true,
            result: { bitcoin: { usd: 100000 } },
        });

        const [tool] = await createAgentTools(["goat:coingecko"]);
        expect(tool.description).toBe("Get coin prices.");

        const schema = tool.schema;
        expect(() => schema.parse({ coinIds: [], currency: "usd" })).toThrow();
        expect(() => schema.parse({ coinIds: ["bitcoin"], currency: "gbp" })).toThrow();
        expect(() => schema.parse({
            coinIds: ["bitcoin"],
            currency: "usd",
            options: { limit: 0 },
        })).toThrow();
        expect(() => schema.parse({
            coinIds: ["bitcoin"],
            currency: "usd",
            options: { limit: 3, unknown: true },
        })).toThrow();

        await tool.invoke({
            coinIds: ["bitcoin"],
            currency: "usd",
            options: { includeMarketCap: true, limit: 3 },
        });

        expect(goatMock.executeGoatTool).toHaveBeenCalledWith("coingecko", "get_coin_prices", {
            coinIds: ["bitcoin"],
            currency: "usd",
            options: { includeMarketCap: true, limit: 3 },
        });
    });
});
