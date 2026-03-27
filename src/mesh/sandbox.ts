import "dotenv/config";
import { createHash } from "node:crypto";
import {
    CodeLanguage,
    Daytona,
    DaytonaNotFoundError,
    type CreateSandboxFromSnapshotParams,
    type DaytonaConfig as DaytonaSdkConfig,
} from "@daytonaio/sdk";
import type { Hex } from "viem";
import { z } from "zod";

const EnvSchema = z.object({
    DAYTONA_API_KEY: z.string().trim().min(1),
    DAYTONA_API_URL: z.string().trim().url().default("https://app.daytona.io/api"),
    DAYTONA_TARGET: z.string().trim().min(1).optional(),
    DAYTONA_CONCLAVE_SNAPSHOT_ID: z.string().trim().min(1).optional(),
    DAYTONA_SANDBOX_LANGUAGE: z.string().trim().default("typescript"),
    DAYTONA_SANDBOX_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
    DAYTONA_AUTO_DELETE_INTERVAL: z.coerce.number().int().min(0).default(5),
});

function toHex(input: string): Hex {
    return `0x${createHash("sha256").update(input).digest("hex")}`;
}

function normalizeStringList(values: string[]): string[] {
    return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort((left, right) => left.localeCompare(right));
}

export interface DaytonaRuntimeConfig {
    apiKey: string;
    apiUrl: string;
    target?: string;
    snapshotId: string | null;
    language: CodeLanguage;
    timeoutMs: number;
    autoDeleteInterval: number;
}

export interface MeteringRecord {
    type: "meter";
    agentWallet: `0x${string}`;
    messages?: number;
    tokensIn?: number;
    tokensOut?: number;
    toolCalls?: number;
    outputHash?: string;
}

export interface ConclaveSandboxSpec {
    conclaveId: string;
    command: string;
    cwd?: string;
    envVars?: Record<string, string>;
    labels?: Record<string, string>;
    snapshotId?: string | null;
    language?: CodeLanguage;
    autoDeleteInterval?: number;
    timeoutMs?: number;
    networkBlockAll?: boolean;
    networkAllowList?: string;
}

export interface DaytonaConclaveReceipt {
    sandboxId: string;
    snapshotId: string | null;
    imageRef: string | null;
    startedAt: number;
    finishedAt: number;
    exitCode: number;
    stdout: string;
    stderr: string;
    meteringRecords: MeteringRecord[];
    artifactRootHash: Hex;
    meteringRootHash: Hex;
}

export interface DaytonaSandboxLike {
    id: string;
    snapshot?: string;
    buildInfo?: {
        imageName?: string;
    };
    process: {
        createSession(sessionId: string): Promise<void>;
        deleteSession(sessionId: string): Promise<void>;
        executeSessionCommand(
            sessionId: string,
            request: {
                command: string;
                runAsync?: boolean;
                suppressInputEcho?: boolean;
            },
            timeoutSeconds?: number,
        ): Promise<{
            exitCode?: number;
            output?: string;
            stdout?: string;
            stderr?: string;
        }>;
    };
    stop(timeoutSeconds?: number): Promise<void>;
    delete(timeoutSeconds?: number): Promise<void>;
}

export interface DaytonaLike {
    create(
        params?: CreateSandboxFromSnapshotParams,
        options?: {
            timeout?: number;
        },
    ): Promise<DaytonaSandboxLike>;
    delete(sandbox: DaytonaSandboxLike, timeoutSeconds?: number): Promise<void>;
}

function normalizeLanguage(language: string): CodeLanguage {
    switch (language.trim().toLowerCase()) {
        case "javascript":
            return CodeLanguage.JAVASCRIPT;
        case "python":
            return CodeLanguage.PYTHON;
        case "typescript":
        default:
            return CodeLanguage.TYPESCRIPT;
    }
}

function timeoutMsToSeconds(timeoutMs: number): number {
    return Math.max(1, Math.ceil(timeoutMs / 1000));
}

function gone(error: unknown): boolean {
    return error instanceof DaytonaNotFoundError;
}

export function loadDaytonaConfig(env: NodeJS.ProcessEnv = process.env): DaytonaRuntimeConfig {
    const parsed = EnvSchema.parse(env);
    return {
        apiKey: parsed.DAYTONA_API_KEY,
        apiUrl: parsed.DAYTONA_API_URL,
        target: parsed.DAYTONA_TARGET,
        snapshotId: parsed.DAYTONA_CONCLAVE_SNAPSHOT_ID || null,
        language: normalizeLanguage(parsed.DAYTONA_SANDBOX_LANGUAGE),
        timeoutMs: parsed.DAYTONA_SANDBOX_TIMEOUT_MS,
        autoDeleteInterval: parsed.DAYTONA_AUTO_DELETE_INTERVAL,
    };
}

export function createDaytonaClient(config: DaytonaRuntimeConfig): Daytona {
    const clientConfig: DaytonaSdkConfig = {
        apiKey: config.apiKey,
        apiUrl: config.apiUrl,
        target: config.target,
    };
    return new Daytona(clientConfig);
}

export function parseMeteringRecords(output: string): MeteringRecord[] {
    const records: MeteringRecord[] = [];

    for (const line of output.split(/\r?\n/g)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
            continue;
        }

        try {
            const parsed = JSON.parse(trimmed) as Record<string, unknown>;
            if (parsed.type !== "meter" || typeof parsed.agentWallet !== "string") {
                continue;
            }

            records.push({
                type: "meter",
                agentWallet: parsed.agentWallet.toLowerCase() as `0x${string}`,
                messages: Number.isFinite(parsed.messages) ? Number(parsed.messages) : undefined,
                tokensIn: Number.isFinite(parsed.tokensIn) ? Number(parsed.tokensIn) : undefined,
                tokensOut: Number.isFinite(parsed.tokensOut) ? Number(parsed.tokensOut) : undefined,
                toolCalls: Number.isFinite(parsed.toolCalls) ? Number(parsed.toolCalls) : undefined,
                outputHash: typeof parsed.outputHash === "string" ? parsed.outputHash : undefined,
            });
        } catch {
            continue;
        }
    }

    records.sort((left, right) => {
        const walletOrder = left.agentWallet.localeCompare(right.agentWallet);
        if (walletOrder !== 0) return walletOrder;
        const outputOrder = (left.outputHash || "").localeCompare(right.outputHash || "");
        if (outputOrder !== 0) return outputOrder;
        return (left.messages || 0) - (right.messages || 0);
    });

    return records;
}

export function hashMeteringRecords(records: MeteringRecord[]): Hex {
    return toHex(JSON.stringify(records));
}

export function hashSandboxArtifacts(input: {
    stdout: string;
    stderr: string;
    exitCode: number;
}): Hex {
    return toHex(JSON.stringify({
        stdout: input.stdout,
        stderr: input.stderr,
        exitCode: input.exitCode,
    }));
}

async function destroySandbox(sandbox: DaytonaSandboxLike, client: DaytonaLike, timeoutSeconds: number): Promise<void> {
    try {
        await sandbox.stop(timeoutSeconds);
    } catch (error) {
        if (!gone(error)) {
            // Ignore stop errors during teardown; delete is the hard cleanup boundary.
        }
    }

    try {
        await client.delete(sandbox, timeoutSeconds);
    } catch (error) {
        if (gone(error)) {
            return;
        }
        try {
            await sandbox.delete(timeoutSeconds);
        } catch (fallbackError) {
            if (!gone(fallbackError)) {
                throw fallbackError;
            }
        }
    }
}

export async function runConclaveSandbox(
    client: DaytonaLike,
    config: DaytonaRuntimeConfig,
    spec: ConclaveSandboxSpec,
): Promise<DaytonaConclaveReceipt> {
    const timeoutMs = spec.timeoutMs ?? config.timeoutMs;
    const timeoutSeconds = timeoutMsToSeconds(timeoutMs);
    const sessionId = `conclave-${spec.conclaveId}`;
    const sandbox = await client.create({
        snapshot: spec.snapshotId ?? config.snapshotId ?? undefined,
        language: spec.language ?? config.language,
        envVars: spec.envVars,
        labels: {
            conclaveId: spec.conclaveId,
            ...spec.labels,
        },
        autoStopInterval: Math.max(1, Math.ceil(timeoutMs / 60_000)),
        ephemeral: true,
        networkBlockAll: spec.networkBlockAll,
        networkAllowList: spec.networkAllowList,
    }, {
        timeout: timeoutSeconds,
    });

    const startedAt = Date.now();

    try {
        await sandbox.process.createSession(sessionId);

        const response = await sandbox.process.executeSessionCommand(
            sessionId,
            {
                command: spec.cwd
                    ? `cd ${JSON.stringify(spec.cwd)} && ${spec.command}`
                    : spec.command,
                runAsync: false,
                suppressInputEcho: true,
            },
            timeoutSeconds,
        );

        const stdout = response.stdout ?? response.output ?? "";
        const stderr = response.stderr ?? "";
        const exitCode = response.exitCode ?? 0;
        const meteringRecords = parseMeteringRecords([stdout, stderr].filter(Boolean).join("\n"));

        return {
            sandboxId: sandbox.id,
            snapshotId: sandbox.snapshot || spec.snapshotId || config.snapshotId || null,
            imageRef: sandbox.buildInfo?.imageName ?? null,
            startedAt,
            finishedAt: Date.now(),
            exitCode,
            stdout,
            stderr,
            meteringRecords,
            artifactRootHash: hashSandboxArtifacts({
                stdout,
                stderr,
                exitCode,
            }),
            meteringRootHash: hashMeteringRecords(meteringRecords),
        };
    } finally {
        try {
            await sandbox.process.deleteSession(sessionId);
        } catch {
            // Session cleanup is best-effort because sandbox teardown is the hard boundary.
        }
        await destroySandbox(sandbox, client, timeoutSeconds);
    }
}