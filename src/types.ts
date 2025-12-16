/**
 * Compose Runtime - Unified Types
 * 
 * Shared type definitions for all runtime sources (GOAT, MCP)
 */

// Runtime sources
export type RuntimeSource = 'goat' | 'mcp';

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
