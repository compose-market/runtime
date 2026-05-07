/**
 * Tests for the shared tool-call extraction primitives
 * (Phase 2.4 — `runtime/src/manowar/agent/tool-calls.ts`).
 *
 * These primitives are the single source of truth used by:
 *   - `agent/graph.ts:extractToolCalls`
 *   - `framework.ts:extractStreamToolCalls` + `extractToolCallChunks`
 *   - `harness/engine.ts:countToolBatches` + `collectToolCalls`
 *
 * Wrap-shape coverage MUST stay tight — every wrapper that LangGraph /
 * LangChain emits in production has a regression test here. If a new
 * shape appears in the wild, add a case below.
 */
import { describe, expect, it } from "vitest";

import {
    readToolCallChunksFromRecord,
    readToolCallsFromRecord,
} from "../src/manowar/agent/tool-calls.js";

describe("readToolCallsFromRecord — wrapper-shape coverage", () => {
    it("reads the canonical `tool_calls` field on a BaseMessage-like value", () => {
        const calls = readToolCallsFromRecord({
            tool_calls: [{ id: "c1", name: "do_thing", args: { x: 1 } }],
        });
        expect(calls).toEqual([{ id: "c1", name: "do_thing", args: { x: 1 } }]);
    });

    it("reads `additional_kwargs.tool_calls` (OpenAI-shape)", () => {
        const calls = readToolCallsFromRecord({
            additional_kwargs: {
                tool_calls: [
                    {
                        id: "c2",
                        function: { name: "do_thing", arguments: '{"x":1}' },
                    },
                ],
            },
        });
        expect(calls).toEqual([{ id: "c2", name: "do_thing", args: { x: 1 } }]);
    });

    it("reads `lc_kwargs.tool_calls`", () => {
        const calls = readToolCallsFromRecord({
            lc_kwargs: { tool_calls: [{ id: "c3", name: "do_thing", args: {} }] },
        });
        expect(calls).toEqual([{ id: "c3", name: "do_thing", args: {} }]);
    });

    it("reads `kwargs.tool_calls`", () => {
        const calls = readToolCallsFromRecord({
            kwargs: { tool_calls: [{ id: "c4", name: "do_thing", args: {} }] },
        });
        expect(calls).toEqual([{ id: "c4", name: "do_thing", args: {} }]);
    });

    it("reads nested `lc_kwargs.additional_kwargs.tool_calls`", () => {
        const calls = readToolCallsFromRecord({
            lc_kwargs: {
                additional_kwargs: {
                    tool_calls: [
                        {
                            id: "c5",
                            function: { name: "do_thing", arguments: '{"x":1}' },
                        },
                    ],
                },
            },
        });
        expect(calls).toEqual([{ id: "c5", name: "do_thing", args: { x: 1 } }]);
    });

    it("returns [] for null / undefined / non-object inputs", () => {
        expect(readToolCallsFromRecord(null)).toEqual([]);
        expect(readToolCallsFromRecord(undefined)).toEqual([]);
        expect(readToolCallsFromRecord("string")).toEqual([]);
        expect(readToolCallsFromRecord([])).toEqual([]);
        expect(readToolCallsFromRecord({})).toEqual([]);
    });

    it("dedups by id when the same call appears in multiple wrappers", () => {
        const args = { coinIds: ["bitcoin"] };
        const message = {
            tool_calls: [{ id: "c1", name: "get_price", args }],
            lc_kwargs: { tool_calls: [{ id: "c1", name: "get_price", args }] },
            additional_kwargs: {
                tool_calls: [
                    {
                        id: "c1",
                        function: { name: "get_price", arguments: JSON.stringify(args) },
                    },
                ],
            },
        };
        const calls = readToolCallsFromRecord(message);
        // Reads from the first non-empty path, dedup keeps a single entry.
        expect(calls).toHaveLength(1);
        expect(calls[0].name).toBe("get_price");
    });

    it("synthesizes a stable id when none is provided (signature dedup)", () => {
        const calls = readToolCallsFromRecord({
            tool_calls: [
                { name: "do_thing", args: { x: 1 } },
                { name: "do_thing", args: { x: 1 } },
                { name: "do_thing", args: { x: 2 } },
            ],
        });
        // Two distinct signatures: { x: 1 } once, { x: 2 } once.
        expect(calls.map((c) => c.args)).toEqual([{ x: 1 }, { x: 2 }]);
    });

    it("parses OpenAI `function.arguments` strings into objects", () => {
        const calls = readToolCallsFromRecord({
            additional_kwargs: {
                tool_calls: [
                    {
                        id: "c1",
                        function: {
                            name: "do_thing",
                            arguments: '{"nested":{"a":1}}',
                        },
                    },
                ],
            },
        });
        expect(calls[0].args).toEqual({ nested: { a: 1 } });
    });

    it("falls back to raw string when OpenAI `function.arguments` is non-JSON", () => {
        const calls = readToolCallsFromRecord({
            additional_kwargs: {
                tool_calls: [
                    {
                        id: "c1",
                        function: { name: "do_thing", arguments: "not-json" },
                    },
                ],
            },
        });
        expect(calls[0].args).toBe("not-json");
    });

    it("skips entries with no name", () => {
        const calls = readToolCallsFromRecord({
            tool_calls: [
                { id: "c1", args: {} }, // no name
                { id: "c2", name: "real", args: {} },
            ],
        });
        expect(calls).toEqual([{ id: "c2", name: "real", args: {} }]);
    });
});

describe("readToolCallChunksFromRecord — streaming partial args", () => {
    it("reads `tool_call_chunks` directly", () => {
        const chunks = readToolCallChunksFromRecord({
            tool_call_chunks: [
                { id: "c1", name: "do_thing", args: '{"x":', index: 0 },
                { id: "c1", args: "1}", index: 0 },
            ],
        });
        expect(chunks).toEqual([
            { id: "c1", name: "do_thing", args: '{"x":', index: 0 },
            { id: "c1", name: undefined, args: "1}", index: 0 },
        ]);
    });

    it("reads camelCase `toolCallChunks` alias", () => {
        const chunks = readToolCallChunksFromRecord({
            toolCallChunks: [{ id: "c1", name: "do", args: "{}" }],
        });
        expect(chunks).toHaveLength(1);
        expect(chunks[0].id).toBe("c1");
    });

    it("reads `kwargs.tool_call_chunks`", () => {
        const chunks = readToolCallChunksFromRecord({
            kwargs: { tool_call_chunks: [{ id: "c1", name: "do" }] },
        });
        expect(chunks).toHaveLength(1);
    });

    it("returns [] for empty / non-array / non-object inputs", () => {
        expect(readToolCallChunksFromRecord(null)).toEqual([]);
        expect(readToolCallChunksFromRecord({})).toEqual([]);
        expect(readToolCallChunksFromRecord({ tool_call_chunks: null })).toEqual([]);
    });

    it("filters chunks with no id, name, AND args", () => {
        const chunks = readToolCallChunksFromRecord({
            tool_call_chunks: [
                { index: 0 }, // empty
                { id: "c1" },
            ],
        });
        expect(chunks).toEqual([
            { id: "c1", name: undefined, args: undefined, index: undefined },
        ]);
    });
});
