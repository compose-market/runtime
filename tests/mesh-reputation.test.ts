import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readMeshReputationSummary } from "../src/mesh/reputation.js";

describe("mesh reputation summary", () => {
  let baseDir = "";
  const agentWallet = "0x1111111111111111111111111111111111111111";

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(os.tmpdir(), "compose-mesh-reputation-"));
    vi.stubEnv("COMPOSE_LOCAL_BASE_DIR", baseDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads successful learning and manifest publications without inventing conclaves", async () => {
    const resultsDir = path.join(baseDir, "mesh", "publications", "results", agentWallet);
    await mkdir(resultsDir, { recursive: true });
    await writeFile(
      path.join(resultsDir, "compose-abc123-7.json"),
      JSON.stringify({
        kind: "manifest.publish",
        success: true,
        path: "compose-abc123-7",
        pdpAnchoredAt: 1_710_240_000_000,
      }),
      "utf8",
    );
    await writeFile(
      path.join(resultsDir, "compose-abc123-retry-strategy-#4.json"),
      JSON.stringify({
        kind: "learning.pin",
        success: true,
        path: "compose-abc123-retry-strategy-#4",
        collection: "learnings",
      }),
      "utf8",
    );

    const summary = await readMeshReputationSummary({ agentWallet });

    expect(summary.score).toBe(0);
    expect(summary.totalConclaves).toBe(0);
    expect(summary.successfulConclaves).toBe(0);
    expect(summary.successfulLearningPublications).toBe(1);
    expect(summary.lastManifestAt).toBe(1_710_240_000_000);
    expect(summary.lastLearningAt).not.toBeNull();
  });

  it("summarizes conclave receipts from runtime-owned mesh evidence", async () => {
    const receiptsDir = path.join(baseDir, "mesh", "conclaves", "results", agentWallet);
    await mkdir(receiptsDir, { recursive: true });
    await writeFile(
      path.join(receiptsDir, "conclave-1.json"),
      JSON.stringify({
        conclaveId: "conclave-1",
        agentWallet,
        finishedAt: Date.now() - 1_000,
        exitCode: 0,
      }),
      "utf8",
    );
    await writeFile(
      path.join(receiptsDir, "conclave-2.json"),
      JSON.stringify({
        conclaveId: "conclave-2",
        agentWallet,
        finishedAt: Date.now() - 2_000,
        success: false,
      }),
      "utf8",
    );

    const summary = await readMeshReputationSummary({ agentWallet, now: Date.now() });

    expect(summary.totalConclaves).toBe(2);
    expect(summary.successfulConclaves).toBe(1);
    expect(summary.score).toBeGreaterThan(0);
    expect(summary.lastConclaveAt).not.toBeNull();
  });
});
