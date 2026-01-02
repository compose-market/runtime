/**
 * File Context Manager Tests
 * 
 * Unit tests for the Manus-style file-based context management system.
 * Tests externalization, retrieval, todo.md pattern, and cleanup.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import {
    FileContextManager,
    getContextManager,
    processForContext,
    formatReference,
    type ContextFile,
    type ContextReference,
    type TodoItem,
} from "../file-context.js";

// Mock fs/promises
vi.mock("fs/promises", () => ({
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue("Test file content"),
    unlink: vi.fn().mockResolvedValue(undefined),
}));

describe("FileContextManager", () => {
    let manager: FileContextManager;
    const workflowId = "test-workflow";
    const runId = "run-123";

    beforeEach(() => {
        vi.clearAllMocks();
        manager = new FileContextManager(workflowId, runId);
    });

    describe("initialize", () => {
        it("should create the context directory", async () => {
            await manager.initialize();
            expect(fs.mkdir).toHaveBeenCalledWith(
                expect.stringContaining(workflowId),
                { recursive: true }
            );
        });

        it("should only initialize once", async () => {
            await manager.initialize();
            await manager.initialize();
            expect(fs.mkdir).toHaveBeenCalledTimes(1);
        });
    });

    describe("externalize", () => {
        it("should return null for small content (below threshold)", async () => {
            const smallContent = "This is a small piece of content";
            const ref = await manager.externalize(smallContent, "observation");
            expect(ref).toBeNull();
        });

        it("should externalize large content to file", async () => {
            const largeContent = "A".repeat(3000); // > 500 tokens estimated
            const ref = await manager.externalize(largeContent, "tool_output");

            expect(ref).not.toBeNull();
            expect(ref?.fileId).toMatch(/^tool_output-\d+-[a-f0-9]+$/);
            expect(ref?.type).toBe("tool_output");
            expect(fs.writeFile).toHaveBeenCalled();
        });

        it("should generate appropriate summary for content types", async () => {
            const jsonContent = '{"tool": "test_tool", "success": true, "data": "' + "A".repeat(3000) + '"}';
            const ref = await manager.externalize(jsonContent, "tool_output");

            expect(ref?.summary).toContain("Tool test_tool result");
        });

        it("should deduplicate identical content", async () => {
            const content = "A".repeat(3000);
            const ref1 = await manager.externalize(content, "observation");
            const ref2 = await manager.externalize(content, "observation");

            expect(ref1?.fileId).toBe(ref2?.fileId);
            expect(fs.writeFile).toHaveBeenCalledTimes(1);
        });

        it("should mark plan and todo as critical", async () => {
            const planContent = JSON.stringify({
                steps: [{ stepNumber: 1 }, { stepNumber: 2 }],
            }).padEnd(3000, " ");

            const ref = await manager.externalize(planContent, "plan");
            expect(ref?.critical).toBe(true);
        });
    });

    describe("retrieve", () => {
        it("should retrieve file content by ID", async () => {
            const largeContent = "A".repeat(3000);
            const ref = await manager.externalize(largeContent, "observation");

            const content = await manager.retrieve(ref!.fileId);
            expect(content).toBe("Test file content"); // From mock
            expect(fs.readFile).toHaveBeenCalled();
        });

        it("should return null for unknown file ID", async () => {
            const content = await manager.retrieve("non-existent-id");
            expect(content).toBeNull();
        });
    });

    describe("updateTodo", () => {
        it("should create todo file with items", async () => {
            const items: TodoItem[] = [
                { number: 1, task: "First task", status: "completed" },
                { number: 2, task: "Second task", status: "in_progress" },
                { number: 3, task: "Third task", status: "pending" },
            ];

            const ref = await manager.updateTodo(items);

            expect(ref.type).toBe("todo");
            expect(ref.critical).toBe(true);
        });

        it("should track todo items", async () => {
            const items: TodoItem[] = [
                { number: 1, task: "Task 1", status: "pending" },
            ];

            await manager.updateTodo(items);
            const stored = manager.getTodoItems();

            expect(stored).toHaveLength(1);
            expect(stored[0].task).toBe("Task 1");
        });
    });

    describe("markTodoComplete", () => {
        it("should mark todo item as completed", async () => {
            const items: TodoItem[] = [
                { number: 1, task: "Task 1", status: "pending" },
            ];

            await manager.updateTodo(items);
            manager.markTodoComplete(1, "Done successfully");

            const stored = manager.getTodoItems();
            expect(stored[0].status).toBe("completed");
            expect(stored[0].notes).toBe("Done successfully");
        });
    });

    describe("getContextManifest", () => {
        it("should return empty array when no files", () => {
            const manifest = manager.getContextManifest();
            expect(manifest).toEqual([]);
        });

        it("should return references for externalized files", async () => {
            const content1 = "A".repeat(3000);
            const content2 = "B".repeat(3000);

            await manager.externalize(content1, "observation");
            await manager.externalize(content2, "tool_output");

            const manifest = manager.getContextManifest();
            expect(manifest.length).toBe(2);
        });

        it("should limit to 10 most recent files", async () => {
            // Create 12 files
            for (let i = 0; i < 12; i++) {
                await manager.externalize(`${"X".repeat(3000)}-${i}`, "observation");
            }

            const manifest = manager.getContextManifest();
            expect(manifest.length).toBeLessThanOrEqual(10);
        });
    });

    describe("buildContextManifestPrompt", () => {
        it("should return empty string when no files", () => {
            const prompt = manager.buildContextManifestPrompt();
            expect(prompt).toBe("");
        });

        it("should include file references in prompt", async () => {
            await manager.externalize("A".repeat(3000), "tool_output", "Analysis results");

            const prompt = manager.buildContextManifestPrompt();
            expect(prompt).toContain("AVAILABLE CONTEXT FILES");
            expect(prompt).toContain("tool_output");
            expect(prompt).toContain("Analysis results");
        });
    });

    describe("getTokenSavings", () => {
        it("should report zero savings when no files", () => {
            const savings = manager.getTokenSavings();
            expect(savings.totalExternalized).toBe(0);
            expect(savings.filesCount).toBe(0);
        });

        it("should calculate token savings correctly", async () => {
            // 3000 chars ≈ 750 tokens, minus ~20 token reference = 730 saved
            await manager.externalize("A".repeat(3000), "observation");

            const savings = manager.getTokenSavings();
            expect(savings.filesCount).toBe(1);
            expect(savings.totalExternalized).toBeGreaterThan(0);
        });
    });
});

describe("getContextManager", () => {
    it("should return same manager for same workflow/run", () => {
        const manager1 = getContextManager("wf-1", "run-1");
        const manager2 = getContextManager("wf-1", "run-1");
        expect(manager1).toBe(manager2);
    });

    it("should return different managers for different workflows", () => {
        const manager1 = getContextManager("wf-1", "run-1");
        const manager2 = getContextManager("wf-2", "run-1");
        expect(manager1).not.toBe(manager2);
    });
});

describe("processForContext", () => {
    it("should return inline for small content", async () => {
        const result = await processForContext(
            "Small content",
            "observation",
            "wf-1",
            "run-1"
        );

        expect(result.inline).toBe("Small content");
        expect(result.reference).toBeNull();
    });

    it("should return reference for large content", async () => {
        const result = await processForContext(
            "A".repeat(3000),
            "tool_output",
            "wf-1",
            "run-1"
        );

        expect(result.inline).toBeNull();
        expect(result.reference).not.toBeNull();
    });
});

describe("formatReference", () => {
    it("should format reference as compact string", () => {
        const ref: ContextReference = {
            fileId: "obs-123-abc",
            type: "observation",
            summary: "Observed data patterns",
            critical: false,
        };

        const formatted = formatReference(ref);
        expect(formatted).toContain("observation");
        expect(formatted).toContain("Observed data patterns");
        expect(formatted).toContain("obs-123-abc");
    });
});
