import { createContentHash } from "./cache.js";
import { searchMemoryLayers } from "./layers.js";
import type { LayeredSearchParams } from "./types.js";
import {
    asString,
    measureMemoryChars,
} from "./utils.js";

function nowMs(): number {
    return Date.now();
}

export async function runMemoryEval(input: {
    agentWallet: string;
    userAddress?: string;
    threadId?: string;
    mode?: "global" | "local";
    haiId?: string;
    filters?: Record<string, unknown>;
    layers?: LayeredSearchParams["layers"];
    testCases: Array<{ query: string; expected?: string; expectedMemoryId?: string }>;
}): Promise<{
    evalRunId: string;
    status: "completed";
    scores: {
        recallAtK: number;
        precisionAtK: number;
        avgContextCharacters: number;
        cases: number;
    };
    results: Array<{ query: string; hit: boolean; returned: number; contextCharacters: number }>;
    avgSearchLatencyMs: number;
}> {
    const results: Array<{ query: string; hit: boolean; returned: number; contextCharacters: number }> = [];
    let totalLatencyMs = 0;

    for (const testCase of input.testCases) {
        const startedAt = nowMs();
        const result = await searchMemoryLayers({
            query: testCase.query,
            agentWallet: input.agentWallet,
            userAddress: input.userAddress,
            threadId: input.threadId,
            mode: input.mode,
            haiId: input.haiId,
            filters: input.filters,
            layers: input.layers || ["working", "scene", "graph", "patterns", "archives", "vectors"],
            limit: 5,
        });
        totalLatencyMs += nowMs() - startedAt;

        const payload = JSON.stringify(result.layers);
        const expected = asString(testCase.expected)?.toLowerCase();
        const expectedMemoryId = asString(testCase.expectedMemoryId);
        const hit = expected
            ? payload.toLowerCase().includes(expected)
            : expectedMemoryId
                ? payload.includes(expectedMemoryId)
                : Object.values(result.totals).some((count) => count > 0);

        results.push({
            query: testCase.query,
            hit,
            returned: Object.values(result.totals).reduce((sum, count) => sum + count, 0),
            contextCharacters: measureMemoryChars(payload),
        });
    }

    const cases = results.length;
    const hits = results.filter((result) => result.hit).length;
    const returned = results.reduce((sum, result) => sum + result.returned, 0);
    const totalCharacters = results.reduce((sum, result) => sum + result.contextCharacters, 0);

    return {
        evalRunId: `memeval_${createContentHash(`${input.agentWallet}|${nowMs()}|${cases}`)}`,
        status: "completed",
        scores: {
            recallAtK: cases === 0 ? 0 : hits / cases,
            precisionAtK: returned === 0 ? 0 : hits / returned,
            avgContextCharacters: cases === 0 ? 0 : totalCharacters / cases,
            cases,
        },
        results,
        avgSearchLatencyMs: cases === 0 ? 0 : totalLatencyMs / cases,
    };
}
