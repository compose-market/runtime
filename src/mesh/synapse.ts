import { Synapse } from "@filoz/synapse-sdk";
import type { StorageContext } from "@filoz/synapse-sdk/storage";
import * as SessionKey from "@filoz/synapse-core/session-key";
import { http } from "viem";
import { privateKeyToAccount, toAccount } from "viem/accounts";
import {
  createStateDatasetMetadata,
  loadMeshSynapseConfig,
  resolveSynapseChain,
} from "./config.js";
import type {
  LocalSynapseProvisionResponse,
  MeshSessionRequest,
  MeshSynapseAnchorRequest,
} from "./types.js";

type ProvisionableRequest = MeshSessionRequest;

function normalizeSynapseExpiryMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value / 1000) * 1000;
}

function buildSessionHeaders(request: ProvisionableRequest): Record<string, string> {
  return {
    Authorization: `Bearer ${request.composeKeyToken}`,
    "Content-Type": "application/json",
    "x-session-user-address": request.userAddress,
    "x-chain-id": String(request.chainId),
  };
}

function apiUrl(request: ProvisionableRequest): string {
  return request.apiUrl.replace(/\/+$/, "");
}

function minSessionExpiryMs(sessionKey: SessionKey.SessionKey<"Secp256k1">): number {
  const minExpiry = SessionKey.DefaultFwssPermissions.reduce((min, permission) => {
    const expiry = sessionKey.expirations[permission] ?? 0n;
    return expiry < min ? expiry : min;
  }, BigInt(Number.MAX_SAFE_INTEGER));

  return Number(minExpiry) * 1000;
}

function buildSessionKey(
  request: ProvisionableRequest,
  payerAddress: `0x${string}`,
) {
  const config = loadMeshSynapseConfig();
  return SessionKey.fromSecp256k1({
    privateKey: request.sessionKeyPrivateKey,
    root: payerAddress,
    chain: resolveSynapseChain(config.network),
    transport: config.rpcUrl ? http(config.rpcUrl) : http(),
  });
}

function createReadOnlyPayerAccount(address: `0x${string}`) {
  const fail = () => {
    throw new Error("Compose mesh runtime must not sign Synapse operations with the payer account");
  };

  return toAccount({
    address,
    sign: async () => fail(),
    signAuthorization: async () => fail(),
    signMessage: async () => fail(),
    signTransaction: async () => fail(),
    signTypedData: async () => fail(),
  });
}

async function requestProvision(
  request: ProvisionableRequest,
  options?: {
    depositAmount?: bigint;
  },
): Promise<LocalSynapseProvisionResponse> {
  const normalizedExpiry = normalizeSynapseExpiryMs(request.targetSynapseExpiry);
  const response = await fetch(`${apiUrl(request)}/api/local/synapse/session`, {
    method: "POST",
    headers: buildSessionHeaders(request),
    body: JSON.stringify({
      agentWallet: request.agentWallet,
      deviceId: request.deviceId,
      sessionKeyAddress: privateKeyToAccount(request.sessionKeyPrivateKey).address,
      sessionKeyExpiresAt: normalizedExpiry,
      ...(options?.depositAmount && options.depositAmount > 0n
        ? { depositAmount: options.depositAmount.toString() }
        : {}),
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Synapse control plane rejected provisioning: HTTP ${response.status}: ${text || response.statusText}`);
  }

  return await response.json() as LocalSynapseProvisionResponse;
}

export interface ProvisionedSynapseClient {
  synapse: Synapse;
  payerAddress: `0x${string}`;
  sessionKeyExpiresAt: number;
}

export async function ensureProvisionedSynapseClient(
  request: ProvisionableRequest,
  options?: {
    depositAmount?: bigint;
  },
): Promise<ProvisionedSynapseClient> {
  const config = loadMeshSynapseConfig();
  const chain = resolveSynapseChain(config.network);
  const requiredExpiry = normalizeSynapseExpiryMs(request.targetSynapseExpiry);

  let payerAddress = request.payerAddress ?? null;
  let sessionKeyExpiresAt = normalizeSynapseExpiryMs(request.sessionKeyExpiresAt ?? 0);

  let sessionKey = payerAddress
    ? buildSessionKey(request, payerAddress)
    : null;

  if (sessionKey) {
    await sessionKey.syncExpirations();
    sessionKeyExpiresAt = minSessionExpiryMs(sessionKey);
  }

  const sessionNeedsProvisioning = (
    sessionKey == null
    || !sessionKey.hasPermissions(SessionKey.DefaultFwssPermissions)
    || sessionKeyExpiresAt < requiredExpiry
  );

  if (sessionNeedsProvisioning || (options?.depositAmount ?? 0n) > 0n) {
    const provisioned = await requestProvision(request, options);
    payerAddress = provisioned.payerAddress;
    sessionKeyExpiresAt = normalizeSynapseExpiryMs(provisioned.sessionKeyExpiresAt);
    sessionKey = buildSessionKey(request, payerAddress);
    await sessionKey.syncExpirations();
    sessionKeyExpiresAt = Math.max(sessionKeyExpiresAt, minSessionExpiryMs(sessionKey));
  }

  if (!payerAddress || !sessionKey) {
    throw new Error("Synapse provisioning did not return a payer-backed session key");
  }

  if (!sessionKey.hasPermissions(SessionKey.DefaultFwssPermissions)) {
    throw new Error("Synapse session key is missing required FWSS permissions");
  }

  const actualExpiry = minSessionExpiryMs(sessionKey);
  if (actualExpiry < requiredExpiry) {
    throw new Error(
      `Synapse session key expiry is below the required mesh anchor window (actual=${actualExpiry} required=${requiredExpiry} provisioned=${sessionKeyExpiresAt})`,
    );
  }

  const synapse = Synapse.create({
    account: createReadOnlyPayerAccount(payerAddress),
    chain,
    transport: config.rpcUrl ? http(config.rpcUrl) : http(),
    source: config.source,
    withCDN: true,
    sessionKey,
  });

  return {
    synapse,
    payerAddress,
    sessionKeyExpiresAt,
  };
}

export async function createMeshStorageContext(
  request: MeshSynapseAnchorRequest,
  options?: {
    depositAmount?: bigint;
  },
): Promise<ProvisionedSynapseClient & { context: StorageContext }> {
  const provisioned = await ensureProvisionedSynapseClient(request, options);
  const config = loadMeshSynapseConfig();
  const context = await provisioned.synapse.storage.createContext({
    withCDN: true,
    metadata: createStateDatasetMetadata(config),
  });

  return {
    ...provisioned,
    context,
  };
}