/**
 * Enhanced Checkpoint Saver with Recovery (Feb 2026)
 * 
 * Modern features:
 * - Automatic state recovery from interruptions
 * - Graceful degradation on checkpoint corruption
 * - Health monitoring and metrics
 * - Support for long-running autonomous agents
 */

import fs from "fs";
import path from "path";
import { BaseCheckpointSaver, type Checkpoint, type CheckpointMetadata, type CheckpointTuple, type CheckpointListOptions } from "@langchain/langgraph-checkpoint";

// Checkpoint health configuration
const CHECKPOINT_MAX_AGE_MS = parseInt(process.env.CHECKPOINT_MAX_AGE_MS || "86400000", 10); // 24 hours
const CHECKPOINT_RETENTION_COUNT = parseInt(process.env.CHECKPOINT_RETENTION_COUNT || "50", 10);

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
                .filter(f => f.endsWith(".bin") || f.endsWith(".json"))  // Support both formats
                .map(f => f.replace(/\.(bin|json)$/, ""))  // Extract checkpoint ID
                .filter((v, i, a) => a.indexOf(v) === i)  // Dedupe
                .sort((a, b) => b.localeCompare(a)); // Descending order (newest first)

            let count = 0;
            for (const checkpointId of files) {

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

        const filePath = path.join(threadDir, `${checkpointId}.bin`);
        const typeFilePath = path.join(threadDir, `${checkpointId}.type`);
        const data = {
            config,
            checkpoint,
            metadata,
        };

        // Use LangChain serde to properly serialize messages (including ChatMessageChunk)
        const [type, bytes] = await this.serde.dumpsTyped(data);
        fs.writeFileSync(filePath, Buffer.from(bytes));
        fs.writeFileSync(typeFilePath, type);

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
        // Try new binary format first, fall back to legacy JSON
        const binFilePath = path.join(this.dataDir, threadId, `${checkpointId}.bin`);
        const typeFilePath = path.join(this.dataDir, threadId, `${checkpointId}.type`);
        const jsonFilePath = path.join(this.dataDir, threadId, `${checkpointId}.json`);

        try {
            if (fs.existsSync(binFilePath) && fs.existsSync(typeFilePath)) {
                // New serde format
                const bytes = fs.readFileSync(binFilePath);
                const type = fs.readFileSync(typeFilePath, "utf-8");
                const data = await this.serde.loadsTyped(type, bytes);

                return {
                    config: data.config,
                    checkpoint: data.checkpoint,
                    metadata: data.metadata,
                    parentConfig: data.config
                };
            } else if (fs.existsSync(jsonFilePath)) {
                // Legacy JSON format - read but will be upgraded on next save
                const content = fs.readFileSync(jsonFilePath, "utf-8");
                const data = JSON.parse(content);

                return {
                    config: data.config,
                    checkpoint: data.checkpoint,
                    metadata: data.metadata,
                    parentConfig: data.config
                };
            }
            return undefined;
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
            .filter(f => f.endsWith(".bin") || f.endsWith(".json"))  // Support both formats
            .map(f => f.replace(/\.(bin|json)$/, ""))  // Extract checkpoint ID
            .filter((v, i, a) => a.indexOf(v) === i)  // Dedupe
            .sort((a, b) => b.localeCompare(a)); // Descending

        if (files.length === 0) return undefined;

        return files[0];
    }

    /**
     * Health check: Verify checkpoint integrity and age
     * Returns health status with recovery recommendations
     */
    async healthCheck(threadId: string): Promise<{
        healthy: boolean;
        lastCheckpointAge?: number;
        checkpointCount: number;
        canRecover: boolean;
        recommendation?: string;
    }> {
        const threadDir = path.join(this.dataDir, threadId);
        
        if (!fs.existsSync(threadDir)) {
            return { healthy: true, checkpointCount: 0, canRecover: false };
        }

        try {
            const files = fs.readdirSync(threadDir)
                .filter(f => f.endsWith(".bin") || f.endsWith(".json"));
            
            const checkpointCount = files.length / 2; // .bin and .type files per checkpoint
            
            if (checkpointCount === 0) {
                return { healthy: true, checkpointCount: 0, canRecover: false };
            }

            const latestId = await this.getLatestCheckpointId(threadId);
            if (!latestId) {
                return { 
                    healthy: false, 
                    checkpointCount, 
                    canRecover: false,
                    recommendation: "No valid checkpoints found"
                };
            }

            // Check age of latest checkpoint
            const latestFile = path.join(threadDir, `${latestId}.bin`);
            const stats = fs.statSync(latestFile);
            const age = Date.now() - stats.mtimeMs;

            const healthy = age < CHECKPOINT_MAX_AGE_MS && checkpointCount > 0;
            
            return {
                healthy,
                lastCheckpointAge: age,
                checkpointCount,
                canRecover: checkpointCount > 0,
                recommendation: healthy ? undefined : 
                    age >= CHECKPOINT_MAX_AGE_MS 
                        ? "Checkpoint is stale, consider restarting conversation"
                        : "Low checkpoint count, recovery may be limited"
            };
        } catch (error) {
            console.error(`[Checkpoint] Health check failed for ${threadId}:`, error);
            return { 
                healthy: false, 
                checkpointCount: 0, 
                canRecover: false,
                recommendation: "Checkpoint directory corrupt or inaccessible"
            };
        }
    }

    /**
     * Cleanup old checkpoints to prevent disk bloat
     * Keeps only the most recent N checkpoints per thread
     */
    async cleanup(threadId: string, keepCount: number = CHECKPOINT_RETENTION_COUNT): Promise<number> {
        const threadDir = path.join(this.dataDir, threadId);
        if (!fs.existsSync(threadDir)) return 0;

        try {
            const files = fs.readdirSync(threadDir)
                .filter(f => f.endsWith(".bin"))
                .map(f => f.replace(/\.bin$/, ""))
                .sort((a, b) => b.localeCompare(a)); // Newest first

            if (files.length <= keepCount) return 0;

            let deleted = 0;
            for (const checkpointId of files.slice(keepCount)) {
                try {
                    fs.unlinkSync(path.join(threadDir, `${checkpointId}.bin`));
                    fs.unlinkSync(path.join(threadDir, `${checkpointId}.type`));
                    deleted++;
                } catch (e) {
                    console.warn(`[Checkpoint] Failed to delete old checkpoint ${checkpointId}:`, e);
                }
            }

            if (deleted > 0) {
                console.log(`[Checkpoint] Cleaned up ${deleted} old checkpoints for ${threadId}`);
            }

            return deleted;
        } catch (error) {
            console.error(`[Checkpoint] Cleanup failed for ${threadId}:`, error);
            return 0;
        }
    }

    /**
     * Recover state from last known good checkpoint
     * Useful after crashes or timeouts
     */
    async recover(threadId: string): Promise<{
        success: boolean;
        checkpoint?: CheckpointTuple;
        message: string;
    }> {
        try {
            const health = await this.healthCheck(threadId);
            
            if (!health.canRecover) {
                return { success: false, message: "No checkpoints available for recovery" };
            }

            // Try to get latest checkpoint
            const checkpoint = await this.getTuple({ configurable: { thread_id: threadId } });
            
            if (!checkpoint) {
                return { success: false, message: "Could not load latest checkpoint" };
            }

            // Validate checkpoint has messages
            const rawMessages = checkpoint.checkpoint?.channel_values?.messages;
            const messages = Array.isArray(rawMessages) ? rawMessages : [];
            if (messages.length === 0) {
                return { 
                    success: true, 
                    checkpoint,
                    message: "Recovered checkpoint but no message history found" 
                };
            }

            // Clean up old checkpoints after successful recovery
            await this.cleanup(threadId);

            return {
                success: true,
                checkpoint,
                message: `Recovered ${messages.length} messages from checkpoint`
            };
        } catch (error) {
            console.error(`[Checkpoint] Recovery failed for ${threadId}:`, error);
            return { 
                success: false, 
                message: `Recovery error: ${error instanceof Error ? error.message : String(error)}` 
            };
        }
    }
}
