import type { UploadResult } from "@filoz/synapse-sdk";
import {
  createStateLatestAlias,
  createStatePieceMetadata,
  loadMeshSynapseConfig,
} from "./config.js";
import { createMeshStorageContext } from "./synapse.js";
import type { MeshSynapseAnchorRequest, MeshSynapseAnchorResponse } from "./types.js";

function assertCompleteUpload(uploadResult: UploadResult): void {
  if (uploadResult.copies.length === 0) {
    throw new Error("Synapse upload returned no persisted copies");
  }

  if (uploadResult.failedAttempts.length === 0) {
    return;
  }

  const failureSummary = uploadResult.failedAttempts
    .map((attempt) => `${attempt.role}:${attempt.providerId.toString()}:${attempt.error}`)
    .join("; ");
  throw new Error(`Synapse upload did not complete all requested copies: ${failureSummary}`);
}

export async function anchorMeshState(
  request: MeshSynapseAnchorRequest,
): Promise<MeshSynapseAnchorResponse> {
  const config = loadMeshSynapseConfig();
  const latestAlias = createStateLatestAlias(request.haiId);
  const payload = new TextEncoder().encode(request.envelopeJson);
  const pieceMetadata = createStatePieceMetadata({
    haiId: request.haiId,
    path: request.path,
    updateNumber: request.updateNumber,
    stateRootHash: request.stateRootHash,
  });

  let storage = await createMeshStorageContext(request);
  let preparation = await storage.synapse.storage.prepare({
    context: storage.context,
    dataSize: BigInt(payload.byteLength),
  });

  if (preparation.transaction != null) {
    storage = await createMeshStorageContext(request, {
      depositAmount: preparation.transaction.depositAmount,
    });
    preparation = await storage.synapse.storage.prepare({
      context: storage.context,
      dataSize: BigInt(payload.byteLength),
    });

    if (preparation.transaction != null) {
      throw new Error(
        `Synapse payer still requires funding after control-plane top-up (deposit=${preparation.transaction.depositAmount.toString()} approval=${String(preparation.transaction.includesApproval)})`,
      );
    }
  }

  const uploadResult = await storage.context.upload(payload, {
    pieceMetadata,
  });
  assertCompleteUpload(uploadResult);

  const primaryCopy = uploadResult.copies[0] ?? null;
  const pieceCid = typeof uploadResult.pieceCid === "string"
    ? uploadResult.pieceCid
    : uploadResult.pieceCid.toString();
  const anchoredAt = Date.now();

  return {
    haiId: request.haiId,
    updateNumber: request.updateNumber,
    path: request.path,
    fileName: request.path,
    latestAlias,
    stateRootHash: request.stateRootHash,
    pdpPieceCid: pieceCid,
    pdpAnchoredAt: anchoredAt,
    payloadSize: uploadResult.size,
    providerId: primaryCopy?.providerId?.toString() ?? storage.context.provider.id.toString(),
    dataSetId: primaryCopy?.dataSetId?.toString() ?? storage.context.dataSetId?.toString() ?? null,
    pieceId: primaryCopy?.pieceId?.toString() ?? null,
    retrievalUrl: primaryCopy?.retrievalUrl ?? null,
    source: config.source,
  };
}
