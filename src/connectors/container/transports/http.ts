/**
 * MCP-over-HTTP client.
 *
 * Single-request lifecycle: open SSE or Streamable-HTTP, initialize the
 * session, execute one tool call, close. The Worker is short-lived per
 * request — there is no persistent connection pool here. Long-running MCP
 * servers that need warm sessions live behind the Container DO transport
 * (see container/index.ts), not here.
 *
 * AbortSignal is honored end-to-end, pending requests are cleaned up on
 * close, and reconnect logic is intentionally absent: one request, one
 * connection.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

const PROTOCOL_VERSION = "2025-03-26";
const CLIENT_NAME = "compose-connectors";
const CLIENT_VERSION = "0.1.0";

interface JsonRpcMessage {
    jsonrpc: "2.0";
    id?: string | number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

interface CallOptions {
    abort?: AbortSignal;
    timeoutMs?: number;
    headers?: Record<string, string>;
}

export interface CallResult {
    isError: boolean;
    content: Array<{ type: string; text?: string }>;
    rawError?: unknown;
}

export interface ToolListing {
    tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
    serverInfo?: Record<string, unknown> | null;
}

class StreamableHttpTransport implements Transport {
    onmessage?: (msg: JsonRpcMessage) => void;
    onerror?: (err: Error) => void;
    onclose?: () => void;
    sessionId?: string;

    private pending = new Map<string | number, { resolve: (m: JsonRpcMessage) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

    constructor(
        private readonly endpoint: string,
        private readonly headers: Record<string, string> = {},
        private readonly defaultTimeoutMs = 30_000,
    ) { }

    async start(): Promise<void> {
        // No-op: streamable-HTTP issues per-request POSTs, not a persistent
        // connection. The MCP SDK calls `start()` before sending; nothing
        // to do.
    }

    async close(): Promise<void> {
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error("transport closed"));
        }
        this.pending.clear();
        this.onclose?.();
    }

    async send(message: JsonRpcMessage): Promise<void> {
        const controller = new AbortController();
        let fetchTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
            controller.abort();
        }, this.defaultTimeoutMs);
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            ...this.headers,
        };
        if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

        const id = message.id;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const pendingPromise = id !== undefined
            ? new Promise<JsonRpcMessage>((resolve, reject) => {
                timer = setTimeout(() => {
                    this.pending.delete(id);
                    reject(new Error(`request ${id} timed out after ${this.defaultTimeoutMs}ms`));
                }, this.defaultTimeoutMs);
                this.pending.set(id, { resolve, reject, timer });
            })
            : null;

        let response: Response;
        try {
            response = await fetch(this.endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify(message),
                signal: controller.signal,
            });
        } catch (error) {
            if (id !== undefined && this.pending.has(id)) {
                const entry = this.pending.get(id);
                if (entry) {
                    clearTimeout(entry.timer);
                    this.pending.delete(id);
                    entry.reject(error instanceof Error ? error : new Error(String(error)));
                }
            }
            throw error;
        }

        try {
            const newSession = response.headers.get("mcp-session-id");
            if (newSession) this.sessionId = newSession;

            if (response.status === 202) {
                if (id !== undefined && timer) {
                    clearTimeout(timer);
                    this.pending.delete(id);
                }
                return;
            }

            const contentType = response.headers.get("content-type") || "";
            if (contentType.includes("text/event-stream")) {
                await this.consumeSse(response.body, id);
            } else {
                const body = await response.text();
                const parsed = body.length > 0 ? JSON.parse(body) as JsonRpcMessage | JsonRpcMessage[] : null;
                if (Array.isArray(parsed)) {
                    for (const m of parsed) this.dispatch(m);
                } else if (parsed) {
                    this.dispatch(parsed);
                }
            }

            if (id !== undefined && pendingPromise) {
                // The dispatch() above resolves the entry in `this.pending` if
                // the response body included our id. If the body was empty or
                // was a notification only, the timeout path still fires.
                await pendingPromise;
            }
        } finally {
            if (fetchTimer) {
                clearTimeout(fetchTimer);
                fetchTimer = null;
            }
        }
    }

    private async consumeSse(stream: ReadableStream<Uint8Array> | null, id: string | number | undefined): Promise<void> {
        if (!stream) return;
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let idx: number;
                while ((idx = buffer.indexOf("\n\n")) !== -1) {
                    const event = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 2);
                    const dataLine = event.split("\n").find((l) => l.startsWith("data:"));
                    if (!dataLine) continue;
                    const json = dataLine.slice(5).trim();
                    if (!json) continue;
                    let parsed: JsonRpcMessage;
                    try { parsed = JSON.parse(json); } catch { continue; }
                    this.dispatch(parsed);
                    if (id !== undefined && parsed.id === id) {
                        // Done; release the reader so we don't hold the
                        // connection open after the client got its result.
                        try { await reader.cancel(); } catch { /* ignore */ }
                        return;
                    }
                }
            }
        } finally {
            try { reader.releaseLock(); } catch { /* ignore */ }
        }
    }

    private dispatch(message: JsonRpcMessage): void {
        if (message.id !== undefined && this.pending.has(message.id)) {
            const entry = this.pending.get(message.id);
            if (!entry) return;
            clearTimeout(entry.timer);
            this.pending.delete(message.id);
            entry.resolve(message);
        }
        this.onmessage?.(message);
    }
}

export interface HttpSpawnTarget {
    url: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    requiredCredentialVars?: string[];
    envProvided?: Record<string, string>;
}

function missingCredentialVars(target: HttpSpawnTarget): string[] {
    const required = [...new Set((target.requiredCredentialVars || [])
        .map((value) => String(value || "").trim().toUpperCase())
        .filter((value) => /^[A-Z][A-Z0-9_]{2,}$/.test(value)))].sort();
    if (required.length === 0) return [];
    const provided = target.envProvided || {};
    return required.filter((name) => !provided[name]);
}

/**
 * One-shot tool listing over Streamable HTTP.
 */
export async function listToolsHttp(target: HttpSpawnTarget): Promise<ToolListing> {
    const missing = missingCredentialVars(target);
    if (missing.length > 0) {
        throw new Error(`credentials required: ${missing.join(", ")}`);
    }
    const transport = new StreamableHttpTransport(target.url, target.headers, target.timeoutMs);
    const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION }, { capabilities: {} });
    try {
        await client.connect(transport);
        const serverInfo = (client as unknown as { getServerVersion?: () => unknown }).getServerVersion?.();
        const { tools } = await client.listTools();
        return { tools, serverInfo: serverInfo && typeof serverInfo === "object" && !Array.isArray(serverInfo) ? serverInfo as Record<string, unknown> : null };
    } finally {
        try { await client.close(); } catch { /* ignore */ }
    }
}

/**
 * One-shot tool execution over Streamable HTTP.
 */
export async function callToolHttp(
    target: HttpSpawnTarget,
    toolName: string,
    args: Record<string, unknown>,
): Promise<CallResult> {
    const missing = missingCredentialVars(target);
    if (missing.length > 0) {
        throw new Error(`credentials required: ${missing.join(", ")}`);
    }
    const transport = new StreamableHttpTransport(target.url, target.headers, target.timeoutMs);
    const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION }, { capabilities: {} });
    try {
        await client.connect(transport);
        const result = await client.callTool({ name: toolName, arguments: args });
        return {
            isError: Boolean(result.isError),
            content: Array.isArray(result.content) ? (result.content as Array<{ type: string; text?: string }>) : [],
        };
    } finally {
        try { await client.close(); } catch { /* ignore */ }
    }
}
