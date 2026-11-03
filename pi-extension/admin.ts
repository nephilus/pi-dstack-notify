/** Explicit operator CLI. Never imported or run by the Pi extension entry. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { defaultConfigurationPath } from './adapter/config-selection.ts';
import { canonicalPath, loadConfiguration } from './core/config.ts';
import { existingDatabase, privateParent, syncParent } from './core/storage.ts';
import { adoptOpaqueHistoryV3, initializeLedgerV3, validateDispatchFence, fencePath, administrationLockPath } from './core/migration.ts';
import { validateSchema, versionOf } from './core/schema.ts';

const help = `Node >=24, from the explicitly located package root:
node ./pi-extension/admin.ts scaffold [--config /absolute/private/config.json]
node ./pi-extension/admin.ts validate --config /absolute/private/config.json
node ./pi-extension/admin.ts status --ledger /absolute/private/ledger.sqlite
node ./pi-extension/admin.ts provision-fresh --ledger /absolute/private/ledger.sqlite --dispatch-disabled --all-old-writers-quiesced --wal-consistent-backup-verified --no-prior-history
node ./pi-extension/admin.ts adopt-one-current-intent --ledger /absolute/private/ledger.sqlite --spec /absolute/private/operator-spec.json --dispatch-disabled --all-old-writers-quiesced --wal-consistent-backup-verified
Adoption reuses the declared literal credential ENV, creates a private profile,
archives exact opaque JSON bytes, and admits only the operator's ONE current item.
See docs/CONTINUE-ONE-ITEM.md. It does NOT assert no prior history.
Scaffold is DISABLED. Validate/status are not readiness or send permission.
Status uses read-only SQLite; WAL/SHM filesystem effects are possible.
Fresh init refuses -journal/-wal/-shm under the exclusive lock before SQLite use.
All four FRESH assertions / three ADOPTION assertions must be externally true; this utility proves none.
Missing files do not establish no history. No retry, repair, overwrite or migration.
`;
class ArgumentsError extends Error {}
function parse(args: string[]): { command: string; values: Map<string, string | true> } {
  if (args.length === 1 && args[0] === '--help') return { command: 'help', values: new Map() };
  const command = args[0];
  const assertions = ['--dispatch-disabled', '--all-old-writers-quiesced', '--wal-consistent-backup-verified', '--no-prior-history'];
  const allowed: Record<string, string[]> = { scaffold: ['--config'], validate: ['--config'], status: ['--ledger'],
    'provision-fresh': ['--ledger', ...assertions],
    'adopt-one-current-intent': ['--ledger','--spec',...assertions.slice(0,3)] };
  if (!Object.hasOwn(allowed, command ?? '')) throw new ArgumentsError();
  const values = new Map<string, string | true>();
  for (let i = 1; i < args.length; i++) {
    const key = args[i];
    if (!allowed[command].includes(key) || values.has(key)) throw new ArgumentsError();
    if (assertions.includes(key)) values.set(key, true);
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new ArgumentsError();
      values.set(key, value);
    }
  }
  if ((command === 'validate' && !values.has('--config'))
      || (['status', 'provision-fresh'].includes(command) && !values.has('--ledger'))
      || (command === 'provision-fresh' && assertions.some(key => !values.has(key)))
      || (command === 'adopt-one-current-intent' && ['--ledger','--spec',...assertions.slice(0,3)].some(key => !values.has(key)))) throw new ArgumentsError();
  return { command, values };
}
function absent(filename: string): void {
  try { fs.lstatSync(filename); } catch (e: any) { if (e.code === 'ENOENT') return; throw e; }
  throw new Error('administration_held');
}
function run(): void {
  const { command, values } = parse(process.argv.slice(2));
  if (command === 'help') { process.stdout.write(help); return; }
  if (command === 'scaffold') {
    const ownDefault = !values.has('--config');
    const filename = ownDefault ? defaultConfigurationPath() : values.get('--config') as string;
    const parent = path.dirname(filename);
    if (ownDefault) {
      canonicalPath(path.dirname(parent));
      const st = fs.lstatSync(path.dirname(parent));
      if (!st.isDirectory() || st.uid !== process.getuid?.()) throw new Error('administration_held');
      try { fs.mkdirSync(parent, { mode: 0o700 }); syncParent(parent); }
      catch (e: any) { if (e.code !== 'EEXIST') throw e; }
    }
    canonicalPath(filename, false); privateParent(filename);
    const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, '{"version":1,"enabled":false,"projects":[]}\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    syncParent(filename);
    process.stdout.write(JSON.stringify({ status: 'created_disabled', enabled: false }) + '\n'); return;
  }
  if (command === 'validate') {
    const config = loadConfiguration(values.get('--config') as string);
    process.stdout.write(JSON.stringify({ status: 'structurally_valid', enabled: config.enabled,
      projects: config.projects.length, readiness: 'not_evaluated' }) + '\n'); return;
  }
  const filename = values.get('--ledger') as string;
  canonicalPath(filename, false); privateParent(filename);
  if (command === 'adopt-one-current-intent') {
    adoptOpaqueHistoryV3(filename,values.get('--spec') as string,{dispatchDisabled:true,allOldWritersQuiesced:true,walConsistentBackupVerified:true});
    process.stdout.write(JSON.stringify({status:'adopted_one_current_intent_v3',fence:'active',config_enabled:'unchanged',
      historical_unknown_attempts:'unavailable',assertions:'operator_declared_not_proven',readiness:'not_evaluated'}) + '\n'); return;
  }
  if (command === 'provision-fresh') {
    for (const file of [filename, filename + '-journal', filename + '-wal', filename + '-shm', fencePath(filename), administrationLockPath(filename)]) absent(file);
    // These are operator declarations, NEVER facts inferred from absence or proven here.
    initializeLedgerV3(filename, { dispatchDisabled: true, allOldWritersQuiesced: true,
      walConsistentBackupVerified: true, noPriorHistory: true });
    process.stdout.write(JSON.stringify({ status: 'initialized_v3', config_enabled: 'unchanged',
      fence: 'active', assertions: 'operator_declared_not_proven', readiness: 'not_evaluated' }) + '\n'); return;
  }
  const db = existingDatabase(filename, true);
  try {
    const version = versionOf(db);
    if (version !== 2 && version !== 3) throw new Error('administration_held');
    validateSchema(db, version); validateDispatchFence(db, filename);
    const unknown = Number((db.prepare("SELECT COUNT(*) n FROM deliveries WHERE state IN ('in_flight','delivery_unknown')").get() as any).n);
    const unmapped = Number((db.prepare('SELECT COUNT(*) n FROM canonical_associations WHERE legacy_unmapped=1').get() as any).n);
    process.stdout.write(JSON.stringify({ status: 'structurally_compatible', version, readiness: 'not_evaluated',
      identity_specific_unknown_or_in_flight: unknown, identity_specific_legacy_unmapped: unmapped,
      holds: 'identity_specific_not_corruption_or_retry_permission', sqlite_sidecar_effects: 'possible' }) + '\n');
  } finally { db.close(); }
}
try { run(); } catch (error) {
  const code = error instanceof ArgumentsError ? 'invalid_arguments' : error instanceof Error
    && /^ledger_(?:cutover|migration|dispatch)_(?:held|ambiguous)$/.test(error.message) ? error.message : 'administration_held';
  process.stderr.write(JSON.stringify({ code, retry: false, preserve_artifacts: true }) + '\n');
  process.exitCode = error instanceof ArgumentsError ? 2 : 1;
}
