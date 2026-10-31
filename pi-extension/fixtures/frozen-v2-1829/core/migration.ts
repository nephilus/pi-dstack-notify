/** SOURCE/OFFLINE cutover only. No CLI, live discovery, automatic migration or restore. */
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { privateBytes, utf8 } from './config.ts';
import { digest, exact, held, strictJson } from './safety.ts';
import { schema, canonicalSchema, validateSchema, versionOf } from './schema.ts';
import { existingDatabase, privateFile, privateParent, syncParent, transaction } from './storage.ts';
export interface CutoverAssertions {
  dispatchDisabled: true;
  allOldWritersQuiesced: true;
  walConsistentBackupVerified: true;
}
export interface NewLedgerAssertions extends CutoverAssertions { noPriorHistory: true }
interface Fence {
  version: 2; cutover_id: string; kind: 'new-ledger' | 'v1-migration'; created_at: number;
  original_count: number; legacy_identity_sha256: string; assertions: {
    dispatch_disabled: true; all_old_writers_quiesced: true;
    wal_consistent_backup_verified: true; no_prior_history: boolean;
  };
  state: 'prepared' | 'active' | 'dispatch-disabled'; manifest_sha256: string;
}
export const fencePath = (filename: string): string => filename + '.cutover-v2.json';
export const administrationLockPath = (filename: string): string => filename + '.cutover-v2.lock';
function assertNoAdministration(filename: string): void {
  try { fs.lstatSync(administrationLockPath(filename)); }
  catch (e: any) { if (e.code === 'ENOENT') return; throw e; }
  held();
}
/** Exclusive across ALL administrative mutations, including initialization.
 * No waiting/reclamation: a crashed owner leaves a fail-closed lock. Recovery
 * requires external dispatch disable and independent review, not lock deletion.
 */
function administer<T>(filename: string, operation: 'cutover' | 'migration' | 'dispatch', fn: () => T): T {
  const lock = administrationLockPath(filename);
  let owned = false;
  try {
    privateParent(filename);
    fs.mkdirSync(lock, { mode: 0o700 }); owned = true;
    syncParent(lock);
    const result = fn();
    fs.rmdirSync(lock); syncParent(lock);
    return result;
  } catch {
    // Keep an owned lock on failure. A visible active fence is NOT a proven
    // durable hold (including post-rename directory-fsync uncertainty).
    let inactive = false;
    try { inactive = readFence(filename).state !== 'active'; } catch { /* unknown */ }
    // A failed disable may have renamed a disabled fence without syncing its
    // directory: visible disabled alone does not prove durable disable.
    throw new Error(`ledger_${operation}_${operation !== 'dispatch' && owned && inactive ? 'held' : 'ambiguous'}`);
  }
}
function assertPrerequisites(value: CutoverAssertions | NewLedgerAssertions, fresh = false): void {
  exact(value, fresh ? ['dispatchDisabled', 'allOldWritersQuiesced', 'walConsistentBackupVerified', 'noPriorHistory']
                     : ['dispatchDisabled', 'allOldWritersQuiesced', 'walConsistentBackupVerified']);
  if (Object.values(value).some(v => v !== true)) held();
}
function manifest(f: Omit<Fence, 'manifest_sha256'> | Fence): string {
  return digest(JSON.stringify({ version: f.version, cutover_id: f.cutover_id, kind: f.kind,
    created_at: f.created_at, original_count: f.original_count, legacy_identity_sha256: f.legacy_identity_sha256, assertions: {
      dispatch_disabled: f.assertions.dispatch_disabled, all_old_writers_quiesced: f.assertions.all_old_writers_quiesced,
      wal_consistent_backup_verified: f.assertions.wal_consistent_backup_verified,
      no_prior_history: f.assertions.no_prior_history,
    } }));
}
function identityDigest(db: DatabaseSync, table: 'deliveries' | 'canonical_associations'): string {
  const rows = db.prepare('SELECT profile_id,destination_id,decision_key,event_revision,purpose FROM ' + table
    + (table === 'canonical_associations' ? ' WHERE legacy_unmapped=1' : '')
    + ' ORDER BY profile_id,destination_id,decision_key,event_revision,purpose').all() as any[];
  return digest(JSON.stringify(rows.map(r => [r.profile_id, r.destination_id, r.decision_key, r.event_revision, r.purpose])));
}
function makeFence(kind: Fence['kind'], count: number, identities: string): Fence {
  const f = { version: 2 as const, cutover_id: randomUUID().replaceAll('-', ''), kind,
    created_at: Math.floor(Date.now() / 1000), original_count: count, legacy_identity_sha256: identities,
    assertions: { dispatch_disabled: true as const, all_old_writers_quiesced: true as const,
      wal_consistent_backup_verified: true as const, no_prior_history: kind === 'new-ledger' },
    state: 'prepared' as const };
  return { ...f, manifest_sha256: manifest(f) };
}
function readFence(filename: string): Fence {
  const f = strictJson(utf8(privateBytes(fencePath(filename))));
  exact(f, ['version', 'cutover_id', 'kind', 'created_at', 'original_count', 'legacy_identity_sha256', 'assertions', 'state', 'manifest_sha256']);
  exact(f.assertions, ['dispatch_disabled', 'all_old_writers_quiesced', 'wal_consistent_backup_verified', 'no_prior_history']);
  if (f.version !== 2 || typeof f.cutover_id !== 'string' || !/^[0-9a-f]{32}$(?![\s\S])/.test(f.cutover_id)
      || !['new-ledger', 'v1-migration'].includes(f.kind) || !Number.isSafeInteger(f.created_at) || f.created_at < 0
      || !Number.isSafeInteger(f.original_count) || f.original_count < 0
      || typeof f.legacy_identity_sha256 !== 'string' || !/^[0-9a-f]{64}$(?![\s\S])/.test(f.legacy_identity_sha256)
      || !['prepared', 'active', 'dispatch-disabled'].includes(f.state)
      || f.assertions.dispatch_disabled !== true || f.assertions.all_old_writers_quiesced !== true
      || f.assertions.wal_consistent_backup_verified !== true
      || f.assertions.no_prior_history !== (f.kind === 'new-ledger') || f.manifest_sha256 !== manifest(f as Fence)) held();
  return f as Fence;
}
function writeNewFence(filename: string, f: Fence): void {
  const target = fencePath(filename); privateParent(target);
  const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(f) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncParent(target);
}
function replaceFence(filename: string, f: Fence): void {
  const target = fencePath(filename); privateFile(target);
  const temp = target + '.' + randomUUID() + '.tmp';
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(f) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, target); syncParent(target);
}
function marker(db: DatabaseSync, f: Fence): void {
  if (db.prepare("SELECT 1 FROM migrations WHERE migration_id LIKE 'canonical-v2/%'").get()) held();
  db.prepare('INSERT INTO migrations VALUES (?,?,?,?)').run('canonical-v2/' + f.cutover_id,
    f.manifest_sha256, f.original_count, f.created_at);
}
/** Must run with a validated v2 schema; called again at effect boundaries. */
export function validateDispatchFence(db: DatabaseSync, filename: string, allowDisabledEvidenceWrite = false): void {
  assertNoAdministration(filename);
  validateFence(db, filename, allowDisabledEvidenceWrite);
}
function validateFence(db: DatabaseSync, filename: string, allowDisabledEvidenceWrite = false): void {
  const f = readFence(filename);
  if ((f.state !== 'active' && !(allowDisabledEvidenceWrite && f.state === 'dispatch-disabled')) || versionOf(db) !== 2) held();
  const rows = db.prepare("SELECT * FROM migrations WHERE migration_id LIKE 'canonical-v2/%'").all() as any[];
  if (rows.length !== 1 || rows[0].migration_id !== 'canonical-v2/' + f.cutover_id
      || rows[0].manifest_sha256 !== f.manifest_sha256 || rows[0].imported_count !== f.original_count
      || rows[0].imported_at !== f.created_at) held();
  const count = Number((db.prepare('SELECT COUNT(*) AS n FROM canonical_associations WHERE legacy_unmapped=1').get() as any).n);
  if (count !== f.original_count || identityDigest(db, 'canonical_associations') !== f.legacy_identity_sha256) held();
}
/** Explicit first provisioning ONLY: absence is not evidence of no old history.
 * The caller's noPriorHistory assertion is an external operator prerequisite.
 */
export function initializeLedgerV2(filename: string, assertions: NewLedgerAssertions): void {
  return administer(filename, 'cutover', () => {
    assertPrerequisites(assertions, true); privateParent(filename);
    // A retained fence blocks recreation after DB loss/restoration. Never pick
    // another file or clear a partial cutover automatically.
    try { fs.lstatSync(fencePath(filename)); held(); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    const fd = fs.openSync(filename, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.fsyncSync(fd); fs.closeSync(fd); syncParent(filename);
    const f = makeFence('new-ledger', 0, digest('[]')); writeNewFence(filename, f);
    const db = existingDatabase(filename);
    try {
      transaction(db, () => {
        if (versionOf(db) !== 0 || db.prepare('SELECT 1 FROM sqlite_master').get()) held();
        schema.forEach(sql => db.exec(sql)); db.exec(canonicalSchema); marker(db, f); db.exec('PRAGMA user_version=2');
      });
      validateSchema(db, 2);
      activateFence(filename, f);
    } finally { db.close(); }
  });
}
/** Explicit transactional v1→v2, not a constructor side effect. All v1 rows stay
 * byte-for-byte equivalent at SQL value level. Failed/partial administration
 * blocks dispatch; an active/unknown fence on error is explicitly ambiguous.
 */
export function migrateLedgerV1ToV2(filename: string, assertions: CutoverAssertions): { migrated: boolean; schema_version: 2 } {
  return administer(filename, 'migration', () => {
  let db: DatabaseSync | undefined;
  try {
    assertPrerequisites(assertions); db = existingDatabase(filename);
    if (versionOf(db) === 2) {
      transaction(db, () => { validateSchema(db!, 2); validateFence(db!, filename); });
      return { migrated: false, schema_version: 2 };
    }
    let f: Fence;
    transaction(db, () => {
      validateSchema(db!, 1);
      const count = Number((db!.prepare('SELECT COUNT(*) AS n FROM deliveries').get() as any).n);
      f = makeFence('v1-migration', count, identityDigest(db!, 'deliveries'));
      writeNewFence(filename, f); // O_EXCL: any previous/partial cutover holds.
      db!.exec(canonicalSchema);
      // No old Inbox IDs is NOT no-history evidence. Preserve an explicit
      // unmapped guard for every v1 identity without inventing native IDs.
      db!.prepare(`INSERT INTO canonical_associations
        (profile_id,destination_id,decision_key,event_revision,purpose,legacy_unmapped,read_verified,created_at)
        SELECT profile_id,destination_id,decision_key,event_revision,purpose,1,0,? FROM deliveries`).run(f.created_at);
      marker(db!, f); db!.exec('PRAGMA user_version=2');
      validateSchema(db!, 2);
    });
    activateFence(filename, f!);
    validateFence(db, filename);
    return { migrated: true, schema_version: 2 };
  } finally { db?.close(); }
  });
}
/** Rollback/restore FIRST disables adapter dispatch, then durably disables this
 * fence. No automatic re-enable or downgrade API exists in this source slice.
 */
export function disableLedgerDispatch(filename: string): void {
  administer(filename, 'dispatch', () => {
    const f = readFence(filename); replaceFence(filename, { ...f, state: 'dispatch-disabled' });
  });
}
/** Under the same exclusive administrative lock as disable. Disabled state is
 * terminal; activation never uses an earlier in-memory state to overwrite it. */
function activateFence(filename: string, expected: Fence): void {
  const current = readFence(filename);
  if (current.cutover_id !== expected.cutover_id || current.manifest_sha256 !== expected.manifest_sha256
      || current.state !== 'prepared') held();
  replaceFence(filename, { ...current, state: 'active' });
}
