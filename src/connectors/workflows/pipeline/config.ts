export type ConnectorCatalogPipelineMode = "maintenance" | "first-pass";
export type ConnectorCatalogPipelineStatus = "queued" | "running" | "complete" | "errored";
export type ConnectorCatalogPipelineStage = "seed" | "verify" | "metadata" | "publish" | "embed" | "health";
export type ConnectorCatalogPipelineWorkerRole =
    | "coordinator"
    | "seed-worker"
    | "verify-worker"
    | "metadata-worker"
    | "publish-worker"
    | "embed-worker";

export interface ConnectorCatalogPipelineInput {
    mode?: ConnectorCatalogPipelineMode;
    stage?: ConnectorCatalogPipelineStage;
    workerRole?: ConnectorCatalogPipelineWorkerRole;
    workerIndex?: number;
    supervisorPolls?: number;
    seedMaxPages?: number;
    seedCandidateLimit?: number;
    seedIterations?: number;
    seedWorkerCount?: number;
    verifyLimit?: number;
    verifyIterations?: number;
    verifyParallelism?: number;
    verifyWorkerCount?: number;
    metadataLimit?: number;
    metadataIterations?: number;
    metadataParallelism?: number;
    metadataWorkerCount?: number;
    publishLimit?: number;
    publishIterations?: number;
    publishWorkerCount?: number;
    embedLimit?: number;
    embedIterations?: number;
    embedWorkerCount?: number;
    shardCount?: number;
    resetSeed?: boolean;
    retryRecent?: boolean;
    force?: boolean;
}

export interface NormalizedPipelineInput extends Required<Omit<ConnectorCatalogPipelineInput, "force">> {
    mode: ConnectorCatalogPipelineMode;
    stage: ConnectorCatalogPipelineStage;
}

const FIRST_PASS_DEFAULTS: NormalizedPipelineInput = {
    mode: "first-pass",
    stage: "seed",
    workerRole: "coordinator",
    workerIndex: 0,
    supervisorPolls: 12,
    seedMaxPages: 1,
    seedCandidateLimit: 10,
    seedIterations: 30,
    seedWorkerCount: 1,
    verifyLimit: 10,
    verifyIterations: 64,
    verifyParallelism: 12,
    verifyWorkerCount: 12,
    metadataLimit: 5,
    metadataIterations: 64,
    metadataParallelism: 4,
    metadataWorkerCount: 12,
    publishLimit: 25,
    publishIterations: 20,
    publishWorkerCount: 4,
    embedLimit: 25,
    embedIterations: 20,
    embedWorkerCount: 4,
    shardCount: 48,
    resetSeed: false,
    retryRecent: false,
};

const MAINTENANCE_DEFAULTS: NormalizedPipelineInput = {
    mode: "maintenance",
    stage: "seed",
    workerRole: "coordinator",
    workerIndex: 0,
    supervisorPolls: 8,
    seedMaxPages: 1,
    seedCandidateLimit: 10,
    seedIterations: 20,
    seedWorkerCount: 1,
    verifyLimit: 10,
    verifyIterations: 32,
    verifyParallelism: 12,
    verifyWorkerCount: 12,
    metadataLimit: 5,
    metadataIterations: 32,
    metadataParallelism: 4,
    metadataWorkerCount: 12,
    publishLimit: 25,
    publishIterations: 16,
    publishWorkerCount: 4,
    embedLimit: 25,
    embedIterations: 16,
    embedWorkerCount: 4,
    shardCount: 48,
    resetSeed: false,
    retryRecent: false,
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(Math.floor(parsed), max));
}

function normalizeWorkerRole(value: unknown): ConnectorCatalogPipelineWorkerRole {
    if (
        value === "seed-worker" ||
        value === "verify-worker" ||
        value === "metadata-worker" ||
        value === "publish-worker" ||
        value === "embed-worker"
    ) return value;
    return "coordinator";
}

function clampMetadataWorkerCount(value: unknown, fallback: number): number {
    const clamped = clampInt(value, fallback, 3, 48);
    return Math.max(3, Math.floor(clamped / 3) * 3);
}

export function normalizePipelineInput(input: ConnectorCatalogPipelineInput = {}): NormalizedPipelineInput {
    const mode: ConnectorCatalogPipelineMode = input.mode === "maintenance" ? "maintenance" : "first-pass";
    const stage: ConnectorCatalogPipelineStage =
        input.stage === "verify" ||
        input.stage === "metadata" ||
        input.stage === "publish" ||
        input.stage === "embed" ||
        input.stage === "health"
            ? input.stage
            : "seed";
    const defaults = mode === "maintenance" ? MAINTENANCE_DEFAULTS : FIRST_PASS_DEFAULTS;
    const workerRole = normalizeWorkerRole(input.workerRole);
    const seedWorkerCount = clampInt(input.seedWorkerCount, defaults.seedWorkerCount, 1, 1);
    const verifyWorkerCount = clampInt(input.verifyWorkerCount ?? input.verifyParallelism, defaults.verifyWorkerCount, 1, 64);
    const metadataWorkerCount = clampMetadataWorkerCount(
        input.metadataWorkerCount ?? (input.metadataParallelism === undefined ? undefined : input.metadataParallelism * 3),
        defaults.metadataWorkerCount,
    );
    const publishWorkerCount = clampInt(input.publishWorkerCount, defaults.publishWorkerCount, 1, 64);
    const embedWorkerCount = clampInt(input.embedWorkerCount, defaults.embedWorkerCount, 1, 64);
    const workerIndexMax =
        workerRole === "seed-worker" ? seedWorkerCount - 1 :
        workerRole === "metadata-worker" ? metadataWorkerCount - 1 :
        workerRole === "publish-worker" ? publishWorkerCount - 1 :
        workerRole === "embed-worker" ? embedWorkerCount - 1 :
        verifyWorkerCount - 1;
    return {
        mode,
        stage,
        workerRole,
        workerIndex: clampInt(input.workerIndex, defaults.workerIndex, 0, Math.max(0, workerIndexMax)),
        supervisorPolls: clampInt(input.supervisorPolls, defaults.supervisorPolls, 1, 60),
        seedMaxPages: clampInt(input.seedMaxPages, defaults.seedMaxPages, 1, 64),
        seedCandidateLimit: clampInt(input.seedCandidateLimit, defaults.seedCandidateLimit, 1, 25),
        seedIterations: clampInt(input.seedIterations, defaults.seedIterations, 1, 80),
        seedWorkerCount,
        verifyLimit: clampInt(input.verifyLimit, defaults.verifyLimit, 1, 200),
        verifyIterations: clampInt(input.verifyIterations, defaults.verifyIterations, 1, 2048),
        verifyParallelism: clampInt(input.verifyParallelism, defaults.verifyParallelism, 1, 64),
        verifyWorkerCount,
        metadataLimit: clampInt(input.metadataLimit, defaults.metadataLimit, 1, 100),
        metadataIterations: clampInt(input.metadataIterations, defaults.metadataIterations, 1, 4096),
        metadataParallelism: clampInt(input.metadataParallelism, defaults.metadataParallelism, 1, 16),
        metadataWorkerCount,
        publishLimit: clampInt(input.publishLimit, defaults.publishLimit, 1, 500),
        publishIterations: clampInt(input.publishIterations, defaults.publishIterations, 1, 1024),
        publishWorkerCount,
        embedLimit: clampInt(input.embedLimit, defaults.embedLimit, 1, 500),
        embedIterations: clampInt(input.embedIterations, defaults.embedIterations, 1, 1024),
        embedWorkerCount,
        shardCount: clampInt(input.shardCount, defaults.shardCount, 1, 64),
        resetSeed: input.resetSeed === true,
        retryRecent: input.retryRecent === true,
    };
}

export function createPipelineRunId(mode: ConnectorCatalogPipelineMode, now = new Date()): string {
    const timestamp = now.toISOString().replace(/[^0-9]/g, "").slice(0, 14);
    const suffix = crypto.randomUUID().slice(0, 8);
    return `connector-catalog-${mode}-${timestamp}-${suffix}`;
}

function parseProgressStage(stage: string | null): { name: string; index: number } | null {
    if (!stage) return null;
    const match = /^(seed|verify|metadata-agents|publish|embed):(\d+)$/.exec(stage);
    if (!match) return null;
    const name = match[1];
    const index = match[2];
    if (!name || !index) return null;
    return { name, index: Number.parseInt(index, 10) };
}

export function isStageRegression(current: string | null, next: string): boolean {
    const currentProgress = parseProgressStage(current);
    const nextProgress = parseProgressStage(next);
    if (!currentProgress || !nextProgress) return false;
    return currentProgress.name === nextProgress.name && currentProgress.index > nextProgress.index;
}

export const __test = {
    normalizePipelineInput,
    isStageRegression,
};
