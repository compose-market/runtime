/**
 * HTTP/SSE Client Transport for MCP
 * 
 * Implements MCP SDK transport interface for remote servers that expose HTTP/SSE endpoints.
 * Supports both Server-Sent Events (SSE) and Streamable HTTP protocols.
 * 
 * Used for:
 * - Servers with `remotes[]` in registry (e.g., exa.ai, cirra.ai)
 * - Containerized servers exposed via supergateway
 */
import { EventSource } from "eventsource";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

interface HttpSseOptions {
    baseUrl: string;
    reconnectInterval?: number;
    maxReconnectAttempts?: number;
}

export class HttpSseClientTransport implements Transport {
    private baseUrl: string;
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

    constructor(options: HttpSseOptions) {
        this.baseUrl = options.baseUrl.replace(/\/$/, ""); // Remove trailing slash
        this.reconnectInterval = options.reconnectInterval || 1000;
        this.maxReconnectAttempts = options.maxReconnectAttempts || 5;
    }

    async start(): Promise<void> {
        return this.connect();
    }

    async connect(): Promise<void> {
        console.log(`[HttpSseTransport] Connecting to ${this.baseUrl}/sse`);

        return new Promise((resolve, reject) => {
            try {
                this.eventSource = new EventSource(`${this.baseUrl}/sse`);

                this.eventSource.onopen = () => {
                    console.log(`[HttpSseTransport] Connected`);
                    this.reconnectAttempts = 0;
                    resolve();
                };

                this.eventSource.onerror = (error) => {
                    console.error(`[HttpSseTransport] SSE error:`, error);

                    if (this.reconnectAttempts < this.maxReconnectAttempts) {
                        this.reconnectAttempts++;
                        console.log(`[HttpSseTransport] Reconnecting (attempt ${this.reconnectAttempts})...`);

                        setTimeout(() => {
                            this.connect().catch(err => {
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
        console.log(`[HttpSseTransport] Sending:`, message);

        // Try /mcp first (standard MCP endpoint), then / (some servers use root)
        const endpoints = [`${this.baseUrl}/mcp`, `${this.baseUrl}/`];
        let lastError: Error | null = null;

        for (const endpoint of endpoints) {
            try {
                const response = await fetch(endpoint, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(message),
                });

                if (response.ok) {
                    // Success - handle response for requests with IDs
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
                    return;
                }
                lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
            } catch (err) {
                lastError = err as Error;
            }
        }

        throw lastError || new Error("All endpoints failed");
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
