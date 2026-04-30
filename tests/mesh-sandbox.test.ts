import { describe, expect, it, vi } from "vitest";
import { CodeLanguage, DaytonaNotFoundError } from "@daytonaio/sdk";
import type { DaytonaLike, DaytonaSandboxLike } from "../src/mesh/sandbox.js";
import { runConclaveSandbox } from "../src/mesh/sandbox.js";

function makeSandbox(): DaytonaSandboxLike {
  return {
    id: "sbx-1",
    snapshot: "snap-1",
    buildInfo: {
      imageName: "compose/conclave:latest",
    },
    process: {
      createSession: vi.fn(async () => {}),
      executeSessionCommand: vi.fn(async () => ({
        exitCode: 0,
        stdout: "{\"type\":\"meter\",\"agentWallet\":\"0x1111111111111111111111111111111111111111\",\"messages\":1}",
        stderr: "",
      })),
      deleteSession: vi.fn(async () => {}),
    },
    stop: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
}

describe("mesh sandbox", () => {
  it("uses ephemeral sandboxes without autoDeleteInterval and cleans up the session", async () => {
    const sandbox = makeSandbox();
    const create = vi.fn(async () => sandbox);
    const client: DaytonaLike = {
      create,
      delete: vi.fn(async () => {}),
    };

    const receipt = await runConclaveSandbox(client, {
      apiKey: "test",
      apiUrl: "https://app.daytona.io/api",
      snapshotId: "snap-config",
      language: CodeLanguage.TYPESCRIPT,
      timeoutMs: 300_000,
      autoDeleteInterval: 5,
    }, {
      conclaveId: "c1",
      command: "echo ok",
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      snapshot: "snap-config",
      language: CodeLanguage.TYPESCRIPT,
      ephemeral: true,
    });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("autoDeleteInterval");
    expect(sandbox.process.createSession).toHaveBeenCalledWith("conclave-c1");
    expect(sandbox.process.deleteSession).toHaveBeenCalledWith("conclave-c1");
    expect(sandbox.stop).toHaveBeenCalled();
    expect(client.delete).toHaveBeenCalledWith(sandbox, 300);
    expect(receipt.exitCode).toBe(0);
    expect(receipt.sandboxId).toBe("sbx-1");
    expect(receipt.meteringRecords).toHaveLength(1);
  });

  it("treats already-deleted ephemeral sandboxes as a clean teardown", async () => {
    const sandbox = makeSandbox();
    const create = vi.fn(async () => sandbox);
    const client: DaytonaLike = {
      create,
      delete: vi.fn(async () => {
        throw new DaytonaNotFoundError("gone");
      }),
    };

    const receipt = await runConclaveSandbox(client, {
      apiKey: "test",
      apiUrl: "https://app.daytona.io/api",
      snapshotId: "snap-config",
      language: CodeLanguage.TYPESCRIPT,
      timeoutMs: 300_000,
      autoDeleteInterval: 5,
    }, {
      conclaveId: "c2",
      command: "echo ok",
    });

    expect(receipt.exitCode).toBe(0);
    expect(client.delete).toHaveBeenCalledWith(sandbox, 300);
    expect(sandbox.delete).not.toHaveBeenCalled();
  });
});
