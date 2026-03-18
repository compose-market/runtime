import { calibration, devnet, mainnet, type Chain } from "@filoz/synapse-sdk";
import { z } from "zod";

const COMPOSE_SYNAPSE_SOURCE = "compose";

const EnvSchema = z.object({
  COMPOSE_LOCAL_RUNTIME_AUTH_TOKEN: z.string().trim().min(1),
  SYNAPSE_NETWORK: z.enum(["calibration", "mainnet", "devnet"]).default("calibration"),
  SYNAPSE_PROJECT_NAMESPACE: z.string().trim().min(1).default(COMPOSE_SYNAPSE_SOURCE),
  SYNAPSE_RPC_URL: z.string().trim().min(1).optional(),
  FILECOIN_CALIBRATION_RPC: z.string().trim().min(1).optional(),
  FILECOIN_MAINNET_RPC: z.string().trim().min(1).optional(),
  FILECOIN_DEVNET_RPC: z.string().trim().min(1).optional(),
});

export interface MeshSynapseConfig {
  runtimeAuthToken: string;
  network: "calibration" | "mainnet" | "devnet";
  source: typeof COMPOSE_SYNAPSE_SOURCE;
  rpcUrl: string | null;
}

export function resolveSynapseChain(network: MeshSynapseConfig["network"]): Chain {
  switch (network) {
    case "mainnet":
      return mainnet;
    case "devnet":
      return devnet;
    case "calibration":
    default:
      return calibration;
  }
}

export function loadMeshSynapseConfig(env: NodeJS.ProcessEnv = process.env): MeshSynapseConfig {
  const parsed = EnvSchema.parse(env);
  const rpcUrl = parsed.SYNAPSE_RPC_URL
    || (parsed.SYNAPSE_NETWORK === "mainnet" ? parsed.FILECOIN_MAINNET_RPC : undefined)
    || (parsed.SYNAPSE_NETWORK === "devnet" ? parsed.FILECOIN_DEVNET_RPC : undefined)
    || (parsed.SYNAPSE_NETWORK === "calibration" ? parsed.FILECOIN_CALIBRATION_RPC : undefined)
    || null;

  const source = parsed.SYNAPSE_PROJECT_NAMESPACE.trim().toLowerCase();
  if (source !== COMPOSE_SYNAPSE_SOURCE) {
    throw new Error(`SYNAPSE_PROJECT_NAMESPACE must be "${COMPOSE_SYNAPSE_SOURCE}" for Compose mesh anchors`);
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
  if (value === "production") {
    return "prod";
  }
  if (value === "development") {
    return "dev";
  }
  if (value.length === 0) {
    return "prod";
  }
  return value;
}

export function createComposeDatasetMetadata(
  config: MeshSynapseConfig,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return {
    Application: "compose",
    Collection: "compose",
    Environment: environmentLabel(env),
    Network: config.network,
    Domain: "compose.market",
    Schema: "compose.mesh.state.v2",
  };
}

export function createComposePieceMetadata(input: {
  haiId: string;
  path: string;
  agentWallet: `0x${string}`;
  userAddress: `0x${string}`;
  deviceId: string;
}): Record<string, string> {
  const latestPath = `compose-${input.haiId}:latest`;
  return {
    name: input.path,
    Agent: input.agentWallet.toLowerCase(),
    User: input.userAddress.toLowerCase(),
    Device: input.deviceId,
    Latest: latestPath,
  };
}
