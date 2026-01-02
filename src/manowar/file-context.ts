/**
 * File-Based Context Manager
 * 
 * Implements file-based context management for token optimization.
 * 
 * Key Features:
 * - Externalize large observations to files
 * - Store only references in LLM context
 * - Support for todo.md pattern to guide attention
 * - Automatic cleanup of stale context files
 * 
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as crypto from "crypto";

// =============================================================================
// Types
// =============================================================================

/**
 * Context file metadata
 */
export interface ContextFile {
    /** Unique file ID */
    fileId: string;
    /** Original content type */
    type: "observation" | "tool_output" | "agent_response" | "attachment" | "plan" | "todo";
    /** File path relative to context directory */
    relativePath: string;
    /** Absolute file path */
    absolutePath: string;
    /** Content hash for deduplication */
    contentHash: string;
    /** Size in bytes */
    sizeBytes: number;
    /** Token estimate (chars / 4) */
    estimatedTokens: number;
    /** Creation timestamp */
    createdAt: number;
    /** Last access timestamp */
    lastAccessed: number;
    /** Summary for LLM context (max 200 chars) */
    summary: string;
    /** Associated workflow ID */
    workflowId: string;
    /** Associated run ID */
    runId: string;
}

/**
 * Context reference for LLM (minimal token footprint)
 */
export interface ContextReference {
    /** File ID for retrieval */
    fileId: string;
    /** Content type */
    type: ContextFile["type"];
    /** Brief summary */
    summary: string;
    /** Whether content is critical (should be fetched before processing) */
    critical: boolean;
}

/**
 * Todo item for attention steering
 */
export interface TodoItem {
    /** Item number */
    number: number;
    /** Task description */
    task: string;
    /** Status */
    status: "pending" | "in_progress" | "completed" | "blocked";
    /** Associated step number (if any) */
    stepNumber?: number;
    /** Notes */
    notes?: string;
}

// =============================================================================
// Configuration
// =============================================================================

const CONTEXT_DIR = process.env.MANOWAR_CONTEXT_DIR || "/tmp/manowar-context";
const MAX_INLINE_TOKENS = 500; // Content larger than this goes to file
const STALE_FILE_TTL_MS = 3600000; // 1 hour
const MAX_SUMMARY_LENGTH = 200;

// =============================================================================
// File Context Manager
// =============================================================================

export class FileContextManager {
    private workflowId: string;
    private runId: string;
    private contextDir: string;
    private files: Map<string, ContextFile> = new Map();
    private todoItems: TodoItem[] = [];
    private initialized: boolean = false;

    constructor(workflowId: string, runId: string) {
        this.workflowId = workflowId;
        this.runId = runId;
        this.contextDir = path.join(CONTEXT_DIR, workflowId, runId);
    }

    /**
     * Initialize the context directory
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;

        try {
            await fs.mkdir(this.contextDir, { recursive: true });
            this.initialized = true;
            console.log(`[file-context] Initialized context directory: ${this.contextDir}`);
        } catch (err) {
            console.error(`[file-context] Failed to initialize:`, err);
            // Continue without file context - will inline everything
        }
    }

    /**
     * Externalize content to a file if it exceeds token threshold
     * Returns a reference if externalized, or null if content should be inlined
     */
    async externalize(
        content: string,
        type: ContextFile["type"],
        summary?: string
    ): Promise<ContextReference | null> {
        await this.initialize();

        const estimatedTokens = Math.ceil(content.length / 4);

        // Small content stays inline
        if (estimatedTokens <= MAX_INLINE_TOKENS) {
            return null;
        }

        // Generate file metadata
        const contentHash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
        const fileId = `${type}-${Date.now()}-${contentHash}`;
        const fileName = `${fileId}.txt`;
        const absolutePath = path.join(this.contextDir, fileName);

        // Check for duplicate content
        const existingFile = Array.from(this.files.values()).find(f => f.contentHash === contentHash);
        if (existingFile) {
            existingFile.lastAccessed = Date.now();
            return {
                fileId: existingFile.fileId,
                type: existingFile.type,
                summary: existingFile.summary,
                critical: type === "plan" || type === "todo",
            };
        }

        // Write file
        try {
            await fs.writeFile(absolutePath, content, "utf-8");
        } catch (err) {
            console.error(`[file-context] Failed to write file:`, err);
            return null; // Fall back to inline
        }

        // Create metadata
        const autoSummary = summary || this.generateSummary(content, type);
        const contextFile: ContextFile = {
            fileId,
            type,
            relativePath: fileName,
            absolutePath,
            contentHash,
            sizeBytes: Buffer.byteLength(content),
            estimatedTokens,
            createdAt: Date.now(),
            lastAccessed: Date.now(),
            summary: autoSummary,
            workflowId: this.workflowId,
            runId: this.runId,
        };

        this.files.set(fileId, contextFile);
        console.log(`[file-context] Externalized ${type}: ${estimatedTokens} tokens → ${fileId}`);

        return {
            fileId,
            type,
            summary: autoSummary,
            critical: type === "plan" || type === "todo",
        };
    }

    /**
     * Generate a concise summary for the content
     */
    private generateSummary(content: string, type: ContextFile["type"]): string {
        let summary: string;

        switch (type) {
            case "tool_output":
                // Try to extract tool name and result type
                const toolMatch = content.match(/"?tool"?\s*:\s*"?([^"\n,]+)"?/i);
                const successMatch = content.match(/"?success"?\s*:\s*(true|false)/i);
                summary = toolMatch
                    ? `Tool ${toolMatch[1]} result${successMatch ? ` (${successMatch[1]})` : ""}`
                    : "Tool execution result";
                break;

            case "agent_response":
                // First sentence or first N characters
                const firstSentence = content.match(/^[^.!?]+[.!?]/);
                summary = firstSentence?.[0] || content.slice(0, MAX_SUMMARY_LENGTH);
                break;

            case "observation":
                summary = `Observation: ${content.slice(0, MAX_SUMMARY_LENGTH - 13)}`;
                break;

            case "attachment":
                const urlMatch = content.match(/https?:\/\/[^\s"]+/);
                summary = urlMatch ? `Attachment at ${urlMatch[0].slice(0, 50)}...` : "File attachment";
                break;

            case "plan":
                const stepCount = (content.match(/stepNumber/g) || []).length;
                summary = `Execution plan with ${stepCount} steps`;
                break;

            case "todo":
                const todoCount = (content.match(/^\d+\./gm) || []).length;
                summary = `Todo list with ${todoCount} items`;
                break;

            default:
                summary = content.slice(0, MAX_SUMMARY_LENGTH);
        }

        return summary.slice(0, MAX_SUMMARY_LENGTH);
    }

    /**
     * Retrieve file content by ID
     */
    async retrieve(fileId: string): Promise<string | null> {
        const file = this.files.get(fileId);
        if (!file) {
            console.warn(`[file-context] File not found: ${fileId}`);
            return null;
        }

        try {
            const content = await fs.readFile(file.absolutePath, "utf-8");
            file.lastAccessed = Date.now();
            return content;
        } catch (err) {
            console.error(`[file-context] Failed to read file ${fileId}:`, err);
            return null;
        }
    }

    /**
     * Update the todo.md file for attention steering
     * This is the Manus pattern for guiding model focus
     */
    async updateTodo(items: TodoItem[]): Promise<ContextReference> {
        this.todoItems = items;

        const todoContent = `# Workflow Todo

## Current Status
${items.filter(i => i.status === "in_progress").map(i => `- [ACTIVE] ${i.task}`).join("\n") || "No active tasks"}

## Pending
${items.filter(i => i.status === "pending").map(i => `${i.number}. ${i.task}`).join("\n") || "None"}

## Completed
${items.filter(i => i.status === "completed").map(i => `- ✓ ${i.task}`).join("\n") || "None"}

---
*Updated: ${new Date().toISOString()}*
`;

        const ref = await this.externalize(todoContent, "todo", `${items.length} todo items`);

        // Todo should always have a reference
        if (!ref) {
            return {
                fileId: "todo-inline",
                type: "todo",
                summary: `${items.length} todo items (inline)`,
                critical: true,
            };
        }

        return ref;
    }

    /**
     * Get current todo items
     */
    getTodoItems(): TodoItem[] {
        return [...this.todoItems];
    }

    /**
     * Mark a todo item as completed
     */
    markTodoComplete(number: number, notes?: string): void {
        const item = this.todoItems.find(i => i.number === number);
        if (item) {
            item.status = "completed";
            if (notes) item.notes = notes;
        }
    }

    /**
     * Get all context references for inclusion in system prompt
     * This provides a token-efficient manifest of available context
     */
    getContextManifest(): ContextReference[] {
        return Array.from(this.files.values())
            .sort((a, b) => b.lastAccessed - a.lastAccessed)
            .slice(0, 10) // Only show most recent 10
            .map(f => ({
                fileId: f.fileId,
                type: f.type,
                summary: f.summary,
                critical: f.type === "plan" || f.type === "todo",
            }));
    }

    /**
     * Build context manifest string for system prompt
     * Optimized for minimal token usage
     */
    buildContextManifestPrompt(): string {
        const manifest = this.getContextManifest();
        if (manifest.length === 0) return "";

        return `## AVAILABLE CONTEXT FILES
${manifest.map(m => `- [${m.type}] ${m.summary} (${m.fileId})`).join("\n")}

To access file content, use the retrieve_context tool with the file ID.`;
    }

    /**
     * Clean up stale context files
     */
    async cleanup(): Promise<number> {
        const now = Date.now();
        let cleaned = 0;

        for (const [fileId, file] of this.files) {
            if (now - file.lastAccessed > STALE_FILE_TTL_MS) {
                try {
                    await fs.unlink(file.absolutePath);
                    this.files.delete(fileId);
                    cleaned++;
                } catch {
                    // File may already be deleted
                }
            }
        }

        if (cleaned > 0) {
            console.log(`[file-context] Cleaned ${cleaned} stale context files`);
        }

        return cleaned;
    }

    /**
     * Get total token savings from externalization
     */
    getTokenSavings(): { totalExternalized: number; filesCount: number } {
        let totalExternalized = 0;
        for (const file of this.files.values()) {
            // Each externalized file replaced with ~20 token reference
            totalExternalized += file.estimatedTokens - 20;
        }
        return {
            totalExternalized: Math.max(0, totalExternalized),
            filesCount: this.files.size,
        };
    }
}

// =============================================================================
// Singleton Manager
// =============================================================================

const contextManagers = new Map<string, FileContextManager>();

/**
 * Get or create a context manager for a workflow run
 */
export function getContextManager(workflowId: string, runId: string): FileContextManager {
    const key = `${workflowId}:${runId}`;
    let manager = contextManagers.get(key);

    if (!manager) {
        manager = new FileContextManager(workflowId, runId);
        contextManagers.set(key, manager);
    }

    return manager;
}

/**
 * Clean up completed workflow context managers
 */
export async function cleanupContextManagers(): Promise<void> {
    for (const [key, manager] of contextManagers) {
        await manager.cleanup();
    }
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Process content for LLM context - externalize if too large
 */
export async function processForContext(
    content: string,
    type: ContextFile["type"],
    workflowId: string,
    runId: string,
    summary?: string
): Promise<{ inline: string | null; reference: ContextReference | null }> {
    const manager = getContextManager(workflowId, runId);
    const ref = await manager.externalize(content, type, summary);

    if (ref) {
        // Content was externalized - return compact reference
        return {
            inline: null,
            reference: ref,
        };
    }

    // Content stays inline
    return {
        inline: content,
        reference: null,
    };
}

/**
 * Format a context reference for inline inclusion
 */
export function formatReference(ref: ContextReference): string {
    return `[Context: ${ref.type}] ${ref.summary} (file: ${ref.fileId})`;
}
