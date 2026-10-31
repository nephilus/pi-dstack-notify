import './offline-guard.mjs';
import { attempts } from './offline-guard.mjs';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initializeLedgerV2, initializeLedgerV3, upgradeLedgerV2ToV3, migrateLedgerV1ToV2, administrationLockPath } from '../../core/migration.ts';
import { validateSchema } from '../../core/schema.ts';
import { DeliveryLedger } from '../../core/ledger.ts';
import { createNotificationService } from '../../core/service.ts';
import { prepareBody, digest } from '../../core/safety.ts';
import { canonicalUTCSlot, reminderDeliveryIdentity } from '../../core/reminder-time.ts';
import { createReminderPlanner } from '../../core/reminder-plan.ts';
import { createTestOwnerEvidenceProvider } from '../../core/owner-evidence.ts';
import { createTestTelegramHttpClient } from '../../core/transport.ts';
import type { DeliveryIdentity } from '../../core/types.ts';
after(() => { assert.deepEqual(attempts,[]); assert.equal(process.env.PATH,'/nonexistent-notification-test-path'); });
const assertions = { dispatchDisabled:true,allOldWritersQuiesced:true,walConsistentBackupVerified:true } as const;
const revision = 'a'.repeat(64), base = 'https://inbox.example.invalid/';
function fixture(t:any, version:2|3=3) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'notification-v3-source-')));
  t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
  const root = path.join(directory,'project'); fs.mkdirSync(root,{mode:0o700});
  const ledger = path.join(directory,'ledger.sqlite'), profile = path.join(directory,'profile.toml'), configPath = path.join(directory,'config.json');
  fs.writeFileSync(profile,fs.readFileSync(new URL('../../fixtures/shared-profile.toml',import.meta.url)),{mode:0o600});
  fs.writeFileSync(configPath,JSON.stringify({version:1,enabled:true,projects:[{project_path:root,enabled:true,
    profile_path:profile,ledger_path:ledger,policy:'notification_product',inbox_base_url:base}]}),{mode:0o600});
  (version===3 ? initializeLedgerV3 : initializeLedgerV2)(ledger,{...assertions,noPriorHistory:true});
  return {directory,root,ledger,profile,configPath};
}
function original(n=1):DeliveryIdentity { return {profile_id:'test-only.primary',destination_id:'test-only.owner',
  decision_key:'repo/request-'+n,event_revision:revision,purpose:'owner_request'}; }
function active(h:ReturnType<typeof fixture>,n=1) {
  // Synthetic state fixture only: this is NOT publishOwnerRequest or proof that
  // capacity/registration is already integrated into the publication engine.
  const id=original(n), session='original-session', mid='msg_'+String(n).padStart(26,'0');
  const body=prepareBody('An owner response is requested.',session,revision,[]);
  const ledger=new DeliveryLedger(h.ledger,()=>1000.5);
  try { const claim=ledger.claim(id); ledger.associate(id,claim.receipt.claim_id!,{authority:new URL(base).origin,
    message_id:mid,thread_id:mid,native_project_id:'prj_synthetic',project_root:h.root,session_id:session},true); }
  finally { ledger.close(); }
  const db=new DatabaseSync(h.ledger);
  try { db.exec('PRAGMA foreign_keys=ON'); db.prepare(`INSERT INTO pending_owner_requests
    (profile_id,destination_id,decision_key,event_revision,purpose,state,inbox_authority,message_id,thread_id,
     canonical_url,native_project_id,project_root,original_session_id,body,created_at,updated_at)
    VALUES (?,?,?,?,?,'active',?,?,?,?,?,?,?,?,1000,1000)`).run(id.profile_id,id.destination_id,id.decision_key,id.event_revision,id.purpose,
      new URL(base).origin,mid,mid,base+'#thread='+mid,'prj_synthetic',h.root,session,body);
    validateSchema(db,3);
  } finally { db.close(); }
  return id;
}
function occurrence(db:DatabaseSync,id:DeliveryIdentity,slot:string,state='in_flight') {
  const reminder=reminderDeliveryIdentity(id,slot), time=Date.parse(slot)/1000;
  db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO deliveries (profile_id,destination_id,decision_key,event_revision,purpose,state,claim_id,
      created_at,updated_at,confirmed_at,confirmation_ref,source,migration_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'live',NULL)`).run(reminder.profile_id,reminder.destination_id,reminder.decision_key,
        reminder.event_revision,reminder.purpose,state,digest(reminder.decision_key).slice(0,32),time,time,
        state==='sent'?time:null,state==='sent'?'1':null);
    db.prepare(`INSERT INTO reminder_occurrences (profile_id,destination_id,decision_key,event_revision,
      original_purpose,utc_slot,purpose,reminder_key,claim_operation_id,created_at) VALUES (?,?,?,?,?,?,'reminder',?,'op.1',?)`)
      .run(id.profile_id,id.destination_id,id.decision_key,id.event_revision,id.purpose,slot,reminder.decision_key,time);
    db.exec('COMMIT');
  } catch(e) { if(db.isTransaction)db.exec('ROLLBACK'); throw e; }
  return reminder;
}

test('UTC fractional clock and range; exact original identity digest excludes native/path/session namespaces',()=>{
  assert.equal(canonicalUTCSlot(0),'1970-01-01T00:00:00+00:00');
  assert.equal(canonicalUTCSlot(3599.999),'1970-01-01T00:00:00+00:00');
  assert.equal(canonicalUTCSlot(3600.001),'1970-01-01T01:00:00+00:00');
  assert.equal(canonicalUTCSlot(253402300799.999),'9999-12-31T23:00:00+00:00');
  for(const value of [-1,NaN,Infinity,253402300800,'3600',null]) assert.throws(()=>canonicalUTCSlot(value));
  const id=original(), saved=structuredClone(id), slot='2026-07-03T23:00:00+00:00';
  const identity=reminderDeliveryIdentity(id,slot);
  assert.equal(identity.decision_key,'reminder:'+digest(JSON.stringify([id.decision_key,revision,'owner_request',slot,'reminder'])));
  assert.deepEqual(id,saved); assert.equal(identity.profile_id,id.profile_id);
  for(const bad of ['2026-07-03T23:00:00Z','2026-07-03T23:00:00.000+00:00','2026-07-03T23:01:00+00:00',
    '2026-02-30T00:00:00+00:00']) assert.throws(()=>reminderDeliveryIdentity(id,bad));
});

test('explicit additive v2->v3 preserves ALL original table rows/DDL/fence and remains idempotent',t=>{
  const h=fixture(t,2), id={...original(),purpose:'explicit_attention'};
  const ledger=new DeliveryLedger(h.ledger,()=>1000.9); ledger.claim(id); ledger.close();
  const snapshot=()=>{
    const db=new DatabaseSync(h.ledger);
    try { return { deliveries:db.prepare('SELECT * FROM deliveries').all(),canonical:db.prepare('SELECT * FROM canonical_associations').all(),
      migrations:db.prepare("SELECT * FROM migrations WHERE migration_id NOT LIKE 'notification-v3/%'").all(),
      ddl:db.prepare("SELECT name,sql FROM sqlite_master WHERE name IN ('deliveries','migrations','canonical_associations') ORDER BY name").all()}; }
    finally {db.close();}
  };
  const before=snapshot(), fence=fs.readFileSync(h.ledger+'.cutover-v2.json');
  assert.deepEqual(upgradeLedgerV2ToV3(h.ledger,assertions),{upgraded:true,schema_version:3});
  assert.deepEqual(snapshot(),before); assert.deepEqual(fs.readFileSync(h.ledger+'.cutover-v2.json'),fence);
  assert.deepEqual(upgradeLedgerV2ToV3(h.ledger,assertions),{upgraded:false,schema_version:3});
  const reopened=new DeliveryLedger(h.ledger); assert.equal(reopened.claim(id).action,'held'); reopened.close();
  const db=new DatabaseSync(h.ledger); try {validateSchema(db,3); assert.throws(()=>validateSchema(db,2));}finally{db.close();}
});

test('exclusive administration failure does not reclaim a lock or mutate old schema',t=>{
  const h=fixture(t,2); fs.mkdirSync(administrationLockPath(h.ledger),{mode:0o700});
  assert.throws(()=>upgradeLedgerV2ToV3(h.ledger,assertions),{message:'ledger_migration_ambiguous'});
  assert.ok(fs.existsSync(administrationLockPath(h.ledger)));
  const db=new DatabaseSync(h.ledger); try{validateSchema(db,2);}finally{db.close();}
});

test('v3 original confirmed coverage is not weakened; exact reminder links need no extra canonical row',t=>{
  const h=fixture(t),id=active(h),db=new DatabaseSync(h.ledger);
  try {
    occurrence(db,id,canonicalUTCSlot(3600.5),'sent'); validateSchema(db,3);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM canonical_associations').get()!.n,1);
    const before=db.prepare('SELECT COUNT(*) AS n FROM reminder_occurrences').get()!.n;
    assert.throws(()=>db.prepare(`INSERT INTO reminder_occurrences (profile_id,destination_id,decision_key,event_revision,
      original_purpose,utc_slot,purpose,reminder_key,claim_operation_id,created_at)
      VALUES (?,?,?,?,?,'1970-01-01T02:00:00+00:00','reminder',?,'op.2',7200)`)
      .run(id.profile_id,id.destination_id,'repo/missing-original',revision,'owner_request','reminder:'+'b'.repeat(64)));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reminder_occurrences').get()!.n,before);
    db.prepare("INSERT INTO deliveries VALUES (?,?,?,?,?,'sent',?,0,0,0,'1','live',NULL)")
      .run(id.profile_id,id.destination_id,'repo/orphan',revision,'explicit_attention','a'.repeat(32));
    assert.throws(()=>validateSchema(db,3));
  }finally{db.close();}
});

test('v3 tampered DDL, marker, original coverage and generated occurrence keys fail closed',t=>{
  for(const tamper of ['ddl','index','marker','coverage','key'] as const){
    const h=fixture(t),id=active(h),db=new DatabaseSync(h.ledger);
    try{
      if(tamper==='ddl')db.exec('CREATE TABLE injected (value TEXT)');
      if(tamper==='index')db.exec('CREATE INDEX injected ON pending_owner_requests (state)');
      if(tamper==='marker')db.prepare("UPDATE migrations SET manifest_sha256=? WHERE migration_id LIKE 'notification-v3/%'").run('0'.repeat(64));
      if(tamper==='coverage')db.exec('UPDATE canonical_associations SET read_verified=0,verified_at=NULL');
      if(tamper==='key'){
        const effect=occurrence(db,id,canonicalUTCSlot(3600));
        db.exec('PRAGMA foreign_keys=OFF');
        const forged='reminder:'+'f'.repeat(64);
        db.prepare('UPDATE reminder_occurrences SET reminder_key=?').run(forged);
        db.prepare('UPDATE deliveries SET decision_key=? WHERE decision_key=?').run(forged,effect.decision_key);
      }
      assert.throws(()=>validateSchema(db,3),tamper);
    }finally{db.close();}
  }
});

test('source reservation capacity validation is32 including reserved; no row eviction',t=>{
  const h=fixture(t),db=new DatabaseSync(h.ledger);
  try{
    db.exec('PRAGMA foreign_keys=ON');
    for(let n=1;n<=33;n++){
      const id=original(n),body=prepareBody('Awaiting owner answer.','original-session',revision,[]);
      db.prepare("INSERT INTO deliveries VALUES (?,?,?,?,?,'in_flight',?,0,0,NULL,NULL,'live',NULL)")
        .run(id.profile_id,id.destination_id,id.decision_key,revision,id.purpose,String(n).padStart(32,'0'));
      db.prepare(`INSERT INTO pending_owner_requests (profile_id,destination_id,decision_key,event_revision,purpose,state,
        project_root,original_session_id,body,created_at,updated_at) VALUES (?,?,?,?,?,'reserved',?,'original-session',?,0,0)`)
        .run(id.profile_id,id.destination_id,id.decision_key,revision,id.purpose,h.root,body);
      if(n===32)validateSchema(db,3);
    }
    assert.throws(()=>validateSchema(db,3));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pending_owner_requests').get()!.n,33);
    // This proves validation only, NOT an implemented concurrent enrollment API.
  }finally{db.close();}
});

test('planner only wakes current eligible fully fake work; fractional snooze expiry and pause dominate',t=>{
  const h=fixture(t),id=active(h),provider=createTestOwnerEvidenceProvider(),telegram=createTestTelegramHttpClient();
  let now=3600.5;
  const planner=createReminderPlanner({configPath:h.configPath,ownerEvidenceProvider:provider,telegramHttpClient:telegram,clock:()=>now});
  const input={observed:{project_path:h.root,session_id:'fresh-current-session'}};
  assert.deepEqual(planner.planReminders(input),{status:'ready',reason:'due_work',utc_slot:canonicalUTCSlot(now),due_count:1});
  const db=new DatabaseSync(h.ledger);
  try{
    const prior=db.prepare('SELECT * FROM pending_owner_requests').all(); planner.planReminders(input);
    assert.deepEqual(db.prepare('SELECT * FROM pending_owner_requests').all(),prior);
    db.prepare('UPDATE pending_owner_requests SET snoozed_until=?,snooze_evidence_json=?').run(3601.25,'{"source":"synthetic-owner"}');
    assert.equal(planner.planReminders(input).due_count,0);
    now=3601.25; assert.equal(planner.planReminders(input).due_count,1);
    db.prepare("UPDATE pending_owner_requests SET state='paused_answer',answer_evidence_json=?").run('{"source":"synthetic-owner"}');
    now=7200.5; assert.equal(planner.planReminders(input).due_count,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deliveries').get()!.n,1);
    assert.equal(id.decision_key,'repo/request-1');
  }finally{db.close();}
  assert.equal(telegram.requests.length,0);
});

test('planner excludes current unknown occurrences, no catchup; new session is not an identity namespace',t=>{
  const h=fixture(t),id=active(h),db=new DatabaseSync(h.ledger); let now=3600.75;
  try{occurrence(db,id,canonicalUTCSlot(now),'delivery_unknown');}finally{db.close();}
  const planner=createReminderPlanner({configPath:h.configPath,ownerEvidenceProvider:createTestOwnerEvidenceProvider(),
    telegramHttpClient:createTestTelegramHttpClient(),clock:()=>now});
  const input={observed:{session_id:'different-session',project_path:h.root}};
  assert.equal(planner.planReminders(input).due_count,0);
  now=36000.5; assert.equal(planner.planReminders(input).due_count,1);
  const check=new DatabaseSync(h.ledger);try{assert.equal(check.prepare('SELECT COUNT(*) AS n FROM reminder_occurrences').get()!.n,1);}finally{check.close();}
});

test('planning samples after readback and never wakes a stale slot after a boundary crossing',t=>{
  const h=fixture(t);active(h);
  const input={observed:{session_id:'session',project_path:h.root}};
  for(const [samples,status,slot] of [ [[3599.9,3600.1,3600.2],'ready',canonicalUTCSlot(3600.1)],
    [[3599.9,3599.95,3600.1],'held',canonicalUTCSlot(3599.95)] ] as const){
    let index=0;
    const planner=createReminderPlanner({configPath:h.configPath,ownerEvidenceProvider:createTestOwnerEvidenceProvider(),
      telegramHttpClient:createTestTelegramHttpClient(),clock:()=>samples[Math.min(index++,samples.length-1)]});
    const plan=planner.planReminders(input);assert.equal(plan.status,status);assert.equal(plan.utc_slot,slot);
    assert.equal(plan.due_count,status==='ready'?1:0);
  }
  const db=new DatabaseSync(h.ledger);try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reminder_occurrences').get()!.n,0);}finally{db.close();}
});

test('unsupported actual owner evidence and disabled/v2/invalid clocks never create due wakeups',t=>{
  const h=fixture(t,2),input={observed:{session_id:'session',project_path:h.root}};
  const actual=createReminderPlanner({configPath:h.configPath,clock:()=>1.5});
  assert.deepEqual(actual.planReminders(input),{status:'held',reason:'owner_evidence_unavailable',utc_slot:canonicalUTCSlot(1.5),due_count:0});
  const fake=createReminderPlanner({configPath:h.configPath,ownerEvidenceProvider:createTestOwnerEvidenceProvider(),
    telegramHttpClient:createTestTelegramHttpClient(),clock:()=>1.5});
  assert.equal(fake.planReminders(input).status,'held');
  const db=new DatabaseSync(h.ledger);try{validateSchema(db,2);}finally{db.close();}
  for(const sample of [-1,NaN,Infinity,253402300800]){
    const plan=createReminderPlanner({clock:()=>sample}).planReminders(input);assert.equal(plan.due_count,0);assert.equal(plan.status,'held');
  }
  assert.equal(createReminderPlanner({clock:()=>1.5}).planReminders(input).status,'inactive');
});

test('notification_product requires explicit v3; existing attention works unchanged on v3',async t=>{
  for(const version of [2,3] as const){
    const h=fixture(t,version),telegram=createTestTelegramHttpClient();
    const service=createNotificationService({configPath:h.configPath,telegramHttpClient:telegram});
    const observed={session_id:'current-session',project_path:h.root}; let sends=0,body='';
    const native=JSON.parse(fs.readFileSync(new URL('../../fixtures/inbox-native.json',import.meta.url),'utf8'));
    const mid='msg_'+'5'.repeat(26);
    const receipt=await service.publish({text:'One off attention.',decision_key:'repo/attention',revision},{operationId:'op.1',observed,
      signal:new AbortController().signal,async hostCheck(){return observed;},async inboxSend(args){
        sends++;body=args.body;const result=structuredClone(native.send),d=result.structuredContent;
        d.message_id=d.thread_id=mid;d.url=base+'#thread='+mid;d.project.root=h.root;return result;
      },async inboxRead(){const result=structuredClone(native.read),d=result.structuredContent;
        d.url=base+'#thread='+mid;d.thread.thread_id=mid;d.thread.project.root=h.root;
        const m=d.thread.messages[0];m.id=m.thread_id=mid;m.author.session=observed.session_id;m.body=body;return result;}});
    assert.equal(receipt.state,version===3?'sent':'held');assert.equal(sends,version===3?1:0);
    const db=new DatabaseSync(h.ledger);try{validateSchema(db,version);
      if(version===3)assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pending_owner_requests').get()!.n,0);
    }finally{db.close();}
  }
});

test('synthetic owner seam is closed and mixed production effects are rejected before lookup',()=>{
  const provider=createTestOwnerEvidenceProvider();
  assert.throws(()=>createReminderPlanner({configPath:'/never-read',ownerEvidenceProvider:provider}));
  assert.throws(()=>createReminderPlanner({ownerEvidenceProvider:{mode:'test-owner-only'},telegramHttpClient:createTestTelegramHttpClient()}));
  assert.throws(()=>createTestOwnerEvidenceProvider({outcome:'snooze'}));
  assert.throws(()=>createTestOwnerEvidenceProvider({outcome:'unanswered',snoozedUntil:1}));
});


test('F1 v3 forbids generic reminder claims and rejects own-association reminder without ORIGINAL chain',t=>{
  const h=fixture(t), id={...original(),decision_key:'not-generated',purpose:'reminder'};
  const ledger=new DeliveryLedger(h.ledger);
  try { assert.throws(()=>ledger.claim(id)); assert.equal(ledger.inspect(id),null); } finally { ledger.close(); }
  const db=new DatabaseSync(h.ledger);
  try {
    db.prepare("INSERT INTO deliveries VALUES (?,?,?,?,?,'sent',?,0,0,0,'1','live',NULL)")
      .run(id.profile_id,id.destination_id,id.decision_key,revision,id.purpose,'b'.repeat(32));
    const mid='msg_'+'1'.repeat(26);
    db.prepare(`INSERT INTO canonical_associations (profile_id,destination_id,inbox_authority,message_id,thread_id,
      decision_key,event_revision,purpose,native_project_id,project_root,session_id,legacy_unmapped,read_verified,created_at,verified_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,0,1,0,0)`).run(id.profile_id,id.destination_id,new URL(base).origin,mid,mid,
        id.decision_key,revision,id.purpose,'project',h.root,'original-session');
    assert.throws(()=>validateSchema(db,3));
  } finally {db.close();}
  assert.throws(()=>new DeliveryLedger(h.ledger));
});

function variedV2(t:any, unsupportedReminder:boolean) {
  const h=fixture(t,2), file=path.join(h.directory,'varied.sqlite');
  const db=new DatabaseSync(file); fs.chmodSync(file,0o600);
  try {
    db.exec(fs.readFileSync(new URL('../../fixtures/delivery-v1.sql',import.meta.url),'utf8'));
    for (const [index,state] of ['sent','delivery_unknown','in_flight'].entries()) {
      db.prepare('INSERT INTO deliveries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run('legacy-profile','legacy-dest',
        'legacy/'+index,revision,'reminder',state,String(index+1).repeat(32),100,100,state==='sent'?100:null,
        state==='sent'?'1':null,'live',null);
    }
  } finally {db.close();}
  migrateLedgerV1ToV2(file,assertions);
  const ledger=new DeliveryLedger(file,()=>200);
  try {
    for (const [index,state] of ['sent','delivery_unknown','in_flight'].entries()) {
      const id={...original(index+10),purpose:'explicit_attention'};
      const claim=ledger.claim(id),mid='msg_'+String(index+10).padStart(26,'0');
      if(state!=='in_flight') ledger.associate(id,claim.receipt.claim_id!,{authority:new URL(base).origin,message_id:mid,
        thread_id:mid,native_project_id:'project',project_root:h.root,session_id:'original-session'},true);
      if(state==='sent')ledger.confirmed(id,claim.receipt.claim_id!,9);
      if(state==='delivery_unknown')ledger.unknown(id,claim.receipt.claim_id!);
    }
    if(unsupportedReminder){
      const id={...original(30),decision_key:'old-v2/reminder',purpose:'reminder'};
      const claim=ledger.claim(id),mid='msg_'+'7'.repeat(26);
      ledger.associate(id,claim.receipt.claim_id!,{authority:new URL(base).origin,message_id:mid,thread_id:mid,
        native_project_id:'project',project_root:h.root,session_id:'original-session'},true);
      ledger.confirmed(id,claim.receipt.claim_id!,10);
    }
  }finally{ledger.close();}
  return {...h,ledger:file};
}
function snapshotHistory(file:string){
  const db=new DatabaseSync(file);
  try{return { version:db.prepare('PRAGMA user_version').get(),ddl:db.prepare('SELECT * FROM sqlite_master ORDER BY name').all(),
    deliveries:db.prepare('SELECT * FROM deliveries ORDER BY profile_id,destination_id,decision_key').all(),
    canonical:db.prepare('SELECT * FROM canonical_associations ORDER BY profile_id,destination_id,decision_key').all(),
    migrations:db.prepare('SELECT * FROM migrations ORDER BY migration_id').all()};}finally{db.close();}
}
test('F1 clean v2 refusal preserves varied sent/unknown/inflight/canonical/legacy history and DB/fence bytes',t=>{
  const h=variedV2(t,true), before=snapshotHistory(h.ledger), bytes=fs.readFileSync(h.ledger),fence=fs.readFileSync(h.ledger+'.cutover-v2.json');
  assert.throws(()=>upgradeLedgerV2ToV3(h.ledger,assertions),{message:'ledger_upgrade_unsupported_reminder_history'});
  assert.deepEqual(snapshotHistory(h.ledger),before); assert.deepEqual(fs.readFileSync(h.ledger),bytes);
  assert.deepEqual(fs.readFileSync(h.ledger+'.cutover-v2.json'),fence); assert.equal(fs.existsSync(administrationLockPath(h.ledger)),false);
  const ledger=new DeliveryLedger(h.ledger,()=>300);
  try {
    assert.equal(ledger.schemaVersion(),2);
    assert.equal(ledger.claim({...original(10),purpose:'explicit_attention'}).action,'suppressed');
    assert.equal(ledger.claim({...original(99),purpose:'explicit_attention'}).action,'claimed');
    assert.throws(()=>ledger.claim({profile_id:'legacy-profile',destination_id:'legacy-dest',decision_key:'new',event_revision:revision,purpose:'explicit_attention'}));
  }finally{ledger.close();}
});
test('varied v2 histories including legacy-unmapped reminder tombstones upgrade with exact original SQL preservation',t=>{
  const h=variedV2(t,false),before=snapshotHistory(h.ledger),fence=fs.readFileSync(h.ledger+'.cutover-v2.json');
  upgradeLedgerV2ToV3(h.ledger,assertions);
  const after=snapshotHistory(h.ledger);
  assert.deepEqual(after.deliveries,before.deliveries); assert.deepEqual(after.canonical,before.canonical);
  assert.deepEqual(after.migrations.filter((row:any)=>!row.migration_id.startsWith('notification-v3/')),before.migrations);
  assert.deepEqual(after.ddl.filter((row:any)=>before.ddl.some((old:any)=>old.name===row.name)),before.ddl);
  assert.deepEqual(fs.readFileSync(h.ledger+'.cutover-v2.json'),fence);
  const db=new DatabaseSync(h.ledger);try{validateSchema(db,3);}finally{db.close();}
  const ledger=new DeliveryLedger(h.ledger);
  try{assert.throws(()=>ledger.claim({profile_id:'legacy-profile',destination_id:'legacy-dest',decision_key:'new',event_revision:revision,purpose:'explicit_attention'}));}
  finally{ledger.close();}
});
