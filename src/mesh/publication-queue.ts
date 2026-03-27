import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const REQUEST_POLL_INTERVAL_MS = 250;
const DEFAULT_WAIT_TIMEOUT_MS = 90_000;

export type MeshPublicationQueueKind = "manifest.publish" | "learning.pin";

interface MeshPublicationQueueBaseRequest {
  requestId: string;
  kind: MeshPublicationQueueKind;
  agentWallet: `0x${string}`;
  requestedAt: number;
}

export interface MeshPublicationQueueRequest extends MeshPublicationQueueBaseRequest {
  reason?: string;
  title?: string;
  summary?: string;
  content?: string;
  accessPriceUsdc?: string;
}

export interface MeshPublicationQueueResult {
  requestId: string;
  kind?: MeshPublicationQueueKind;
  success: boolean;
  error?: string;
  haiId?: string;
  updateNumber?: number;
  artifactKind?: "learning" | "report" | "resource" | "ticket";
  artifactNumber?: number;
  path?: string;
  latestAlias?: string;
  rootCid?: string;
  pieceCid?: string;
  collection?: "learnings";
  stateRootHash?: string;
  pdpPieceCid?: string;
  pdpAnchoredAt?: number;
  manifest?: Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseDir(value: string | undefined): string {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error("COMPOSE_LOCAL_BASE_DIR is required for local mesh publication");
  }
  return normalized;
}

function queueRoot(baseDir: string): string {
  return path.join(baseDir, "mesh", "publications");
}

function requestDir(baseDir: string): string {
  return path.join(queueRoot(baseDir), "requests");
}

function resultDir(baseDir: string): string {
  return path.join(queueRoot(baseDir), "results");
}

function requestPath(baseDir: string, requestId: string): string {
  return path.join(requestDir(baseDir), `${requestId}.json`);
}

function resultPath(baseDir: string, requestId: string): string {
  return path.join(resultDir(baseDir), `${requestId}.json`);
}

export function isLocalMeshPublicationAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RUNTIME_HOST_MODE === "local" && String(env.COMPOSE_LOCAL_BASE_DIR || "").trim().length > 0;
}

async function queueLocalMeshRequest(
  request: MeshPublicationQueueRequest,
  options?: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  },
): Promise<MeshPublicationQueueResult> {
  const env = options?.env || process.env;
  if (!isLocalMeshPublicationAvailable(env)) {
    throw new Error("Local mesh publication is only available inside the local runtime host");
  }

  const baseDir = normalizeBaseDir(env.COMPOSE_LOCAL_BASE_DIR);
  const timeoutMs = options?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;

  await mkdir(requestDir(baseDir), { recursive: true });
  await mkdir(resultDir(baseDir), { recursive: true });
  await writeFile(requestPath(baseDir, request.requestId), JSON.stringify(request, null, 2), "utf8");

  const deadline = Date.now() + timeoutMs;
  const outputPath = resultPath(baseDir, request.requestId);

  while (Date.now() < deadline) {
    try {
      const raw = await readFile(outputPath, "utf8");
      const parsed = JSON.parse(raw) as MeshPublicationQueueResult;
      await rm(outputPath, { force: true });
      if (!parsed.success) {
        throw new Error(parsed.error || "Local mesh publication failed");
      }
      return parsed;
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno?.code !== "ENOENT") {
        throw error;
      }
    }

    await sleep(REQUEST_POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for local mesh publication result after ${timeoutMs}ms`);
}

export async function queueLocalMeshPublication(input: {
  agentWallet: `0x${string}`;
  reason?: string;
}, options?: {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<MeshPublicationQueueResult> {
  return queueLocalMeshRequest({
    requestId: `mesh-publish-${randomUUID()}`,
    kind: "manifest.publish",
    agentWallet: input.agentWallet.toLowerCase() as `0x${string}`,
    requestedAt: Date.now(),
    ...(input.reason && input.reason.trim().length > 0
      ? { reason: input.reason.trim() }
      : {}),
    }, options);
  }
  
  export async function queueLocalMeshLearning(input: {
    agentWallet: `0x${string}`;
    title: string;
    summary: string;
    content: string;
    accessPriceUsdc?: string;
  }, options?: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  }): Promise<MeshPublicationQueueResult> {
    return queueLocalMeshRequest({
      requestId: `mesh-learning-${randomUUID()}`,
      kind: "learning.pin",
      agentWallet: input.agentWallet.toLowerCase() as `0x${string}`,
      requestedAt: Date.now(),
      title: input.title.trim(),
      summary: input.summary.trim(),
      content: input.content.trim(),
      ...(input.accessPriceUsdc?.trim() ? { accessPriceUsdc: input.accessPriceUsdc.trim() } : {}),
  }, options);
}
