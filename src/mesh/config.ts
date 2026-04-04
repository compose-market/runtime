import { calibration, mainnet, METADATA_KEYS, type Chain } from "@filoz/synapse-sdk";
import { z } from "zod";


export const STATE_COLLECTION = "compose";
export const LEARNINGS_COLLECTION = "learnings";
const COMPOSE_STORAGE_SOURCE = "compose";
const LEARNING_DATASET_SCHEMA = "compose.mesh.learning.v1";
const METADATA_VALUE_LIMIT = 128;

const EnvSchema = z.object({
  SYNAPSE_NETWORK: z.enum(["calibration", "mainnet"]).default("calibration"),
  SYNAPSE_PROJECT_NAMESPACE: z.string().trim().min(1),
  SYNAPSE_RPC_URL: z.string().trim().min(1).optional(),
  FILECOIN_CALIBRATION_RPC: z.string().trim().min(1).optional(),
  FILECOIN_MAINNET_RPC: z.string().trim().min(1).optional(),
});

function normalizeInlineCommentedEnvValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.replace(/\s+#.*$/, "").trim();
}

export interface MeshSynapseConfig {
  network: "calibration" | "mainnet";
  source: string;
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

export function resolveFilecoinNetworkChain(network: MeshSynapseConfig["network"]): Chain {
  return resolveSynapseChain(network);
}

export function loadMeshSynapseConfig(env: NodeJS.ProcessEnv = process.env): MeshSynapseConfig {
  const parsed = EnvSchema.parse({
    ...env,
    SYNAPSE_NETWORK: normalizeInlineCommentedEnvValue(env.SYNAPSE_NETWORK),
    SYNAPSE_PROJECT_NAMESPACE: normalizeInlineCommentedEnvValue(env.SYNAPSE_PROJECT_NAMESPACE),
    SYNAPSE_RPC_URL: normalizeInlineCommentedEnvValue(env.SYNAPSE_RPC_URL),
    FILECOIN_CALIBRATION_RPC: normalizeInlineCommentedEnvValue(env.FILECOIN_CALIBRATION_RPC),
    FILECOIN_MAINNET_RPC: normalizeInlineCommentedEnvValue(env.FILECOIN_MAINNET_RPC),
  });
  const rpcUrl = parsed.SYNAPSE_RPC_URL
    || (parsed.SYNAPSE_NETWORK === "mainnet" ? parsed.FILECOIN_MAINNET_RPC : undefined)
    || (parsed.SYNAPSE_NETWORK === "calibration" ? parsed.FILECOIN_CALIBRATION_RPC : undefined)
    || null;

  return {
    network: parsed.SYNAPSE_NETWORK,
    source: COMPOSE_STORAGE_SOURCE,
    rpcUrl,
  };
}

export function loadMeshFilecoinNetworkConfig(env: NodeJS.ProcessEnv = process.env): MeshSynapseConfig {
  return loadMeshSynapseConfig(env);
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

export function createStateLatestAlias(haiId: string): string {
  return `compose-${haiId.toLowerCase()}:latest`;
}

export function createStatePieceMetadata(input: {
  haiId: string;
  path: string;
  updateNumber: number;
  stateRootHash: `0x${string}`;
}): Record<string, string> {
  return {
    name: input.path,
    HAI: input.haiId.toLowerCase(),
    Latest: createStateLatestAlias(input.haiId),
    Update: String(Math.trunc(input.updateNumber)),
    StateRootHash: input.stateRootHash.toLowerCase(),
  };
}

export function createLearningDatasetMetadata(
  config: MeshSynapseConfig,
): Record<string, string> {
  return {
    Collection: LEARNINGS_COLLECTION,
    Schema: LEARNING_DATASET_SCHEMA,
    [METADATA_KEYS.SOURCE]: COMPOSE_STORAGE_SOURCE,
    [METADATA_KEYS.WITH_IPFS_INDEXING]: "",
  };
}

export function createLearningLatestAlias(haiId: string): string {
  return `compose-${haiId.toLowerCase()}:latest`;
}

export function createLearningPieceMetadata(input: {
  title: string;
  summary: string;
  agentWallet: `0x${string}`;
  userAddress: `0x${string}`;
}): Record<string, string> {
  return {
    name: input.title.trim().slice(0, METADATA_VALUE_LIMIT),
    Agent: input.agentWallet.toLowerCase(),
    User: input.userAddress.toLowerCase(),
    Summary: input.summary.trim().slice(0, METADATA_VALUE_LIMIT),
  };
}
