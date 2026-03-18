export interface MeshSynapseAnchorRequest {
  apiUrl: string;
  composeKeyToken: string;
  userAddress: `0x${string}`;
  agentWallet: `0x${string}`;
  deviceId: string;
  chainId: number;
  targetSynapseExpiry: number;
  haiId: string;
  updateNumber: number;
  path: string;
  canonicalSnapshotJson: string;
  stateRootHash: `0x${string}`;
  envelopeJson: string;
  sessionKeyPrivateKey: `0x${string}`;
  payerAddress?: `0x${string}` | null;
  sessionKeyExpiresAt?: number | null;
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

export interface LocalSynapseProvisionResponse {
  success: true;
  payerAddress: `0x${string}`;
  sessionKeyAddress: `0x${string}`;
  sessionKeyExpiresAt: number;
  availableFunds: string;
  depositAmount: string;
  depositExecuted: boolean;
  network: "calibration" | "mainnet" | "devnet";
  source: string;
}
