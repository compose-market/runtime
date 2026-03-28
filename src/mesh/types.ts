export type MeshSharedArtifactKind = "learning" | "report" | "resource" | "ticket";
export type MeshSignedRequestAction = "compose.state.read" | "learning.pin";

export interface MeshSignedRequestEnvelope {
  version: 1;
  kind: "compose.mesh.request";
  action: MeshSignedRequestAction;
  collection: "compose" | "learnings";
  requesterHaiId: string;
  requesterAgentWallet: `0x${string}`;
  requesterUserAddress: `0x${string}`;
  requesterDeviceId: string;
  requesterPeerId: string;
  targetPath: string;
  targetPieceCid?: string | null;
  targetDataSetId?: string | null;
  targetPieceId?: string | null;
  artifactKind?: MeshSharedArtifactKind | null;
  fileName?: string | null;
  rootCid?: string | null;
  payloadSha256?: `0x${string}` | null;
  signedAt: number;
  signature: string;
}

export interface MeshSessionRequest {
  apiUrl: string;
  composeKeyToken: string;
  userAddress: `0x${string}`;
  agentWallet: `0x${string}`;
  deviceId: string;
  chainId: number;
  targetSynapseExpiry: number;
  sessionKeyPrivateKey: `0x${string}`;
  payerAddress?: `0x${string}` | null;
  sessionKeyExpiresAt?: number | null;
}

export interface MeshSynapseAnchorRequest extends MeshSessionRequest {
  haiId: string;
  updateNumber: number;
  path: string;
  canonicalSnapshotJson: string;
  stateRootHash: `0x${string}`;
  envelopeJson: string;
}

export interface MeshSynapseAnchorResponse {
  haiId: string;
  updateNumber: number;
  path: string;
  fileName: string;
  latestAlias: string;
  stateRootHash: `0x${string}`;
  pdpPieceCid: string;
  pdpAnchoredAt: number;
  payloadSize: number;
  providerId: string;
  dataSetId: string | null;
  pieceId: string | null;
  retrievalUrl: string | null;
  payerAddress: `0x${string}`;
  sessionKeyExpiresAt: number;
  source: string;
}

export interface MeshSynapseReadRequest extends MeshSessionRequest {
  updateNumber: number;
  stateRootHash: `0x${string}`;
  haiId: string;
  artifactKind: MeshSharedArtifactKind;
  path: string;
  fileName: string;
  rootCid: string;
  pieceCid: string;
  dataSetId: string;
  pieceId: string;
  signedRequestJson: string;
}

export interface MeshSharedArtifactPinRequest extends MeshSessionRequest {
  signedRequestJson: string;
  haiId: string;
  artifactKind: MeshSharedArtifactKind;
  artifactNumber: number;
  path: string;
  payloadJson: string;
  publisherAddress?: `0x${string}` | null;
  accessPriceUsdc?: string | null;
  title?: string | null;
  summary?: string | null;
  copies?: number;
}

export interface MeshSharedArtifactPinResponse {
  haiId: string;
  artifactKind: MeshSharedArtifactKind;
  artifactNumber: number;
  path: string;
  fileName: string;
  latestAlias: string;
  rootCid: string;
  pieceCid: string;
  payloadSize: number;
  copyCount: number;
  providerId: string;
  dataSetId: string | null;
  pieceId: string | null;
  retrievalUrl: string | null;
  payerAddress: `0x${string}`;
  sessionKeyExpiresAt: number;
  source: string;
  collection: "learnings";
}

export interface MeshSharedArtifactReadRequest extends MeshSessionRequest {
}

export interface MeshSharedArtifactReadResponse {
  haiId: string;
  artifactKind: MeshSharedArtifactKind;
  path: string;
  fileName: string;
  rootCid: string;
  payloadJson: string;
  collection: "learnings";
}

export interface LocalSynapseProvisionResponse {
  success: true;
  payerAddress: `0x${string}`;
  sessionKeyAddress: `0x${string}`;
  sessionKeyExpiresAt: number;
  availableFunds: string;
  depositAmount: string;
  depositExecuted: boolean;
  network: "calibration" | "mainnet";
  source: string;
}
