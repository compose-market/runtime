/**
 * Compose Runtime - Unified Tool Runtime
 * 
 * Manages GOAT, MCP, and ElizaOS runtimes as independent subsystems.
 * Provides a single interface for loading and executing tools from multiple sources.
 */

import { GoatRuntime, type GoatRuntimeConfig } from './runtimes/goat.js';
import { McpRuntime, type McpRuntimeConfig } from './runtimes/mcp.js';
import type { ComposeTool, RuntimeSource } from './types.js';

export interface ComposeRuntimeConfig {
    goat?: GoatRuntimeConfig;
    mcp?: McpRuntimeConfig;
    eliza?: {
        // Future Eliza config
    };
}

export class ComposeRuntime {
    private goatRuntime: GoatRuntime;
    private mcpRuntime: McpRuntime;
    private initialized = false;

    constructor(config: ComposeRuntimeConfig = {}) {
        this.goatRuntime = new GoatRuntime(config.goat || {});
        this.mcpRuntime = new McpRuntime(config.mcp || {});
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;

        await Promise.all([
            this.goatRuntime.initialize(),
            this.mcpRuntime.initialize(),
        ]);

        this.initialized = true;
        console.log("[Compose Runtime] Initialized successfully");
    }

    /**
     * Load tools from multiple sources
     * @param plugins Object mapping runtime sources to plugin IDs
     * @returns Array of unified ComposeTool instances
     */
    async loadTools(plugins: {
        goat?: string[];
        mcp?: string[];
        eliza?: string[];
    }): Promise<ComposeTool[]> {
        await this.initialize();

        const [goatTools, mcpTools] = await Promise.all([
            plugins.goat && plugins.goat.length > 0
                ? this.goatRuntime.loadTools(plugins.goat)
                : [],
            plugins.mcp && plugins.mcp.length > 0
                ? this.mcpRuntime.loadTools(plugins.mcp)
                : [],
            // Future: eliza tools
        ]);

        const allTools = [...goatTools, ...mcpTools];
        console.log(
            `[Compose Runtime] Loaded ${allTools.length} tools total ` +
            `(${goatTools.length} GOAT, ${mcpTools.length} MCP)`
        );

        return allTools;
    }

    /**
     * Get runtime statistics
     */
    getStats(): {
        initialized: boolean;
        runtimes: {
            goat: boolean;
            mcp: boolean;
            eliza: boolean;
        };
    } {
        return {
            initialized: this.initialized,
            runtimes: {
                goat: true,
                mcp: true,
                eliza: false, // Not implemented yet
            },
        };
    }

    /**
     * Cleanup all runtimes
     */
    async cleanup(): Promise<void> {
        await Promise.all([
            this.goatRuntime.cleanup(),
            this.mcpRuntime.cleanup(),
        ]);
        this.initialized = false;
        console.log("[Compose Runtime] Cleaned up all runtimes");
    }
}

// Re-export types
export * from './types.js';
export type { GoatRuntimeConfig, McpRuntimeConfig };
