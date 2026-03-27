import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { peerIdFromString } from "@libp2p/peer-id";
import { encodePacked, keccak256 } from "viem";
import { z } from "zod";
import type {
    MeshSignedRequestAction,
    MeshSignedRequestEnvelope,
    MeshSynapseAnchorRequest,
    MeshSynapseReadRequest,
} from "./types.js";

const enc = new TextEncoder();
const sigMs = 10 * 60 * 1000;
const haiModulus = 36n ** 6n;
const haiDomain = ":compose:hai:v1";

export const walletRe = /^0x[a-f0-9]{40}$/i;
export const hex32Re = /^0x[a-f0-9]{64}$/i;
export const sigRe = /^[a-f0-9]+$/i;
export const haiRe = /^[a-z0-9]{6}$/i;
export const stateRe = /^compose-([a-z0-9]{6})-#(\d+)$/i;
const pkRe = /^0x[a-f0-9]{64}$/i;

export class MeshA409Error extends Error {
    readonly code = "a409" as const;

    constructor(message = "inconsistent agent identity") {
        super(message);
        this.name = "MeshA409Error";
    }
}

export function a409(message = "inconsistent agent identity"): MeshA409Error {
    return new MeshA409Error(message);
}

export function isA409(error: unknown): error is MeshA409Error {
    return error instanceof MeshA409Error;
}

const reqSchema = z.object({
    version: z.literal(1),
    kind: z.literal("compose.mesh.request.v1"),
    action: z.literal("compose.state.read.v1"),
    collection: z.literal("compose"),
    requesterHaiId: z.string().regex(haiRe).transform((value) => value.toLowerCase()),
    requesterAgentWallet: z.string().regex(walletRe).transform((value) => value.toLowerCase() as `0x${string}`),
    requesterUserAddress: z.string().regex(walletRe).transform((value) => value.toLowerCase() as `0x${string}`),
    requesterDeviceId: z.string().trim().min(8).max(128),
    requesterPeerId: z.string().trim().min(1),
    targetPath: z.string().trim().min(1),
    targetPieceCid: z.string().trim().min(1).nullable().optional(),
    targetDataSetId: z.string().trim().min(1).nullable().optional(),
    targetPieceId: z.string().trim().min(1).nullable().optional(),
    signedAt: z.number().int().positive(),
    signature: z.string().regex(sigRe),
}).strict();

const anchorSchema = z.object({
    version: z.number().int().positive(),
    kind: z.literal("compose.mesh.state.v2"),
    collection: z.literal("compose"),
    haiId: z.string().regex(haiRe).transform((value) => value.toLowerCase()),
    updateNumber: z.number().int().positive(),
    path: z.string().regex(stateRe),
    peerId: z.string().trim().min(1),
    agentWallet: z.string().regex(walletRe).transform((value) => value.toLowerCase() as `0x${string}`),
    userAddress: z.string().regex(walletRe).transform((value) => value.toLowerCase() as `0x${string}`),
    deviceId: z.string().trim().min(8).max(128),
    chainId: z.number().int().positive(),
    signedAt: z.number().int().positive(),
    stateRootHash: z.string().regex(hex32Re).transform((value) => value.toLowerCase() as `0x${string}`),
    snapshot: z.unknown(),
    signature: z.string().regex(sigRe),
}).strict();

export interface HaiRow {
    version: 1;
    agentWallet: `0x${string}`;
    userAddress: `0x${string}`;
    deviceId: string;
    haiId: string;
    synapseSessionPrivateKey: `0x${string}`;
    payerAddress: `0x${string}` | null;
    sessionKeyExpiresAt: number | null;
    nextUpdateNumber: number;
    lastUpdateNumber: number | null;
    lastPath: string | null;
    lastStateRootHash: `0x${string}` | null;
    lastPieceCid: string | null;
    lastAnchoredAt: number | null;
    updatedAt: number;
}

function baseDir(env: NodeJS.ProcessEnv = process.env): string {
    const dir = String(env.COMPOSE_LOCAL_BASE_DIR || "").trim();
    if (!dir) {
        throw new Error("COMPOSE_LOCAL_BASE_DIR is required for local HAI registration");
    }
    return dir;
}

function dirPath(env: NodeJS.ProcessEnv = process.env): string {
    return path.join(baseDir(env), "synapse", "hai");
}

function rowPath(
    agentWallet: `0x${string}`,
    userAddress: `0x${string}`,
    deviceId: string,
    env: NodeJS.ProcessEnv = process.env,
): string {
    return path.join(dirPath(env), `${agentWallet}__${userAddress}__${deviceId}.json`);
}

function hex(input: string): string {
    return createHash("sha256").update(input).digest("hex");
}

function normWallet(value: string, field: string): `0x${string}` {
    const normalized = value.trim().toLowerCase();
    if (!walletRe.test(normalized)) {
        throw new Error(`${field} must be a valid wallet address`);
    }
    return normalized as `0x${string}`;
}

function normDev(value: string): string {
    const normalized = value.trim();
    if (normalized.length < 8 || normalized.length > 128) {
        throw new Error("deviceId is invalid");
    }
    return normalized;
}

function hexBytes(value: string): Uint8Array {
    const normalized = value.trim();
    if (!normalized || normalized.length % 2 !== 0) {
        throw new Error("Invalid hex signature encoding");
    }
    return Uint8Array.from(Buffer.from(normalized, "hex"));
}

function stable(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map((item) => stable(item));
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, nested]) => [key, stable(nested)]),
        );
    }
    return value;
}

function within(ts: number, label: string): void {
    const now = Date.now();
    if (ts > now + sigMs || ts < now - sigMs) {
        throw new Error(`${label} signature timestamp is outside the accepted window`);
    }
}

async function verifySig(peerIdText: string, payload: string, sig: string, label: string): Promise<void> {
    const peer = peerIdFromString(peerIdText.trim());
    if (!peer.publicKey) {
        throw a409(`${label} peerId must contain inline public key material`);
    }
    const ok = await peer.publicKey.verify(enc.encode(payload), hexBytes(sig));
    if (!ok) {
        throw a409(`${label} signature verification failed`);
    }
}

function reqBytes(env: Omit<MeshSignedRequestEnvelope, "signature">): string {
    return JSON.stringify([
        env.version,
        env.kind,
        env.action,
        env.collection,
        env.requesterHaiId,
        env.requesterAgentWallet,
        env.requesterUserAddress,
        env.requesterDeviceId,
        env.requesterPeerId,
        env.targetPath,
        env.targetPieceCid ?? null,
        env.targetDataSetId ?? null,
        env.targetPieceId ?? null,
        env.signedAt,
    ]);
}

function encodeHaiBase36(value: bigint): string {
    return value.toString(36).padStart(6, "0").slice(-6);
}

function deriveHaiSeed(input: {
    userAddress: `0x${string}`;
    agentWallet: `0x${string}`;
    deviceId: string;
}): `0x${string}` {
    return keccak256(
        encodePacked(
            ["string", "address", "address", "string"],
            [haiDomain, input.userAddress, input.agentWallet, input.deviceId],
        ),
    );
}

export function sha256Hex(value: string): `0x${string}` {
    return `0x${hex(value)}` as `0x${string}`;
}

export function mkHai(input: {
    userAddress: string;
    agentWallet: string;
    deviceId: string;
}): string {
    const userAddress = normWallet(input.userAddress, "userAddress");
    const agentWallet = normWallet(input.agentWallet, "agentWallet");
    const deviceId = normDev(input.deviceId);
    const seed = deriveHaiSeed({ userAddress, agentWallet, deviceId });
    const numeric = BigInt(`0x${seed.slice(2, 18)}`) % haiModulus;
    return encodeHaiBase36(numeric);
}

export function parseStatePath(pathText: string): { hai: string; n: number } {
    const hit = stateRe.exec(pathText.trim());
    if (!hit) {
        throw new Error("Invalid compose mesh state path");
    }
    return {
        hai: hit[1].toLowerCase(),
        n: Number(hit[2]),
    };
}

export async function ensureHai(input: {
    agentWallet: string;
    userAddress: string;
    deviceId: string;
    sessionKeyPrivateKey?: string | null;
}, env: NodeJS.ProcessEnv = process.env): Promise<HaiRow> {
    const agentWallet = normWallet(input.agentWallet, "agentWallet");
    const userAddress = normWallet(input.userAddress, "userAddress");
    const deviceId = normDev(input.deviceId);
    const file = rowPath(agentWallet, userAddress, deviceId, env);
    await mkdir(dirPath(env), { recursive: true });

    try {
        const raw = await readFile(file, "utf8");
        const row = JSON.parse(raw) as HaiRow;
        const haiId = mkHai({ userAddress, agentWallet, deviceId });
        const normalized: HaiRow = {
            ...row,
            agentWallet,
            userAddress,
            deviceId,
            haiId,
            synapseSessionPrivateKey: normPk(row.synapseSessionPrivateKey),
            payerAddress: row.payerAddress ? normWallet(row.payerAddress, "payerAddress") : null,
            sessionKeyExpiresAt: Number.isFinite(row.sessionKeyExpiresAt) ? Number(row.sessionKeyExpiresAt) : null,
            nextUpdateNumber: Number.isInteger(row.nextUpdateNumber) && row.nextUpdateNumber > 0 ? row.nextUpdateNumber : 1,
            lastUpdateNumber: Number.isInteger(row.lastUpdateNumber) ? row.lastUpdateNumber : null,
            lastPath: typeof row.lastPath === "string" && row.lastPath.trim().length > 0 ? row.lastPath : null,
            lastStateRootHash: row.lastStateRootHash ? row.lastStateRootHash.toLowerCase() as `0x${string}` : null,
            lastPieceCid: typeof row.lastPieceCid === "string" && row.lastPieceCid.trim().length > 0 ? row.lastPieceCid : null,
            lastAnchoredAt: Number.isFinite(row.lastAnchoredAt) ? Number(row.lastAnchoredAt) : null,
            updatedAt: Date.now(),
        };
        await saveHai(normalized, env);
        return normalized;
    } catch (error) {
        const errno = error as NodeJS.ErrnoException;
        if (errno?.code !== "ENOENT") {
            throw error;
        }
    }

    const row: HaiRow = {
        version: 1,
        agentWallet,
        userAddress,
        deviceId,
        haiId: mkHai({ userAddress, agentWallet, deviceId }),
        synapseSessionPrivateKey: input.sessionKeyPrivateKey
            ? normPk(input.sessionKeyPrivateKey)
            : `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
        payerAddress: null,
        sessionKeyExpiresAt: null,
        nextUpdateNumber: 1,
        lastUpdateNumber: null,
        lastPath: null,
        lastStateRootHash: null,
        lastPieceCid: null,
        lastAnchoredAt: null,
        updatedAt: Date.now(),
    };
    await saveHai(row, env);
    return row;
}

async function saveHai(row: HaiRow, env: NodeJS.ProcessEnv = process.env): Promise<HaiRow> {
    const file = rowPath(row.agentWallet, row.userAddress, row.deviceId, env);
    await mkdir(dirPath(env), { recursive: true });
    await writeFile(file, JSON.stringify(row, null, 2), "utf8");
    return row;
}

export async function markHaiAnchor(input: {
    agentWallet: string;
    userAddress: string;
    deviceId: string;
    updateNumber: number;
    path: string;
    stateRootHash: `0x${string}`;
    pieceCid: string;
    anchoredAt: number;
    payerAddress?: `0x${string}` | null;
    sessionKeyExpiresAt?: number | null;
}, env: NodeJS.ProcessEnv = process.env): Promise<HaiRow> {
    const row = await ensureHai({
        agentWallet: input.agentWallet,
        userAddress: input.userAddress,
        deviceId: input.deviceId,
    }, env);
    row.nextUpdateNumber = input.updateNumber + 1;
    row.lastUpdateNumber = input.updateNumber;
    row.lastPath = input.path;
    row.lastStateRootHash = input.stateRootHash;
    row.lastPieceCid = input.pieceCid;
    row.lastAnchoredAt = input.anchoredAt;
    row.payerAddress = input.payerAddress ?? row.payerAddress ?? null;
    row.sessionKeyExpiresAt = input.sessionKeyExpiresAt ?? row.sessionKeyExpiresAt ?? null;
    row.updatedAt = Date.now();
    return saveHai(row, env);
}

function expectSameReq(
    env: MeshSignedRequestEnvelope,
    want: {
        agentWallet: `0x${string}`;
        userAddress: `0x${string}`;
        deviceId: string;
        path: string;
        pieceCid?: string | null;
        dataSetId?: string | null;
        pieceId?: string | null;
    },
): void {
    if (env.requesterAgentWallet !== want.agentWallet) throw a409("Signed HAI agentWallet does not match the request");
    if (env.requesterUserAddress !== want.userAddress) throw a409("Signed HAI userAddress does not match the request");
    if (env.requesterDeviceId !== want.deviceId) throw a409("Signed HAI deviceId does not match the request");
    if (env.targetPath !== want.path) throw a409("Signed HAI path does not match the request");
    if ((env.targetPieceCid ?? null) !== (want.pieceCid ?? null)) throw a409("Signed HAI pieceCid does not match the request");
    if ((env.targetDataSetId ?? null) !== (want.dataSetId ?? null)) throw a409("Signed HAI dataSetId does not match the request");
    if ((env.targetPieceId ?? null) !== (want.pieceId ?? null)) throw a409("Signed HAI pieceId does not match the request");
}

async function verifyReq(input: {
    raw: string;
    action: MeshSignedRequestAction;
    want: {
        agentWallet: `0x${string}`;
        userAddress: `0x${string}`;
        deviceId: string;
        path: string;
        pieceCid?: string | null;
        dataSetId?: string | null;
        pieceId?: string | null;
    };
}): Promise<MeshSignedRequestEnvelope> {
    let raw: unknown;
    try {
        raw = JSON.parse(input.raw);
    } catch {
        throw new Error("Signed HAI envelope must be valid JSON");
    }

    const env = reqSchema.parse(raw) as MeshSignedRequestEnvelope;
    within(env.signedAt, "Signed HAI");
    if (env.action !== input.action) {
        throw new Error(`Signed HAI action must be ${input.action}`);
    }
    if (env.requesterHaiId !== mkHai({
        userAddress: env.requesterUserAddress,
        agentWallet: env.requesterAgentWallet,
        deviceId: env.requesterDeviceId,
    })) {
        throw a409("Signed HAI does not match the requester triplet");
    }

    expectSameReq(env, input.want);

    const { signature, ...unsigned } = env;
    await verifySig(env.requesterPeerId, reqBytes(unsigned), signature, "Signed HAI");
    return env;
}

export async function verifyAnchor(req: MeshSynapseAnchorRequest): Promise<void> {
    const parsedPath = parseStatePath(req.path);
    if (parsedPath.hai !== req.haiId.toLowerCase()) throw a409("Mesh state path haiId does not match the request");
    if (parsedPath.n !== req.updateNumber) throw a409("Mesh state path number does not match the request");

    let raw: unknown;
    try {
        raw = JSON.parse(req.envelopeJson);
    } catch {
        throw new Error("Mesh state envelope must be valid JSON");
    }

    const env = anchorSchema.parse(raw);
    within(env.signedAt, "Mesh state");
    if (env.haiId !== mkHai({
        userAddress: env.userAddress,
        agentWallet: env.agentWallet,
        deviceId: env.deviceId,
    })) {
        throw a409("Mesh state HAI does not match the triplet");
    }
    if (env.haiId !== req.haiId.toLowerCase()) throw a409("Mesh state HAI does not match the request");
    if (env.updateNumber !== req.updateNumber) throw a409("Mesh state update number does not match the request");
    if (env.path !== req.path) throw a409("Mesh state path does not match the request");
    if (env.agentWallet !== req.agentWallet.toLowerCase()) throw a409("Mesh state agentWallet does not match the request");
    if (env.userAddress !== req.userAddress.toLowerCase()) throw a409("Mesh state userAddress does not match the request");
    if (env.deviceId !== req.deviceId) throw a409("Mesh state deviceId does not match the request");
    if (env.chainId !== req.chainId) throw a409("Mesh state chainId does not match the request");

    const root = sha256Hex(req.canonicalSnapshotJson);
    if (root !== req.stateRootHash.toLowerCase()) throw a409("Mesh state root hash does not match canonicalSnapshotJson");
    if (env.stateRootHash !== root) throw a409("Mesh state envelope root hash does not match canonicalSnapshotJson");

    let parsedSnapshot: unknown;
    try {
        parsedSnapshot = JSON.parse(req.canonicalSnapshotJson);
    } catch {
        throw new Error("canonicalSnapshotJson must be valid JSON");
    }
    if (JSON.stringify(stable(parsedSnapshot)) !== JSON.stringify(stable(env.snapshot))) {
        throw a409("Mesh state snapshot does not match canonicalSnapshotJson");
    }

    await verifySig(env.peerId, req.canonicalSnapshotJson, env.signature, "Mesh state");
}

export async function verifyStateRead(req: MeshSynapseReadRequest): Promise<MeshSignedRequestEnvelope> {
    const parsedPath = parseStatePath(req.path);
    if (parsedPath.hai !== req.haiId.toLowerCase()) throw a409("Mesh state read path haiId does not match the request");
    return verifyReq({
        raw: req.signedRequestJson,
        action: "compose.state.read.v1",
        want: {
            agentWallet: req.agentWallet,
            userAddress: req.userAddress,
            deviceId: req.deviceId,
            path: req.path,
            pieceCid: req.pieceCid,
            dataSetId: req.dataSetId,
            pieceId: req.pieceId,
        },
    });
}

export function signBytes(env: Omit<MeshSignedRequestEnvelope, "signature">): string {
    return reqBytes(env);
}

export function isHaiReady(env: NodeJS.ProcessEnv = process.env): boolean {
    return String(env.COMPOSE_LOCAL_BASE_DIR || "").trim().length > 0;
}

export function normPk(value: string): `0x${string}` {
    const normalized = value.trim().toLowerCase();
    if (!pkRe.test(normalized)) {
        throw new Error("sessionKeyPrivateKey must be a valid hex private key");
    }
    return normalized as `0x${string}`;
}
