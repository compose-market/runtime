import { calibration, mainnet, type Chain } from "@filoz/synapse-sdk";
import { z } from "zod";
import type { MeshSharedArtifactKind } from "./types.js";


export const STATE_COLLECTION = "compose";
export const LEARNINGS_COLLECTION = "learnings";

const EnvSchema = z.object({
  COMPOSE_LOCAL_RUNTIME_AUTH_TOKEN: z.string().trim().min(1),
  SYNAPSE_NETWORK: z.enum(["calibration", "mainnet"]).default("calibration"),
  SYNAPSE_PROJECT_NAMESPACE: z.string().trim().min(1).default(STATE_COLLECTION),
  SYNAPSE_RPC_URL: z.string().trim().min(1).optional(),
  FILECOIN_CALIBRATION_RPC: z.string().trim().min(1).optional(),
  FILECOIN_MAINNET_RPC: z.string().trim().min(1).optional(),
});

export interface MeshSynapseConfig {
  runtimeAuthToken: string;
  network: "calibration" | "mainnet";
  source: typeof STATE_COLLECTION;
  rpcUrl: string | null;
}

export function resolveSynapseChain(network: MeshSynapseConfig["network"]): Chain {
  switch (network) {
    case "mainnet":
      return mainnet;
    case "calibration":
    default:
      return calibration;
  }
}

export function loadMeshSynapseConfig(env: NodeJS.ProcessEnv = process.env): MeshSynapseConfig {
  const parsed = EnvSchema.parse(env);
  const rpcUrl = parsed.SYNAPSE_RPC_URL
    || (parsed.SYNAPSE_NETWORK === "mainnet" ? parsed.FILECOIN_MAINNET_RPC : undefined)
    || (parsed.SYNAPSE_NETWORK === "calibration" ? parsed.FILECOIN_CALIBRATION_RPC : undefined)
    || null;

  const source = parsed.SYNAPSE_PROJECT_NAMESPACE.trim().toLowerCase();
  if (source !== STATE_COLLECTION) {
    throw new Error(`SYNAPSE_PROJECT_NAMESPACE must be "${STATE_COLLECTION}" for Compose mesh storage`);
  }

  return {
    runtimeAuthToken: parsed.COMPOSE_LOCAL_RUNTIME_AUTH_TOKEN,
    network: parsed.SYNAPSE_NETWORK,
    source,
    rpcUrl,
  };
}

function environmentLabel(env: NodeJS.ProcessEnv): string {
  const value = String(env.NODE_ENV || "production").trim().toLowerCase();
  if (value === "production" || value.length === 0) {
    return "prod";
  }
  if (value === "development") {
    return "dev";
  }
  return value;
}

export function createStateDatasetMetadata(
  config: MeshSynapseConfig,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return {
    Application: "compose",
    Collection: STATE_COLLECTION,
    Environment: environmentLabel(env),
    Network: config.network,
    Domain: "compose.market",
    Schema: "compose.mesh.state.v2",
  };
}

export function createComposeDatasetMetadata(
  config: MeshSynapseConfig,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return createStateDatasetMetadata(config, env);
}

export function createStatePieceMetadata(input: {
  haiId: string;
  path: string;
  agentWallet: `0x${string}`;
  userAddress: `0x${string}`;
  deviceId: string;
}): Record<string, string> {
  return {
    name: input.path,
    HAI: input.haiId.toLowerCase(),
    Agent: input.agentWallet.toLowerCase(),
  };
}

export function createComposePieceMetadata(input: {
  haiId: string;
  path: string;
  agentWallet: `0x${string}`;
  userAddress: `0x${string}`;
  deviceId: string;
}): Record<string, string> {
  return createStatePieceMetadata(input);
}

export function createLearningDatasetMetadata(
  config: MeshSynapseConfig,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return {
    Application: "compose",
    Collection: LEARNINGS_COLLECTION,
    Environment: environmentLabel(env),
    Network: config.network,
    Domain: "compose.market",
    Schema: "compose.mesh.learnings",
    Scope: "mesh",
    withIPFSIndexing: "",
  };
}

export function createLearningLatestAlias(haiId: string, kind: MeshSharedArtifactKind): string {
  return `learning-${haiId.toLowerCase()}-${kind}:latest`;
}

export function createLearningPieceMetadata(input: {
  haiId: string;
  path: string;
  artifactKind: MeshSharedArtifactKind;
  agentWallet: `0x${string}`;
  userAddress: `0x${string}`;
  deviceId: string;
  publisherAddress: `0x${string}`;
  accessPriceUsdc?: string | null;
  title?: string | null;
  summary?: string | null;
}): Record<string, string> {
  return {
    name: input.path,
    HAI: input.haiId.toLowerCase(),
    ArtifactKind: input.artifactKind,
    Agent: input.agentWallet.toLowerCase(),
    User: input.userAddress.toLowerCase(),
    Device: input.deviceId,
    Publisher: input.publisherAddress.toLowerCase(),
    Latest: createLearningLatestAlias(input.haiId, input.artifactKind),
    ...(input.accessPriceUsdc?.trim() ? { AccessPriceUsdc: input.accessPriceUsdc.trim() } : {}),
    ...(input.title?.trim() ? { Title: input.title.trim() } : {}),
    ...(input.summary?.trim() ? { Summary: input.summary.trim() } : {}),
  };
}
