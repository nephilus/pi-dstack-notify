-- Literal accepted alert_delivery.py v1 schema; synthetic DBs only.
CREATE TABLE migrations (
    migration_id TEXT PRIMARY KEY COLLATE BINARY,
    manifest_sha256 TEXT NOT NULL,
    imported_count INTEGER NOT NULL CHECK (imported_count >= 0),
    imported_at INTEGER NOT NULL CHECK (imported_at >= 0)
) WITHOUT ROWID;
CREATE TABLE deliveries (
    profile_id TEXT NOT NULL COLLATE BINARY,
    destination_id TEXT NOT NULL COLLATE BINARY,
    decision_key TEXT NOT NULL COLLATE BINARY,
    event_revision TEXT NOT NULL COLLATE BINARY,
    purpose TEXT NOT NULL COLLATE BINARY,
    state TEXT NOT NULL CHECK (state IN ('in_flight','sent','duplicate','delivery_unknown')),
    claim_id TEXT UNIQUE,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    confirmed_at INTEGER CHECK (confirmed_at IS NULL OR confirmed_at >= 0),
    confirmation_ref TEXT,
    source TEXT NOT NULL CHECK (source IN ('live','legacy_attention')),
    migration_id TEXT,
    PRIMARY KEY (profile_id,destination_id,decision_key,event_revision,purpose),
    CHECK ((state IN ('sent','duplicate') AND confirmed_at IS NOT NULL) OR
           (state IN ('in_flight','delivery_unknown') AND confirmed_at IS NULL)),
    CHECK ((source='live' AND claim_id IS NOT NULL AND migration_id IS NULL) OR
           (source='legacy_attention' AND claim_id IS NULL AND migration_id IS NOT NULL)),
    FOREIGN KEY (migration_id) REFERENCES migrations(migration_id)
) WITHOUT ROWID;
PRAGMA user_version=1;
