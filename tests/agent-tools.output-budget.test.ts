import { describe, expect, it } from "vitest";

import { formatToolResultForAgent } from "../src/manowar/agent/tools.js";

describe("agent tool result budgeting", () => {
    it("keeps small structured tool results as normal JSON", () => {
        const output = formatToolResultForAgent({
            name: "Pudgy Penguins",
            symbol: "PENGU",
        }, { maxChars: 1_000 });

        expect(JSON.parse(output)).toEqual({
            name: "Pudgy Penguins",
            symbol: "PENGU",
        });
    });

    it("compacts large arrays without losing the first usable records", () => {
        const rows = Array.from({ length: 20 }, (_, index) => ({
            id: `coin-${index}`,
            name: `Coin ${index}`,
            symbol: `C${index}`,
            description: "x".repeat(400),
        }));

        const output = formatToolResultForAgent({ coins: rows }, {
            maxChars: 2_000,
            arrayItems: 3,
            objectKeys: 4,
            stringChars: 40,
            maxDepth: 4,
        });
        const parsed = JSON.parse(output);

        expect(output.length).toBeLessThanOrEqual(2_000);
        expect(parsed.__compose_tool_result).toBe("compacted_json");
        expect(parsed.value.coins).toHaveLength(4);
        expect(parsed.value.coins[0]).toMatchObject({
            id: "coin-0",
            name: "Coin 0",
            symbol: "C0",
        });
        expect(parsed.value.coins[3].__compose_truncated).toMatchObject({
            omittedItems: 17,
            totalItems: 20,
        });
    });

    it("preserves the primary collection before dropping secondary collections", () => {
        const output = formatToolResultForAgent({
            coins: Array.from({ length: 10 }, (_, index) => ({
                item: {
                    id: `coin-${index}`,
                    name: `Coin ${index}`,
                    symbol: `C${index}`,
                    description: "x".repeat(300),
                },
            })),
            nfts: Array.from({ length: 10 }, (_, index) => ({
                id: `nft-${index}`,
                name: `NFT ${index}`,
                description: "y".repeat(300),
            })),
            categories: Array.from({ length: 10 }, (_, index) => ({
                id: `category-${index}`,
                name: `Category ${index}`,
                description: "z".repeat(300),
            })),
        }, {
            maxChars: 1_500,
            arrayItems: 3,
            objectKeys: 12,
            stringChars: 160,
            maxDepth: 5,
        });
        const parsed = JSON.parse(output);

        expect(output.length).toBeLessThanOrEqual(1_500);
        expect(parsed.value.coins).toHaveLength(4);
        expect(parsed.value.coins[0].item).toMatchObject({
            id: "coin-0",
            name: "Coin 0",
            symbol: "C0",
        });
        expect(parsed.value.__compose_truncated).toMatchObject({
            strategy: "primary_collection",
            omittedTopLevelKeys: 2,
            totalTopLevelKeys: 3,
        });
    });
});
