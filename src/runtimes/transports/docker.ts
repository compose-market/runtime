/**
 * Docker Client Transport for MCP
 * 
 * Spawns Docker containers for containerized MCP servers and delegates
 * communication to HttpSseClientTransport.
 * 
 * Features:
 * - Automatic container lifecycle management
 * - Random port allocation
 * - Health check waiting
 * - Automatic cleanup on close
 */
import Dockerode from "dockerode";
import { HttpSseClientTransport } from "./http.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

interface DockerTransportOptions {
    image: string;
    pullImage?: boolean;
    healthCheckRetries?: number;
    healthCheckInterval?: number;
}

export class DockerClientTransport implements Transport {
    private docker: Dockerode;
    private image: string;
    private container: Dockerode.Container | null = null;
    private httpTransport: HttpSseClientTransport | null = null;
    private port: number | null = null;
    private pullImage: boolean;
    private healthCheckRetries: number;
    private healthCheckInterval: number;

    constructor(options: DockerTransportOptions) {
        this.docker = new Dockerode();
        this.image = options.image;
        this.pullImage = options.pullImage !== false; // Default true
        this.healthCheckRetries = options.healthCheckRetries || 30;
        this.healthCheckInterval = options.healthCheckInterval || 1000;
    }

    async start(): Promise<void> {
        return this.connect();
    }

    async connect(): Promise<void> {
        console.log(`[DockerTransport] Starting container for image: ${this.image}`);

        try {
            // Pull image if requested
            if (this.pullImage) {
                await this.pullImageIfNeeded();
            }

            // Create and start container
            this.container = await this.docker.createContainer({
                Image: this.image,
                ExposedPorts: { "8080/tcp": {} },
                HostConfig: {
                    PublishAllPorts: true,
                    AutoRemove: false, // We'll remove manually
                },
            });

            await this.container.start();
            console.log(`[DockerTransport] Container started: ${this.container.id.substring(0, 12)}`);

            // Get allocated port
            const inspect = await this.container.inspect();
            const portBinding = inspect.NetworkSettings.Ports["8080/tcp"];

            if (!portBinding || portBinding.length === 0) {
                throw new Error("No port allocated for container");
            }

            this.port = parseInt(portBinding[0].HostPort);
            console.log(`[DockerTransport] Container port: ${this.port}`);

            // Wait for container to be healthy
            await this.waitForHealth();

            // Create HTTP transport to communicate with container
            const baseUrl = `http://localhost:${this.port}`;
            this.httpTransport = new HttpSseClientTransport({ baseUrl });

            await this.httpTransport.connect();

            console.log(`[DockerTransport] Connected to container via HTTP/SSE`);

        } catch (error) {
            // Cleanup on error
            await this.cleanup();
            throw error;
        }
    }

    private async pullImageIfNeeded(): Promise<void> {
        try {
            console.log(`[DockerTransport] Checking for image: ${this.image}`);
            await this.docker.getImage(this.image).inspect();
            console.log(`[DockerTransport] Image already present`);
        } catch {
            console.log(`[DockerTransport] Pulling image: ${this.image}`);

            const stream = await this.docker.pull(this.image);

            await new Promise((resolve, reject) => {
                this.docker.modem.followProgress(stream, (err: any, res: any) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(res);
                    }
                });
            });

            console.log(`[DockerTransport] Image pulled successfully`);
        }
    }

    private async waitForHealth(): Promise<void> {
        console.log(`[DockerTransport] Waiting for container health...`);

        const baseUrl = `http://localhost:${this.port}`;

        for (let i = 0; i < this.healthCheckRetries; i++) {
            try {
                const response = await fetch(`${baseUrl}/sse`, {
                    method: "GET",
                    headers: { "Accept": "text/event-stream" },
                    signal: AbortSignal.timeout(2000),
                });

                if (response.ok) {
                    console.log(`[DockerTransport] Container is healthy`);
                    return;
                }
            } catch (error) {
                // Retry
            }

            if (i < this.healthCheckRetries - 1) {
                await new Promise(resolve => setTimeout(resolve, this.healthCheckInterval));
            }
        }

        throw new Error("Container did not become healthy within timeout");
    }

    private async cleanup(): Promise<void> {
        if (this.httpTransport) {
            try {
                await this.httpTransport.close();
            } catch (error) {
                console.warn(`[DockerTransport] Error closing HTTP transport:`, error);
            }
            this.httpTransport = null;
        }

        if (this.container) {
            try {
                console.log(`[DockerTransport] Stopping container...`);
                await this.container.stop({ t: 5 }); // 5 second grace period
                await this.container.remove();
                console.log(`[DockerTransport] Container removed`);
            } catch (error) {
                console.warn(`[DockerTransport] Error cleaning up container:`, error);
            }
            this.container = null;
        }
    }

    async send(message: JSONRPCMessage): Promise<void> {
        if (!this.httpTransport) {
            throw new Error("Transport not connected");
        }
        return this.httpTransport.send(message);
    }

    async close(): Promise<void> {
        console.log(`[DockerTransport] Closing transport`);
        await this.cleanup();
    }

    set onclose(handler: () => void) {
        if (this.httpTransport) {
            this.httpTransport.onclose = handler;
        }
    }

    set onerror(handler: (error: Error) => void) {
        if (this.httpTransport) {
            this.httpTransport.onerror = handler;
        }
    }

    set onmessage(handler: (message: JSONRPCMessage) => void) {
        if (this.httpTransport) {
            this.httpTransport.onmessage = handler;
        }
    }
}
