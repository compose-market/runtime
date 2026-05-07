-- ============================================================================
-- catalog — D1 schema for the connectors broker
-- ============================================================================
-- Single source of truth for what servers exist, how to reach them, what
-- credentials they need, what tools they expose, and how healthy they are.
--
-- Identity primitives used here come from runtime/src/manowar/agent/context.ts
-- (AgentExecutionContext): agentWallet, userAddress, composeRunId, threadId,
-- workflowWallet, mode, haiId. NO new identity types.
-- ============================================================================

-- ─── servers ──────────────────────────────────────────────────────────────
-- One row per logical server (MCP or GOAT).
CREATE TABLE IF NOT EXISTS servers (
    slug              TEXT PRIMARY KEY,
    origin            TEXT NOT NULL CHECK (origin IN ('tools', 'onchain')),
    name              TEXT NOT NULL,
    namespace         TEXT NOT NULL DEFAULT 'unknown',
    description       TEXT NOT NULL DEFAULT '',
    tags              TEXT NOT NULL DEFAULT '[]',
    category          TEXT,
    repo_url          TEXT,
    image             TEXT,
    status            TEXT NOT NULL DEFAULT 'inspecting'
                          CHECK (status IN ('live', 'credential_gated', 'inspecting', 'verified', 'metadata_reviewed', 'embedded', 'shadowed', 'quarantined', 'deprecated')),
    statefulness      TEXT NOT NULL DEFAULT 'unknown'
                          CHECK (statefulness IN ('stateless', 'stateful', 'unknown')),
    card_version      TEXT NOT NULL DEFAULT '',
    compiled_at       TEXT,
    inspected_at      TEXT,
    created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_servers_origin ON servers(origin);
CREATE INDEX IF NOT EXISTS idx_servers_status ON servers(status);
CREATE INDEX IF NOT EXISTS idx_servers_category ON servers(category);

-- ─── candidate_screenings ────────────────────────────────────────────────
-- Deterministic state-machine output from the first spawn pass. This table
-- is not a served catalog; it is a resumable queue between seed and the
-- model-backed metadata agents.
CREATE TABLE IF NOT EXISTS candidate_screenings (
    server_slug            TEXT NOT NULL,
    source_hash            TEXT NOT NULL,
    source_version         TEXT NOT NULL,
    raw_key                TEXT NOT NULL,
    screening_key          TEXT NOT NULL,
    status                 TEXT NOT NULL
                               CHECK (status IN ('functional', 'credential_gated', 'retryable', 'shadowed')),
    functional_transports  TEXT NOT NULL DEFAULT '[]',
    credential_vars        TEXT NOT NULL DEFAULT '[]',
    errors                 TEXT NOT NULL DEFAULT '[]',
    metadata_agent_id      INTEGER,
    screened_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (server_slug, source_hash)
);

CREATE INDEX IF NOT EXISTS idx_candidate_screenings_status ON candidate_screenings(status, updated_at);

-- ─── candidate_retry_queue ───────────────────────────────────────────────
-- Retryable verification outcomes are parked outside RAW/candidates so the
-- first-pass verify stage can exhaust active candidates. A dispatcher can
-- later requeue these rows when their retry policy is ready.
CREATE TABLE IF NOT EXISTS candidate_retry_queue (
    server_slug     TEXT NOT NULL,
    source_hash     TEXT NOT NULL,
    source_version  TEXT NOT NULL,
    raw_key         TEXT NOT NULL,
    candidate_key   TEXT NOT NULL,
    retry_class     TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 1,
    next_retry_at   TEXT NOT NULL,
    last_error      TEXT,
    parked_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (server_slug, source_hash)
);

CREATE INDEX IF NOT EXISTS idx_candidate_retry_queue_next
    ON candidate_retry_queue(next_retry_at, retry_class, updated_at);

-- ─── metadata_agent_reviews ──────────────────────────────────────────────
-- Agent-authored metadata artifacts. The three model-backed metadata agents
-- write here after respawning MCPs themselves. The deterministic publisher
-- is the only workflow that consumes these into the final catalog tables.
CREATE TABLE IF NOT EXISTS metadata_agent_reviews (
    server_slug          TEXT NOT NULL,
    source_hash          TEXT NOT NULL,
    source_version       TEXT NOT NULL,
    agent_id             INTEGER NOT NULL CHECK (agent_id IN (0, 1, 2)),
    status               TEXT NOT NULL CHECK (status IN ('complete', 'retryable', 'failed')),
    human_name           TEXT,
    short_description    TEXT,
    tags                 TEXT NOT NULL DEFAULT '[]',
    observed_tools       TEXT NOT NULL DEFAULT '[]',
    observed_schemas     TEXT NOT NULL DEFAULT '{}',
    observed_transports  TEXT NOT NULL DEFAULT '[]',
    credential_vars      TEXT NOT NULL DEFAULT '[]',
    reviewer             TEXT NOT NULL,
    artifact_key         TEXT,
    card_version         TEXT,
    canonical_agent_id   INTEGER,
    error_message        TEXT,
    reviewed_at          TEXT,
    updated_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (server_slug, source_hash, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_metadata_agent_reviews_status ON metadata_agent_reviews(status, updated_at);

-- ─── catalog_decisions ───────────────────────────────────────────────────
-- Durable serving decisions that seed is not allowed to overwrite.
CREATE TABLE IF NOT EXISTS catalog_decisions (
    server_slug       TEXT PRIMARY KEY,
    decision          TEXT NOT NULL CHECK (decision IN ('serve', 'shadow', 'quarantine', 'deprecated')),
    reason            TEXT NOT NULL,
    source_version    TEXT,
    decided_by        TEXT NOT NULL,
    decided_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at        TEXT,
    FOREIGN KEY (server_slug) REFERENCES servers(slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_catalog_decisions_decision ON catalog_decisions(decision);

-- ─── metadata_reviews ────────────────────────────────────────────────────
-- Agent-reviewed metadata. This is the serving metadata of record once set.
CREATE TABLE IF NOT EXISTS metadata_reviews (
    server_slug       TEXT PRIMARY KEY,
    human_name        TEXT NOT NULL,
    short_description TEXT NOT NULL,
    tags              TEXT NOT NULL DEFAULT '[]',
    category          TEXT,
    tool_summary      TEXT NOT NULL DEFAULT '[]',
    reviewer          TEXT NOT NULL,
    reviewed_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    card_version      TEXT NOT NULL,
    FOREIGN KEY (server_slug) REFERENCES servers(slug) ON DELETE CASCADE
);

-- ─── embedding_state ─────────────────────────────────────────────────────
-- Server-level embedding state. Tool rows are not the embedding marker.
CREATE TABLE IF NOT EXISTS embedding_state (
    server_slug       TEXT PRIMARY KEY,
    vector_id         TEXT NOT NULL,
    provider          TEXT NOT NULL,
    model             TEXT NOT NULL,
    dimensions        INTEGER NOT NULL,
    input_type        TEXT NOT NULL,
    text_hash         TEXT NOT NULL,
    card_version      TEXT NOT NULL,
    embedded_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (server_slug) REFERENCES servers(slug) ON DELETE CASCADE
);

-- ─── verification_cursor ─────────────────────────────────────────────────
-- One row per deterministic crawler shard.
CREATE TABLE IF NOT EXISTS verification_cursor (
    shard_id          INTEGER PRIMARY KEY,
    shard_count       INTEGER NOT NULL,
    last_slug         TEXT,
    r2_cursor         TEXT,
    done              INTEGER NOT NULL DEFAULT 0,
    updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ─── transports ───────────────────────────────────────────────────────────
-- One row per usable spawn config per server. Priority is computed by the
-- health workflow from observed signals — never a hardcoded array.
CREATE TABLE IF NOT EXISTS transports (
    server_slug       TEXT NOT NULL,
    kind              TEXT NOT NULL
                          CHECK (kind IN ('stdio', 'http', 'docker', 'npx', 'goat-plugin')),
    package           TEXT,
    image             TEXT,
    remote_url        TEXT,
    protocol          TEXT CHECK (protocol IN ('sse', 'streamable-http') OR protocol IS NULL),
    port_observed     INTEGER,
    cmd_args          TEXT NOT NULL DEFAULT '[]',
    env_required      TEXT NOT NULL DEFAULT '[]',
    env_optional      TEXT NOT NULL DEFAULT '[]',
    last_success_at   TEXT,
    last_failure_at   TEXT,
    failure_streak    INTEGER NOT NULL DEFAULT 0,
    median_latency_ms INTEGER,
    runner_profile    TEXT,
    deadline_ms       INTEGER,
    priority          REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (server_slug, kind),
    FOREIGN KEY (server_slug) REFERENCES servers(slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_transports_priority ON transports(server_slug, priority DESC);

-- ─── spawn_attempts ─────────────────────────────────────────────────────
-- Per transport/profile evidence from verify and metadata respawns.
CREATE TABLE IF NOT EXISTS spawn_attempts (
    id                 TEXT PRIMARY KEY,
    server_slug        TEXT NOT NULL,
    source_hash        TEXT NOT NULL,
    source_version     TEXT NOT NULL,
    stage              TEXT NOT NULL CHECK (stage IN ('verify', 'metadata')),
    transport_kind     TEXT NOT NULL,
    runner_profile     TEXT,
    deadline_ms        INTEGER,
    attempt_no         INTEGER NOT NULL DEFAULT 1,
    status             TEXT NOT NULL CHECK (status IN ('success', 'failed')),
    retry_class        TEXT NOT NULL,
    error_code         TEXT,
    error_message      TEXT,
    latency_ms         INTEGER,
    observed_tools     INTEGER NOT NULL DEFAULT 0,
    attempted_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_spawn_attempts_candidate ON spawn_attempts(server_slug, source_hash, stage, attempted_at);
CREATE INDEX IF NOT EXISTS idx_spawn_attempts_status ON spawn_attempts(status, retry_class, attempted_at);

-- ─── catalog_stage_errors ────────────────────────────────────────────────
-- Per-item stage failures that should not fail a worker workflow or erase
-- completed upstream state. Reconciliation can retry rows after next_retry_at.
CREATE TABLE IF NOT EXISTS catalog_stage_errors (
    item_id        TEXT NOT NULL,
    item_version   TEXT NOT NULL DEFAULT '',
    stage          TEXT NOT NULL CHECK (stage IN ('seed', 'verify', 'metadata', 'publish', 'embed')),
    error_message  TEXT NOT NULL,
    attempts       INTEGER NOT NULL DEFAULT 1,
    next_retry_at  TEXT,
    first_seen_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (item_id, item_version, stage)
);

CREATE INDEX IF NOT EXISTS idx_catalog_stage_errors_retry
    ON catalog_stage_errors(stage, next_retry_at, updated_at);

-- ─── tools ────────────────────────────────────────────────────────────────
-- Tool descriptors observed during inspect. Schema is JSON-serialized.
CREATE TABLE IF NOT EXISTS tools (
    server_slug       TEXT NOT NULL,
    name              TEXT NOT NULL,
    description       TEXT,
    input_schema      TEXT NOT NULL DEFAULT '{}',
    embedding_id      TEXT,
    last_seen_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    card_version      TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (server_slug, name),
    FOREIGN KEY (server_slug) REFERENCES servers(slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tools_name ON tools(name);

-- ─── credentials ──────────────────────────────────────────────────────────
-- Required env vars per server, captured ONLY from structured signals
-- (JSON-RPC -32602 envelopes, Node ERR_INVALID_ENV, "Missing environment
-- variable: X"). Never inferred from name strings.
CREATE TABLE IF NOT EXISTS credentials (
    server_slug       TEXT NOT NULL,
    var_name          TEXT NOT NULL,
    description       TEXT,
    obtain_url        TEXT,
    evidence_key      TEXT,
    PRIMARY KEY (server_slug, var_name),
    FOREIGN KEY (server_slug) REFERENCES servers(slug) ON DELETE CASCADE
);

-- ─── health ───────────────────────────────────────────────────────────────
-- Per-call outcome rolled into 5-min buckets by the health workflow.
CREATE TABLE IF NOT EXISTS health (
    server_slug       TEXT NOT NULL,
    transport_kind    TEXT NOT NULL,
    bucket_at         TEXT NOT NULL,
    outcome           TEXT NOT NULL
                          CHECK (outcome IN ('ok', 'fail_transport', 'fail_creds', 'fail_tool', 'fail_timeout')),
    latency_ms        INTEGER NOT NULL,
    count             INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (server_slug, transport_kind, bucket_at, outcome),
    FOREIGN KEY (server_slug) REFERENCES servers(slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_health_bucket ON health(bucket_at);

-- ─── aliases ──────────────────────────────────────────────────────────────
-- Alternate ids mapped to canonical slugs.
CREATE TABLE IF NOT EXISTS aliases (
    alias_id          TEXT PRIMARY KEY,
    server_slug       TEXT NOT NULL,
    FOREIGN KEY (server_slug) REFERENCES servers(slug) ON DELETE CASCADE
);

-- ─── versions ─────────────────────────────────────────────────────────────
-- Immutable card history; R2 blob holds the full JSON.
CREATE TABLE IF NOT EXISTS versions (
    server_slug       TEXT NOT NULL,
    card_version      TEXT NOT NULL,
    card_key          TEXT NOT NULL,
    created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (server_slug, card_version),
    FOREIGN KEY (server_slug) REFERENCES servers(slug) ON DELETE CASCADE
);

-- ─── runs ─────────────────────────────────────────────────────────────────
-- One row per inspect / compile / call, for audit and replay.
CREATE TABLE IF NOT EXISTS runs (
    id                TEXT PRIMARY KEY,
    server_slug       TEXT NOT NULL,
    started_at        TEXT NOT NULL,
    ended_at          TEXT,
    transport_kind    TEXT,
    outcome           TEXT,
    snapshot_key      TEXT,
    error_envelope    TEXT,
    agent_wallet      TEXT,
    user_address      TEXT,
    compose_run_id    TEXT,
    thread_id         TEXT,
    workflow_wallet   TEXT,
    mode              TEXT,
    hai_id            TEXT,
    FOREIGN KEY (server_slug) REFERENCES servers(slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runs_server ON runs(server_slug, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_correlate ON runs(compose_run_id);

-- ─── seed_cursor ─────────────────────────────────────────────────────────
-- Persists pagination cursor for the chunked seed workflow so each
-- /seed invocation processes the next candidate window of the MCP Registry.
CREATE TABLE IF NOT EXISTS seed_cursor (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    cursor      TEXT,
    page_offset INTEGER NOT NULL DEFAULT 0,
    registry_complete INTEGER NOT NULL DEFAULT 0,
    ghcr_offset INTEGER NOT NULL DEFAULT 0,
    ghcr_complete INTEGER NOT NULL DEFAULT 0,
    complete    INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT,
    updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ─── pipeline_runs ───────────────────────────────────────────────────────
-- Cloudflare Workflow control-plane state for full catalog pipeline runs.
-- This is operational metadata only; served catalog rows still come only
-- from agent-authored reviews published by workflows/publish.ts.
CREATE TABLE IF NOT EXISTS pipeline_runs (
    id             TEXT PRIMARY KEY,
    root_id        TEXT,
    parent_id      TEXT,
    mode           TEXT NOT NULL,
    status         TEXT NOT NULL CHECK (status IN ('queued', 'running', 'complete', 'errored')),
    current_stage  TEXT,
    input          TEXT NOT NULL DEFAULT '{}',
    result         TEXT,
    error          TEXT,
    started_at     TEXT,
    finished_at    TEXT,
    updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status, updated_at);

-- ─── pipeline_lock ───────────────────────────────────────────────────────
-- Singleton cursor owner for the full catalog pipeline. Manual starts and
-- cron starts must not mutate seed/verify cursors concurrently.
CREATE TABLE IF NOT EXISTS pipeline_lock (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    root_run_id    TEXT NOT NULL,
    active_run_id  TEXT NOT NULL,
    mode           TEXT NOT NULL,
    status         TEXT NOT NULL CHECK (status IN ('running', 'complete', 'errored')),
    acquired_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
