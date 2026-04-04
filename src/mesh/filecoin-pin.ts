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
import type {
  LocalFilecoinPinProvisionResponse,
  MeshSharedArtifactPinRequest,
  MeshSharedArtifactPinResponse,
} from "./types.js";

const {
  createCarFromPath,
  executeUpload,
} = filecoinPin;
const DEFAULT_FILECOIN_PIN_COPIES = 2;

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
  title: string;
  sequenceNumber: number;
}): string {
  return `compose-${input.haiId.toLowerCase()}-${learningPathSlug(input.title)}-#${Math.trunc(input.sequenceNumber)}`;
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

function learningPathSlug(title: string): string {
  const normalized = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || "untitled";
}

function parseLearningPayload(payloadJson: string): {
  title: string;
  summary: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    throw new Error("Learning payload JSON must be valid JSON");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Learning payload JSON must be an object");
  }

  const object = parsed as Record<string, unknown>;
  const title = typeof object.title === "string" ? object.title.trim() : "";
  const summary = typeof object.summary === "string" ? object.summary.trim() : "";

  if (!title) {
    throw new Error("Learning payload title is required");
  }
  if (!summary) {
    throw new Error("Learning payload summary is required");
  }

  return { title, summary };
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

function resolveRequestedCopies(request: MeshSharedArtifactPinRequest): number {
  return request.copies ?? DEFAULT_FILECOIN_PIN_COPIES;
}

async function requestFilecoinPinSession(
  request: MeshSharedArtifactPinRequest,
  options: {
    fileSizeBytes: number;
    copies: number;
  },
): Promise<LocalFilecoinPinProvisionResponse> {
  const response = await fetch(`${normalizeApiBaseUrl(request)}/api/local/filecoin-pin/session`, {
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
      sessionKeyAddress: privateKeyToAccount(request.filecoinPinSessionKeyPrivateKey).address,
      sessionKeyExpiresAt: request.targetSessionExpiry,
      fileSizeBytes: options.fileSizeBytes,
      copies: options.copies,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Filecoin Pin control plane rejected provisioning: HTTP ${response.status}: ${text || response.statusText}`);
  }

  return await response.json() as LocalFilecoinPinProvisionResponse;
}

async function getFilecoinPinClient(
  request: MeshSharedArtifactPinRequest,
  payerAddress: `0x${string}`,
): Promise<FilecoinPinClient> {
  const config = loadMeshFilecoinNetworkConfig();
  const cacheKey = [
    config.network,
    config.rpcUrl ?? "",
    payerAddress,
    request.filecoinPinSessionKeyPrivateKey,
  ].join(":");

  if (!cachedClient || cachedClient.key !== cacheKey) {
    cachedClient = {
      key: cacheKey,
      promise: createFilecoinPinClient({
        walletAddress: payerAddress,
        sessionKey: request.filecoinPinSessionKeyPrivateKey,
        chain: resolveFilecoinNetworkChain(config.network),
        withCDN: true,
        ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
      }),
    };
  }

  return await cachedClient.promise;
}

export async function pinMeshArtifact(
  request: MeshSharedArtifactPinRequest,
): Promise<MeshSharedArtifactPinResponse> {
  const artifactKind = normalizeMeshLearningKind(request.artifactKind);
  const payload = parseLearningPayload(request.payloadJson);
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
  const latestAlias = createLearningLatestAlias(request.haiId);
  const payloadPath = tempLearningPayloadPath(request);
  let carPath: string | null = null;

  try {
    await writeFile(payloadPath, request.payloadJson, "utf8");
    const car = await createCarFromPath(payloadPath, { bare: true });
    carPath = car.carPath;
    const carBytes = await readFile(car.carPath);
    const provisioned = await requestFilecoinPinSession(request, {
      fileSizeBytes: carBytes.byteLength,
      copies: resolveRequestedCopies(request),
    });
    const providerIds = provisioned.providerIds.map((value) => BigInt(value));
    if (providerIds.length === 0) {
      throw new Error("Filecoin Pin control plane returned no providers for the upload");
    }
    const client = await getFilecoinPinClient(request, provisioned.payerAddress);

    const uploadResult = await executeUpload(client, carBytes, car.rootCid, {
      logger: console as never,
      contextId: request.path,
      ipniValidation: { enabled: false },
      metadata: createLearningDatasetMetadata(config),
      pieceMetadata: createLearningPieceMetadata({
        title: payload.title,
        summary: payload.summary,
        agentWallet: request.agentWallet,
        userAddress: request.userAddress,
      }),
      providerIds,
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
