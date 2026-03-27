const envLabel = (env: NodeJS.ProcessEnv = process.env): string => {
  const value = String(env.NODE_ENV || "production").trim().toLowerCase();
  if (!value || value === "production") {
    return "prod";
  }
  if (value === "development") {
    return "dev";
  }
  return value;
};

export const LEARNINGS_DATASET = "learnings";
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

export function createLearningsDatasetMetadata(input: {
  network: "calibration" | "mainnet";
  env?: NodeJS.ProcessEnv;
}): Record<string, string> {
  return {
    Application: "compose",
    Collection: LEARNINGS_DATASET,
    Environment: envLabel(input.env),
    Network: input.network,
    Domain: "compose.market",
  };
}

export function createLearningPieceMetadata(input: {
  haiId: string;
  kind: MeshLearningKind;
  path: string;
  agentWallet: `0x${string}`;
  userAddress: `0x${string}`;
  deviceId: string;
}): Record<string, string> {
  return {
    name: input.path,
    HAI: input.haiId.toLowerCase(),
    ArtifactKind: input.kind,
    Agent: input.agentWallet.toLowerCase(),
  };
}

export function encodeLearningPayload(payload: unknown): Uint8Array {
  const text = typeof payload === "string"
    ? payload
    : JSON.stringify(payload);
  return new TextEncoder().encode(text);
}
