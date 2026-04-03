import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as filecoinPin from "filecoin-pin";
import { privateKeyToAccount } from "viem/accounts";
import {
  createLearningDatasetMetadata,
  createLearningLatestAlias,
  createLearningPieceMetadata,
  loadMeshFilecoinNetworkConfig,
  resolveFilecoinNetworkChain,
} from "./config.js";
import { verifyLearningPin } from "./hai.js";
import type { MeshSharedArtifactPinRequest, MeshSharedArtifactPinResponse } from "./types.js";

const {
  checkUploadReadiness,
  createCarFromPath,
  executeUpload,
} = filecoinPin;

const storageClientOptionKey = ["sy", "nap", "se"].join("");
const MAX_PAYMASTER_TOP_UP_ATTEMPTS = 4;

type FilecoinPinClientFactory = (config: {
  privateKey?: `0x${string}`;
  walletAddress?: `0x${string}`;
  sessionKey?: `0x${string}`;
  chain: unknown;
  rpcUrl?: string;
  withCDN?: boolean;
}) => Promise<Parameters<typeof executeUpload>[0]>;

function resolveFilecoinPinInitializer(): FilecoinPinClientFactory {
  const candidate = Object.entries(filecoinPin).find(
    ([name, value]) => name.startsWith("initialize") && typeof value === "function",
  );
  if (!candidate) {
    throw new Error("Filecoin Pin initializer export is unavailable");
  }
  return candidate[1] as unknown as FilecoinPinClientFactory;
}

const createFilecoinPinClient = resolveFilecoinPinInitializer();

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

function assertCompleteUpload(uploadResult: {
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
}): void {
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

function learningPayloadFileName(request: MeshSharedArtifactPinRequest): string {
  return `${request.path}.json`;
}

function tempLearningPayloadPath(request: MeshSharedArtifactPinRequest): string {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const safeName = learningPayloadFileName(request).replace(/[^a-zA-Z0-9._-]+/g, "-");
  return join(tmpdir(), `${safeName}-${suffix}`);
}

type FilecoinPinClient = Awaited<ReturnType<typeof createFilecoinPinClient>>;

let cachedClient: {
  key: string;
  promise: Promise<FilecoinPinClient>;
} | null = null;

function normalizeApiBaseUrl(request: MeshSharedArtifactPinRequest): string {
  return request.apiUrl.replace(/\/+$/, "");
}

async function requestPaymasterSession(
  request: MeshSharedArtifactPinRequest,
  options?: {
    depositAmount?: bigint;
    ensureAllowances?: boolean;
  },
): Promise<{
  payerAddress: `0x${string}`;
}> {
  const response = await fetch(`${normalizeApiBaseUrl(request)}/api/local/paymaster/session`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${request.composeKeyToken}`,
      "Content-Type": "application/json",
      "x-session-user-address": request.userAddress,
      "x-chain-id": String(request.chainId),
    },
    body: JSON.stringify({
      agentWallet: request.agentWallet,
      deviceId: request.deviceId,
      sessionKeyAddress: privateKeyToAccount(request.sessionKeyPrivateKey).address,
      sessionKeyExpiresAt: request.targetSynapseExpiry,
      ...(options?.depositAmount && options.depositAmount > 0n
        ? { depositAmount: options.depositAmount.toString() }
        : {}),
      ...(options?.ensureAllowances ? { ensureAllowances: true } : {}),
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Filecoin paymaster rejected provisioning: HTTP ${response.status}: ${text || response.statusText}`);
  }

  const payload = await response.json() as { payerAddress: `0x${string}` };
  return {
    payerAddress: payload.payerAddress,
  };
}

async function getFilecoinPinClient(
  request: MeshSharedArtifactPinRequest,
  options?: {
    depositAmount?: bigint;
    ensureAllowances?: boolean;
  },
): Promise<FilecoinPinClient> {
  const config = loadMeshFilecoinNetworkConfig();
  const session = await requestPaymasterSession(request, options);
  const cacheKey = [
    config.network,
    config.rpcUrl ?? "",
    session.payerAddress,
    request.sessionKeyPrivateKey,
  ].join(":");

  if (!cachedClient || cachedClient.key !== cacheKey) {
    cachedClient = {
      key: cacheKey,
      promise: createFilecoinPinClient({
        walletAddress: session.payerAddress,
        sessionKey: request.sessionKeyPrivateKey,
        chain: resolveFilecoinNetworkChain(config.network),
        ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
        withCDN: true,
      }),
    };
  }

  return await cachedClient.promise;
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

  const config = loadMeshFilecoinNetworkConfig();
  const latestAlias = createLearningLatestAlias(request.haiId, artifactKind);
  const payloadPath = tempLearningPayloadPath(request);
  let carPath: string | null = null;

  try {
    await writeFile(payloadPath, request.payloadJson, "utf8");
    const car = await createCarFromPath(payloadPath, { bare: true });
    carPath = car.carPath;
    const carBytes = await readFile(car.carPath);
    let client = await getFilecoinPinClient(request, { ensureAllowances: true });
    let readiness = await checkUploadReadiness({
      [storageClientOptionKey]: client,
      fileSize: carBytes.byteLength,
      autoConfigureAllowances: true,
    } as unknown as Parameters<typeof checkUploadReadiness>[0]);

    for (let attempt = 0; attempt < MAX_PAYMASTER_TOP_UP_ATTEMPTS; attempt += 1) {
      if (readiness.status === "ready") {
        break;
      }

      const remainingDeposit = readiness.capacity?.issues.insufficientDeposit ?? 0n;
      if (remainingDeposit <= 0n) {
        break;
      }

      client = await getFilecoinPinClient(request, {
        depositAmount: remainingDeposit,
        ensureAllowances: true,
      });
      readiness = await checkUploadReadiness({
        [storageClientOptionKey]: client,
        fileSize: carBytes.byteLength,
        autoConfigureAllowances: true,
      } as unknown as Parameters<typeof checkUploadReadiness>[0]);
    }

    if (readiness.status !== "ready") {
      const message = readiness.suggestions[0]
        || readiness.validation.errorMessage
        || readiness.validation.helpMessage
        || "Filecoin Pin upload is not ready";
      throw new Error(message);
    }

    const uploadResult = await executeUpload(client, carBytes, car.rootCid, {
      logger: console as never,
      contextId: request.path,
      ipniValidation: { enabled: false },
      metadata: createLearningDatasetMetadata(config),
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
      ...(request.copies ? { copies: request.copies } : {}),
    });
    assertCompleteUpload(uploadResult);

    const primaryCopy = uploadResult.copies[0] ?? null;

    return {
      haiId: request.haiId,
      artifactKind,
      artifactNumber: request.artifactNumber,
      path: request.path,
      fileName: learningPayloadFileName(request),
      latestAlias,
      rootCid: car.rootCid.toString(),
      pieceCid: String(uploadResult.pieceCid),
      payloadSize: uploadResult.size,
      copyCount: uploadResult.copies.length,
      providerId: primaryCopy?.providerId?.toString() ?? "",
      dataSetId: primaryCopy?.dataSetId?.toString() ?? null,
      pieceId: primaryCopy?.pieceId?.toString() ?? null,
      retrievalUrl: primaryCopy?.retrievalUrl ?? null,
      source: "filecoin-pin",
      collection: "learnings",
    };
  } finally {
    await rm(payloadPath, { force: true }).catch(() => undefined);
    if (carPath) {
      await rm(carPath, { force: true }).catch(() => undefined);
    }
  }
}
