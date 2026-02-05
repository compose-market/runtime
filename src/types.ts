/**
 * Compose Runtime - Unified Types
 * 
 * Shared type definitions for all runtime sources (GOAT, MCP, Eliza)
 */

// Runtime sources
export type RuntimeSource = 'goat' | 'mcp' | 'eliza';

// Unified tool interface
export interface ComposeTool {
    name: string;
    description: string;
    source: RuntimeSource;
    inputSchema: Record<string, unknown>;
    execute: (args: Record<string, unknown>) => Promise<any>;
}

// Plugin/Server configuration
export interface PluginConfig {
    id: string;
    source: RuntimeSource;
    name: string;
    description: string;
}

// Registry server (replaces scattered MCP references)
export interface RegistryServer {
    registryId: string;  // "goat:coingecko", "mcp:github", "eliza:twitter"
    slug: string;
    name: string;
    description: string;
    source: RuntimeSource;
    category?: string;
    url?: string;
}
