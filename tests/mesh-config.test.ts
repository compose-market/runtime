import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLearningDatasetMetadata,
  createLearningLatestAlias,
  createLearningPieceMetadata,
  createStatePieceMetadata,
} from "../src/mesh/config.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllGlobals();
});

function buildLearningPinRequest() {
  return {
    apiUrl: "https://api.compose.market",
    composeKeyToken: "compose-key-token",
    userAddress: ("0x" + "22".repeat(20)) as `0x${string}`,
    agentWallet: ("0x" + "11".repeat(20)) as `0x${string}`,
    deviceId: "device-12345678",
    chainId: 314159,
    targetSessionExpiry: 1_710_250_000_000,
    filecoinPinSessionKeyPrivateKey: ("0x" + "aa".repeat(32)) as `0x${string}`,
    signedRequestJson: "{\"signed\":true}",
    haiId: "abc123",
    artifactKind: "learning" as const,
    artifactNumber: 4,
    path: "compose-abc123-retry-strategy-#4",
    payloadJson: JSON.stringify({
      version: 1,
      kind: "compose.mesh.learning",
      createdAt: 1_710_250_000_000,
      title: "Retry strategy",
      summary: "Retry transient failures with bounded backoff.",
      content: "Use bounded backoff for transient failures.",
      accessPriceUsdc: "0.10",
      publisherAddress: "0x" + "22".repeat(20),
    }),
  };
}

async function loadFilecoinPinModule(uploadResult: {
  pieceCid: string;
  size: number;
  copies: Array<{
    providerId: bigint;
    dataSetId: bigint | null;
    pieceId: bigint | null;
    retrievalUrl?: string | null;
  }>;
  failedAttempts: Array<{
    role: string;
    providerId: bigint;
    error: string;
  }>;
}) {
  const createCarFromPath = vi.fn(async () => ({
    carPath: "/tmp/compose-learning.car",
    rootCid: { toString: () => "bafybeigdyrztxsamplelearningcid" },
  }));
  const executeUpload = vi.fn(async () => uploadResult);

  vi.doMock("node:fs/promises", () => ({
    readFile: vi.fn(async () => Buffer.from("car-bytes")),
    rm: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
  }));
  vi.doMock("filecoin-pin", () => ({
    createCarFromPath,
    executeUpload,
    initializeSynapse: vi.fn(async () => ({ client: true })),
  }));
  vi.doMock("../src/mesh/config.js", () => ({
    createLearningDatasetMetadata: vi.fn(() => ({
      Collection: "learnings",
      Schema: "compose.mesh.learning.v1",
      source: "compose",
      withIPFSIndexing: "",
    })),
    createLearningLatestAlias: vi.fn(() => "compose-abc123:latest"),
    createLearningPieceMetadata: vi.fn(() => ({
      name: "Retry strategy",
      Agent: "0x" + "11".repeat(20),
      User: "0x" + "22".repeat(20),
      Summary: "Retry transient failures with bounded backoff.",
    })),
    loadMeshFilecoinNetworkConfig: vi.fn(() => ({
      network: "calibration",
      rpcUrl: "https://rpc.calibration.example",
      source: "compose",
    })),
    resolveFilecoinNetworkChain: vi.fn(() => ({
      id: 314159,
      name: "calibration",
    })),
  }));
  vi.doMock("../src/mesh/hai.js", () => ({
    verifyLearningPin: vi.fn(async () => undefined),
  }));
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({
      success: true,
      payerAddress: ("0x" + "33".repeat(20)) as `0x${string}`,
      sessionKeyAddress: ("0x" + "44".repeat(20)) as `0x${string}`,
      sessionKeyExpiresAt: 1_710_250_000_000,
      availableFunds: "1000",
      depositAmount: "0",
      depositExecuted: false,
      network: "calibration",
      source: "compose",
      fileSizeBytes: 128,
      providerIds: ["1", "2"],
    }),
    text: async () => "",
  })));

  const module = await import("../src/mesh/filecoin-pin.js");
  return { ...module, createCarFromPath, executeUpload };
}

describe("mesh config", () => {
  it("embeds the numbered path and latest denomination for a HAI update", () => {
    const metadata = createStatePieceMetadata({
      haiId: "abc123",
      path: "compose-abc123-7",
      updateNumber: 7,
      stateRootHash: "0x" + "ab".repeat(32),
    });

    expect(metadata).toEqual({
      HAI: "abc123",
      Latest: "compose-abc123:latest",
      Update: "7",
      StateRootHash: "0x" + "ab".repeat(32),
      name: "compose-abc123-7",
    });
    expect(Object.keys(metadata)).toHaveLength(5);
  });

  it("uses the short learning alias format", () => {
    expect(createLearningLatestAlias("abc123")).toBe("compose-abc123:latest");
  });

  it("marks learning datasets as compose-scoped IPFS-indexed storage", () => {
    expect(createLearningDatasetMetadata({
      network: "calibration",
      source: "ignored-at-call-site",
      rpcUrl: null,
    })).toMatchObject({
      Collection: "learnings",
      Schema: "compose.mesh.learning.v1",
      source: "compose",
      withIPFSIndexing: "",
    });
  });

  it("keeps learning piece metadata within the on-chain piece-key budget", () => {
    const metadata = createLearningPieceMetadata({
      title: "Retry strategy",
      summary: "Retry transient failures with bounded backoff.",
      agentWallet: ("0x" + "11".repeat(20)) as `0x${string}`,
      userAddress: ("0x" + "22".repeat(20)) as `0x${string}`,
    });

    expect(metadata).toEqual({
      name: "Retry strategy",
      Agent: "0x" + "11".repeat(20),
      User: "0x" + "22".repeat(20),
      Summary: "Retry transient failures with bounded backoff.",
    });
    expect(Object.keys(metadata)).toHaveLength(4);
  });

  it("keeps a learning pin when a secondary Filecoin Pin copy fails after one persisted copy", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { pinMeshArtifact, executeUpload } = await loadFilecoinPinModule({
      pieceCid: "baga6ea4seaexamplelearningpiececid",
      size: 128,
      copies: [
        {
          providerId: 1n,
          dataSetId: 10n,
          pieceId: 20n,
          retrievalUrl: "https://example.com/piece/primary",
        },
      ],
      failedAttempts: [
        {
          role: "secondary",
          providerId: 2n,
          error: "Commit failed",
        },
      ],
    });

    const result = await pinMeshArtifact(buildLearningPinRequest());

    expect(result).toMatchObject({
      collection: "learnings",
      copyCount: 1,
      providerId: "1",
      dataSetId: "10",
      pieceId: "20",
      pieceCid: "baga6ea4seaexamplelearningpiececid",
    });
    expect(executeUpload).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Buffer),
      expect.anything(),
      expect.objectContaining({
        providerIds: [1n, 2n],
      }),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("stored 1/2 copies with reduced redundancy"));
  });

  it("still rejects a learning pin when Filecoin Pin persists zero copies", async () => {
    const { pinMeshArtifact } = await loadFilecoinPinModule({
      pieceCid: "baga6ea4seaexamplelearningpiececid",
      size: 128,
      copies: [],
      failedAttempts: [
        {
          role: "secondary",
          providerId: 2n,
          error: "Commit failed",
        },
      ],
    });

    await expect(pinMeshArtifact(buildLearningPinRequest())).rejects.toThrow(
      "Filecoin Pin upload returned no persisted copies",
    );
  });
});
