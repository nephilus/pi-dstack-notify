import type { DatabaseSync } from 'node:sqlite';
import { held } from './safety.ts';
/** Accepted v1 tables retained literally; v2 adds only canonical_associations. */
export const schema = [
`CREATE TABLE migrations (
    migration_id TEXT PRIMARY KEY COLLATE BINARY,
    manifest_sha256 TEXT NOT NULL,
    imported_count INTEGER NOT NULL CHECK (imported_count >= 0),
    imported_at INTEGER NOT NULL CHECK (imported_at >= 0)
) WITHOUT ROWID`,
`CREATE TABLE deliveries (
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
) WITHOUT ROWID`,
] as const;
export const canonicalSchema = `CREATE TABLE canonical_associations (
    profile_id TEXT NOT NULL COLLATE BINARY,
    destination_id TEXT NOT NULL COLLATE BINARY,
    inbox_authority TEXT COLLATE BINARY,
    message_id TEXT COLLATE BINARY,
    thread_id TEXT COLLATE BINARY,
    decision_key TEXT NOT NULL COLLATE BINARY,
    event_revision TEXT NOT NULL COLLATE BINARY,
    purpose TEXT NOT NULL COLLATE BINARY,
    native_project_id TEXT,
    project_root TEXT,
    session_id TEXT,
    legacy_unmapped INTEGER NOT NULL CHECK (legacy_unmapped IN (0,1)),
    read_verified INTEGER NOT NULL CHECK (read_verified IN (0,1)),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    verified_at INTEGER CHECK (verified_at IS NULL OR verified_at >= 0),
    PRIMARY KEY (profile_id,destination_id,decision_key,event_revision,purpose),
    UNIQUE (profile_id,destination_id,inbox_authority,message_id),
    FOREIGN KEY (profile_id,destination_id,decision_key,event_revision,purpose)
      REFERENCES deliveries(profile_id,destination_id,decision_key,event_revision,purpose),
    CHECK ((read_verified=0 AND verified_at IS NULL) OR
           (read_verified=1 AND verified_at IS NOT NULL)),
    CHECK ((legacy_unmapped=1 AND inbox_authority IS NULL AND message_id IS NULL AND thread_id IS NULL
            AND native_project_id IS NULL AND project_root IS NULL AND session_id IS NULL AND read_verified=0) OR
           (legacy_unmapped=0 AND inbox_authority IS NOT NULL AND message_id IS NOT NULL AND thread_id IS NOT NULL
            AND native_project_id IS NOT NULL AND project_root IS NOT NULL AND session_id IS NOT NULL))
) WITHOUT ROWID`;
export function versionOf(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as any).user_version;
}
export function validateSchema(db: DatabaseSync, version: 1 | 2): void {
  if (versionOf(db) !== version) held();
  const objects = db.prepare("SELECT name,type,sql FROM sqlite_master WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%'").all() as any[];
  const expected = version === 1 ? [...schema] : [...schema, canonicalSchema];
  if (objects.length !== expected.length) held();
  const compact = (sql: string) => sql.replace(/\s+/g, ' ').trim();
  for (const sql of expected) {
    const name = /^CREATE TABLE (\w+)/.exec(sql)![1];
    if (!objects.some(o => o.type === 'table' && o.name === name && compact(o.sql) === compact(sql))) held();
  }
  if ((db.prepare('PRAGMA quick_check').get() as any).quick_check !== 'ok'
      || db.prepare('PRAGMA foreign_key_check').all().length) held();
  // Confirmed post-cutover deliveries must have canonical coverage. Unknown
  // claims can legitimately lack IDs; without a separate durable witness their
  // lost association cannot be distinguished from IDs never being obtained.
  if (version === 2 && db.prepare(`SELECT 1 FROM deliveries d
    LEFT JOIN canonical_associations c USING (profile_id,destination_id,decision_key,event_revision,purpose)
    WHERE d.state IN ('sent','duplicate') AND c.profile_id IS NULL LIMIT 1`).get()) held();
}
