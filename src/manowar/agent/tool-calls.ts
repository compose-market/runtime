/**
 * Tool-call extraction primitives.
 *
 * LangChain / LangGraph serialize tool-call data across at least 5 wrapper
 * shapes (`tool_calls`, `additional_kwargs.tool_calls`, `lc_kwargs.tool_calls`,
 * `kwargs.tool_calls`, OpenAI-style `function.{name,arguments}`). Different
 * call sites in the runtime (graph.ts, framework.ts, harness/engine.ts) need
 * the same data in slightly different shapes. This module is the single
 * source of truth for the leaf-level read.
 *
 * Every higher-level extractor (stream-event walkers, message-list counters,
 * BaseMessage extractors) calls one of these primitives. NEVER reach into
 * `tool_calls` / `additional_kwargs` directly elsewhere; if a new shape
 * appears, it goes here.
 */

export interface NormalizedToolCall {
    id: string;
    name: string;
    args?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "string" && value.length > 0) return value;
    }
    return undefined;
}

function parseArgsString(value: unknown): unknown {
    if (typeof value !== "string") return value;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

/**
 * Read tool_calls from one record, accepting any of the known wrapper shapes.
 * Returns [] if none found. Deduplicates by `id` (or by `name+args` signature
 * when id is missing).
 */
export function readToolCallsFromRecord(value: unknown): NormalizedToolCall[] {
    const record = asRecord(value);
    if (!record) return [];

    const candidatePaths: Array<unknown> = [
        record.tool_calls,
        (record as { toolCalls?: unknown }).toolCalls,
        asRecord(record.lc_kwargs)?.tool_calls,
        asRecord(record.kwargs)?.tool_calls,
        asRecord(record.additional_kwargs)?.tool_calls,
        asRecord(asRecord(record.lc_kwargs)?.additional_kwargs)?.tool_calls,
        asRecord(asRecord(record.kwargs)?.additional_kwargs)?.tool_calls,
    ];

    const out: NormalizedToolCall[] = [];
    const seen = new Set<string>();

    for (const list of candidatePaths) {
        if (!Array.isArray(list)) continue;
        for (let index = 0; index < list.length; index += 1) {
            const raw = asRecord(list[index]);
            if (!raw) continue;
            // Direct shape: { id?, name, args? }
            // OpenAI shape:  { id?, function: { name, arguments } }
            const fn = asRecord(raw.function);
            const name = readString(raw, "name") ?? (fn ? readString(fn, "name") : undefined);
            if (!name) continue;
            const id = readString(raw, "id", "tool_call_id") ?? `${name}:${out.length}:${index}`;
            const args = raw.args !== undefined
                ? raw.args
                : raw.arguments !== undefined
                    ? raw.arguments
                    : fn
                        ? parseArgsString(fn.arguments)
                        : undefined;
            const key = id.startsWith(`${name}:`) ? `sig:${name}:${safeStringify(args)}` : `id:${id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ id, name, args });
        }
        if (out.length > 0) break;
    }

    return out;
}

/**
 * Read partial tool-args streamed token-by-token (LangGraph
 * `tool_call_chunks` / OpenAI `function_call_arguments.delta`). Each chunk
 * carries an `index` so the consumer can stitch them back together.
 */
export interface ToolCallChunk {
    id?: string;
    name?: string;
    args?: string;
    index?: number;
}

export function readToolCallChunksFromRecord(value: unknown): ToolCallChunk[] {
    const record = asRecord(value);
    if (!record) return [];
    const candidatePaths: Array<unknown> = [
        record.tool_call_chunks,
        (record as { toolCallChunks?: unknown }).toolCallChunks,
        asRecord(record.kwargs)?.tool_call_chunks,
        asRecord(record.lc_kwargs)?.tool_call_chunks,
    ];
    const out: ToolCallChunk[] = [];
    for (const list of candidatePaths) {
        if (!Array.isArray(list)) continue;
        for (const raw of list) {
            const chunk = asRecord(raw);
            if (!chunk) continue;
            const id = readString(chunk, "id", "tool_call_id");
            const name = readString(chunk, "name");
            const args = readString(chunk, "args", "arguments");
            const indexValue = chunk.index;
            const index = typeof indexValue === "number" ? indexValue : undefined;
            if (!id && !name && !args) continue;
            out.push({ id, name, args, index });
        }
        if (out.length > 0) break;
    }
    return out;
}

/**
 * Stable signature used for dedup keys when id is absent. Safe across
 * JSON-stringify failures.
 */
function safeStringify(value: unknown): string {
    if (typeof value === "string") return value.replace(/\s+/g, " ").trim().slice(0, 600);
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}
