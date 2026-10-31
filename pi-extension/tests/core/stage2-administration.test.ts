import './offline-guard.mjs';
import { attempts } from './offline-guard.mjs';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { DeliveryLedger as FrozenV2Ledger, LegacyMappingRequired as FrozenLegacyMappingRequired } from '../../fixtures/frozen-v2-1829/core/ledger.ts';
import { migrateLedgerV1ToV2 as frozenMigrateV1ToV2 } from '../../fixtures/frozen-v2-1829/core/migration.ts';
import { schema as frozenV1Tables } from '../../fixtures/frozen-v2-1829/core/schema.ts';
import { DeliveryLedger } from '../../core/ledger.ts';
import { upgradeLedgerV2ToV3, disableLedgerDispatch, administrationLockPath, fencePath } from '../../core/migration.ts';
import { validateSchema } from '../../core/schema.ts';
import type { DeliveryIdentity } from '../../core/types.ts';

const prerequisites = { dispatchDisabled:true, allOldWritersQuiesced:true, walConsistentBackupVerified:true } as const;
const revision = 'a'.repeat(64);
const fixtureBase = new URL('../../fixtures/frozen-v2-1829/',import.meta.url);
const id = (key:string, scope='current'):DeliveryIdentity => ({profile_id:scope,destination_id:'owner',decision_key:key,event_revision:revision,purpose:'explicit_attention'});
after(()=>{assert.deepEqual(attempts,[]);assert.equal(process.env.PATH,'/nonexistent-notification-test-path');});

function fixture(t:any, unsupported=false) {
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'notification-v3-admin-')));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const filename=path.join(directory,'ledger.sqlite');
  const db=new DatabaseSync(filename);fs.chmodSync(filename,0o600);
  try {
    frozenV1Tables.forEach(sql=>db.exec(sql));db.exec('PRAGMA user_version=1');
    db.prepare('INSERT INTO migrations VALUES (?,?,?,?)').run('synthetic-legacy-import','f'.repeat(64),1,10);
    for (const [index,state] of ['sent','duplicate','delivery_unknown','in_flight'].entries()) {
      db.prepare('INSERT INTO deliveries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run('legacy','owner','old/'+state,revision,
        index%2 ? 'explicit_attention':'reminder',state,state==='sent'?null:String(index).repeat(32),10,11,
        ['sent','duplicate'].includes(state)?11:null,['sent','duplicate'].includes(state)?'historic-confirmation':null,
        state==='sent'?'legacy_attention':'live',state==='sent'?'synthetic-legacy-import':null);
    }
  }finally{db.close();}
  // The disposable mixed fixture is genuinely provisioned by OLD1829 code.
  frozenMigrateV1ToV2(filename,prerequisites);
  const ledger=new FrozenV2Ledger(filename,()=>100);
  try {
    for(const [index,state] of ['sent','delivery_unknown','in_flight','unassociated-unknown'].entries()){
      const identity=id(state),claim=ledger.claim(identity),mid='msg_'+String(index+1).padStart(26,'0');
      if(state!=='unassociated-unknown')ledger.associate(identity,claim.receipt.claim_id!,{authority:'https://inbox.example.invalid',
        message_id:mid,thread_id:mid,native_project_id:'synthetic-project',project_root:directory,session_id:'original-session'},state==='sent');
      if(state==='sent')ledger.confirmed(identity,claim.receipt.claim_id!,42);
      if(state.includes('unknown'))ledger.unknown(identity,claim.receipt.claim_id!);
    }
    if(unsupported){
      const identity={...id('old-v2/unlinked-reminder'),purpose:'reminder'},claim=ledger.claim(identity),mid='msg_'+'9'.repeat(26);
      ledger.associate(identity,claim.receipt.claim_id!,{authority:'https://inbox.example.invalid',message_id:mid,thread_id:mid,
        native_project_id:'synthetic-project',project_root:directory,session_id:'original-session'},true);
      ledger.confirmed(identity,claim.receipt.claim_id!,43);
    }
  }finally{ledger.close();}
  return {filename,directory};
}
function snapshot(filename:string){
  const db=new DatabaseSync(filename,{readOnly:true});
  try{return {
    version:db.prepare('PRAGMA user_version').get(),
    ddl:db.prepare('SELECT name,type,sql FROM sqlite_master ORDER BY name').all(),
    deliveries:db.prepare('SELECT * FROM deliveries ORDER BY profile_id,destination_id,decision_key,event_revision,purpose').all(),
    canonical:db.prepare('SELECT * FROM canonical_associations ORDER BY profile_id,destination_id,decision_key,event_revision,purpose').all(),
    migrations:db.prepare('SELECT * FROM migrations ORDER BY migration_id').all(),
  };}finally{db.close();}
}
function fileBytes(filename:string){return {db:fs.readFileSync(filename),fence:fs.readFileSync(fencePath(filename))};}
function preserved(filename:string,before:ReturnType<typeof snapshot>){
  const after=snapshot(filename);assert.deepEqual(after.deliveries,before.deliveries);assert.deepEqual(after.canonical,before.canonical);
  assert.deepEqual(after.migrations.filter((r:any)=>!r.migration_id.startsWith('notification-v3/')),before.migrations);
  assert.deepEqual(after.ddl.filter((r:any)=>before.ddl.some((old:any)=>old.name===r.name)),before.ddl);
  return after;
}
function fenceState(filename:string){return JSON.parse(fs.readFileSync(fencePath(filename),'utf8')).state;}
function assertEmptyProductTables(filename:string){
  const db=new DatabaseSync(filename,{readOnly:true});try{for(const table of ['fyip_decisions','pending_owner_requests','reminder_occurrences'])
    assert.equal(db.prepare('SELECT COUNT(*) n FROM '+table).get()!.n,0);}finally{db.close();}
}

test('frozen1829 reader fixture is byte-exact Git blob/SHA256 closure, with no current-core imports',()=>{
  // Fixed reader integrity pins, not an imported operational validation manifest.
  // Both content and Git blob hashes retain the original compatibility assertion.
  const provenance={files:[
    {file:'core/config.ts',sha256:'f88b1a300e5282ce5afb8fa44cf081735804860adc1418cb018405a293b16869',git_blob:'77c0ecaa34c0b272cdb35d7fe2ddcbd343801eec'},
    {file:'core/ledger.ts',sha256:'55796e2923ece0956e06b789993c2c2de64b9f1b60c2c1bcd7bde6d3b9ee5e1f',git_blob:'95055ba325188312f25cf7fae689fb11b833db1e'},
    {file:'core/migration.ts',sha256:'7934c09e4bcf820f0e59bb238c44b600c8de7d9adc6c0c473fe83595cfc50e6f',git_blob:'ddf258cb7ac26242c0c7c7adbb21ece14b0216cb'},
    {file:'core/safety.ts',sha256:'aa5be6abf9ac902e95163da1c8726373f9bac174531689453a44fc3b021502ee',git_blob:'3ce085d9797d314d09117ba79dae2a4f64e94ea9'},
    {file:'core/schema.ts',sha256:'cb9488718dab8681f57eaada968600d9b55424d08bc3901b365b45ceb218b4cc',git_blob:'3e3dab6ea13c1a082159d3da8954bed0eaf556ff'},
    {file:'core/storage.ts',sha256:'11b5182d434d9be5ae4c0913acf0e43c794b6ac7ce37cb18a1ec8fd34d01c8d3',git_blob:'1884280da3bcedcb2148c071c5011d104bea7600'},
    {file:'core/types.ts',sha256:'4c0f4e5274bb4795006c63ca1cc6e54f5e06383c9f228d8896dc55f358642e31',git_blob:'350bb9e1717caf8f8d0c85ae979ddc81be9a7ae3'},
  ]};
  assert.deepEqual(provenance.files.map((f:any)=>f.file).sort(),['config','ledger','migration','safety','schema','storage','types'].map(n=>'core/'+n+'.ts'));
  for(const entry of provenance.files){
    const bytes=fs.readFileSync(new URL(entry.file,fixtureBase));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256);
    assert.equal(createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex'),entry.git_blob);
    for(const match of bytes.toString().matchAll(/(?:from\s+|import\s*)['"]([^'"]+)['"]/g)){
      assert.ok(match[1].startsWith('node:') || /^\.\/[a-z-]+\.ts$/.test(match[1]),match[1]);
      if(match[1].startsWith('./'))assert.ok(provenance.files.some((f:any)=>f.file==='core/'+match[1].slice(2)));
    }
  }
});

test('genuine frozen old-v2 reader remains usable after clean unsupported-history refusal, exact bytes/rows/epoch/fence',t=>{
  const h=fixture(t,true);
  const usable=new FrozenV2Ledger(h.filename);try{assert.equal(usable.inspect(id('sent'))?.state,'sent');}finally{usable.close();}
  const before=snapshot(h.filename),bytes=fileBytes(h.filename);
  assert.throws(()=>upgradeLedgerV2ToV3(h.filename,prerequisites),{message:'ledger_upgrade_unsupported_reminder_history'});
  assert.deepEqual(snapshot(h.filename),before);assert.deepEqual(fileBytes(h.filename),bytes);
  assert.equal(fs.existsSync(administrationLockPath(h.filename)),false);
  const reopened=new FrozenV2Ledger(h.filename);
  try{
    assert.equal(reopened.inspect(id('sent'))?.state,'sent');assert.equal(reopened.inspect(id('in_flight'))?.state,'in_flight');
    assert.equal(reopened.inspect(id('delivery_unknown'))?.state,'delivery_unknown');
    assert.equal(reopened.canonicalFor(id('sent'))?.message_id,'msg_'+String(1).padStart(26,'0'));
  }finally{reopened.close();}
  assert.deepEqual(snapshot(h.filename),before);assert.deepEqual(fileBytes(h.filename),bytes);
  const operational=new FrozenV2Ledger(h.filename,()=>200);
  try{
    assert.equal(operational.claim(id('sent')).action,'suppressed');
    assert.equal(operational.claim(id('new-explicit-attention')).action,'claimed');
    assert.throws(()=>operational.claim(id('no-inferred-enrollment','legacy')),FrozenLegacyMappingRequired);
  }finally{operational.close();}
});

test('actual format3 preserves mixed old SQL/fence but frozen old reader rejects BEFORE WAL-mode/write publication',t=>{
  const h=fixture(t),before=snapshot(h.filename),fence=fs.readFileSync(fencePath(h.filename));
  assert.deepEqual(upgradeLedgerV2ToV3(h.filename,prerequisites),{upgraded:true,schema_version:3});
  assert.equal(preserved(h.filename,before).version!.user_version,3);assert.deepEqual(fs.readFileSync(fencePath(h.filename)),fence);
  assertEmptyProductTables(h.filename);
  const upgraded=snapshot(h.filename),bytes=fileBytes(h.filename),original=DatabaseSync.prototype.exec,
    prepare=DatabaseSync.prototype.prepare,commands:string[]=[];
  DatabaseSync.prototype.exec=function(query:string){commands.push(query);return original.call(this,query);};
  DatabaseSync.prototype.prepare=function(query:string){commands.push(query);return prepare.call(this,query);};
  try{assert.throws(()=>new FrozenV2Ledger(h.filename),{message:'notification_held'});}
  finally{DatabaseSync.prototype.exec=original;DatabaseSync.prototype.prepare=prepare;}
  assert.ok(commands.includes('BEGIN IMMEDIATE'));assert.ok(commands.includes('ROLLBACK'));
  assert.ok(!commands.some(q=>/journal_mode|CREATE |INSERT |UPDATE |DELETE |user_version\s*=/i.test(q)));
  assert.deepEqual(snapshot(h.filename),upgraded);assert.deepEqual(fileBytes(h.filename),bytes);
  const current=new DeliveryLedger(h.filename);try{assert.equal(current.inspect(id('sent'))?.state,'sent');}finally{current.close();}
});

for(const stage of ['ddl','version','commit-before','commit-after'] as const)test('v2->v3 '+stage+' fault preserves exact mixed history, reports ambiguous and keeps owned lock',t=>{
  const h=fixture(t),before=snapshot(h.filename),fence=fs.readFileSync(fencePath(h.filename)),original=DatabaseSync.prototype.exec;
  let failed=false;
  DatabaseSync.prototype.exec=function(query:string){
    const target=stage==='ddl'?query.startsWith('CREATE TABLE pending_owner_requests'):stage==='version'?query==='PRAGMA user_version=3':query==='COMMIT';
    if(!failed&&target){failed=true;if(stage==='commit-after')original.call(this,query);throw new Error('synthetic v3 fault');}
    return original.call(this,query);
  };
  try{assert.throws(()=>upgradeLedgerV2ToV3(h.filename,prerequisites),{message:'ledger_migration_ambiguous'});}
  finally{DatabaseSync.prototype.exec=original;}
  assert.ok(failed);const after=preserved(h.filename,before);assert.equal(after.version!.user_version,stage==='commit-after'?3:2);
  if(stage!=='commit-after')assert.deepEqual(after,before);else assertEmptyProductTables(h.filename);
  assert.deepEqual(fs.readFileSync(fencePath(h.filename)),fence);assert.equal(fenceState(h.filename),'active');
  assert.ok(fs.existsSync(administrationLockPath(h.filename)));
  assert.throws(()=>new DeliveryLedger(h.filename));assert.throws(()=>new FrozenV2Ledger(h.filename));
  assert.throws(()=>upgradeLedgerV2ToV3(h.filename,prerequisites),{message:'ledger_migration_ambiguous'});
  preserved(h.filename,before); // No automatic reclaim/retry/reset.
});

test('v2->v3 lock-parent sync failure is ambiguous before transaction and never changes version/fence/history',t=>{
  const h=fixture(t),before=snapshot(h.filename),bytes=fileBytes(h.filename),original=fs.fsyncSync;let failed=false;
  fs.fsyncSync=((fd:number)=>{if(!failed&&fs.fstatSync(fd).isDirectory()){failed=true;throw new Error('synthetic lock dir sync');}original(fd);}) as typeof fs.fsyncSync;
  syncBuiltinESMExports();try{assert.throws(()=>upgradeLedgerV2ToV3(h.filename,prerequisites),{message:'ledger_migration_ambiguous'});}
  finally{fs.fsyncSync=original;syncBuiltinESMExports();}
  assert.ok(failed);assert.deepEqual(snapshot(h.filename),before);assert.deepEqual(fileBytes(h.filename),bytes);
  assert.ok(fs.existsSync(administrationLockPath(h.filename)));assert.throws(()=>new FrozenV2Ledger(h.filename));assert.throws(()=>new DeliveryLedger(h.filename));
});

test('dispatch-disabled v2 upgrade stays held without changing version/history/fence or reactivating it',t=>{
  const h=fixture(t);disableLedgerDispatch(h.filename);const before=snapshot(h.filename),bytes=fileBytes(h.filename);
  assert.throws(()=>upgradeLedgerV2ToV3(h.filename,prerequisites),{message:'ledger_migration_held'});
  assert.deepEqual(snapshot(h.filename),before);assert.deepEqual(fileBytes(h.filename),bytes);
  assert.equal(fenceState(h.filename),'dispatch-disabled');assert.ok(fs.existsSync(administrationLockPath(h.filename)));
  assert.throws(()=>new DeliveryLedger(h.filename));assert.throws(()=>new FrozenV2Ledger(h.filename));
});

test('v2->v3 release rmdir fault is postcommit ambiguous, retained lock blocks otherwise-valid v3',t=>{
  const h=fixture(t),before=snapshot(h.filename),fence=fs.readFileSync(fencePath(h.filename)),original=fs.rmdirSync;let failed=false;
  fs.rmdirSync=((...args:Parameters<typeof fs.rmdirSync>)=>{if(String(args[0])===administrationLockPath(h.filename)){failed=true;throw new Error('synthetic release fault');}original(...args);}) as typeof fs.rmdirSync;
  syncBuiltinESMExports();try{assert.throws(()=>upgradeLedgerV2ToV3(h.filename,prerequisites),{message:'ledger_migration_ambiguous'});}
  finally{fs.rmdirSync=original;syncBuiltinESMExports();}
  assert.ok(failed);assert.equal(preserved(h.filename,before).version!.user_version,3);assertEmptyProductTables(h.filename);
  assert.deepEqual(fs.readFileSync(fencePath(h.filename)),fence);assert.ok(fs.existsSync(administrationLockPath(h.filename)));
  const db=new DatabaseSync(h.filename,{readOnly:true});try{validateSchema(db,3);}finally{db.close();}
  assert.throws(()=>new DeliveryLedger(h.filename));
});

for(const unsupported of [false,true])test('v2->v3 '+(unsupported?'refusal':'success')+' release directory fsync failure: ambiguous with NO lock, not dispatch safety',t=>{
  const h=fixture(t,unsupported),before=snapshot(h.filename),bytes=fileBytes(h.filename),originalRemove=fs.rmdirSync,originalSync=fs.fsyncSync;
  let removed=false,failed=false;
  fs.rmdirSync=((...args:Parameters<typeof fs.rmdirSync>)=>{originalRemove(...args);if(String(args[0])===administrationLockPath(h.filename))removed=true;}) as typeof fs.rmdirSync;
  fs.fsyncSync=((fd:number)=>{if(removed&&!failed&&fs.fstatSync(fd).isDirectory()){failed=true;throw new Error('synthetic release fsync');}originalSync(fd);}) as typeof fs.fsyncSync;
  syncBuiltinESMExports();try{assert.throws(()=>upgradeLedgerV2ToV3(h.filename,prerequisites),{message:'ledger_migration_ambiguous'});}
  finally{fs.rmdirSync=originalRemove;fs.fsyncSync=originalSync;syncBuiltinESMExports();}
  assert.ok(removed&&failed);assert.equal(fs.existsSync(administrationLockPath(h.filename)),false);
  const after=preserved(h.filename,before);assert.equal(after.version!.user_version,unsupported?2:3);
  assert.deepEqual(fs.readFileSync(fencePath(h.filename)),bytes.fence);
  if(unsupported)assert.deepEqual(fileBytes(h.filename),bytes);else assertEmptyProductTables(h.filename);
  // This is the acknowledged release-window limit, NOT evidence of safety.
  // Visible local gates can open despite the ambiguous result. No dispatch is made.
  const local=new DeliveryLedger(h.filename);try{assert.equal(local.inspect(id('sent'))?.state,'sent');}finally{local.close();}
  if(unsupported){const old=new FrozenV2Ledger(h.filename);old.close();}
  else assert.throws(()=>new FrozenV2Ledger(h.filename));
});

test('v2->v3 preserves active fence without activation/rename; concurrent admin and publisher are fenced during commit',t=>{
  const h=fixture(t),before=snapshot(h.filename),fence=fs.readFileSync(fencePath(h.filename)),exec=DatabaseSync.prototype.exec,rename=fs.renameSync;
  let observed=false,renames=0;
  fs.renameSync=((...args:Parameters<typeof fs.renameSync>)=>{renames++;return rename(...args);}) as typeof fs.renameSync;syncBuiltinESMExports();
  DatabaseSync.prototype.exec=function(query:string){
    const result=exec.call(this,query);
    if(query==='COMMIT'&&!observed){observed=true;assert.ok(fs.existsSync(administrationLockPath(h.filename)));
      assert.throws(()=>disableLedgerDispatch(h.filename),{message:'ledger_dispatch_ambiguous'});
      assert.throws(()=>upgradeLedgerV2ToV3(h.filename,prerequisites),{message:'ledger_migration_ambiguous'});
      assert.throws(()=>new DeliveryLedger(h.filename));assert.throws(()=>new FrozenV2Ledger(h.filename));}
    return result;
  };
  try{upgradeLedgerV2ToV3(h.filename,prerequisites);}
  finally{DatabaseSync.prototype.exec=exec;fs.renameSync=rename;syncBuiltinESMExports();}
  assert.ok(observed);assert.equal(renames,0);assert.deepEqual(fs.readFileSync(fencePath(h.filename)),fence);
  assert.equal(preserved(h.filename,before).version!.user_version,3);assertEmptyProductTables(h.filename);
});

for(const stage of ['pre-rename','post-rename','release-sync'] as const)test('upgraded-v3 explicit disable '+stage+' fault preserves history and honestly reports ambiguous',t=>{
  const h=fixture(t);upgradeLedgerV2ToV3(h.filename,prerequisites);const before=snapshot(h.filename),fence=fs.readFileSync(fencePath(h.filename));
  const originalRename=fs.renameSync,originalSync=fs.fsyncSync,originalRemove=fs.rmdirSync;let renamed=false,removed=false,failed=false;
  fs.renameSync=((from:fs.PathLike,to:fs.PathLike)=>{originalRename(from,to);if(String(to)===fencePath(h.filename))renamed=true;}) as typeof fs.renameSync;
  fs.rmdirSync=((...args:Parameters<typeof fs.rmdirSync>)=>{originalRemove(...args);if(String(args[0])===administrationLockPath(h.filename))removed=true;}) as typeof fs.rmdirSync;
  fs.fsyncSync=((fd:number)=>{
    const directory=fs.fstatSync(fd).isDirectory();
    if(!failed&&(stage==='pre-rename'?!directory&&!renamed:stage==='post-rename'?directory&&renamed:directory&&removed)){
      failed=true;throw new Error('synthetic upgraded disable fsync');}
    originalSync(fd);
  }) as typeof fs.fsyncSync;
  syncBuiltinESMExports();try{assert.throws(()=>disableLedgerDispatch(h.filename),{message:'ledger_dispatch_ambiguous'});}
  finally{fs.renameSync=originalRename;fs.fsyncSync=originalSync;fs.rmdirSync=originalRemove;syncBuiltinESMExports();}
  assert.ok(failed);assert.deepEqual(snapshot(h.filename),before);
  assert.equal(fenceState(h.filename),stage==='pre-rename'?'active':'dispatch-disabled');
  if(stage==='pre-rename'){
    assert.deepEqual(fs.readFileSync(fencePath(h.filename)),fence);
    assert.ok(fs.readdirSync(h.directory).some(name=>name.endsWith('.tmp')),'failed private temp evidence is not silently recovered');
  }
  assert.equal(fs.existsSync(administrationLockPath(h.filename)),stage!=='release-sync');
  assert.throws(()=>new DeliveryLedger(h.filename)); // retained lock OR visible disabled fence; neither proves fsync durability.
  assert.throws(()=>new FrozenV2Ledger(h.filename));
});
