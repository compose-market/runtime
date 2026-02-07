/**
 * HTTP/SSE Client Transport for MCP
 * 
 * Implements MCP SDK transport interface for remote servers that expose HTTP/SSE endpoints.
 * Supports both Server-Sent Events (SSE) and Streamable HTTP protocols.
 * 
 * Protocol detection:
 * - If baseUrl ends with /sse → SSE protocol (EventSource on that URL, POST to sibling /message)
 * - If baseUrl ends with /mcp → Streamable HTTP protocol (POST directly to that URL)
 * - Otherwise → auto-detect: try Streamable HTTP first, fall back to SSE
 * - Can be overridden via explicit `protocol` option
 * 
 * Used for:
 * - Servers with `remotes[]` in registry (e.g., exa.ai, cirra.ai)
 * - Containerized servers exposed via supergateway
 */
import { EventSource } from "eventsource";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

type McpProtocol = "sse" | "streamable-http";

interface HttpSseOptions {
    baseUrl: string;
    /** Explicit protocol hint: "sse" or "streamable-http". Auto-detected from URL if not set. */
    protocol?: McpProtocol;
    reconnectInterval?: number;
    maxReconnectAttempts?: number;
}

/**
 * Detect the MCP protocol from the URL path.
 */
function detectProtocol(url: string): McpProtocol | null {
    const path = new URL(url).pathname;
    if (path.endsWith("/sse")) return "sse";
    if (path.endsWith("/mcp")) return "streamable-http";
    return null;
}

/**
 * Derive the SSE endpoint and message POST endpoint from a base URL.
 * 
 * SSE protocol:
 *   - EventSource connects to the /sse endpoint
 *   - Messages POST to /message (sibling path)
 * 
 * Streamable HTTP protocol:
 *   - No EventSource needed (or connect to same URL)
 *   - Messages POST directly to the base URL
 */
function deriveEndpoints(baseUrl: string, protocol: McpProtocol): {
    sseUrl: string;
    postUrl: string;
} {
    const cleanUrl = baseUrl.replace(/\/$/, "");

    if (protocol === "sse") {
        // SSE protocol: EventSource on /sse, POST to /message
        const sseUrl = cleanUrl.endsWith("/sse") ? cleanUrl : `${cleanUrl}/sse`;
        // Message endpoint is a sibling of /sse → replace /sse with /message
        const postUrl = sseUrl.replace(/\/sse$/, "/message");
        return { sseUrl, postUrl };
    }

    // Streamable HTTP protocol: POST directly to the URL
    const postUrl = cleanUrl.endsWith("/mcp") ? cleanUrl : `${cleanUrl}/mcp`;
    return { sseUrl: postUrl, postUrl };
}

export class HttpSseClientTransport implements Transport {
    private baseUrl: string;
    private protocol: McpProtocol;
    private sseUrl: string;
    private postUrl: string;
    private eventSource: EventSource | null = null;
    private reconnectInterval: number;
    private maxReconnectAttempts: number;
    private reconnectAttempts = 0;
    private pendingRequests = new Map<string | number, {
        resolve: (value: JSONRPCMessage) => void;
        reject: (reason: any) => void;
    }>();
    private messageHandler: ((message: JSONRPCMessage) => void) | null = null;
    private closeHandler: (() => void) | null = null;
    private errorHandler: ((error: Error) => void) | null = null;
    /** For Streamable HTTP: the session URL returned by the server in its response */
    private sessionUrl: string | null = null;

    constructor(options: HttpSseOptions) {
        this.baseUrl = options.baseUrl.replace(/\/$/, "");
        this.reconnectInterval = options.reconnectInterval || 1000;
        this.maxReconnectAttempts = options.maxReconnectAttempts || 5;

        // Determine protocol
        this.protocol = options.protocol || detectProtocol(this.baseUrl) || "sse";

        // Derive endpoints
        const { sseUrl, postUrl } = deriveEndpoints(this.baseUrl, this.protocol);
        this.sseUrl = sseUrl;
        this.postUrl = postUrl;

        console.log(`[HttpSseTransport] Protocol: ${this.protocol}, SSE: ${this.sseUrl}, POST: ${this.postUrl}`);
    }

    async start(): Promise<void> {
        if (this.protocol === "streamable-http") {
            // Streamable HTTP doesn't require an initial SSE connection
            // Just verify the endpoint is reachable
            await this.verifyStreamableEndpoint();
        } else {
            await this.connectSSE();
        }
    }

    /**
     * Verify that the Streamable HTTP endpoint is reachable.
     * Some servers support both GET (for SSE notifications) and POST (for requests).
     */
    private async verifyStreamableEndpoint(): Promise<void> {
        console.log(`[HttpSseTransport] Verifying Streamable HTTP endpoint: ${this.postUrl}`);
        try {
            // Try OPTIONS or a simple GET to check connectivity
            const response = await fetch(this.postUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json, text/event-stream",
                },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    method: "initialize",
                    params: {
                        protocolVersion: "2025-03-26",
                        capabilities: {},
                        clientInfo: { name: "compose-mcp-runtime", version: "1.0.0" },
                    },
                    id: 0,
                }),
            });

            if (!response.ok) {
                // If Streamable HTTP fails, fall back to SSE
                console.log(`[HttpSseTransport] Streamable HTTP returned ${response.status}, falling back to SSE`);
                this.protocol = "sse";
                const { sseUrl, postUrl } = deriveEndpoints(this.baseUrl, "sse");
                this.sseUrl = sseUrl;
                this.postUrl = postUrl;
                await this.connectSSE();
                return;
            }

            // Check for session URL in response headers
            const sessionEndpoint = response.headers.get("mcp-session-id");
            if (sessionEndpoint) {
                this.sessionUrl = sessionEndpoint;
            }

            console.log(`[HttpSseTransport] Streamable HTTP endpoint verified`);
        } catch (error) {
            // Network error — fall back to SSE
            console.log(`[HttpSseTransport] Streamable HTTP failed, falling back to SSE:`, error);
            this.protocol = "sse";
            const { sseUrl, postUrl } = deriveEndpoints(this.baseUrl, "sse");
            this.sseUrl = sseUrl;
            this.postUrl = postUrl;
            await this.connectSSE();
        }
    }

    private async connectSSE(): Promise<void> {
        console.log(`[HttpSseTransport] Connecting SSE to ${this.sseUrl}`);

        return new Promise((resolve, reject) => {
            try {
                this.eventSource = new EventSource(this.sseUrl);

                this.eventSource.onopen = () => {
                    console.log(`[HttpSseTransport] SSE connected`);
                    this.reconnectAttempts = 0;
                    resolve();
                };

                this.eventSource.onerror = (error) => {
                    console.error(`[HttpSseTransport] SSE error:`, error);

                    if (this.reconnectAttempts < this.maxReconnectAttempts) {
                        this.reconnectAttempts++;
                        console.log(`[HttpSseTransport] Reconnecting (attempt ${this.reconnectAttempts})...`);

                        setTimeout(() => {
                            this.connectSSE().catch(err => {
                                if (this.errorHandler) {
                                    this.errorHandler(err);
                                }
                            });
                        }, this.reconnectInterval * this.reconnectAttempts);
                    } else {
                        const err = new Error("Max reconnection attempts reached");
                        if (this.errorHandler) {
                            this.errorHandler(err);
                        }
                        reject(err);
                    }
                };

                // Listen for the 'endpoint' event (SSE protocol sends POST endpoint via event)
                this.eventSource.addEventListener("endpoint", (event: any) => {
                    const endpoint = event.data;
                    if (endpoint) {
                        // Server told us where to POST messages
                        const resolved = new URL(endpoint, this.baseUrl).href;
                        console.log(`[HttpSseTransport] Server endpoint: ${resolved}`);
                        this.postUrl = resolved;
                    }
                });

                this.eventSource.onmessage = (event) => {
                    try {
                        const message: JSONRPCMessage = JSON.parse(event.data);

                        // Handle JSON-RPC responses
                        if ("id" in message && message.id !== undefined) {
                            const pending = this.pendingRequests.get(message.id);
                            if (pending) {
                                pending.resolve(message);
                                this.pendingRequests.delete(message.id);
                                return;
                            }
                        }

                        // Handle notifications and other messages
                        if (this.messageHandler) {
                            this.messageHandler(message);
                        }
                    } catch (error) {
                        console.error(`[HttpSseTransport] Failed to parse message:`, error);
                    }
                };

            } catch (error) {
                reject(error);
            }
        });
    }

    async send(message: JSONRPCMessage): Promise<void> {
        if (this.protocol === "streamable-http") {
            return this.sendStreamableHttp(message);
        }
        return this.sendSSE(message);
    }

    /**
     * Send via SSE protocol: POST to the message endpoint, wait for response via EventSource
     */
    private async sendSSE(message: JSONRPCMessage): Promise<void> {
        console.log(`[HttpSseTransport] SSE POST to ${this.postUrl}:`, JSON.stringify(message).slice(0, 200));

        const response = await fetch(this.postUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(message),
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        // For requests with IDs, wait for response via EventSource
        if ("id" in message && message.id !== undefined) {
            return new Promise((resolve, reject) => {
                this.pendingRequests.set(message.id!, { resolve: resolve as any, reject });
                setTimeout(() => {
                    if (this.pendingRequests.has(message.id!)) {
                        this.pendingRequests.delete(message.id!);
                        reject(new Error("Request timeout"));
                    }
                }, 30000);
            }) as any;
        }
    }

    /**
     * Send via Streamable HTTP protocol: POST directly, parse response body
     */
    private async sendStreamableHttp(message: JSONRPCMessage): Promise<void> {
        console.log(`[HttpSseTransport] Streamable POST to ${this.postUrl}:`, JSON.stringify(message).slice(0, 200));

        const response = await fetch(this.postUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                ...(this.sessionUrl ? { "mcp-session-id": this.sessionUrl } : {}),
            },
            body: JSON.stringify(message),
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        // Check for session ID in response
        const sessionId = response.headers.get("mcp-session-id");
        if (sessionId) {
            this.sessionUrl = sessionId;
        }

        const contentType = response.headers.get("content-type") || "";

        if (contentType.includes("text/event-stream")) {
            // Server is streaming SSE responses
            const text = await response.text();
            const lines = text.split("\n");
            for (const line of lines) {
                if (line.startsWith("data: ")) {
                    try {
                        const data: JSONRPCMessage = JSON.parse(line.slice(6));
                        if ("id" in data && data.id !== undefined) {
                            const pending = this.pendingRequests.get(data.id);
                            if (pending) {
                                pending.resolve(data);
                                this.pendingRequests.delete(data.id);
                            }
                        }
                        if (this.messageHandler) {
                            this.messageHandler(data);
                        }
                    } catch {
                        // Skip unparseable lines
                    }
                }
            }
        } else {
            // JSON response
            const data: JSONRPCMessage = await response.json();

            if ("id" in message && message.id !== undefined) {
                // Direct response — resolve immediately
                const pending = this.pendingRequests.get(message.id);
                if (pending) {
                    pending.resolve(data);
                    this.pendingRequests.delete(message.id);
                } else if (this.messageHandler) {
                    this.messageHandler(data);
                }
            } else if (this.messageHandler) {
                this.messageHandler(data);
            }
        }

        // For requests with IDs that were not resolved yet (should be resolved above)
        if ("id" in message && message.id !== undefined && this.pendingRequests.has(message.id)) {
            return new Promise((resolve, reject) => {
                // Already registered, just add timeout
                setTimeout(() => {
                    if (this.pendingRequests.has(message.id!)) {
                        this.pendingRequests.delete(message.id!);
                        reject(new Error("Request timeout"));
                    }
                }, 30000);
            }) as any;
        }
    }

    async close(): Promise<void> {
        console.log(`[HttpSseTransport] Closing connection`);

        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }

        // Reject all pending requests
        for (const [id, pending] of this.pendingRequests) {
            pending.reject(new Error("Connection closed"));
        }
        this.pendingRequests.clear();

        if (this.closeHandler) {
            this.closeHandler();
        }
    }

    set onclose(handler: () => void) {
        this.closeHandler = handler;
    }

    set onerror(handler: (error: Error) => void) {
        this.errorHandler = handler;
    }

    set onmessage(handler: (message: JSONRPCMessage) => void) {
        this.messageHandler = handler;
    }
}
