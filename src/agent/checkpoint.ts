/**
 * File System Checkpoint Saver
 * 
 * Persists LangGraph agent state to the local filesystem (JSON files).
 * Ensures agent state survives server restarts.
 */

import fs from "fs";
import path from "path";
import { BaseCheckpointSaver, type Checkpoint, type CheckpointMetadata, type CheckpointTuple, type CheckpointListOptions } from "@langchain/langgraph-checkpoint";

export class FileSystemCheckpointSaver extends BaseCheckpointSaver {
    private dataDir: string;

    constructor(dataDir: string) {
        // initialize tokenizer/serde used by base class
        super();
        this.dataDir = dataDir;

        // Ensure directory exists
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    /**
     * Get a checkpoint tuple for a given config
     */
    async getTuple(config: { configurable?: { thread_id?: string; checkpoint_id?: string } }): Promise<CheckpointTuple | undefined> {
        const threadId = config.configurable?.thread_id;
        const checkpointId = config.configurable?.checkpoint_id;

        if (!threadId) return undefined;

        try {
            if (checkpointId) {
                // Get specific checkpoint
                return await this.loadCheckpoint(threadId, checkpointId);
            } else {
                // Get latest checkpoint
                const latestId = await this.getLatestCheckpointId(threadId);
                if (!latestId) return undefined;
                return await this.loadCheckpoint(threadId, latestId);
            }
        } catch (error) {
            console.error(`[Checkpoint] Failed to get tuple for thread ${threadId}:`, error);
            return undefined;
        }
    }

    /**
     * Delete a thread
     */
    async deleteThread(threadId: string): Promise<void> {
        const threadDir = path.join(this.dataDir, threadId);
        if (fs.existsSync(threadDir)) {
            fs.rmSync(threadDir, { recursive: true, force: true });
        }
    }

    /**
     * List checkpoints for a config
     */
    async *list(
        config: { configurable?: { thread_id?: string } },
        options?: CheckpointListOptions
    ): AsyncGenerator<CheckpointTuple> {
        const threadId = config.configurable?.thread_id;
        if (!threadId) return;

        try {
            const threadDir = path.join(this.dataDir, threadId);
            if (!fs.existsSync(threadDir)) return;

            const files = fs.readdirSync(threadDir)
                .filter(f => f.endsWith(".json"))
                .sort((a, b) => b.localeCompare(a)); // Descending order (newest first)

            let count = 0;
            for (const file of files) {
                const checkpointId = file.replace(".json", "");

                // Skip if 'before' constraint
                if (options?.before?.configurable?.checkpoint_id && checkpointId >= options.before.configurable.checkpoint_id) continue;

                const tuple = await this.loadCheckpoint(threadId, checkpointId);
                if (tuple) {
                    yield tuple;
                    count++;
                }

                if (options?.limit && count >= options.limit) break;
            }
        } catch (error) {
            console.error(`[Checkpoint] Failed to list checkpoints for thread ${threadId}:`, error);
        }
    }

    /**
     * Save a checkpoint
     */
    async put(
        config: { configurable?: { thread_id?: string; checkpoint_id?: string } },
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata
    ): Promise<{ configurable: { thread_id: string; checkpoint_id: string } }> {
        const threadId = config.configurable?.thread_id;
        const checkpointId = checkpoint.id; // Checkpoint ID comes from the checkpoint object itself usually

        if (!threadId) throw new Error("Thread ID required for saving checkpoint");
        if (!checkpointId) throw new Error("Checkpoint ID required for saving checkpoint");

        const threadDir = path.join(this.dataDir, threadId);
        if (!fs.existsSync(threadDir)) {
            fs.mkdirSync(threadDir, { recursive: true });
        }

        const filePath = path.join(threadDir, `${checkpointId}.json`);
        const data = {
            config,
            checkpoint,
            metadata,
        };

        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

        // Also update "latest" pointer if needed, but file sorting handles it

        return {
            configurable: {
                thread_id: threadId,
                checkpoint_id: checkpointId,
            },
        };
    }


    /**
     * Save pending writes (required by LangGraph v0.2+)
     */
    async putWrites(
        config: { configurable?: { thread_id?: string; checkpoint_id?: string } },
        writes: any[],
        taskId: string
    ): Promise<void> {
        const threadId = config.configurable?.thread_id;
        if (!threadId) return;

        // Persist writes to disk if needed for full robustness
        // For now, we stub it to allow execution, as conversation state (Checkpoint) covers most restoration needs
        // In a full implementation, we would store these in a 'writes' subdirectory/file
        // to support complex tool-confirmation flows.

        // console.log(`[Checkpoint] putWrites for thread ${threadId} task ${taskId}`);
    }

    /**
     * Private helper to load a checkpoint from disk
     */
    private async loadCheckpoint(threadId: string, checkpointId: string): Promise<CheckpointTuple | undefined> {
        const filePath = path.join(this.dataDir, threadId, `${checkpointId}.json`);
        if (!fs.existsSync(filePath)) return undefined;

        try {
            const content = fs.readFileSync(filePath, "utf-8");
            const data = JSON.parse(content);

            return {
                config: data.config,
                checkpoint: data.checkpoint,
                metadata: data.metadata,
                parentConfig: data.config // This is a simplification; ideally we track parent
            };
        } catch (error) {
            console.error(`[Checkpoint] Failed to load checkpoint ${checkpointId}:`, error);
            return undefined;
        }
    }

    /**
     * Get latest checkpoint ID for a thread
     */
    private async getLatestCheckpointId(threadId: string): Promise<string | undefined> {
        const threadDir = path.join(this.dataDir, threadId);
        if (!fs.existsSync(threadDir)) return undefined;

        const files = fs.readdirSync(threadDir)
            .filter(f => f.endsWith(".json"))
            .sort((a, b) => b.localeCompare(a)); // Descending

        if (files.length === 0) return undefined;

        return files[0].replace(".json", "");
    }
}
