import express, { type Request, type Response, type Router } from "express";
import { z } from "zod";
import { ensureHai, isA409, verifyAnchor } from "./hai.js";
import { loadMeshSynapseConfig } from "./config.js";
import { anchorMeshState } from "./anchor.js";
import type { MeshSynapseAnchorRequest } from "./types.js";

const walletPattern = /^0x[a-f0-9]{40}$/i;
const hex32Pattern = /^0x[a-f0-9]{64}$/i;
const privateKeyPattern = /^0x[a-f0-9]{64}$/i;
const haiIdPattern = /^[a-z0-9]{6}$/i;
const pathPattern = /^compose-[a-z0-9]{6}-#\d+$/i;

const AnchorRequestSchema = z.object({
  apiUrl: z.string().trim().url(),
  composeKeyToken: z.string().trim().min(1),
  userAddress: z.string().regex(walletPattern).transform((value) => value.toLowerCase() as `0x${string}`),
  agentWallet: z.string().regex(walletPattern).transform((value) => value.toLowerCase() as `0x${string}`),
  deviceId: z.string().trim().min(8).max(128),
  chainId: z.number().int().positive(),
  targetSynapseExpiry: z.number().int().positive(),
  haiId: z.string().regex(haiIdPattern).transform((value) => value.toLowerCase()),
  updateNumber: z.number().int().positive(),
  path: z.string().regex(pathPattern),
  canonicalSnapshotJson: z.string().trim().min(2),
  stateRootHash: z.string().regex(hex32Pattern).transform((value) => value.toLowerCase() as `0x${string}`),
  envelopeJson: z.string().trim().min(2),
  sessionKeyPrivateKey: z.string().regex(privateKeyPattern).transform((value) => value.toLowerCase() as `0x${string}`),
  payerAddress: z.string().regex(walletPattern).transform((value) => value.toLowerCase() as `0x${string}`).nullable().optional(),
  sessionKeyExpiresAt: z.number().int().positive().nullable().optional(),
}).strict();

const RegisterHaiRequestSchema = z.object({
  agentWallet: z.string().regex(walletPattern).transform((value) => value.toLowerCase() as `0x${string}`),
  userAddress: z.string().regex(walletPattern).transform((value) => value.toLowerCase() as `0x${string}`),
  deviceId: z.string().trim().min(8).max(128),
  sessionKeyPrivateKey: z.string().regex(privateKeyPattern).transform((value) => value.toLowerCase() as `0x${string}`).nullable().optional(),
}).strict();

function extractRuntimeToken(req: Request): string | null {
  const header = req.headers["x-compose-local-runtime-token"];
  if (Array.isArray(header)) {
    return header[0] ?? null;
  }
  if (typeof header === "string" && header.trim().length > 0) {
    return header.trim();
  }
  return null;
}

function requireLocalRuntimeAuth(req: Request, res: Response): boolean {
  const expected = loadMeshSynapseConfig().runtimeAuthToken;
  if (extractRuntimeToken(req) !== expected) {
    res.status(401).json({
      error: "Missing or invalid local runtime auth token",
    });
    return false;
  }
  return true;
}

export function createMeshRouter(): Router {
  const router = express.Router();

  router.post("/hai/register", async (req: Request, res: Response) => {
    if (!requireLocalRuntimeAuth(req, res)) {
      return;
    }

    const parsed = RegisterHaiRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid HAI registration payload",
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }

    try {
      const row = await ensureHai(parsed.data);
      res.status(200).json(row);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to register HAI",
      });
    }
  });

  router.post("/synapse/anchor", async (req: Request, res: Response) => {
    if (!requireLocalRuntimeAuth(req, res)) {
      return;
    }

    const parsed = AnchorRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid mesh Synapse anchor payload",
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }

    try {
      const request = parsed.data as MeshSynapseAnchorRequest;
      await verifyAnchor(request);
      const result = await anchorMeshState(request);
      res.status(200).json(result);
    } catch (error) {
      if (isA409(error)) {
        res.status(409).json({
          error: error.message,
          code: error.code,
        });
        return;
      }
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to anchor mesh state",
      });
    }
  });

  return router;
}
