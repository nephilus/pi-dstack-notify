import './offline-guard.mjs';
import { attempts } from './offline-guard.mjs';
import { after,test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createNotificationService } from '../../core/service.ts';
import { initializeLedgerV3,migrateLedgerV1ToV2,upgradeLedgerV2ToV3 } from '../../core/migration.ts';
import { DeliveryLedger } from '../../core/ledger.ts';
import { createTestTelegramHttpClient,createTestTelegramTransport } from '../../core/transport.ts';
import { createTestClefHttpClient } from '../../core/clef.ts';
import { createTestOwnerEvidenceProvider } from '../../core/owner-evidence.ts';
import type { TestOwnerOutcome,TestOwnerEvidenceProvider } from '../../core/owner-evidence.ts';
import { decodeOwnerObservation,ownerObservationData,testOwnerNativeFixtures,ownerSourceRequest } from '../../core/owner-control.ts';
import type { StoredOwnerOriginal } from '../../core/owner-control.ts';
import { observeStoredOwnerRequest } from '../../core/owner-observation.ts';
import { validateSchema } from '../../core/schema.ts';
import type { PublicationContext,DeliveryIdentity } from '../../core/types.ts';
const native=JSON.parse(fs.readFileSync(new URL('../../fixtures/inbox-native.json',import.meta.url),'utf8'));
const profileText=fs.readFileSync(new URL('../../fixtures/shared-profile.toml',import.meta.url),'utf8');
const revision='a'.repeat(64),base='https://inbox.example.invalid/';
const assertions={dispatchDisabled:true,allOldWritersQuiesced:true,walConsistentBackupVerified:true,noPriorHistory:true}as const;
after(()=>{assert.deepEqual(attempts,[]);assert.equal(process.env.PATH,'/nonexistent-notification-test-path');});
function rows(file:string,table:string):any[]{const db=new DatabaseSync(file,{readOnly:true});try{return db.prepare('SELECT * FROM '+table).all();}finally{db.close();}}
function fixture(t:any,outcome:TestOwnerOutcome='unanswered',telegramOutcome:'echo'|'unknown'='echo'){
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'notification-owner-')));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const root=path.join(directory,'project');fs.mkdirSync(root,{mode:0o700});
  const ledger=path.join(directory,'ledger.sqlite'),profile=path.join(directory,'profile.toml'),configPath=path.join(directory,'config.json');
  fs.writeFileSync(profile,profileText,{mode:0o600});
  fs.writeFileSync(configPath,JSON.stringify({version:1,enabled:true,projects:[{project_path:root,enabled:true,profile_path:profile,
    ledger_path:ledger,policy:'notification_product',inbox_base_url:base}]}),{mode:0o600});initializeLedgerV3(ledger,assertions);
  const provider=createTestOwnerEvidenceProvider(outcome==='snooze'?{outcome,snoozedUntil:4000.5}:{outcome});
  const telegram=createTestTelegramHttpClient({outcome:telegramOutcome}),clef=createTestClefHttpClient();
  const state={sends:0,reads:0,sourceReads:0,readerProvider:provider,hook:undefined as undefined|(()=>void),
    mutate:undefined as undefined|((read:any,source:boolean)=>void)};
  const originals=new Map<string,StoredOwnerOriginal>();const controller=new AbortController();
  const context:PublicationContext={operationId:'owner.op',observed:{session_id:'original-pi-author',project_path:root},signal:controller.signal,
    async hostCheck(){state.hook?.();return {...context.observed};},
    async inboxSend({body}){
      const mid='msg_'+String(++state.sends).padStart(26,'0'),sent=structuredClone(native.send),data=sent.structuredContent;
      data.message_id=data.thread_id=mid;data.project.root=root;data.url=base+'#thread='+mid;
      originals.set(mid,{identity:{profile_id:'test-only.primary',destination_id:'test-only.owner',decision_key:'placeholder',event_revision:revision,purpose:'owner_request'},
        target:{project_id:data.project.id,project_root:root,session_id:context.observed.session_id,message_id:mid,thread_id:mid,
          revision,revision_semantics:'content-sha256',url:data.url},body});return sent;
    },
    async inboxRead(request,options){
      assert.ok(options===undefined||options.signal===context.signal);state.reads++;
      let original=originals.get(request.message_id),source=false;
      if(!original){original=[...originals.values()].find(o=>ownerSourceRequest(state.readerProvider,o)?.message_id===request.message_id);source=true;}
      assert.ok(original);let read:any;
      if(source){state.sourceReads++;read=testOwnerNativeFixtures(state.readerProvider,original).source_read;assert.ok(read);}
      else{
        read=structuredClone(native.read);const data=read.structuredContent;data.url=original.target.url;data.thread.thread_id=original.target.thread_id;
        data.thread.project.root=root;const m=data.thread.messages[0];m.id=original.target.message_id;m.thread_id=original.target.thread_id;
        m.author.session=original.target.session_id;m.body=original.body;
        data.thread.messages.push(...testOwnerNativeFixtures(state.readerProvider,original).messages);
      }
      state.mutate?.(read,source);return read;
    }};
  const make=(p:TestOwnerEvidenceProvider|undefined=provider,secrets:readonly string[]=[],clock?:()=>number)=>createNotificationService({configPath,
    telegramHttpClient:telegram,clefHttpClient:clef,...(p?{ownerEvidenceProvider:p}:{}),knownSecrets:secrets,...(clock?{clock}:{})});
  const args=(key='owner/request')=>({decision_key:key,revision,text:'A recorded owner response is requested.'});
  const identity=(key='owner/request'):DeliveryIdentity=>({profile_id:'test-only.primary',destination_id:'test-only.owner',decision_key:key,event_revision:revision,purpose:'owner_request'});
  return {directory,root,ledger,profile,configPath,provider,telegram,clef,state,controller,context,originals,make,args,identity,service:make()};
}
async function observe(h:ReturnType<typeof fixture>,outcome:TestOwnerOutcome){
  const provider=createTestOwnerEvidenceProvider(outcome==='snooze'?{outcome,snoozedUntil:4000.5}:{outcome});h.state.readerProvider=provider;
  const ledger=new DeliveryLedger(h.ledger);
  try{const original=ledger.storedOwnerOriginal(h.identity());assert.ok(original);
    return await observeStoredOwnerRequest(ledger,original,provider,h.context,[],()=>{});
  }finally{ledger.close();}
}

test('owner original uses shared pipeline, atomic reservation precedes Inbox and full read activates tracking',async t=>{
  const h=fixture(t);let checked=false;
  h.state.hook=()=>{if(rows(h.ledger,'pending_owner_requests').length&&!checked){checked=true;
    const pending=rows(h.ledger,'pending_owner_requests')[0],delivery=rows(h.ledger,'deliveries')[0];
    assert.equal(pending.state,'reserved');assert.equal(delivery.state,'in_flight');assert.ok(pending.processing_sequence>0);
    assert.equal(pending.message_id,null);}};
  const result=await h.service.publishOwnerRequest(h.args(),h.context);
  assert.equal(result.state,'sent');assert.equal(result.tracking?.status,'active');assert.equal(result.classification.bypass_reason,'owner_request');
  assert.match(h.telegram.messages[0].text,/^Attention · owner request/);assert.equal(h.state.sends,1);assert.equal(h.state.reads,1);
  assert.equal(h.clef.requests.length,0);assert.equal(rows(h.ledger,'canonical_associations')[0].read_verified,1);
  const p=rows(h.ledger,'pending_owner_requests')[0];assert.equal(p.original_session_id,'original-pi-author');assert.equal(p.body,[...h.originals.values()][0].body);
  assert.ok(checked);const telegramCount=h.telegram.requests.length;
  assert.equal((await h.make().publishOwnerRequest(h.args(),h.context)).state,'duplicate');assert.equal(h.state.reads,1);assert.equal(h.state.sends,1);
  assert.equal(h.telegram.requests.length,telegramCount);
});

test('ACTUAL unsupported owner provider holds before lookup/claim/native, even with production IDs',async t=>{
  const h=fixture(t);const service=createNotificationService({configPath:h.configPath});
  const result=await service.publishOwnerRequest(h.args(),h.context);assert.equal(result.state,'held');assert.equal(result.admission.reason,'owner_evidence_unavailable');
  assert.equal(result.tracking?.status,'not_enrolled');assert.equal(h.state.sends,0);assert.equal(h.state.reads,0);
  assert.equal(rows(h.ledger,'deliveries').length,0);assert.equal(rows(h.ledger,'pending_owner_requests').length,0);
  assert.equal(service.planReminders({observed:h.context.observed}).due_count,0);
});

for(const outcome of ['direct-answer','verified-mirror','wrong-owner','wrong-request','wrong-revision','unverified-mirror','unknown','snooze'] as const)
  test('initial registration closed owner '+outcome+' controls are independently bound and durable',async t=>{
    const h=fixture(t,outcome);let checked=false;
    h.state.hook=()=>{const p=rows(h.ledger,'pending_owner_requests')[0];if(p&&p.state!=='reserved'){
      checked=true;assert.equal(p.state,['direct-answer','verified-mirror'].includes(outcome)?'paused_answer':'active');
    }};
    const result=await h.service.publishOwnerRequest(h.args(),h.context);assert.equal(result.state,'sent');
    const p=rows(h.ledger,'pending_owner_requests')[0];assert.equal(p.state,['direct-answer','verified-mirror'].includes(outcome)?'paused_answer':'active');
    assert.equal(p.answer_evidence_json!==null,['direct-answer','verified-mirror'].includes(outcome));
    assert.equal(p.snoozed_until,outcome==='snooze'?4000.5:null);assert.ok(checked,'durable control visible BEFORE later host/Telegram dispatch');
    assert.equal(h.state.sourceReads,outcome==='verified-mirror'?1:0);assert.equal(h.clef.requests.length,0);
    const reads=h.state.reads;const replay=await h.make().publishOwnerRequest(h.args(),h.context);assert.equal(replay.state,'duplicate');assert.equal(h.state.reads,reads);
  });

test('REAL independent service32nd/33rd race: capacity+claim committed BEFORE any winner Inbox; loser has no effect',async t=>{
  const h=fixture(t);for(let i=0;i<31;i++)assert.equal((await h.make().publishOwnerRequest(h.args('request/'+i),h.context)).state,'sent');
  const first=h.make(),second=h.make();let release!:()=>void,reached!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),atSend=new Promise<void>(resolve=>{reached=resolve;});
  const send=h.context.inboxSend;
  const winnerContext={...h.context,operationId:'race.32',async inboxSend(args:{body:string;idempotency_key:string}){
    assert.equal(rows(h.ledger,'pending_owner_requests').length,32);assert.equal(rows(h.ledger,'deliveries').length,32);
    assert.equal(rows(h.ledger,'pending_owner_requests').filter(p=>p.state==='reserved').length,1);
    reached();await gate;return send(args);
  }};
  const winner=first.publishOwnerRequest(h.args('request/32'),winnerContext);await atSend;
  const readsBeforeLoser=h.state.reads;
  const loser=await second.publishOwnerRequest(h.args('request/33'),{...h.context,operationId:'race.33'});
  assert.equal(h.state.reads,readsBeforeLoser);assert.ok(!rows(h.ledger,'pending_owner_requests').some(row=>row.decision_key==='request/33'));
  assert.equal(loser.state,'held');assert.equal(loser.admission.reason,'owner_capacity_held');assert.equal(h.state.sends,31);
  assert.ok(!rows(h.ledger,'deliveries').some(row=>row.decision_key==='request/33'));release();assert.equal((await winner).state,'sent');
  assert.equal(h.state.sends,32);assert.equal(h.telegram.requests.length,32);assert.equal(rows(h.ledger,'pending_owner_requests').length,32);
});

for(const stage of ['before-send','readback','activation-write','telegram'] as const)test('owner uncertainty '+stage+' retains reservation/verified registration across restart',async t=>{
  const h=fixture(t,'unanswered',stage==='telegram'?'unknown':'echo');
  if(stage==='before-send')h.context.inboxSend=async()=>{throw new Error('synthetic interrupted native send');};
  if(stage==='readback')h.state.mutate=(read,source)=>{if(!source)read.structuredContent.thread.messages[0].body+=' mismatch';};
  const original=DatabaseSync.prototype.prepare;
  if(stage==='activation-write')DatabaseSync.prototype.prepare=function(query:string){if(query.includes("UPDATE pending_owner_requests SET state='active'"))throw new Error('synthetic activation write');return original.call(this,query);};
  let result;try{result=await h.service.publishOwnerRequest(h.args(),h.context);}finally{DatabaseSync.prototype.prepare=original;}
  assert.equal(result.state,'unknown');const pending=rows(h.ledger,'pending_owner_requests')[0];
  assert.equal(pending.state,stage==='telegram'?'active':'reserved');
  assert.equal(rows(h.ledger,'deliveries')[0].state,'delivery_unknown');
  const before=JSON.stringify(rows(h.ledger,'pending_owner_requests')),reads=h.state.reads,sends=h.state.sends;
  assert.equal((await h.make().publishOwnerRequest(h.args(),h.context)).state,'unknown');assert.equal(h.state.reads,reads);assert.equal(h.state.sends,sends);
  assert.equal(JSON.stringify(rows(h.ledger,'pending_owner_requests')),before);
  const db=new DatabaseSync(h.ledger,{readOnly:true});try{validateSchema(db,3);}finally{db.close();}
});

test('crash after reservation commit retains in-flight original+reserved capacity, never reclaims',async t=>{
  const h=fixture(t),check=h.context.hostCheck;let crash=false;
  h.context.hostCheck=async()=>{if(rows(h.ledger,'pending_owner_requests').length){h.controller.abort();crash=true;}return check();};
  assert.equal((await h.service.publishOwnerRequest(h.args(),h.context)).state,'unknown');assert.ok(crash);assert.equal(h.state.sends,0);
  assert.equal(rows(h.ledger,'pending_owner_requests')[0].state,'reserved');h.context.signal=new AbortController().signal;
  assert.equal((await h.make().publishOwnerRequest(h.args(),h.context)).state,'unknown');assert.equal(h.state.sends,0);
});

test('historic terminal owner delivery is NOT silently enrolled or refreshed',async t=>{
  const h=fixture(t);const ledger=new DeliveryLedger(h.ledger);try{const claim=ledger.claim(h.identity());ledger.unknown(h.identity(),claim.receipt.claim_id!);}finally{ledger.close();}
  assert.equal((await h.service.publishOwnerRequest(h.args(),h.context)).state,'unknown');
  assert.equal(rows(h.ledger,'pending_owner_requests').length,0);assert.equal(h.state.sends,0);assert.equal(h.state.reads,0);
});

test('INTERNAL stored-original controls use original author despite NEW invocation; pause persists across snooze/unknown/restart',async t=>{
  const h=fixture(t);assert.equal((await h.service.publishOwnerRequest(h.args(),h.context)).state,'sent');
  h.context.observed={...h.context.observed,session_id:'fresh-invocation-not-original-author'};
  assert.equal(await observe(h,'snooze'),'active');const snooze=rows(h.ledger,'pending_owner_requests')[0].snoozed_until;
  assert.equal(await observe(h,'verified-mirror'),'paused_answer');
  const answer=rows(h.ledger,'pending_owner_requests')[0].answer_evidence_json;assert.equal(rows(h.ledger,'pending_owner_requests')[0].snoozed_until,snooze);
  assert.equal(await observe(h,'unknown'),'paused_answer');assert.equal(await observe(h,'unanswered'),'paused_answer');
  const p=rows(h.ledger,'pending_owner_requests')[0];assert.equal(p.answer_evidence_json,answer);assert.equal(p.snoozed_until,snooze);
  assert.equal(h.state.sends,1);assert.equal(h.telegram.requests.length,1,'internal observation is NOT a new public publication/tick');
});

test('INTERNAL wrong original/source read and failed control write never commit pause',async t=>{
  for(const failure of ['original-author','mirror-source','write'] as const){
    const h=fixture(t);await h.service.publishOwnerRequest(h.args(),h.context);
    if(failure==='original-author')h.state.mutate=(read,source)=>{if(!source)read.structuredContent.thread.messages[0].author.session='wrong-original-author';};
    if(failure==='mirror-source')h.state.mutate=(read,source)=>{if(source)read.structuredContent.thread.messages[0].author.session='wrong-source-owner';};
    const original=DatabaseSync.prototype.prepare;
    if(failure==='write')DatabaseSync.prototype.prepare=function(query:string){if(query.includes("SET state='paused_answer'"))throw new Error('synthetic control write failure');return original.call(this,query);};
    try{if(failure==='mirror-source')assert.equal(await observe(h,'verified-mirror'),'active');else await assert.rejects(observe(h,'direct-answer'));}
    finally{DatabaseSync.prototype.prepare=original;}
    const p=rows(h.ledger,'pending_owner_requests')[0];assert.equal(p.state,'active');assert.equal(p.answer_evidence_json,null);
  }
});

test('FIFO reservation joins tail even after pause/free-capacity churn, no default0 priority jump',async t=>{
  const h=fixture(t);for(const key of ['a','b','c'])await h.make().publishOwnerRequest(h.args(key),h.context);
  const before=rows(h.ledger,'pending_owner_requests');assert.deepEqual(before.map(p=>p.processing_sequence),[1,2,3]);
  // Control the actual first registered original through the reusable fresh path.
  const l=new DeliveryLedger(h.ledger);try{const original=l.storedOwnerOriginal(h.identity('a'));assert.ok(original);
    const provider=createTestOwnerEvidenceProvider({outcome:'direct-answer'});h.state.readerProvider=provider;
    await observeStoredOwnerRequest(l,original,provider,h.context,[],()=>{});
  }finally{l.close();}
  h.state.readerProvider=h.provider;await h.make().publishOwnerRequest(h.args('newcomer'),h.context);
  const after=rows(h.ledger,'pending_owner_requests');assert.equal(after.find(p=>p.decision_key==='newcomer').processing_sequence,4);
  assert.equal(after.find(p=>p.decision_key==='a').state,'paused_answer');assert.equal(after.find(p=>p.decision_key==='b').processing_sequence,2);
});

test('closed control capsules reject duck verified objects; mixed modes and secret metadata fail before effects',async t=>{
  const h=fixture(t);assert.throws(()=>createNotificationService({configPath:'/never-read',ownerEvidenceProvider:h.provider}),{message:'notification_held'});
  assert.throws(()=>createNotificationService({configPath:'/never-read',telegramHttpClient:h.telegram,ownerEvidenceProvider:{} as any}),{message:'notification_held'});
  await h.service.publishOwnerRequest(h.args(),h.context);const l=new DeliveryLedger(h.ledger);
  try{assert.throws(()=>l.applyOwnerObservation(h.identity(),{mode:'closed-owner-observation',verified:true} as any));}finally{l.close();}
  for(const secret of ['owner_request','paused_answer','owner request']){
    const next=fixture(t);const result=await next.make(next.provider,[secret]).publishOwnerRequest(next.args(),next.context);
    assert.equal(result.state,'held');assert.ok(!JSON.stringify(result).includes(secret));assert.equal(next.state.sends,0);assert.equal(rows(next.ledger,'deliveries').length,0);
  }
});

// Exercise every key and fixed scalar from REAL assembled success/duplicate/unknown
// receipts, plus preclaim/failure outcomes. No duplicated hand-picked policy patch.
test('whole predictable owner receipt metadata preflights before ANY durable or external effect',async t=>{
  const sample=fixture(t);const receipts=[await sample.service.publishOwnerRequest(sample.args(),sample.context),
    await sample.make().publishOwnerRequest(sample.args(),sample.context)];
  const uncertain=fixture(t,'unanswered','unknown');receipts.push(await uncertain.service.publishOwnerRequest(uncertain.args(),uncertain.context));
  const secrets=new Set<string>(['identity_binding','reserved_unknown','not_enrolled','owner_capacity_held','owner_evidence_unavailable',
    'configured_admission_held','legacy_history_unmapped','canonical_identity_conflict','prior_attempt_terminal','receipt_protected',
    'publication_or_delivery_unknown_no_retry']);
  const visit=(v:any):void=>{if(v&&typeof v==='object')for(const [k,x]of Object.entries(v)){secrets.add(k);visit(x);}
    else if(typeof v==='string'&&/^[a-z][a-z_-]*$/.test(v))secrets.add(v);};receipts.forEach(visit);
  for(const secret of secrets){
    const h=fixture(t);let result;
    try{result=await h.make(h.provider,[secret]).publishOwnerRequest(h.args(),h.context);}
    catch(error){assert.equal((error as Error).message,'notification_held');}
    if(result){assert.ok(['held','unknown'].includes(result.state),secret);assert.ok(!JSON.stringify(result).includes(secret),secret);}
    assert.equal(h.state.sends,0,secret);assert.equal(h.state.reads,0,secret);
    assert.equal(h.telegram.requests.length,0,secret);assert.equal(h.clef.requests.length,0,secret);
    assert.equal(rows(h.ledger,'deliveries').length,0,secret);assert.equal(rows(h.ledger,'pending_owner_requests').length,0,secret);
  }
});

test('opaque observations bind immutable FULL original target and exact namespace, never another native request',async t=>{
  const h=fixture(t);await h.service.publishOwnerRequest(h.args(),h.context);
  const ledger=new DeliveryLedger(h.ledger),provider=createTestOwnerEvidenceProvider({outcome:'direct-answer'});
  try{
    const stored=ledger.storedOwnerOriginal(h.identity());assert.ok(stored);
    const capsuleFor=async(original:StoredOwnerOriginal)=>{
      // Construct a fully valid native read for this CLOSED synthetic target.
      const read=structuredClone(native.read),d=read.structuredContent,m=d.thread.messages[0],target=original.target;
      d.url=target.url;d.thread.thread_id=target.thread_id;d.thread.project={id:target.project_id,root:target.project_root};
      Object.assign(m,{id:target.message_id,thread_id:target.thread_id,project_id:target.project_id,body:original.body});
      m.author.session=target.session_id;d.thread.messages.push(...testOwnerNativeFixtures(provider,original).messages);
      return decodeOwnerObservation(provider,original,read,null,[]);
    };
    for(const field of ['message_id','thread_id','project_id','project_root','url','session_id','profile_id','destination_id','decision_key','event_revision'] as const){
      const other=structuredClone(stored);
      if(field==='profile_id'||field==='destination_id')other.identity[field]+='.other';
      else if(field==='decision_key')other.identity.decision_key+='/other';
      else if(field==='event_revision'){other.identity.event_revision='b'.repeat(64);other.target.revision=other.identity.event_revision;
        other.body=other.body.replaceAll(revision,other.identity.event_revision);}
      else if(field==='session_id'){other.target.session_id='other-author';other.body=other.body.replaceAll('original-pi-author','other-author');}
      else if(field==='message_id'||field==='thread_id'){other.target[field]='msg_'+ '9'.repeat(26);
        if(field==='thread_id')other.target.url=base+'#thread='+other.target.thread_id;}
      else other.target[field]+='/other';
      // URL must retain the required thread suffix to pass the independent verifier.
      if(field==='url')other.target.url='https://other.example.invalid/#thread='+other.target.thread_id;
      const capsule=await capsuleFor(other);
      assert.throws(()=>ledger.applyOwnerObservation(h.identity(),capsule),field);
      assert.equal(rows(h.ledger,'pending_owner_requests')[0].state,'active',field);
    }
    const mutable=structuredClone(stored),good=await capsuleFor(mutable);
    mutable.target.message_id='msg_'+'8'.repeat(26);mutable.identity.decision_key='mutated';mutable.body='mutated';
    const exposed=ownerObservationData(good);exposed.target.message_id='msg_'+'7'.repeat(26);
    assert.equal(ledger.applyOwnerObservation(h.identity(),good),'paused_answer','validated detached snapshot remains authoritative');
  }finally{ledger.close();}
});

for(const field of ['body','project','thread','message','url','revision','attachment','duplicate'] as const)
  test('malformed ORIGINAL '+field+' cannot activate from known IDs alone',async t=>{
    const h=fixture(t,'direct-answer');h.state.mutate=(read,source)=>{if(source)return;
      const d=read.structuredContent,m=d.thread.messages[0];
      if(field==='body')m.body+=' mismatch';if(field==='project')d.thread.project.id='other-project';
      if(field==='thread')d.thread.thread_id='msg_'+'9'.repeat(26);if(field==='message')m.id='msg_'+'9'.repeat(26);
      if(field==='url')d.url='https://wrong.example.invalid/#thread='+d.thread.thread_id;
      if(field==='revision')m.body=m.body.replace(revision,'b'.repeat(64));
      if(field==='attachment')m.attachments=[{}];if(field==='duplicate')d.thread.messages.push(structuredClone(m));
    };
    assert.equal((await h.service.publishOwnerRequest(h.args(),h.context)).state,'unknown');
    assert.equal(rows(h.ledger,'pending_owner_requests')[0].state,'reserved');
    assert.equal(rows(h.ledger,'canonical_associations')[0].read_verified,0);assert.equal(h.telegram.requests.length,0);
  });

test('REAL cap32 retains reserved unknowns and snoozes; verified answer frees exactly one FIFO tail slot',async t=>{
  const h=fixture(t),send=h.context.inboxSend;
  h.context.inboxSend=async()=>{throw new Error('closed interrupted send');};
  assert.equal((await h.make().publishOwnerRequest(h.args('reserved'),h.context)).state,'unknown');h.context.inboxSend=send;
  for(let i=0;i<31;i++)assert.equal((await h.make().publishOwnerRequest(h.args(i===0?'owner/request':'active/'+i),h.context)).state,'sent');
  assert.equal(await observe(h,'snooze'),'active');
  assert.equal((await h.make().publishOwnerRequest(h.args('overflow'),h.context)).admission.reason,'owner_capacity_held');
  assert.equal(rows(h.ledger,'deliveries').length,32);assert.equal(h.state.sends,31);
  assert.equal(await observe(h,'direct-answer'),'paused_answer');
  const paused=rows(h.ledger,'pending_owner_requests').find(p=>p.decision_key==='owner/request');
  assert.equal(paused.snoozed_until,4000.5);assert.ok(paused.answer_evidence_json);
  h.state.readerProvider=h.provider;
  assert.equal((await h.make().publishOwnerRequest(h.args('tail'),h.context)).state,'sent');
  assert.equal(rows(h.ledger,'pending_owner_requests').find(p=>p.decision_key==='tail').processing_sequence,33);
  assert.equal((await h.make().publishOwnerRequest(h.args('overflow2'),h.context)).admission.reason,'owner_capacity_held');
  assert.equal(rows(h.ledger,'pending_owner_requests').length,33);assert.equal(rows(h.ledger,'deliveries').length,33);
});

test('INTERNAL invalid original holds BEFORE independently reading a mirror source',async t=>{
  const h=fixture(t);await h.service.publishOwnerRequest(h.args(),h.context);
  h.state.mutate=(read,source)=>{if(!source)read.structuredContent.thread.messages[0].author.session='wrong-original';};
  await assert.rejects(observe(h,'verified-mirror'));assert.equal(h.state.sourceReads,0);
  assert.equal(rows(h.ledger,'pending_owner_requests')[0].state,'active');assert.equal(h.telegram.requests.length,1);
});

test('confirmed and canonical untracked originals never re-enroll under owner intent or changed invocation',async t=>{
  for(const terminal of ['confirmed','canonical-unknown'] as const){
    const h=fixture(t),l=new DeliveryLedger(h.ledger);
    try{const claim=l.claim(h.identity()),mid='msg_'+'6'.repeat(26);
      l.associate(h.identity(),claim.receipt.claim_id!,{authority:new URL(base).origin,message_id:mid,thread_id:mid,
        native_project_id:'historic-project',project_root:h.root,session_id:'historic-author'},true);
      if(terminal==='confirmed')l.confirmed(h.identity(),claim.receipt.claim_id!,9);else l.unknown(h.identity(),claim.receipt.claim_id!);
    }finally{l.close();}
    const prior=JSON.stringify(rows(h.ledger,'canonical_associations'));h.context.observed={session_id:'changed-invocation',project_path:h.root};
    const result=await h.make(createTestOwnerEvidenceProvider({outcome:'direct-answer'})).publishOwnerRequest({...h.args(),review_link:{label:'review',url:'https://review.example.invalid/new'}},h.context);
    assert.equal(result.state,terminal==='confirmed'?'duplicate':'unknown');assert.equal(result.tracking?.status,'not_enrolled');
    assert.equal(rows(h.ledger,'pending_owner_requests').length,0);assert.equal(JSON.stringify(rows(h.ledger,'canonical_associations')),prior);
    assert.equal(h.state.sends,0);assert.equal(h.state.reads,0);assert.equal(h.telegram.requests.length,0);
  }
});

test('fractional OWNER snooze conflicts hold, expiry never unpauses recorded answer or resets identity',async t=>{
  const h=fixture(t);await h.service.publishOwnerRequest(h.args(),h.context);
  assert.equal(await observe(h,'snooze'),'active');const before=rows(h.ledger,'pending_owner_requests')[0];
  const conflict=createTestOwnerEvidenceProvider({outcome:'snooze',snoozedUntil:4001.25});h.state.readerProvider=conflict;
  const l=new DeliveryLedger(h.ledger);try{const original=l.storedOwnerOriginal(h.identity());assert.ok(original);
    await assert.rejects(observeStoredOwnerRequest(l,original,conflict,h.context,[],()=>{}));
  }finally{l.close();}
  assert.equal(rows(h.ledger,'pending_owner_requests')[0].snoozed_until,4000.5);
  assert.equal(await observe(h,'direct-answer'),'paused_answer');assert.equal(await observe(h,'snooze'),'paused_answer');
  for(const now of [4000.25,4000.5,4000.75,1e9]){
    const service=createNotificationService({configPath:h.configPath,telegramHttpClient:h.telegram,ownerEvidenceProvider:h.provider,clock:()=>now});
    assert.equal(service.planReminders({observed:h.context.observed}).due_count,0);
  }
  const after=rows(h.ledger,'pending_owner_requests')[0];
  for(const key of ['decision_key','event_revision','purpose','original_session_id','message_id','created_at','processing_sequence','snoozed_until'])assert.equal(after[key],before[key],key);
  assert.equal(h.state.sends,1);assert.equal(h.telegram.requests.length,1);
});

for(const failure of ['project','url','thread','reply','body','attachment'] as const)
  test('independent mirror source '+failure+' mismatch cannot pause',async t=>{
    const h=fixture(t);await h.service.publishOwnerRequest(h.args(),h.context);
    h.state.mutate=(read,source)=>{if(!source)return;const d=read.structuredContent,m=d.thread.messages[0];
      if(failure==='project')d.thread.project.root+='/wrong';if(failure==='url')d.url+='wrong';
      if(failure==='thread')m.thread_id='msg_'+'7'.repeat(26);if(failure==='reply')m.reply_to='msg_'+'7'.repeat(26);
      if(failure==='body')m.body+='wrong';if(failure==='attachment')m.attachments=[{}];};
    assert.equal(await observe(h,'verified-mirror'),'active');assert.equal(rows(h.ledger,'pending_owner_requests')[0].answer_evidence_json,null);
    assert.equal(h.telegram.requests.length,1);
  });

test('closed owner fixtures require BOTH test IDs and BOTH fake Telegram transport modes before config lookup',async t=>{
  const h=fixture(t);
  const legacy=createTestTelegramTransport();
  const legacyService=createNotificationService({configPath:h.configPath,telegramTransport:legacy,ownerEvidenceProvider:h.provider});
  assert.equal((await legacyService.publishOwnerRequest(h.args('legacy-fake'),h.context)).state,'sent');assert.equal(legacy.messages.length,1);
  for(const mode of [{telegramHttpClient:h.telegram},{telegramTransport:legacy}])
    assert.throws(()=>createNotificationService({configPath:'/never-open-owner-config',...mode,ownerEvidenceProvider:h.provider,clefConfigPath:'/never-open-clef'}),{message:'notification_held'});
  // Construction rejects fake owner + real Telegram before reading this nonexistent config.
  assert.throws(()=>createNotificationService({configPath:'/never-open-owner-config',ownerEvidenceProvider:h.provider}),{message:'notification_held'});
  await h.service.publishOwnerRequest(h.args(),h.context);const l=new DeliveryLedger(h.ledger);
  try{const stored=l.storedOwnerOriginal(h.identity());assert.ok(stored);
    for(const field of ['profile_id','destination_id'] as const){const mixed=structuredClone(stored);mixed.identity[field]='production';
      assert.throws(()=>testOwnerNativeFixtures(h.provider,mixed));assert.throws(()=>l.storedOwnerOriginal(mixed.identity));}
  }finally{l.close();}
  assert.equal(rows(h.ledger,'deliveries').every(row=>row.profile_id.startsWith('test-only.')&&row.destination_id.startsWith('test-only.')),true);
});

test('owner intent preserves legacy-unmapped scope guard; no claims or enrollment or native read',async t=>{
  const h=fixture(t),legacy=h.identity('legacy-tombstone'),file=path.join(h.directory,'legacy.sqlite');
  const db=new DatabaseSync(file);fs.chmodSync(file,0o600);try{
    db.exec(fs.readFileSync(new URL('../../fixtures/delivery-v1.sql',import.meta.url),'utf8'));
    db.prepare("INSERT INTO deliveries VALUES (?,?,?,?,?,'delivery_unknown',?,0,0,NULL,NULL,'live',NULL)")
      .run(legacy.profile_id,legacy.destination_id,legacy.decision_key,legacy.event_revision,legacy.purpose,'6'.repeat(32));
  }finally{db.close();}
  const cutover={dispatchDisabled:true,allOldWritersQuiesced:true,walConsistentBackupVerified:true} as const;
  migrateLedgerV1ToV2(file,cutover);upgradeLedgerV2ToV3(file,cutover);
  const config=JSON.parse(fs.readFileSync(h.configPath,'utf8'));config.projects[0].ledger_path=file;
  fs.writeFileSync(h.configPath,JSON.stringify(config),{mode:0o600});h.ledger=file;
  const before=JSON.stringify(rows(h.ledger,'deliveries'));
  const result=await h.make().publishOwnerRequest(h.args(),h.context);assert.equal(result.admission.reason,'legacy_history_unmapped');
  assert.equal(rows(h.ledger,'pending_owner_requests').length,0);assert.equal(JSON.stringify(rows(h.ledger,'deliveries')),before);
  assert.equal(h.state.sends,0);assert.equal(h.state.reads,0);assert.equal(h.telegram.requests.length,0);
});

test('public OWNER proof, authority and target overrides never enter the shared publication pipeline',async t=>{
  for(const field of ['verified','owner','proof','profile','destination','target','policy','hour']){
    const h=fixture(t);assert.equal((await h.service.publishOwnerRequest({...h.args(),[field]:true} as any,h.context)).state,'held');
    assert.equal(rows(h.ledger,'deliveries').length,0);assert.equal(h.state.sends,0);assert.equal(h.state.reads,0);
  }
});

test('owner publication exact v3 upper timestamp boundary refuses BEFORE paired claim/reservation/native effects',async t=>{
  const h=fixture(t),limit=253402300800;
  const result=await h.make(h.provider,[],()=>limit).publishOwnerRequest(h.args(),h.context);
  assert.equal(result.state,'held');assert.equal(rows(h.ledger,'deliveries').length,0);assert.equal(rows(h.ledger,'pending_owner_requests').length,0);
  assert.equal(h.state.sends,0);assert.equal(h.state.reads,0);assert.equal(h.telegram.requests.length,0);
  const db=new DatabaseSync(h.ledger,{readOnly:true});try{validateSchema(db,3);}finally{db.close();}
  assert.equal((await h.make(h.provider,[],()=>limit-0.5).publishOwnerRequest(h.args(),h.context)).state,'sent');
  assert.equal(rows(h.ledger,'pending_owner_requests')[0].created_at,limit-0.5,'supported fractions retained below upper boundary');
});

for(const outcome of ['direct-answer','snooze'] as const)
  test('later '+outcome+' at exact upper timestamp boundary rolls back unchanged VALID owner state',async t=>{
    const h=fixture(t);await h.service.publishOwnerRequest(h.args(),h.context);
    const prior=JSON.stringify(rows(h.ledger,'pending_owner_requests')),deliveries=JSON.stringify(rows(h.ledger,'deliveries'));
    const provider=createTestOwnerEvidenceProvider(outcome==='snooze'?{outcome,snoozedUntil:4000.5}:{outcome});h.state.readerProvider=provider;
    const ledger=new DeliveryLedger(h.ledger,()=>253402300800);
    try{const original=ledger.storedOwnerOriginal(h.identity());assert.ok(original);
      await assert.rejects(observeStoredOwnerRequest(ledger,original,provider,h.context,[],()=>{}));
    }finally{ledger.close();}
    assert.equal(JSON.stringify(rows(h.ledger,'pending_owner_requests')),prior);assert.equal(JSON.stringify(rows(h.ledger,'deliveries')),deliveries);
    assert.equal(h.state.sends,1);assert.equal(h.telegram.requests.length,1);assert.equal(rows(h.ledger,'pending_owner_requests')[0].state,'active');
    const db=new DatabaseSync(h.ledger,{readOnly:true});try{validateSchema(db,3);}finally{db.close();}
  });

test('owner activation crossing upper timestamp boundary retains VALID reserved original, never partial activation',async t=>{
  const h=fixture(t);let now=3600.5;h.state.mutate=()=>{now=253402300800;};
  const r=await h.make(h.provider,[],()=>now).publishOwnerRequest(h.args(),h.context);assert.equal(r.state,'unknown');
  const pending=rows(h.ledger,'pending_owner_requests')[0];assert.equal(pending.state,'reserved');assert.equal(pending.created_at,3600.5);
  assert.equal(rows(h.ledger,'canonical_associations')[0].read_verified,0);assert.equal(h.telegram.requests.length,0);
  const db=new DatabaseSync(h.ledger,{readOnly:true});try{validateSchema(db,3);}finally{db.close();}
});

test('reservation insertion or commit failure rolls back BOTH claim and reservation before Inbox',async t=>{
  for(const failure of ['insert','commit'] as const){
    const h=fixture(t),prepare=DatabaseSync.prototype.prepare,exec=DatabaseSync.prototype.exec;let injected=false;
    if(failure==='insert')DatabaseSync.prototype.prepare=function(sql:string){if(sql.includes('INSERT INTO pending_owner_requests')){injected=true;throw new Error('closed insertion fault');}return prepare.call(this,sql);};
    if(failure==='commit')DatabaseSync.prototype.exec=function(sql:string){
      if(sql==='COMMIT'&&this.prepare('SELECT COUNT(*) n FROM deliveries').get()!.n===1){injected=true;throw new Error('closed commit fault');}return exec.call(this,sql);};
    try{assert.equal((await h.service.publishOwnerRequest(h.args(),h.context)).state,'held');}
    finally{DatabaseSync.prototype.prepare=prepare;DatabaseSync.prototype.exec=exec;}
    assert.ok(injected);assert.equal(rows(h.ledger,'deliveries').length,0);assert.equal(rows(h.ledger,'pending_owner_requests').length,0);
    assert.equal(h.state.sends,0);assert.equal(h.telegram.requests.length,0);
  }
});
