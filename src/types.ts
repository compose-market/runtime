/**
 * Compose Runtime - Unified Types
 * 
 * Shared type definitions for all runtime sources.
 */

// Runtime sources
export type RuntimeSource = 'tools' | 'onchain' | 'eliza';

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

// Registry server
export interface RegistryServer {
    registryId: string;  // "tools:github", "onchain:coingecko"
    slug: string;
    name: string;
    description: string;
    source: RuntimeSource;
    category?: string;
    url?: string;
}
