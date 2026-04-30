import { describe, expect, it } from "vitest";

import {
  buildInspectCandidates,
  cleanSlug,
  isServerComplete,
  type CompiledServer,
  type RawMcpServer,
} from "../scripts/compile-mcp-compiled.js";

describe("mcp catalog compiler utils", () => {
  it("cleanSlug strips MCP/server/author/source noise", () => {
    expect(cleanSlug("CodeAnalysis MCP Server by 0xjcf | Glama")).toBe("codeanalysis");
    // Keep this aligned with backend/services/connector/src/registry.ts (cleanSlug).
    expect(cleanSlug("Official Zapier MCP Server | PulseMCP")).toBe("official-zapier");
  });

  it("buildInspectCandidates prefers streamable-http over sse and includes npm packages", () => {
    const raw: RawMcpServer = {
      id: "x",
      name: "Example MCP Server",
      namespace: "example",
      slug: "example",
      remotes: [
        // Use a non-placeholder domain; "example.com" is treated as a placeholder and excluded.
        { type: "sse", url: "https://acme.dev/sse" },
        { type: "streamable-http", url: "https://acme.dev/mcp" },
      ],
      packages: [
        { registryType: "npm", identifier: "@example/mcp" },
      ],
    };

    const cands = buildInspectCandidates(raw);
    expect(cands[0]?.transport).toBe("http");
    expect(cands[0]?.remoteUrl).toBe("https://acme.dev/mcp");
    expect(cands.some((c) => c.transport === "npx" && c.package === "@example/mcp")).toBe(true);
  });

  it("isServerComplete enforces required fields", () => {
    const incomplete: Partial<CompiledServer> = {
      id: "mcp:test",
      name: "Test",
      description: "A server.",
      tags: ["api"],
      tools: [{ name: "call", description: "Do something." }],
      spawn: { status: "verified", transport: "npx", lastCheckedAt: "", attempts: 1 } as any,
    };
    expect(isServerComplete(incomplete as CompiledServer)).toBe(false);

    const complete: CompiledServer = {
      id: "mcp:test",
      name: "Test",
      description: "A server.",
      tags: ["api", "web"],
      tools: [{ name: "call", description: "Do something." }],
      spawn: { status: "verified", transport: "npx", lastCheckedAt: new Date().toISOString(), attempts: 1 },
    };
    expect(isServerComplete(complete)).toBe(true);
  });
});
