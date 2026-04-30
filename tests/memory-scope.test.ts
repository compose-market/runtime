import { describe, expect, it } from "vitest";

import { resolveMemoryScope } from "../src/manowar/agent/memory-scope.js";

describe("resolveMemoryScope", () => {
  it("preserves the global wallet, user, thread, and compose run scope", () => {
    expect(resolveMemoryScope({
      agentWallet: "0x1111111111111111111111111111111111111111",
      userAddress: "0x2222222222222222222222222222222222222222",
      workflowWallet: "0x3333333333333333333333333333333333333333",
      context: {
        mode: "global",
        threadId: "thread-123",
        composeRunId: "compose-run-456",
        userAddress: "0x2222222222222222222222222222222222222222",
      },
    })).toEqual({
      mode: "global",
      agentWallet: "0x1111111111111111111111111111111111111111",
      userId: "0x2222222222222222222222222222222222222222",
      threadId: "thread-123",
      composeRunId: "compose-run-456",
      filters: {
        workflow_wallet: "0x3333333333333333333333333333333333333333",
      },
      metadata: {
        mode: "global",
        workflow_wallet: "0x3333333333333333333333333333333333333333",
      },
    });
  });

  it("keeps the canonical agent wallet and adds explicit local hai scope", () => {
    expect(resolveMemoryScope({
      agentWallet: "0x1111111111111111111111111111111111111111",
      userAddress: "0x2222222222222222222222222222222222222222",
      context: {
        mode: "local",
        haiId: "abc123",
        threadId: "local-agent:abc123:chat:thread-1",
      },
    })).toEqual({
      mode: "local",
      agentWallet: "0x1111111111111111111111111111111111111111",
      haiId: "abc123",
      threadId: "local-agent:abc123:chat:thread-1",
      filters: {
        mode: "local",
        hai_id: "abc123",
      },
      metadata: {
        mode: "local",
        hai_id: "abc123",
      },
    });
  });

  it("defaults the local thread to haiId when no explicit conversation thread is provided", () => {
    expect(resolveMemoryScope({
      agentWallet: "0x1111111111111111111111111111111111111111",
      context: {
        mode: "local",
        haiId: "abc123",
      },
    })).toEqual({
      mode: "local",
      agentWallet: "0x1111111111111111111111111111111111111111",
      haiId: "abc123",
      threadId: "abc123",
      filters: {
        mode: "local",
        hai_id: "abc123",
      },
      metadata: {
        mode: "local",
        hai_id: "abc123",
      },
    });
  });
});
