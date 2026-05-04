-- Rebuild servers to expand the status CHECK constraint.
-- D1/SQLite cannot ALTER a CHECK constraint in place.

PRAGMA foreign_keys=off;

DROP TABLE IF EXISTS servers_new;

CREATE TABLE servers_new (
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

INSERT INTO servers_new (
    slug,
    origin,
    name,
    namespace,
    description,
    tags,
    category,
    repo_url,
    image,
    status,
    statefulness,
    card_version,
    compiled_at,
    inspected_at,
    created_at,
    updated_at
)
SELECT
    slug,
    origin,
    name,
    namespace,
    description,
    tags,
    category,
    repo_url,
    image,
    status,
    statefulness,
    card_version,
    compiled_at,
    inspected_at,
    created_at,
    updated_at
FROM servers;

DROP TABLE servers;
ALTER TABLE servers_new RENAME TO servers;

CREATE INDEX IF NOT EXISTS idx_servers_origin ON servers(origin);
CREATE INDEX IF NOT EXISTS idx_servers_status ON servers(status);
CREATE INDEX IF NOT EXISTS idx_servers_category ON servers(category);

PRAGMA foreign_keys=on;
