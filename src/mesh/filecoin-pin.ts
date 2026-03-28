import type { UploadResult } from "@filoz/synapse-sdk";
import {
  createLearningDatasetMetadata,
  createLearningLatestAlias,
  createLearningPieceMetadata,
  loadMeshSynapseConfig,
} from "./config.js";
import { markHaiLearning, verifyLearningPin } from "./hai.js";
import { ensureProvisionedSynapseClient } from "./synapse.js";
import type { MeshSharedArtifactPinRequest, MeshSharedArtifactPinResponse } from "./types.js";

export const learningKinds = ["learning", "report", "resource", "ticket"] as const;

export type MeshLearningKind = (typeof learningKinds)[number];

export function isMeshLearningKind(value: string): value is MeshLearningKind {
  return learningKinds.includes(value as MeshLearningKind);
}

export function normalizeMeshLearningKind(value: string): MeshLearningKind {
  const normalized = value.trim().toLowerCase();
  if (!isMeshLearningKind(normalized)) {
    throw new Error(`Unsupported mesh learning kind: ${value}`);
  }
  return normalized;
}

export function composeLearningPath(input: {
  haiId: string;
  kind: MeshLearningKind;
  sequenceNumber: number;
}): string {
  return `learning-${input.haiId.toLowerCase()}-${input.kind}-#${Math.trunc(input.sequenceNumber)}`;
}

export function encodeLearningPayload(payload: unknown): Uint8Array {
  const text = typeof payload === "string"
    ? payload
    : JSON.stringify(payload);
  return new TextEncoder().encode(text);
}

function assertCompleteUpload(uploadResult: UploadResult): void {
  if (uploadResult.copies.length === 0) {
    throw new Error("Filecoin Pin upload returned no persisted copies");
  }

  if (uploadResult.failedAttempts.length === 0) {
    return;
  }

  const failureSummary = uploadResult.failedAttempts
    .map((attempt) => `${attempt.role}:${attempt.providerId.toString()}:${attempt.error}`)
    .join("; ");
  throw new Error(`Filecoin Pin upload did not complete all requested copies: ${failureSummary}`);
}

export async function pinMeshArtifact(
  request: MeshSharedArtifactPinRequest,
): Promise<MeshSharedArtifactPinResponse> {
  const artifactKind = normalizeMeshLearningKind(request.artifactKind);
  await verifyLearningPin({
    signedRequestJson: request.signedRequestJson,
    agentWallet: request.agentWallet,
    userAddress: request.userAddress,
    deviceId: request.deviceId,
    haiId: request.haiId,
    artifactKind,
    artifactNumber: request.artifactNumber,
    path: request.path,
    payloadJson: request.payloadJson,
  });

  const config = loadMeshSynapseConfig();
  const latestAlias = createLearningLatestAlias(request.haiId, artifactKind);
  const payload = encodeLearningPayload(request.payloadJson);

  let provisioned = await ensureProvisionedSynapseClient(request);
  let context = await provisioned.synapse.storage.createContext({
    withCDN: true,
    metadata: createLearningDatasetMetadata(config),
  });

  let preparation = await provisioned.synapse.storage.prepare({
    context,
    dataSize: BigInt(payload.byteLength),
  });

  if (preparation.transaction != null) {
    provisioned = await ensureProvisionedSynapseClient(request, {
      depositAmount: preparation.transaction.depositAmount,
    });
    context = await provisioned.synapse.storage.createContext({
      withCDN: true,
      metadata: createLearningDatasetMetadata(config),
    });
    preparation = await provisioned.synapse.storage.prepare({
      context,
      dataSize: BigInt(payload.byteLength),
    });

    if (preparation.transaction != null) {
      throw new Error(
        `Filecoin Pin payer still requires funding after control-plane top-up (deposit=${preparation.transaction.depositAmount.toString()} approval=${String(preparation.transaction.includesApproval)})`,
      );
    }
  }

  const uploadResult = await context.upload(payload, {
    pieceMetadata: createLearningPieceMetadata({
      haiId: request.haiId,
      path: request.path,
      artifactKind,
      agentWallet: request.agentWallet,
      userAddress: request.userAddress,
      deviceId: request.deviceId,
      publisherAddress: request.publisherAddress ?? request.userAddress,
      accessPriceUsdc: request.accessPriceUsdc,
      title: request.title,
      summary: request.summary,
    }),
  });
  assertCompleteUpload(uploadResult);

  const primaryCopy = uploadResult.copies[0] ?? null;
  const pieceCid = typeof uploadResult.pieceCid === "string"
    ? uploadResult.pieceCid
    : uploadResult.pieceCid.toString();

  await markHaiLearning({
    agentWallet: request.agentWallet,
    userAddress: request.userAddress,
    deviceId: request.deviceId,
    artifactNumber: request.artifactNumber,
    payerAddress: provisioned.payerAddress,
    sessionKeyExpiresAt: provisioned.sessionKeyExpiresAt,
  });

  return {
    haiId: request.haiId,
    artifactKind,
    artifactNumber: request.artifactNumber,
    path: request.path,
    fileName: request.path,
    latestAlias,
    rootCid: pieceCid,
    pieceCid,
    payloadSize: uploadResult.size,
    copyCount: uploadResult.copies.length,
    providerId: primaryCopy?.providerId?.toString() ?? context.provider.id.toString(),
    dataSetId: primaryCopy?.dataSetId?.toString() ?? context.dataSetId?.toString() ?? null,
    pieceId: primaryCopy?.pieceId?.toString() ?? null,
    retrievalUrl: primaryCopy?.retrievalUrl ?? null,
    payerAddress: provisioned.payerAddress,
    sessionKeyExpiresAt: provisioned.sessionKeyExpiresAt,
    source: config.source,
    collection: "learnings",
  };
}
