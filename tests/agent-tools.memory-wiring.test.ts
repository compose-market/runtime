import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

describe("runtime memory tool wiring", () => {
    it("binds explicit memory tools to hosted agents alongside the structured memory loop", () => {
        const source = normalizeWhitespace(readFileSync(
            path.resolve(process.cwd(), "src/manowar/framework.ts"),
            "utf8",
        ));

        expect(source).toContain("createMemoryTools(");
        expect(source).toContain("retrieveAgentMemory(");
        expect(source).toContain("persistAgentConversationTurn(");
    });

    it("keeps createAgentTools free of implicit runtime-memory injection (memory tools live alongside, not inside)", () => {
        const source = normalizeWhitespace(readFileSync(
            path.resolve(process.cwd(), "src/manowar/agent/tools.ts"),
            "utf8",
        ));

        // createAgentTools must not inline createMemoryTools — manowar.ts composes both.
        expect(source).not.toContain("for (const tool of createMemoryTools(");
    });

    it("does not advertise hidden memory tools in the registration-time persona blob", () => {
        const source = normalizeWhitespace(readFileSync(
            path.resolve(process.cwd(), "src/manowar/runtime.ts"),
            "utf8",
        ));

        // Identity + tool catalog are rendered per-turn in manowar.ts, not in registration.
        expect(source).not.toContain("runtime memory tools: search_memory");
        expect(source).not.toContain("Use save_memory with a content string");
    });

    it("passes the current user query into the structured pre-turn memory loop", () => {
        const source = normalizeWhitespace(readFileSync(
            path.resolve(process.cwd(), "src/manowar/agent/memory.ts"),
            "utf8",
        ));

        expect(source).toContain('step: "pre_turn", query: params.query,');
    });
});
