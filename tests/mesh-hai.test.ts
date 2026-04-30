import { generateKeyPair } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { describe, expect, it } from "vitest";
import { mkHai, parseLearningPath, parseStatePath, registerHai, sha256Hex, signBytes, verifyLearningPin } from "../src/mesh/hai.js";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

describe("mesh hai", () => {
  it("registers a deterministic HAI without local runtime storage", () => {
    const registration = registerHai({
      agentWallet: "0x1111111111111111111111111111111111111111",
      userAddress: "0x2222222222222222222222222222222222222222",
      deviceId: "device-12345678",
    });

    expect(registration.haiId).toBe(mkHai({
      agentWallet: "0x1111111111111111111111111111111111111111",
      userAddress: "0x2222222222222222222222222222222222222222",
      deviceId: "device-12345678",
    }));
  });

  it("parses compose and learning paths", () => {
    expect(parseStatePath("compose-abc123-7")).toEqual({
      hai: "abc123",
      n: 7,
    });
    expect(parseLearningPath("compose-abc123-retry-strategy-#3")).toEqual({
      hai: "abc123",
      slug: "retry-strategy",
      n: 3,
    });
  });

  it("serializes the full signed mesh request tuple for learning pins", () => {
    expect(signBytes({
      version: 1,
      kind: "compose.mesh.request",
      action: "learning.pin",
      collection: "learnings",
      requesterHaiId: "abc123",
      requesterAgentWallet: "0x1111111111111111111111111111111111111111",
      requesterUserAddress: "0x2222222222222222222222222222222222222222",
      requesterDeviceId: "device-12345678",
      requesterPeerId: "12D3KooWQfJqLxy6Jh6yJvPevn8zJmcM6iUW1Rpx5c2Wdrm8wU5V",
      targetPath: "compose-abc123-useful-learning-#4",
      targetPieceCid: null,
      targetDataSetId: null,
      targetPieceId: null,
      artifactKind: "learning",
      fileName: null,
      rootCid: null,
      payloadSha256: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      signedAt: 1_710_000_000_000,
    })).toBe(JSON.stringify([
      1,
      "compose.mesh.request",
      "learning.pin",
      "learnings",
      "abc123",
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
      "device-12345678",
      "12D3KooWQfJqLxy6Jh6yJvPevn8zJmcM6iUW1Rpx5c2Wdrm8wU5V",
      "compose-abc123-useful-learning-#4",
      null,
      null,
      null,
      "learning",
      null,
      null,
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      1_710_000_000_000,
    ]));
  });

  it("verifies learning pins signed over the canonical learning tuple", async () => {
    const privateKey = await generateKeyPair("Ed25519");
    const peerId = peerIdFromPrivateKey(privateKey).toString();
    const haiId = mkHai({
      agentWallet: "0x1111111111111111111111111111111111111111",
      userAddress: "0x2222222222222222222222222222222222222222",
      deviceId: "device-12345678",
    });
    const path = `compose-${haiId}-useful-learning-#4`;
    const payloadJson = JSON.stringify({
      version: 1,
      kind: "compose.mesh.learning",
      createdAt: 1_710_000_000_000,
      title: "Useful learning",
      summary: "Short summary",
      content: "High-signal content",
      accessPriceUsdc: "0.10",
      publisherAddress: "0x2222222222222222222222222222222222222222",
    });
    const unsigned = {
      version: 1 as const,
      kind: "compose.mesh.request" as const,
      action: "learning.pin" as const,
      collection: "learnings" as const,
      requesterHaiId: haiId,
      requesterAgentWallet: "0x1111111111111111111111111111111111111111" as const,
      requesterUserAddress: "0x2222222222222222222222222222222222222222" as const,
      requesterDeviceId: "device-12345678",
      requesterPeerId: peerId,
      targetPath: path,
      targetPieceCid: null,
      targetDataSetId: null,
      targetPieceId: null,
      artifactKind: "learning" as const,
      fileName: null,
      rootCid: null,
      payloadSha256: sha256Hex(payloadJson),
      signedAt: Date.now(),
    };
    const signature = await privateKey.sign(new TextEncoder().encode(signBytes(unsigned)));

    await expect(verifyLearningPin({
      signedRequestJson: JSON.stringify({
        ...unsigned,
        signature: toHex(signature),
      }),
      agentWallet: "0x1111111111111111111111111111111111111111",
      userAddress: "0x2222222222222222222222222222222222222222",
      deviceId: "device-12345678",
      haiId,
      artifactKind: "learning",
      artifactNumber: 4,
      path,
      payloadJson,
    })).resolves.toMatchObject({
      requesterPeerId: peerId,
      payloadSha256: sha256Hex(payloadJson),
      artifactKind: "learning",
    });
  });
});
