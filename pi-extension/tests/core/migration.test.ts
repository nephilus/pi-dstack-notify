import './offline-guard.mjs';
import { attempts } from './offline-guard.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { migrateLedgerV1ToV2, initializeLedgerV2, disableLedgerDispatch, fencePath, administrationLockPath } from '../../core/migration.ts';
import { DeliveryLedger, LegacyMappingRequired } from '../../core/ledger.ts';
import { canonicalSchema } from '../../core/schema.ts';
import { digest } from '../../core/safety.ts';
import { acceptedV1ReaderGate } from '../../fixtures/v1-reader-gate.ts';
import type { DeliveryIdentity } from '../../core/types.ts';
const sql = fs.readFileSync(new URL('../../fixtures/delivery-v1.sql', import.meta.url), 'utf8');
const prerequisites = { dispatchDisabled: true, allOldWritersQuiesced: true, walConsistentBackupVerified: true } as const;
function identity(key = 'owner/repo:confirmed'): DeliveryIdentity {
  return { profile_id: 'primary', destination_id: 'owner', decision_key: key, event_revision: 'a'.repeat(64), purpose: 'explicit_attention' };
}
function make(t: any) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notification-migration-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'ledger.sqlite');
  const db = new DatabaseSync(filename); fs.chmodSync(filename, 0o600); db.exec(sql);
  db.prepare('INSERT INTO migrations VALUES (?,?,?,?)').run('retained-legacy-import', 'f'.repeat(64), 1, 1);
  db.prepare("INSERT INTO deliveries VALUES ('primary','owner','owner/repo:confirmed',?,'explicit_attention','sent',NULL,1,2,2,'legacy-confirmation','legacy_attention','retained-legacy-import')").run('a'.repeat(64));
  const insert = db.prepare("INSERT INTO deliveries VALUES ('primary','owner',?,?,'explicit_attention',?,?,1,2,?,?, 'live',NULL)");
  insert.run('owner/repo:unknown', 'a'.repeat(64), 'delivery_unknown', 'b'.repeat(32), null, null);
  insert.run('owner/repo:inflight', 'a'.repeat(64), 'in_flight', 'c'.repeat(32), null, null);
  insert.run('owner/repo:duplicate', 'a'.repeat(64), 'duplicate', 'd'.repeat(32), 2, '42');
  db.close(); return { directory, filename };
}
function snapshot(filename: string) {
  const db = new DatabaseSync(filename);
  try {
    return { deliveries: db.prepare('SELECT * FROM deliveries ORDER BY profile_id,destination_id,decision_key,event_revision,purpose').all(),
      migrations: db.prepare("SELECT * FROM migrations WHERE migration_id NOT LIKE 'canonical-v2/%' ORDER BY migration_id").all(),
      version: (db.prepare('PRAGMA user_version').get() as any).user_version };
  } finally { db.close(); }
}
function assertHistory(filename: string, before: ReturnType<typeof snapshot>) {
  const after = snapshot(filename); assert.deepEqual(after.deliveries, before.deliveries); assert.deepEqual(after.migrations, before.migrations);
}
after(() => assert.deepEqual(attempts, []));

test('explicit v1→v2 preserves ALL old values/claims/unknowns and repeated valid migration is no-op', t => {
  const h = make(t), before = snapshot(h.filename);
  assert.throws(() => new DeliveryLedger(h.filename), 'v1 must not auto-upgrade in a publisher');
  assert.deepEqual(migrateLedgerV1ToV2(h.filename, prerequisites), { migrated: true, schema_version: 2 });
  assertHistory(h.filename, before); assert.equal(snapshot(h.filename).version, 2);
  const db = new DatabaseSync(h.filename);
  const rows = db.prepare('SELECT * FROM canonical_associations').all() as any[];
  assert.equal(rows.length, 4); assert.ok(rows.every(r => r.legacy_unmapped === 1 && r.message_id === null && r.inbox_authority === null));
  db.close();
  const fence = fs.readFileSync(fencePath(h.filename)); const second = snapshot(h.filename);
  assert.deepEqual(migrateLedgerV1ToV2(h.filename, prerequisites), { migrated: false, schema_version: 2 });
  assertHistory(h.filename, second); assert.deepEqual(fs.readFileSync(fencePath(h.filename)), fence);
  const ledger = new DeliveryLedger(h.filename);
  try {
    assert.equal(ledger.claim(identity()).action, 'suppressed');
    assert.equal(ledger.claim(identity('owner/repo:duplicate')).action, 'suppressed');
    assert.equal(ledger.claim(identity('owner/repo:unknown')).action, 'held');
    assert.equal(ledger.claim(identity('owner/repo:inflight')).action, 'held');
    assert.throws(() => ledger.claim(identity('owner/repo:asserted-new')), LegacyMappingRequired);
    assert.throws(() => ledger.claim({ ...identity('genuinely-new'), purpose: 'different-purpose' }), LegacyMappingRequired);
  } finally { ledger.close(); }
});

test('DDL/version/commit failure rolls back database atomically, preserves rows, and retains partial fence hold', t => {
  for (const stage of ['version', 'commit']) {
    const h = make(t), before = snapshot(h.filename);
    const original = DatabaseSync.prototype.exec; let failed = false;
    DatabaseSync.prototype.exec = function (query: string) {
      if (!failed && query === (stage === 'version' ? 'PRAGMA user_version=2' : 'COMMIT')) {
        failed = true; throw new Error('synthetic migration fault');
      }
      return original.call(this, query);
    };
    try { assert.throws(() => migrateLedgerV1ToV2(h.filename, prerequisites), { message: 'ledger_migration_held' }); }
    finally { DatabaseSync.prototype.exec = original; }
    assert.ok(failed); assertHistory(h.filename, before); assert.equal(snapshot(h.filename).version, 1);
    const db = new DatabaseSync(h.filename);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='canonical_associations'").get(), undefined); db.close();
    const fence = JSON.parse(fs.readFileSync(fencePath(h.filename), 'utf8')); assert.equal(fence.state, 'prepared');
    assert.throws(() => new DeliveryLedger(h.filename));
    assert.throws(() => migrateLedgerV1ToV2(h.filename, prerequisites));
    assertHistory(h.filename, before); // No retry can erase the partial fence or start fresh.
  }
});

test('failure after DB commit but before fence activation remains fully preserved and dispatch-held', t => {
  const h = make(t), before = snapshot(h.filename); const original = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === fencePath(h.filename)) throw new Error('synthetic activation fault');
    return original(from, to);
  }) as typeof fs.renameSync; syncBuiltinESMExports();
  try { assert.throws(() => migrateLedgerV1ToV2(h.filename, prerequisites)); }
  finally { fs.renameSync = original; syncBuiltinESMExports(); }
  assertHistory(h.filename, before); assert.equal(snapshot(h.filename).version, 2);
  assert.equal(JSON.parse(fs.readFileSync(fencePath(h.filename), 'utf8')).state, 'prepared');
  assert.throws(() => new DeliveryLedger(h.filename));
  assert.throws(() => migrateLedgerV1ToV2(h.filename, prerequisites));
});

test('nonlegacy confirmed coverage loss rejects open and repeated migration without rewriting history', t => {
  for (const fresh of [true, false]) {
    const h = make(t);
    if (fresh) fs.unlinkSync(h.filename);
    if (fresh) initializeLedgerV2(h.filename, { ...prerequisites, noPriorHistory: true });
    else migrateLedgerV1ToV2(h.filename, prerequisites);
    const id = { ...identity('post-cutover-confirmed'), profile_id: 'unaffected' };
    const ledger = new DeliveryLedger(h.filename);
    const claim = ledger.claim(id).receipt.claim_id!;
    assert.throws(() => ledger.confirmed(id, claim, 42), 'confirmation requires canonical coverage');
    ledger.associate(id, claim, { authority: 'https://inbox.example.invalid', message_id: 'msg_00000000000000000000000001', thread_id: 'msg_00000000000000000000000001',
      native_project_id: 'project-1', project_root: h.directory, session_id: 'session-1' }, true);
    ledger.confirmed(id, claim, 42); ledger.close();
    const before = snapshot(h.filename);
    const db = new DatabaseSync(h.filename);
    db.prepare('DELETE FROM canonical_associations WHERE profile_id=?').run(id.profile_id); db.close();
    assert.throws(() => new DeliveryLedger(h.filename));
    assert.throws(() => migrateLedgerV1ToV2(h.filename, prerequisites));
    assertHistory(h.filename, before);
  }
});

test('administration serialization rejects disable during commit/activation; successful disable is monotonic', t => {
  const h = make(t); const original = DatabaseSync.prototype.exec; let attempted = false;
  DatabaseSync.prototype.exec = function (query: string) {
    const result = original.call(this, query);
    if (query === 'COMMIT' && !attempted) {
      attempted = true;
      assert.throws(() => disableLedgerDispatch(h.filename), { message: 'ledger_dispatch_ambiguous' });
      assert.throws(() => initializeLedgerV2(h.filename, { ...prerequisites, noPriorHistory: true }));
      assert.throws(() => migrateLedgerV1ToV2(h.filename, prerequisites));
      assert.throws(() => new DeliveryLedger(h.filename));
    }
    return result;
  };
  try { migrateLedgerV1ToV2(h.filename, prerequisites); }
  finally { DatabaseSync.prototype.exec = original; }
  assert.ok(attempted);
  assert.equal(JSON.parse(fs.readFileSync(fencePath(h.filename), 'utf8')).state, 'active');
  assert.ok(!fs.existsSync(administrationLockPath(h.filename)));
  disableLedgerDispatch(h.filename); disableLedgerDispatch(h.filename);
  assert.throws(() => migrateLedgerV1ToV2(h.filename, prerequisites));
  assert.equal(JSON.parse(fs.readFileSync(fencePath(h.filename), 'utf8')).state, 'dispatch-disabled');
  assert.throws(() => new DeliveryLedger(h.filename));
});

test('crashed administration lock fails closed without automatic stale reclamation', t => {
  const h = make(t); migrateLedgerV1ToV2(h.filename, prerequisites);
  const before = fs.readFileSync(fencePath(h.filename));
  fs.mkdirSync(administrationLockPath(h.filename), { mode: 0o700 });
  assert.throws(() => new DeliveryLedger(h.filename));
  assert.throws(() => disableLedgerDispatch(h.filename), { message: 'ledger_dispatch_ambiguous' });
  assert.throws(() => migrateLedgerV1ToV2(h.filename, prerequisites));
  assert.deepEqual(fs.readFileSync(fencePath(h.filename)), before);
  assert.ok(fs.existsSync(administrationLockPath(h.filename)));
});

test('activation fsync faults before and after rename distinguish held from ambiguous and retain fail-closed lock', t => {
  for (const stage of ['pre-rename', 'post-rename']) {
    const h = make(t), before = snapshot(h.filename);
    const originalSync = fs.fsyncSync, originalRename = fs.renameSync;
    let committed = false, renamed = false, failed = false;
    const originalExec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function (query: string) {
      const result = originalExec.call(this, query);
      if (query === 'COMMIT') committed = true;
      return result;
    };
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      originalRename(from, to); if (String(to) === fencePath(h.filename)) renamed = true;
    }) as typeof fs.renameSync;
    fs.fsyncSync = ((fd: number) => {
      if (!failed && committed && (stage === 'post-rename' ? renamed && fs.fstatSync(fd).isDirectory() : !renamed)) {
        failed = true; throw new Error('synthetic sync fault');
      }
      originalSync(fd);
    }) as typeof fs.fsyncSync;
    syncBuiltinESMExports();
    try {
      assert.throws(() => migrateLedgerV1ToV2(h.filename, prerequisites),
        { message: stage === 'post-rename' ? 'ledger_migration_ambiguous' : 'ledger_migration_held' });
    } finally {
      DatabaseSync.prototype.exec = originalExec; fs.fsyncSync = originalSync; fs.renameSync = originalRename; syncBuiltinESMExports();
    }
    assert.ok(failed); assertHistory(h.filename, before); assert.equal(snapshot(h.filename).version, 2);
    assert.equal(JSON.parse(fs.readFileSync(fencePath(h.filename), 'utf8')).state, stage === 'post-rename' ? 'active' : 'prepared');
    assert.ok(fs.existsSync(administrationLockPath(h.filename)));
    assert.throws(() => new DeliveryLedger(h.filename));
    assert.throws(() => migrateLedgerV1ToV2(h.filename, prerequisites));
  }
});

test('post-rename disable sync failure does not claim durable disable from visible disabled state', t => {
  const h = make(t); migrateLedgerV1ToV2(h.filename, prerequisites);
  const originalSync = fs.fsyncSync, originalRename = fs.renameSync; let renamed = false;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    originalRename(from, to); if (String(to) === fencePath(h.filename)) renamed = true;
  }) as typeof fs.renameSync;
  fs.fsyncSync = ((fd: number) => {
    if (renamed && fs.fstatSync(fd).isDirectory()) throw new Error('synthetic disable directory sync fault');
    originalSync(fd);
  }) as typeof fs.fsyncSync;
  syncBuiltinESMExports();
  try { assert.throws(() => disableLedgerDispatch(h.filename), { message: 'ledger_dispatch_ambiguous' }); }
  finally { fs.fsyncSync = originalSync; fs.renameSync = originalRename; syncBuiltinESMExports(); }
  assert.equal(JSON.parse(fs.readFileSync(fencePath(h.filename), 'utf8')).state, 'dispatch-disabled');
  assert.ok(fs.existsSync(administrationLockPath(h.filename)));
  assert.throws(() => new DeliveryLedger(h.filename));
});

test('release directory sync failure after successful rmdir is ambiguous with active fence and NO runtime lock', t => {
  const h = make(t), before = snapshot(h.filename);
  const lock = administrationLockPath(h.filename);
  const originalRmdir = fs.rmdirSync, originalSync = fs.fsyncSync;
  let removed = false, failed = false;
  fs.rmdirSync = ((...args: Parameters<typeof fs.rmdirSync>) => {
    originalRmdir(...args);
    if (String(args[0]) === lock) {
      removed = true;
      assert.equal(fs.existsSync(lock), false, 'fault must follow actual successful lock removal');
    }
  }) as typeof fs.rmdirSync;
  fs.fsyncSync = ((fd: number) => {
    if (removed && !failed && fs.fstatSync(fd).isDirectory()) {
      failed = true; throw new Error('synthetic release parent-directory sync fault');
    }
    originalSync(fd);
  }) as typeof fs.fsyncSync;
  syncBuiltinESMExports();
  try { assert.throws(() => migrateLedgerV1ToV2(h.filename, prerequisites), { message: 'ledger_migration_ambiguous' }); }
  finally { fs.rmdirSync = originalRmdir; fs.fsyncSync = originalSync; syncBuiltinESMExports(); }
  assert.ok(removed && failed);
  assert.equal(fs.existsSync(lock), false, 'no retained lock or automatic recreation may be claimed');
  assert.equal(JSON.parse(fs.readFileSync(fencePath(h.filename), 'utf8')).state, 'active');
  assertHistory(h.filename, before); assert.equal(snapshot(h.filename).version, 2);
  // Negative guarantee: the TS runtime can open in this release window. This
  // is NOT permission to enable external dispatch; it must remain disabled.
  const ledger = new DeliveryLedger(h.filename);
  try { ledger.checkFence(); } finally { ledger.close(); }
});

test('corrupt or partial v1/v2 layouts never transform twice or invent empty history', t => {
  for (const mode of ['v1-partial', 'v2-missing', 'v2-corrupt-coverage', 'v2-marker', 'v2-fence']) {
    const h = make(t), before = snapshot(h.filename);
    if (mode !== 'v1-partial') migrateLedgerV1ToV2(h.filename, prerequisites);
    const db = new DatabaseSync(h.filename);
    if (mode === 'v1-partial') db.exec(canonicalSchema);
    if (mode === 'v2-missing') db.exec('DROP TABLE canonical_associations');
    if (mode === 'v2-corrupt-coverage') db.exec("DELETE FROM canonical_associations WHERE decision_key='owner/repo:unknown'");
    if (mode === 'v2-marker') db.exec("UPDATE migrations SET manifest_sha256='corrupt' WHERE migration_id LIKE 'canonical-v2/%'");
    db.close();
    if (mode === 'v2-fence') fs.writeFileSync(fencePath(h.filename), '{"version":2}\n');
    assert.throws(() => new DeliveryLedger(h.filename));
    assert.throws(() => migrateLedgerV1ToV2(h.filename, prerequisites));
    assertHistory(h.filename, before);
  }
});

test('v2 rejects accepted v1 reader gate before WAL changes; no downgrade compatibility', t => {
  const h = make(t); migrateLedgerV1ToV2(h.filename, prerequisites);
  const before = digest(fs.readFileSync(h.filename)); const db = new DatabaseSync(h.filename);
  assert.throws(() => acceptedV1ReaderGate(db), { message: 'Unsupported delivery ledger schema version.' });
  assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, 2); db.close();
  assert.equal(digest(fs.readFileSync(h.filename)), before);
});

test('false cutover prerequisites with an old writer open are refused before any transform', t => {
  const h = make(t), before = snapshot(h.filename); const old = new DatabaseSync(h.filename);
  try {
    for (const key of Object.keys(prerequisites)) {
      assert.throws(() => migrateLedgerV1ToV2(h.filename, { ...prerequisites, [key]: false } as any));
    }
    assertHistory(h.filename, before); assert.ok(!fs.existsSync(fencePath(h.filename)));
  } finally { old.close(); }
});

test('active old write transaction blocks migration; atomic busy failure does not reset history', t => {
  const h = make(t), before = snapshot(h.filename); const old = new DatabaseSync(h.filename); old.exec('BEGIN IMMEDIATE');
  const original = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (query: string) { return original.call(this, query.replace('busy_timeout=10000', 'busy_timeout=1')); };
  try { assert.throws(() => migrateLedgerV1ToV2(h.filename, prerequisites)); }
  finally { DatabaseSync.prototype.exec = original; old.exec('ROLLBACK'); old.close(); }
  assertHistory(h.filename, before); assert.equal(snapshot(h.filename).version, 1); assert.ok(!fs.existsSync(fencePath(h.filename)));
});

test('quiescence assertion cannot detect a previously open idle writer: explicit external prerequisite', t => {
  const h = make(t); const old = new DatabaseSync(h.filename);
  // NEGATIVE fixture: caller lies about quiescence. A native idle connection
  // remains capable after schema commit; no claim of automatic detection.
  migrateLedgerV1ToV2(h.filename, prerequisites);
  old.prepare("INSERT INTO deliveries VALUES ('primary','owner','owner/repo:old-writer',?,'explicit_attention','in_flight',?,1,1,NULL,NULL,'live',NULL)")
    .run('a'.repeat(64), 'e'.repeat(32)); old.close();
  const ledger = new DeliveryLedger(h.filename);
  try { assert.equal(ledger.claim(identity('owner/repo:old-writer')).action, 'held'); }
  finally { ledger.close(); }
});

test('rollback disables TS dispatch and preserves newer evidence; TS refuses stale v1 restore', t => {
  const h = make(t); const oldBackup = fs.readFileSync(h.filename); migrateLedgerV1ToV2(h.filename, prerequisites);
  // New profile/destination scope, not an invented alias for unmapped old rows.
  const fresh = { ...identity('owner/repo:post-cutover'), profile_id: 'second', destination_id: 'other' };
  const ledger = new DeliveryLedger(h.filename); const claim = ledger.claim(fresh);
  ledger.unknown(fresh, claim.receipt.claim_id!); ledger.close();
  const evidence = path.join(h.directory, 'POST-v2-evidence.sqlite'); fs.copyFileSync(h.filename, evidence); fs.chmodSync(evidence, 0o600);
  const fenceEvidence = fs.readFileSync(fencePath(h.filename));
  disableLedgerDispatch(h.filename);
  assert.throws(() => new DeliveryLedger(h.filename));
  fs.writeFileSync(h.filename, oldBackup); // CLOSED disposable files only, not a live restore.
  assert.throws(() => new DeliveryLedger(h.filename));
  assert.throws(() => migrateLedgerV1ToV2(h.filename, prerequisites));
  assert.throws(() => initializeLedgerV2(h.filename, { ...prerequisites, noPriorHistory: true }));
  const retained = new DatabaseSync(evidence);
  assert.equal((retained.prepare("SELECT state FROM deliveries WHERE decision_key='owner/repo:post-cutover'").get() as any).state, 'delivery_unknown'); retained.close();
  assert.equal(JSON.parse(fs.readFileSync(fencePath(h.filename), 'utf8')).state, 'dispatch-disabled');
  assert.equal(JSON.parse(fenceEvidence.toString()).state, 'active');
});

test('TS v2 refuses stale v1 restore, missing DB and fresh-path fallback with retained fence', t => {
  const h = make(t), backup = fs.readFileSync(h.filename); migrateLedgerV1ToV2(h.filename, prerequisites);
  const fence = fs.readFileSync(fencePath(h.filename));
  fs.writeFileSync(h.filename, backup);
  assert.throws(() => new DeliveryLedger(h.filename)); assert.throws(() => migrateLedgerV1ToV2(h.filename, prerequisites));
  assert.deepEqual(fs.readFileSync(fencePath(h.filename)), fence);
  fs.unlinkSync(h.filename);
  assert.throws(() => new DeliveryLedger(h.filename));
  assert.throws(() => initializeLedgerV2(h.filename, { ...prerequisites, noPriorHistory: true }));
  assert.ok(!fs.existsSync(h.filename));
  const alternate = path.join(h.directory, 'empty-fallback.sqlite');
  assert.throws(() => new DeliveryLedger(alternate)); assert.ok(!fs.existsSync(alternate));
});

test('same-epoch stale v2 restore remains held by rollback fence; no automatic re-enable', t => {
  const h = make(t); migrateLedgerV1ToV2(h.filename, prerequisites);
  const stale = fs.readFileSync(h.filename);
  const ledger = new DeliveryLedger(h.filename); const id = { ...identity('later'), profile_id: 'second' };
  ledger.claim(id); ledger.close();
  // Epoch alone cannot detect intra-epoch stale data. Correct restore protocol
  // disables dispatch first; paired fence/DB rollback is an external trust limit.
  disableLedgerDispatch(h.filename); fs.writeFileSync(h.filename, stale);
  assert.throws(() => new DeliveryLedger(h.filename)); assert.throws(() => migrateLedgerV1ToV2(h.filename, prerequisites));
});
