/**
 * Cloudflare Worker bindings for the connectors broker.
 *
 * Bound resources are declared in wrangler.toml. Secrets are set via
 * `wrangler secret put <NAME>`.
 */

export interface Env {
    // D1 catalog
    CATALOG: D1Database;
    // R2 buckets
    RAW: R2Bucket;
    SNAPSHOTS: R2Bucket;
    CARDS: R2Bucket;
    // Vectorize index for card embeddings
    EMBEDDINGS: VectorizeIndex;
    // Workers AI binding (used as one of the compiler models)
    AI: Ai;
    // Cloudflare Workflows binding for full catalog pipeline runs.
    CATALOG_PIPELINE: WorkflowBinding<unknown>;
    // Cloudflare Container binding for the Supergateway MCP runner.
    // The binding is optional so local/dev deployments can point at
    // MCP_RUNNER_URL instead.
    MCP_RUNNER?: DurableObjectNamespace;
    MCP_RUNNER_BASIC?: DurableObjectNamespace;
    MCP_RUNNER_STANDARD_1?: DurableObjectNamespace;
    MCP_RUNNER_STANDARD_2?: DurableObjectNamespace;

    // Non-secret config from wrangler.toml [vars]
    GHCR_NAMESPACE: string;
    MCP_REGISTRY_URL: string;
    EMBEDDING_MODEL: string;
    EMBEDDING_API_BASE: string;
    COMPILER_MODEL_PRIMARY: string;
    COMPILER_MODEL_SECONDARY: string;
    COMPILER_MODEL_TERTIARY: string;
    MCP_RUNNER_URL?: string;
    MCP_RUNNER_INSTANCES?: string;
    MCP_RUNNER_BASIC_INSTANCES?: string;
    MCP_RUNNER_STANDARD_1_INSTANCES?: string;
    MCP_RUNNER_STANDARD_2_INSTANCES?: string;
    MCP_RUNNER_SHUTDOWN_AFTER_REQUEST?: string;

    // Secrets (set via `wrangler secret put`)
    RUNTIME_INTERNAL_SECRET: string;
    MONGO_DB_API_KEY: string;
    GHCR_GITHUB_PAT?: string;
    GITHUB_GHCR_PAT?: string;
    GHCR_TOKEN?: string;
    CF_API_TOKEN?: string;
    COINGECKO_API_KEY?: string;
    ONEINCH_API_KEY?: string;
    ZEROX_API_KEY?: string;
    ETHERSCAN_API_KEY?: string;
    POLYMARKET_API_KEY?: string;
    UNISWAP_API_KEY?: string;
}

export interface DurableObjectNamespace {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): DurableObjectStub;
}

export interface DurableObjectId {
    toString(): string;
}

export interface DurableObjectStub {
    fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface WorkflowBinding<PARAMS = unknown> {
    create(options?: WorkflowInstanceCreateOptions<PARAMS>): Promise<WorkflowInstance>;
    get(id: string): Promise<WorkflowInstance>;
}

export interface WorkflowInstanceCreateOptions<PARAMS = unknown> {
    id?: string;
    params?: PARAMS;
    retention?: {
        successRetention?: string | number;
        errorRetention?: string | number;
    };
}

export interface WorkflowInstance {
    id: string;
    status(): Promise<{
        status: "queued" | "running" | "paused" | "errored" | "terminated" | "complete" | "waiting" | "waitingForPause" | "unknown";
        error?: { name: string; message: string };
        output?: unknown;
    }>;
    terminate(): Promise<void>;
}

/**
 * Cloudflare Workers globals — hand-rolled minimal types so we don't have
 * to pull @cloudflare/workers-types into the runtime package's tsconfig.
 */
export interface D1Database {
    prepare(query: string): D1PreparedStatement;
    batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
    exec(query: string): Promise<{ count: number; duration: number }>;
}

export interface D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement;
    first<T = unknown>(colName?: string): Promise<T | null>;
    all<T = unknown>(): Promise<D1Result<T>>;
    run<T = unknown>(): Promise<D1Result<T>>;
    raw<T = unknown>(): Promise<T[]>;
}

export interface D1Result<T = unknown> {
    results?: T[];
    success: boolean;
    meta?: {
        duration: number;
        changes?: number;
        last_row_id?: number;
        rows_read?: number;
        rows_written?: number;
    };
}

export interface R2Bucket {
    get(key: string): Promise<R2ObjectBody | null>;
    put(
        key: string,
        value: ReadableStream | ArrayBuffer | string,
        options?: R2PutOptions,
    ): Promise<R2Object>;
    delete(key: string | string[]): Promise<void>;
    list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<R2Objects>;
    head(key: string): Promise<R2Object | null>;
}

export interface R2Object {
    key: string;
    size: number;
    etag: string;
    httpEtag: string;
    uploaded: Date;
    httpMetadata?: { contentType?: string };
    customMetadata?: Record<string, string>;
}

export interface R2ObjectBody extends R2Object {
    body: ReadableStream;
    bodyUsed: boolean;
    arrayBuffer(): Promise<ArrayBuffer>;
    text(): Promise<string>;
    json<T>(): Promise<T>;
}

export interface R2PutOptions {
    httpMetadata?: { contentType?: string };
    customMetadata?: Record<string, string>;
}

export interface R2Objects {
    objects: R2Object[];
    truncated: boolean;
    cursor?: string;
}

export interface VectorizeIndex {
    insert(vectors: VectorizeVector[]): Promise<VectorizeMutation>;
    upsert(vectors: VectorizeVector[]): Promise<VectorizeMutation>;
    query(
        vector: number[],
        options?: VectorizeQueryOptions,
    ): Promise<VectorizeMatches>;
    deleteByIds(ids: string[]): Promise<VectorizeMutation>;
}

export interface VectorizeVector {
    id: string;
    values: number[];
    metadata?: Record<string, unknown>;
}

export interface VectorizeQueryOptions {
    topK?: number;
    returnMetadata?: boolean | "all";
    filter?: Record<string, unknown>;
}

export interface VectorizeMatches {
    matches: Array<{
        id: string;
        score: number;
        values?: number[];
        metadata?: Record<string, unknown>;
    }>;
    count: number;
}

export interface VectorizeMutation {
    mutationId: string;
}

export interface Ai {
    run<T = unknown>(model: string, inputs: Record<string, unknown>): Promise<T>;
}

export interface ScheduledController {
    scheduledTime: number;
    cron: string;
    noRetry(): void;
}

export interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
}
