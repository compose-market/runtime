import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    isLocalMeshPublicationAvailable,
    queueLocalMeshLearning,
    queueLocalMeshPublication,
    type MeshPublicationQueueRequest,
} from "../src/mesh/publication-queue.js";

describe("mesh publication queue", () => {
  let baseDir = "";

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(os.tmpdir(), "compose-mesh-publication-"));
    vi.stubEnv("RUNTIME_HOST_MODE", "local");
    vi.stubEnv("COMPOSE_LOCAL_BASE_DIR", baseDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports availability only for the local desktop runtime host", () => {
    expect(isLocalMeshPublicationAvailable()).toBe(true);
    vi.stubEnv("RUNTIME_HOST_MODE", "cloud");
    expect(isLocalMeshPublicationAvailable()).toBe(false);
  });

  it("writes a request and resolves when Tauri posts the result", async () => {
    const publication = queueLocalMeshPublication({
      agentWallet: "0x1111111111111111111111111111111111111111",
      reason: "skill-update",
    }, {
      timeoutMs: 5_000,
    });

    const requestsDir = path.join(baseDir, "mesh", "publications", "requests");
    const resultsDir = path.join(baseDir, "mesh", "publications", "results");

    let requestFile = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const files = await readdir(requestsDir);
        requestFile = files.find((file) => file.endsWith(".json")) || "";
        if (requestFile) {
          break;
        }
      } catch {
        // wait for the queue directory to exist
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(requestFile).not.toBe("");

    const request = JSON.parse(
      await readFile(path.join(requestsDir, requestFile), "utf8"),
    ) as MeshPublicationQueueRequest;

    expect(request.agentWallet).toBe("0x1111111111111111111111111111111111111111");
    expect(request.reason).toBe("skill-update");

    await writeFile(
      path.join(resultsDir, `${request.requestId}.json`),
      JSON.stringify({
        requestId: request.requestId,
        success: true,
        haiId: "abc123",
        updateNumber: 9,
        path: "compose-abc123-9",
        stateRootHash: "0x" + "ab".repeat(32),
        pdpPieceCid: "baga6ea4seaexamplepiececid",
        pdpAnchoredAt: 1_710_240_000_000,
        manifest: {
          agentWallet: request.agentWallet,
        },
      }),
      "utf8",
    );

    await expect(publication).resolves.toMatchObject({
      success: true,
      haiId: "abc123",
      updateNumber: 9,
      path: "compose-abc123-9",
    });
  });

  it("writes a learning.pin request and resolves the mesh artifact result", async () => {
    const publication = queueLocalMeshLearning({
      agentWallet: "0x1111111111111111111111111111111111111111",
      title: "Universal retry strategy",
      summary: "Retry transient failures with bounded backoff.",
      content: "Use short exponential backoff for transient network failures and stop after a bounded number of attempts.",
      accessPriceUsdc: "250000",
    }, {
      timeoutMs: 5_000,
    });

    const requestsDir = path.join(baseDir, "mesh", "publications", "requests");
    const resultsDir = path.join(baseDir, "mesh", "publications", "results");

    let requestFile = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const files = await readdir(requestsDir);
        requestFile = files.find((file) => file.endsWith(".json")) || "";
        if (requestFile) {
          break;
        }
      } catch {
        // wait for the queue directory to exist
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(requestFile).not.toBe("");

    const request = JSON.parse(
      await readFile(path.join(requestsDir, requestFile), "utf8"),
    ) as MeshPublicationQueueRequest;

    expect(request.kind).toBe("learning.pin");
    expect(request.title).toBe("Universal retry strategy");
    expect(request.accessPriceUsdc).toBe("250000");

    await writeFile(
      path.join(resultsDir, `${request.requestId}.json`),
      JSON.stringify({
        requestId: request.requestId,
        kind: request.kind,
        success: true,
        haiId: "abc123",
        artifactKind: "learning",
        artifactNumber: 4,
        path: "compose-abc123-universal-retry-strategy-#4",
        latestAlias: "compose-abc123:latest",
        rootCid: "bafybeigdyrztxsamplelearningcid",
        pieceCid: "baga6ea4seaexamplelearningpiececid",
        collection: "learnings",
      }),
      "utf8",
    );

    await expect(publication).resolves.toMatchObject({
      success: true,
      artifactKind: "learning",
      artifactNumber: 4,
      path: "compose-abc123-universal-retry-strategy-#4",
      latestAlias: "compose-abc123:latest",
      collection: "learnings",
    });
  });
});
