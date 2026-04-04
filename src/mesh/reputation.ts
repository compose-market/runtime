import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

function clamp(value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.max(0, Math.min(1, value));
}

export interface ReputationReceipt {
    conclaveId: string;
    finishedAt: number;
    success: boolean;
    qualityScore?: number;
}

export interface ReputationEngineOptions {
    receipts: ReputationReceipt[];
    now?: number;
    decayLambda?: number;
}

export interface ReputationSummary {
    score: number;
    successRate: number;
    qualityMultiplier: number;
    activityMultiplier: number;
    totalConclaves: number;
    successfulConclaves: number;
    lastConclaveAt: number | null;
    daysSinceLastConclave: number | null;
}

export interface MeshReputationSummary extends ReputationSummary {
    successfulLearningPublications: number;
    lastLearningAt: number | null;
    lastManifestAt: number | null;
}

interface StoredMeshPublicationResult {
    success?: unknown;
    kind?: unknown;
    path?: unknown;
    collection?: unknown;
    pdpAnchoredAt?: unknown;
}

interface StoredConclaveReceipt {
    conclaveId?: unknown;
    agentWallet?: unknown;
    finishedAt?: unknown;
    success?: unknown;
    exitCode?: unknown;
    qualityScore?: unknown;
}

const DAY_MS = 86_400_000;

function localBaseDir(baseDir?: string, env: NodeJS.ProcessEnv = process.env): string {
    const value = String(baseDir || env.COMPOSE_LOCAL_BASE_DIR || "").trim();
    if (!value) {
        throw new Error("COMPOSE_LOCAL_BASE_DIR is required for mesh reputation");
    }
    return value;
}

function normalizeWallet(value: string): string {
    return value.trim().toLowerCase();
}

async function collectJsonFiles(root: string): Promise<string[]> {
    const output: string[] = [];

    async function walk(current: string): Promise<void> {
        let entries;
        try {
            entries = await readdir(current, { withFileTypes: true });
        } catch (error) {
            const errno = error as NodeJS.ErrnoException;
            if (errno?.code === "ENOENT") {
                return;
            }
            throw error;
        }

        for (const entry of entries) {
            const target = path.join(current, entry.name);
            if (entry.isDirectory()) {
                await walk(target);
                continue;
            }
            if (entry.isFile() && entry.name.endsWith(".json")) {
                output.push(target);
            }
        }
    }

    await walk(root);
    return output.sort((left, right) => left.localeCompare(right));
}

async function readJsonFile(filePath: string): Promise<unknown> {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
}

function numberOrNull(value: unknown): number | null {
    return Number.isFinite(value) ? Number(value) : null;
}

function maxTimestamp(current: number | null, next: number | null): number | null {
    if (next == null) {
        return current;
    }
    if (current == null) {
        return next;
    }
    return Math.max(current, next);
}

async function fileTimestamp(filePath: string): Promise<number | null> {
    try {
        const info = await stat(filePath);
        return Number.isFinite(info.mtimeMs) ? Math.trunc(info.mtimeMs) : null;
    } catch {
        return null;
    }
}

async function readPublicationSignals(
    agentWallet: string,
    env: NodeJS.ProcessEnv,
    baseDir?: string,
): Promise<{
    successfulLearningPublications: number;
    lastLearningAt: number | null;
    lastManifestAt: number | null;
}> {
    const resultsDir = path.join(
        localBaseDir(baseDir, env),
        "mesh",
        "publications",
        "results",
        normalizeWallet(agentWallet),
    );
    const files = await collectJsonFiles(resultsDir);
    let successfulLearningPublications = 0;
    let lastLearningAt: number | null = null;
    let lastManifestAt: number | null = null;

    for (const filePath of files) {
        let parsed: StoredMeshPublicationResult;
        try {
            parsed = await readJsonFile(filePath) as StoredMeshPublicationResult;
        } catch {
            continue;
        }
        if (parsed.success !== true) {
            continue;
        }

        const fallbackTimestamp = await fileTimestamp(filePath);
        const anchoredAt = numberOrNull(parsed.pdpAnchoredAt);
        const fileKind = typeof parsed.kind === "string" ? parsed.kind.trim() : "";
        const resultPath = typeof parsed.path === "string" ? parsed.path.trim() : "";
        const collection = typeof parsed.collection === "string" ? parsed.collection.trim() : "";

        if (
            fileKind === "manifest.publish"
            || (resultPath.startsWith("compose-") && !resultPath.includes("-#"))
        ) {
            lastManifestAt = maxTimestamp(lastManifestAt, anchoredAt ?? fallbackTimestamp);
        }

        if (
            fileKind === "learning.pin"
            || collection === "learnings"
            || (resultPath.startsWith("compose-") && resultPath.includes("-#"))
        ) {
            successfulLearningPublications += 1;
            lastLearningAt = maxTimestamp(lastLearningAt, fallbackTimestamp);
        }
    }

    return {
        successfulLearningPublications,
        lastLearningAt,
        lastManifestAt,
    };
}

async function readConclaveReceipts(
    agentWallet: string,
    env: NodeJS.ProcessEnv,
    baseDir?: string,
): Promise<ReputationReceipt[]> {
    const conclaveDir = path.join(localBaseDir(baseDir, env), "mesh", "conclaves", "results");
    const files = await collectJsonFiles(conclaveDir);
    const targetWallet = normalizeWallet(agentWallet);
    const receipts: ReputationReceipt[] = [];

    for (const filePath of files) {
        let parsed: StoredConclaveReceipt;
        try {
            parsed = await readJsonFile(filePath) as StoredConclaveReceipt;
        } catch {
            continue;
        }

        const receiptWallet = typeof parsed.agentWallet === "string"
            ? normalizeWallet(parsed.agentWallet)
            : "";
        const fileScopedToWallet = filePath.toLowerCase().includes(`${path.sep}${targetWallet}${path.sep}`);
        if (receiptWallet && receiptWallet !== targetWallet) {
            continue;
        }
        if (!receiptWallet && !fileScopedToWallet) {
            continue;
        }

        const conclaveId = typeof parsed.conclaveId === "string"
            ? parsed.conclaveId.trim()
            : path.basename(filePath, ".json");
        const finishedAt = numberOrNull(parsed.finishedAt);
        if (!conclaveId || finishedAt == null) {
            continue;
        }

        const qualityScore = numberOrNull(parsed.qualityScore);
        const success = parsed.success === true
            || numberOrNull(parsed.exitCode) === 0;

        receipts.push({
            conclaveId,
            finishedAt,
            success,
            ...(qualityScore == null ? {} : { qualityScore }),
        });
    }

    receipts.sort((left, right) => right.finishedAt - left.finishedAt);
    return receipts;
}

export function quality(receipts: ReputationReceipt[]): number {
    const scored = receipts
        .map((receipt) => receipt.qualityScore)
        .filter((score): score is number => Number.isFinite(score));

    if (scored.length === 0) {
        return 1;
    }

    return clamp(scored.reduce((sum, score) => sum + clamp(score), 0) / scored.length);
}

export function activity(days: number | null, decay = 0.01): number {
    if (days == null) {
        return 0;
    }
    return clamp(Math.exp(-decay * Math.max(0, days)));
}

export function summarizeReputation(options: ReputationEngineOptions): ReputationSummary {
    const now = options.now ?? Date.now();
    const decay = options.decayLambda ?? 0.01;
    const receipts = [...options.receipts].sort((left, right) => right.finishedAt - left.finishedAt);
    const totalConclaves = receipts.length;
    const successfulConclaves = receipts.filter((receipt) => receipt.success).length;
    const successRate = totalConclaves === 0 ? 0 : successfulConclaves / totalConclaves;
    const lastConclaveAt = receipts[0]?.finishedAt ?? null;
    const daysSinceLastConclave = lastConclaveAt == null ? null : (now - lastConclaveAt) / 86_400_000;
    const qualityMultiplier = quality(receipts);
    const activityMultiplier = activity(daysSinceLastConclave, decay);

    return {
        score: clamp(successRate * qualityMultiplier * activityMultiplier),
        successRate: clamp(successRate),
        qualityMultiplier,
        activityMultiplier,
        totalConclaves,
        successfulConclaves,
        lastConclaveAt,
        daysSinceLastConclave,
    };
}

export async function readMeshReputationSummary(input: {
    agentWallet: string;
    baseDir?: string;
    env?: NodeJS.ProcessEnv;
    now?: number;
    decayLambda?: number;
}): Promise<MeshReputationSummary> {
    const env = input.env ?? process.env;
    const [receipts, publicationSignals] = await Promise.all([
        readConclaveReceipts(input.agentWallet, env, input.baseDir),
        readPublicationSignals(input.agentWallet, env, input.baseDir),
    ]);
    const summary = summarizeReputation({
        receipts,
        now: input.now,
        decayLambda: input.decayLambda,
    });

    return {
        ...summary,
        successfulLearningPublications: publicationSignals.successfulLearningPublications,
        lastLearningAt: publicationSignals.lastLearningAt,
        lastManifestAt: publicationSignals.lastManifestAt,
    };
}
