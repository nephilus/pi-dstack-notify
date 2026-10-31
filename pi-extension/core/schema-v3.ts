import type { DatabaseSync } from 'node:sqlite';
import { digest, held, protectScalars, safeBody, safeNativeIdentity, sessionPattern, messagePattern, revisionPattern, strictJson, validateReviewLink } from './safety.ts';
import { reminderDeliveryIdentity, validateUTCSlot, MAX_REMINDER_EPOCH } from './reminder-time.ts';
import type { DeliveryIdentity } from './types.ts';

/** Additive source format. Original tables stay literal. Reserved rows and their
 * original delivery claim must be inserted atomically after checking capacity. */
export const stage3Schema = [
`CREATE TABLE fyip_decisions (
    profile_id TEXT NOT NULL COLLATE BINARY,
    destination_id TEXT NOT NULL COLLATE BINARY,
    decision_key TEXT NOT NULL COLLATE BINARY,
    event_revision TEXT NOT NULL COLLATE BINARY,
    purpose TEXT NOT NULL CHECK (purpose='fyip'),
    candidate_sha256 TEXT NOT NULL,
    question_sha256 TEXT NOT NULL,
    config_sha256 TEXT NOT NULL,
    decision_claim_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('classifying','decided','terminal_unknown')),
    classification_status TEXT,
    choice TEXT CHECK (choice IN ('yes','no')),
    created_at REAL NOT NULL CHECK (created_at>=0),
    decided_at REAL,
    PRIMARY KEY (profile_id,destination_id,decision_key,event_revision,purpose),
    CHECK ((state='decided' AND classification_status IS NOT NULL AND decided_at IS NOT NULL) OR
           (state IN ('classifying','terminal_unknown') AND classification_status IS NULL AND choice IS NULL AND decided_at IS NULL))
) WITHOUT ROWID`,
`CREATE TABLE pending_owner_requests (
    profile_id TEXT NOT NULL COLLATE BINARY,
    destination_id TEXT NOT NULL COLLATE BINARY,
    decision_key TEXT NOT NULL COLLATE BINARY,
    event_revision TEXT NOT NULL COLLATE BINARY,
    purpose TEXT NOT NULL CHECK (purpose='owner_request'),
    state TEXT NOT NULL CHECK (state IN ('reserved','active','paused_answer')),
    inbox_authority TEXT,
    message_id TEXT,
    thread_id TEXT,
    canonical_url TEXT,
    native_project_id TEXT,
    project_root TEXT NOT NULL,
    original_session_id TEXT NOT NULL,
    body TEXT NOT NULL,
    review_link_json TEXT,
    answer_evidence_json TEXT,
    snoozed_until REAL CHECK (snoozed_until>=0),
    snooze_evidence_json TEXT,
    processing_sequence INTEGER NOT NULL DEFAULT 0 CHECK (processing_sequence>=0),
    created_at REAL NOT NULL CHECK (created_at>=0),
    updated_at REAL NOT NULL CHECK (updated_at>=0),
    PRIMARY KEY (profile_id,destination_id,decision_key,event_revision,purpose),
    FOREIGN KEY (profile_id,destination_id,decision_key,event_revision,purpose)
      REFERENCES deliveries(profile_id,destination_id,decision_key,event_revision,purpose),
    CHECK ((state='reserved' AND inbox_authority IS NULL AND message_id IS NULL AND thread_id IS NULL
             AND canonical_url IS NULL AND native_project_id IS NULL AND answer_evidence_json IS NULL) OR
           (state IN ('active','paused_answer') AND inbox_authority IS NOT NULL AND message_id IS NOT NULL
             AND thread_id IS NOT NULL AND canonical_url IS NOT NULL AND native_project_id IS NOT NULL)),
    CHECK ((state='paused_answer')=(answer_evidence_json IS NOT NULL)),
    CHECK ((snoozed_until IS NULL)=(snooze_evidence_json IS NULL))
) WITHOUT ROWID`,
`CREATE TABLE reminder_occurrences (
    profile_id TEXT NOT NULL COLLATE BINARY,
    destination_id TEXT NOT NULL COLLATE BINARY,
    decision_key TEXT NOT NULL COLLATE BINARY,
    event_revision TEXT NOT NULL COLLATE BINARY,
    original_purpose TEXT NOT NULL CHECK (original_purpose='owner_request'),
    utc_slot TEXT NOT NULL COLLATE BINARY,
    purpose TEXT NOT NULL CHECK (purpose='reminder'),
    reminder_key TEXT NOT NULL COLLATE BINARY,
    claim_operation_id TEXT NOT NULL,
    created_at REAL NOT NULL CHECK (created_at>=0),
    send_started_at REAL,
    PRIMARY KEY (profile_id,destination_id,decision_key,event_revision,original_purpose,utc_slot,purpose),
    UNIQUE (profile_id,destination_id,reminder_key,event_revision,purpose),
    FOREIGN KEY (profile_id,destination_id,decision_key,event_revision,original_purpose)
      REFERENCES pending_owner_requests(profile_id,destination_id,decision_key,event_revision,purpose),
    FOREIGN KEY (profile_id,destination_id,reminder_key,event_revision,purpose)
      REFERENCES deliveries(profile_id,destination_id,decision_key,event_revision,purpose)
) WITHOUT ROWID`,
] as const;
export const STAGE3_FORMAT_SHA256 = digest(JSON.stringify(stage3Schema));
const identityColumns = 'profile_id,destination_id,decision_key,event_revision,purpose';
const where = 'profile_id=? AND destination_id=? AND decision_key=? AND event_revision=? AND purpose=?';
const tuple = (row: DeliveryIdentity) => [row.profile_id, row.destination_id, row.decision_key, row.event_revision, row.purpose];
const hex = /^[0-9a-f]{64}$(?![\s\S])/;
function instant(value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= MAX_REMINDER_EPOCH) held();
}
function identity(row: any): void {
  for (const [key, max] of [['profile_id',128], ['destination_id',128], ['decision_key',512], ['event_revision',256], ['purpose',128]] as const)
    if (typeof row[key] !== 'string' || !row[key] || row[key].length > max
        || !/^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$(?![\s\S])/.test(row[key])) held();
}
/** Validation only: no publication, adoption, repair, cleanup or state transition. */
export function validateStage3Rows(db: DatabaseSync): void {
  const marker = db.prepare("SELECT * FROM migrations WHERE migration_id LIKE 'notification-v3/%'").all() as any[];
  if (marker.length !== 1 || !/^notification-v3\/[0-9a-f]{32}$(?![\s\S])/.test(marker[0].migration_id)
      || marker[0].manifest_sha256 !== STAGE3_FORMAT_SHA256 || !Number.isSafeInteger(marker[0].imported_count)
      || marker[0].imported_count < 0) held();
  instant(marker[0].imported_at);
  for (const row of db.prepare('SELECT * FROM fyip_decisions').all() as any[]) {
    protectScalars({ ...row },[]); identity(row); if (!revisionPattern.test(row.event_revision)) held();
    for (const name of ['candidate_sha256','question_sha256','config_sha256']) if (!hex.test(row[name])) held();
    if (!/^[0-9a-f]{32}$(?![\s\S])/.test(row.decision_claim_id)) held();
    instant(row.created_at);
    if (row.state === 'decided') {
      instant(row.decided_at);
      const choice = row.classification_status === 'classified_yes' ? 'yes' : row.classification_status === 'classified_no' ? 'no' : null;
      if (!['classified_yes','classified_no','fallback_unavailable','fallback_uncertain','fallback_invalid','fallback_error'].includes(row.classification_status)
          || row.choice !== choice) held();
      if (choice === 'no' && db.prepare('SELECT 1 FROM deliveries WHERE ' + where).get(...tuple(row))) held();
    }
  }
  if (db.prepare(`SELECT 1 FROM pending_owner_requests WHERE state IN ('reserved','active')
      GROUP BY profile_id,destination_id,project_root HAVING COUNT(*)>32 LIMIT 1`).get()) held();
  for (const row of db.prepare('SELECT * FROM pending_owner_requests').all() as any[]) {
    protectScalars({ ...row },[]); identity(row); if (!revisionPattern.test(row.event_revision) || !sessionPattern.test(row.original_session_id)) held();
    safeNativeIdentity(row.project_root,4096); instant(row.created_at); instant(row.updated_at);
    if (!Number.isSafeInteger(row.processing_sequence) || row.processing_sequence < 0) held();
    const link = row.review_link_json === null ? undefined : validateReviewLink(strictJson(row.review_link_json));
    safeBody(row.body,[],link);
    if (!row.body.endsWith(`\n\nPi notification; session ${row.original_session_id}; revision ${row.event_revision}`)) held();
    if (row.snoozed_until !== null) instant(row.snoozed_until);
    for (const name of ['answer_evidence_json','snooze_evidence_json']) if (row[name] !== null) {
      const proof = strictJson(row[name]);
      // Proof semantics are independently checked by the owner decoder before
      // writes; stored metadata must still be bounded, plain and secret-safe.
      if (!proof || typeof proof !== 'object' || Array.isArray(proof)) held();
      protectScalars(proof,[]);
    }
    if (row.state === 'reserved') continue;
    safeNativeIdentity(row.native_project_id);
    if (!messagePattern.test(row.message_id) || !messagePattern.test(row.thread_id)
        || new URL(row.inbox_authority).origin !== row.inbox_authority || !row.inbox_authority.startsWith('https://')
        || !row.canonical_url.startsWith(row.inbox_authority + '/') || !row.canonical_url.endsWith('#thread=' + row.thread_id)) held();
    const association = db.prepare('SELECT * FROM canonical_associations WHERE ' + where).get(...tuple(row)) as any;
    if (!association || association.legacy_unmapped !== 0 || association.read_verified !== 1
        || association.inbox_authority !== row.inbox_authority || association.message_id !== row.message_id
        || association.thread_id !== row.thread_id || association.native_project_id !== row.native_project_id
        || association.project_root !== row.project_root || association.session_id !== row.original_session_id) held();
  }
  for (const row of db.prepare('SELECT * FROM reminder_occurrences').all() as any[]) {
    protectScalars({ ...row },[]); validateUTCSlot(row.utc_slot); instant(row.created_at); if (row.send_started_at !== null) instant(row.send_started_at);
    const original = { ...row, purpose: row.original_purpose } as DeliveryIdentity;
    const expected = reminderDeliveryIdentity(original, row.utc_slot);
    if (row.reminder_key !== expected.decision_key || !/^[A-Za-z0-9._-]{1,80}$(?![\s\S])/.test(row.claim_operation_id)) held();
    const pending = db.prepare('SELECT state FROM pending_owner_requests WHERE ' + where).get(...tuple(original));
    if (!pending || pending.state === 'reserved') held();
    const delivery = db.prepare('SELECT source FROM deliveries WHERE ' + where).get(...tuple(expected));
    if (!delivery || delivery.source !== 'live') held();
  }
  // Legacy-unmapped rows remain blocked historical tombstones, never eligible
  // hourly effects. Every OTHER live reminder requires the original chain even
  // if somebody supplied a per-effect canonical association.
  if (db.prepare(`SELECT 1 FROM deliveries d WHERE d.purpose='reminder' AND d.source='live'
      AND NOT EXISTS (SELECT 1 FROM canonical_associations c WHERE c.profile_id=d.profile_id
        AND c.destination_id=d.destination_id AND c.decision_key=d.decision_key
        AND c.event_revision=d.event_revision AND c.purpose=d.purpose AND c.legacy_unmapped=1)
      AND NOT EXISTS (SELECT 1 FROM reminder_occurrences o WHERE o.profile_id=d.profile_id
        AND o.destination_id=d.destination_id AND o.reminder_key=d.decision_key
        AND o.event_revision=d.event_revision AND o.purpose=d.purpose) LIMIT 1`).get()) held();
  // This exception is scoped ONLY to exact linked reminders. Every other
  // confirmed delivery must retain the original canonical-association coverage.
  if (db.prepare(`SELECT 1 FROM deliveries d LEFT JOIN canonical_associations c USING (${identityColumns})
      WHERE d.state IN ('sent','duplicate') AND c.profile_id IS NULL AND NOT EXISTS (
        SELECT 1 FROM reminder_occurrences o WHERE d.purpose='reminder' AND o.profile_id=d.profile_id
          AND o.destination_id=d.destination_id AND o.reminder_key=d.decision_key
          AND o.event_revision=d.event_revision AND o.purpose=d.purpose) LIMIT 1`).get()) held();
}
