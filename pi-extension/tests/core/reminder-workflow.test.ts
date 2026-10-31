import './offline-guard.mjs';
import { attempts } from './offline-guard.mjs';
import { after,test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createNotificationService } from '../../core/service.ts';
import { initializeLedgerV3 } from '../../core/migration.ts';
import { DeliveryLedger } from '../../core/ledger.ts';
import { createTestTelegramHttpClient,waitForTestTelegramHttpRequest,completeLateTestTelegramHttp } from '../../core/transport.ts';
import { createTestClefHttpClient } from '../../core/clef.ts';
import { createTestOwnerEvidenceProvider } from '../../core/owner-evidence.ts';
import { testOwnerNativeFixtures,ownerSourceRequest } from '../../core/owner-control.ts';
import type { StoredOwnerOriginal } from '../../core/owner-control.ts';
import type { TestOwnerEvidenceProvider,TestOwnerOutcome } from '../../core/owner-evidence.ts';
import { observeStoredOwnerRequest,readOwnerObservation } from '../../core/owner-observation.ts';
import { canonicalUTCSlot,reminderDeliveryIdentity } from '../../core/reminder-time.ts';
import type { PublicationContext,DeliveryIdentity,ReminderTickReceipt } from '../../core/types.ts';
import { validateSchema } from '../../core/schema.ts';
const native=JSON.parse(fs.readFileSync(new URL('../../fixtures/inbox-native.json',import.meta.url),'utf8'));
const profileText=fs.readFileSync(new URL('../../fixtures/shared-profile.toml',import.meta.url),'utf8');
const revision='a'.repeat(64),base='https://inbox.example.invalid/';
after(()=>{assert.deepEqual(attempts,[]);assert.equal(process.env.PATH,'/nonexistent-notification-test-path');});
function rows(file:string,table:string):any[]{const db=new DatabaseSync(file,{readOnly:true});try{return db.prepare('SELECT * FROM '+table).all();}finally{db.close();}}
function fixture(t:any){
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'notification-tick-')));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const root=path.join(directory,'project');fs.mkdirSync(root,{mode:0o700});
  const ledger=path.join(directory,'ledger.sqlite'),profile=path.join(directory,'profile.toml'),configPath=path.join(directory,'config.json');
  fs.writeFileSync(profile,profileText,{mode:0o600});
  fs.writeFileSync(configPath,JSON.stringify({version:1,enabled:true,projects:[{project_path:root,enabled:true,profile_path:profile,
    ledger_path:ledger,policy:'notification_product',inbox_base_url:base}]}),{mode:0o600});
  initializeLedgerV3(ledger,{dispatchDisabled:true,allOldWritersQuiesced:true,walConsistentBackupVerified:true,noPriorHistory:true});
  const telegram=createTestTelegramHttpClient(),clef=createTestClefHttpClient(),controller=new AbortController();
  const provider=createTestOwnerEvidenceProvider();
  const state={now:3600.25,sends:0,reads:0,sourceReads:0,provider,
    onRead:undefined as undefined|((request:{message_id:string;thread_id:string},signal:AbortSignal)=>Promise<void>),
    onHost:undefined as undefined|(()=>Promise<void>),mutate:undefined as undefined|((read:any,source:boolean)=>void),order:[] as string[],signals:[] as AbortSignal[]};
  const originals=new Map<string,StoredOwnerOriginal>();
  const context:PublicationContext={operationId:'tick.op',observed:{session_id:'original-author',project_path:root},signal:controller.signal,
    async hostCheck(){await state.onHost?.();return {...context.observed};},
    async inboxSend({body}){
      const mid='msg_'+String(++state.sends).padStart(26,'0'),sent=structuredClone(native.send),data=sent.structuredContent;
      data.message_id=data.thread_id=mid;data.project.root=root;data.url=base+'#thread='+mid;
      originals.set(mid,{identity:{profile_id:'test-only.primary',destination_id:'test-only.owner',decision_key:'placeholder',event_revision:revision,purpose:'owner_request'},
        target:{project_id:data.project.id,project_root:root,session_id:context.observed.session_id,message_id:mid,thread_id:mid,
          revision,revision_semantics:'content-sha256',url:data.url},body});return sent;
    },
    async inboxRead(request,options){
      assert.deepEqual(Object.keys(request).sort(),['message_id','thread_id']);
      if(options){assert.deepEqual(Object.keys(options),['signal']);assert.ok(options.signal instanceof AbortSignal);}
      state.reads++;state.order.push(request.message_id);if(options?.signal)state.signals.push(options.signal);
      await state.onRead?.(request,options?.signal??context.signal);
      let original=originals.get(request.message_id),source=false;
      if(!original){original=[...originals.values()].find(o=>ownerSourceRequest(state.provider,o)?.message_id===request.message_id);source=true;}
      assert.ok(original);let read:any;
      if(source){state.sourceReads++;read=testOwnerNativeFixtures(state.provider,original).source_read;assert.ok(read);}
      else{read=structuredClone(native.read);const d=read.structuredContent,m=d.thread.messages[0];
        d.url=original.target.url;d.thread.thread_id=original.target.thread_id;d.thread.project.root=root;
        Object.assign(m,{id:original.target.message_id,thread_id:original.target.thread_id,body:original.body});m.author.session=original.target.session_id;
        d.thread.messages.push(...testOwnerNativeFixtures(state.provider,original).messages);}
      state.mutate?.(read,source);return read;
    }};
  const identity=(key='request'):DeliveryIdentity=>({profile_id:'test-only.primary',destination_id:'test-only.owner',decision_key:key,event_revision:revision,purpose:'owner_request'});
  const args=(key='request')=>({decision_key:key,revision,text:'Owner response requested.',review_link:{label:'Review',url:'https://review.example.invalid/request'}});
  const make=(p:TestOwnerEvidenceProvider|undefined=provider,secrets:readonly string[]=[],http=telegram,tickMonotonicClock?:()=>number)=>createNotificationService({configPath,
    telegramHttpClient:http,clefHttpClient:clef,...(p?{ownerEvidenceProvider:p}:{}),knownSecrets:secrets,clock:()=>state.now,...(tickMonotonicClock?{tickMonotonicClock}:{})});
  const enroll=async(key='request')=>{assert.equal((await make().publishOwnerRequest(args(key),context)).state,'sent');};
  const fresh=()=>{state.order=[];state.signals=[];context.observed={session_id:'fresh-invocation',project_path:root};return context;};
  const control=async(key:string,outcome:TestOwnerOutcome,until=4000.5)=>{
    const p=createTestOwnerEvidenceProvider(outcome==='snooze'?{outcome,snoozedUntil:until}:{outcome}),old=state.provider;state.provider=p;
    const l=new DeliveryLedger(ledger);try{const original=l.storedOwnerOriginal(identity(key));assert.ok(original);
      return await observeStoredOwnerRequest(l,original,p,context,[],()=>{});
    }finally{l.close();state.provider=old;}
  };
  return {directory,root,ledger,profile,configPath,telegram,clef,controller,provider,state,context,originals,identity,args,make,enroll,fresh,control};
}
function counts(r:ReminderTickReceipt){assert.equal(r.selected,r.processed+r.incomplete+r.remaining);for(const field of ['selected','processed','incomplete','remaining','sent','duplicate','paused','snoozed','held'] as const)assert.ok(Number.isInteger(r[field])&&r[field]>=0&&r[field]<=32,field);}

test('REAL Tick sends shared delivery once/original/revision/CURRENT hour, original author provenance and no Clef/Inbox send',async t=>{
  const h=fixture(t);await h.enroll();h.fresh();const before=h.telegram.requests.length;
  const r=await h.make().tickReminders({},h.context);counts(r);assert.equal(r.state,'completed');assert.equal(r.sent,1);assert.equal(r.utc_slot,canonicalUTCSlot(h.state.now));
  assert.equal(h.state.sends,1);assert.equal(h.clef.requests.length,0);assert.equal(h.telegram.requests.length,before+1);
  const message=h.telegram.messages.at(-1)!;assert.match(message.text,/^Attention · unanswered owner reminder · unclassified/);
  assert.match(message.text,/Source: Pi session original-author/);assert.ok(!message.text.includes('fresh-invocation'));assert.match(message.text,/https:\/\/review.example.invalid\/request/);
  assert.equal(rows(h.ledger,'canonical_associations').length,1);assert.equal(rows(h.ledger,'reminder_occurrences').length,1);
  assert.equal(rows(h.ledger,'deliveries').find(d=>d.purpose==='reminder').state,'sent');
  assert.equal(h.make().planReminders({observed:h.context.observed}).due_count,0);
  assert.equal((await h.make().tickReminders({},h.context)).duplicate,1);assert.equal(h.telegram.requests.length,before+1);
  h.state.now+=4*3600;assert.equal((await h.make().tickReminders({},h.context)).sent,1);assert.equal(rows(h.ledger,'reminder_occurrences').length,2,'no missed-hour catchup');
  h.state.now=3600.5;assert.equal((await h.make().tickReminders({},h.context)).duplicate,1,'rollback cannot replay');
});

test('REAL healthy32 snapshot drains ALL32 in one call; exact count identity and cursor persisted BEFORE first native',async t=>{
  const h=fixture(t);for(let i=0;i<32;i++)await h.enroll('request/'+i);h.fresh();
  const initial=rows(h.ledger,'pending_owner_requests').sort((a,b)=>a.processing_sequence-b.processing_sequence);
  let first=true;h.state.onRead=async request=>{if(first){first=false;const row=rows(h.ledger,'pending_owner_requests').find(p=>p.message_id===request.message_id);
    assert.equal(row.processing_sequence,33);assert.equal(row.decision_key,initial[0].decision_key);}};
  const result=await h.make().tickReminders({},h.context);counts(result);assert.equal(result.selected,32);assert.equal(result.processed,32);assert.equal(result.sent,32);assert.equal(result.remaining,0);
  assert.equal(h.state.order.length,64);assert.equal(h.state.sends,32);assert.equal(rows(h.ledger,'reminder_occurrences').length,32);
});

test('initial exact snapshot churn: concurrent pause plus newcomer cannot displace original members',async t=>{
  const h=fixture(t);for(const key of ['a','b','c',...Array.from({length:29},(_,i)=>'waiting/'+i)])await h.enroll(key);h.fresh();let changed=false;
  h.state.onRead=async()=>{if(changed)return;changed=true;h.state.onRead=undefined;
    await h.control('b','direct-answer');await h.enroll('newcomer');};
  const r=await h.make().tickReminders({},h.context);counts(r);assert.equal(r.selected,32);assert.equal(r.processed,32);assert.equal(r.paused,1);assert.equal(r.sent,31);
  const occurrences=rows(h.ledger,'reminder_occurrences');assert.equal(occurrences.length,31);assert.ok(!occurrences.some(row=>['b','newcomer'].includes(row.decision_key)));
  const pending=rows(h.ledger,'pending_owner_requests');assert.equal(pending.length,33);assert.ok(pending.find(p=>p.decision_key==='newcomer').processing_sequence>33);
});

for(const outcome of ['direct-answer','verified-mirror','wrong-owner','wrong-request','wrong-revision','unverified-mirror'] as const)
  test('Tick closed '+outcome+' observation is independently verified; unknown never claims',async t=>{
    const h=fixture(t);await h.enroll();h.fresh();const p=createTestOwnerEvidenceProvider({outcome});h.state.provider=p;
    const before=h.telegram.requests.length,r=await h.make(p).tickReminders({},h.context);counts(r);
    if(outcome==='direct-answer'||outcome==='verified-mirror'){
      assert.equal(r.paused,1);assert.equal(r.processed,1);assert.equal(rows(h.ledger,'pending_owner_requests')[0].state,'paused_answer');
    }else{assert.equal(r.incomplete,1);assert.equal(rows(h.ledger,'pending_owner_requests')[0].state,'active');}
    assert.equal(rows(h.ledger,'reminder_occurrences').length,0);assert.equal(h.telegram.requests.length,before);
  });

test('snoozed originals can record answer immediately; fractional expiry never unpauses/no catchup',async t=>{
  const h=fixture(t);await h.enroll();await h.control('request','snooze',4000.5);h.fresh();
  h.state.now=4000.25;assert.equal(h.make().planReminders({observed:h.context.observed}).due_count,0);
  assert.equal((await h.make().tickReminders({},h.context)).snoozed,1);
  h.state.now=4000.5;assert.equal((await h.make().tickReminders({},h.context)).sent,1);
  h.state.now+=3600;await h.control('request','snooze',4000.5);
  const p=createTestOwnerEvidenceProvider({outcome:'verified-mirror'});h.state.provider=p;
  assert.equal((await h.make(p).tickReminders({},h.context)).paused,1);assert.equal(rows(h.ledger,'pending_owner_requests')[0].snoozed_until,4000.5);
  h.state.provider=h.provider;h.state.now+=10*3600;assert.equal((await h.make().tickReminders({},h.context)).selected,0);
  assert.equal(rows(h.ledger,'reminder_occurrences').length,1);assert.equal(h.make().planReminders({observed:h.context.observed}).due_count,0);
  assert.equal(rows(h.ledger,'pending_owner_requests')[0].state,'paused_answer');
});

for(const stage of ['initial-read','final-read','before-send'] as const)
  test('fractional clock '+stage+' crossing uses current slot or retains OLD unknown without slot switch',async t=>{
    const h=fixture(t);await h.enroll();h.fresh();h.state.now=7199.75;let reads=0;
    h.state.onRead=async()=>{reads++;if(stage==='initial-read'&&reads===1||stage==='final-read'&&reads===2)h.state.now=7200.25;};
    if(stage==='before-send')h.state.onHost=async()=>{if(rows(h.ledger,'reminder_occurrences').length&&reads>=2)h.state.now=7200.25;};
    const r=await h.make().tickReminders({},h.context);counts(r);
    const occurrences=rows(h.ledger,'reminder_occurrences');assert.equal(occurrences.length,1);
    assert.equal(occurrences[0].utc_slot,canonicalUTCSlot(stage==='initial-read'?7200:3600));
    assert.equal(r.sent,stage==='initial-read'?1:0);
    if(stage!=='initial-read')assert.equal(rows(h.ledger,'deliveries').find(d=>d.purpose==='reminder').state,'delivery_unknown');
  });

test('two independent current-slot Ticks race through SAME atomic occurrence+delivery claim and send once',async t=>{
  const h=fixture(t);await h.enroll();h.fresh();
  const [a,b]=await Promise.all([h.make().tickReminders({},h.context),h.make().tickReminders({},{...h.context,operationId:'second.tick'})]);
  counts(a);counts(b);assert.equal(a.sent+b.sent,1);assert.equal(rows(h.ledger,'reminder_occurrences').length,1);assert.equal(h.telegram.requests.length,2);
});

for(const failure of ['insert','commit'] as const)
  test('occurrence '+failure+' fault rolls back BOTH original-linked claim rows before Telegram',async t=>{
    const h=fixture(t);await h.enroll();h.fresh();const prepare=DatabaseSync.prototype.prepare,exec=DatabaseSync.prototype.exec;let injected=false;
    if(failure==='insert')DatabaseSync.prototype.prepare=function(sql:string){if(sql.includes('INSERT INTO reminder_occurrences')){injected=true;throw Error('closed insertion failure');}return prepare.call(this,sql);};
    if(failure==='commit')DatabaseSync.prototype.exec=function(sql:string){if(sql==='COMMIT'&&this.prepare("SELECT COUNT(*) n FROM deliveries WHERE purpose='reminder'").get()!.n===1){injected=true;throw Error('closed commit failure');}return exec.call(this,sql);};
    let r;try{r=await h.make().tickReminders({},h.context);}finally{DatabaseSync.prototype.prepare=prepare;DatabaseSync.prototype.exec=exec;}
    counts(r);assert.ok(injected);assert.equal(r.sent,0);assert.equal(rows(h.ledger,'reminder_occurrences').length,0);assert.equal(rows(h.ledger,'deliveries').length,1);assert.equal(h.telegram.requests.length,1);
  });

test('Telegram unknown retains linked occurrence and original chain forever across restart; later hour distinct',async t=>{
  const h=fixture(t);await h.enroll();h.fresh();const unknown=createTestTelegramHttpClient({outcome:'unknown'});
  const r=await h.make(h.provider,[],unknown).tickReminders({},h.context);counts(r);assert.equal(r.incomplete,1);
  const prior=JSON.stringify(rows(h.ledger,'reminder_occurrences'));assert.equal(rows(h.ledger,'deliveries').find(d=>d.purpose==='reminder').state,'delivery_unknown');
  assert.equal((await h.make().tickReminders({},h.context)).duplicate,1);assert.equal(JSON.stringify(rows(h.ledger,'reminder_occurrences')),prior);assert.equal(h.telegram.requests.length,1);
  h.state.now+=3600;assert.equal((await h.make().tickReminders({},h.context)).sent,1);
  const db=new DatabaseSync(h.ledger,{readOnly:true});try{validateSchema(db,3);}finally{db.close();}
});

test('ignored native abort times out WHOLE Tick, exact partial counts; late result authorizes nothing and next-slot FIFO survives',async t=>{
  const h=fixture(t);await h.enroll('bad');for(let i=0;i<31;i++)await h.enroll(i===0?'healthy':'healthy/'+i);h.fresh();
  let release!:()=>void;const deferred=new Promise<void>(resolve=>{release=resolve;});let calls=0,observedSignal:AbortSignal|undefined;
  h.state.onRead=async(_request,signal)=>{calls++;observedSignal=signal;await deferred;};
  const r=await h.make().tickReminders({},h.context);counts(r);assert.equal(r.state,'incomplete');assert.equal(r.selected,32);assert.equal(r.incomplete,1);assert.equal(r.remaining,31);assert.equal(r.processed,0);
  assert.equal(calls,1);assert.equal(observedSignal!.aborted,true);assert.equal(rows(h.ledger,'reminder_occurrences').length,0);
  release();await deferred;await Promise.resolve();assert.equal(h.telegram.requests.length,32,'late original read cannot send or claim');
  h.state.onRead=undefined;h.state.now+=3600;h.fresh();
  const next=await h.make().tickReminders({},h.context);assert.equal(next.sent,32);
  const pending=rows(h.ledger,'pending_owner_requests');const healthy=pending.find(p=>p.decision_key==='healthy');
  assert.equal(h.state.order[0],healthy.message_id,'unvisited healthy original precedes timed-out one next slot');
});

test('parent cancellation during final read leaves linked unknown; ignored late native result cannot confirm',async t=>{
  const h=fixture(t);await h.enroll();h.fresh();let reads=0,release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  h.state.onRead=async()=>{if(++reads===2){h.controller.abort();await gate;}};
  const nativeRead=h.context.inboxRead.bind(h.context);let calls=0,settle!:()=>void;
  const finalSettled=new Promise<void>(resolve=>{settle=resolve;});
  h.context.inboxRead=(args,options)=>{const call=++calls;return nativeRead(args,options).finally(()=>{if(call===2)settle();});};
  const r=await h.make().tickReminders({},h.context);counts(r);assert.equal(r.incomplete,1);assert.equal(r.sent,0);
  assert.equal(rows(h.ledger,'deliveries').find(d=>d.purpose==='reminder').state,'delivery_unknown');
  const deliveries=rows(h.ledger,'deliveries'),occurrences=rows(h.ledger,'reminder_occurrences');
  release();await finalSettled;await Promise.resolve();assert.equal(h.telegram.requests.length,1);
  assert.deepEqual(rows(h.ledger,'deliveries'),deliveries,'settled late final read cannot confirm or alter terminal unknown');
  assert.deepEqual(rows(h.ledger,'reminder_occurrences'),occurrences,'settled late final read cannot alter occurrence/latch');
});

test('actual/static unknown/disabled/invalid arguments hold zero before native or claims; no model wakes',async t=>{
  const h=fixture(t);await h.enroll();h.fresh();const before=h.state.reads;
  const actual=createNotificationService({configPath:h.configPath,clock:()=>h.state.now});
  assert.equal((await actual.tickReminders({},h.context)).reason,'owner_evidence_unavailable');
  assert.equal(actual.planReminders({observed:h.context.observed}).due_count,0);
  const unknown=createTestOwnerEvidenceProvider({outcome:'unknown'});assert.equal((await h.make(unknown).tickReminders({},h.context)).reason,'owner_evidence_unavailable');
  assert.equal(h.make(unknown).planReminders({observed:h.context.observed}).due_count,0);
  for(const input of [{hour:'override'},{verified:true},{owner:'override'},{profile:'override'}])assert.equal((await h.make().tickReminders(input as any,h.context)).state,'held');
  for(const session_id of [null,3,'bad\nvalue'])assert.equal((await h.make().tickReminders({},{...h.context,observed:{...h.context.observed,session_id} as any})).state,'held');
  const config=JSON.parse(fs.readFileSync(h.configPath,'utf8'));config.enabled=false;fs.writeFileSync(h.configPath,JSON.stringify(config),{mode:0o600});
  assert.equal((await h.make().tickReminders({},h.context)).state,'inactive');
  assert.equal(h.state.reads,before);assert.equal(rows(h.ledger,'reminder_occurrences').length,0);assert.equal(h.clef.requests.length,0);
});

test('verified answer after HTTP send-start can pause yet known verified echo is honestly recorded',async t=>{
  const h=fixture(t);await h.enroll();h.fresh();const late=createTestTelegramHttpClient({outcome:'late'});
  const running=h.make(h.provider,[],late).tickReminders({},h.context);await waitForTestTelegramHttpRequest(late);
  assert.ok(rows(h.ledger,'reminder_occurrences')[0].send_started_at!==null);
  await h.control('request','direct-answer');assert.equal(rows(h.ledger,'pending_owner_requests')[0].state,'paused_answer');
  completeLateTestTelegramHttp(late);const r=await running;counts(r);assert.equal(r.sent,1);
  assert.equal(rows(h.ledger,'deliveries').find(d=>d.purpose==='reminder').state,'sent');
  assert.equal(rows(h.ledger,'pending_owner_requests')[0].state,'paused_answer');
});

test('signal-aborted late Telegram echo NEVER confirms or retries retained occurrence',async t=>{
  const h=fixture(t);await h.enroll();h.fresh();const late=createTestTelegramHttpClient({outcome:'late'});
  const running=h.make(h.provider,[],late).tickReminders({},h.context);await waitForTestTelegramHttpRequest(late);h.controller.abort();
  const r=await running;counts(r);assert.equal(r.sent,0);assert.equal(r.incomplete,1);
  completeLateTestTelegramHttp(late);await Promise.resolve();await Promise.resolve();
  assert.equal(rows(h.ledger,'deliveries').find(d=>d.purpose==='reminder').state,'delivery_unknown');
  h.context.signal=new AbortController().signal;assert.equal((await h.make().tickReminders({},h.context)).duplicate,1);
  assert.equal(h.telegram.requests.length,1,'no retry on the normal sender');
});

for(const outcome of ['direct-answer','snooze'] as const)
 test(outcome+' observed on final read commits BEFORE later host gate, cancels claimed send without approval',async t=>{
  const h=fixture(t);await h.enroll();h.fresh();let reads=0,checked=false;
  const answer=createTestOwnerEvidenceProvider(outcome==='snooze'?{outcome,snoozedUntil:4000.5}:{outcome}),l=new DeliveryLedger(h.ledger);
  try{
    const original=l.storedOwnerOriginal(h.identity());assert.ok(original);h.state.provider=answer;
    const recorded=await readOwnerObservation(original,answer,h.context,[],()=>l.checkFence());h.state.provider=h.provider;
    // A competing genuine recorded-answer observation commits during final read.
    h.state.onRead=async()=>{if(++reads===2)l.applyOwnerObservation(h.identity(),recorded);};
    h.state.onHost=async()=>{const row=rows(h.ledger,'pending_owner_requests')[0];if(outcome==='direct-answer'?row.state==='paused_answer':row.snoozed_until===4000.5)checked=true;};
    const r=await h.make().tickReminders({},h.context);counts(r);assert.equal(r[outcome==='direct-answer'?'paused':'snoozed'],1);assert.equal(r.sent,0);assert.equal(r.processed,1);
    assert.equal(rows(h.ledger,'reminder_occurrences').length,1);assert.equal(checked,true);
    assert.equal(rows(h.ledger,'deliveries').find(d=>d.purpose==='reminder').state,'delivery_unknown');assert.equal(h.telegram.requests.length,1);
  }finally{l.close();}
});

for(const stage of ['initial','final'] as const)test('wrong native target on '+stage+' original read cannot send',async t=>{
  const h=fixture(t);await h.enroll();h.fresh();let reads=0;
  h.state.mutate=(read,source)=>{if(!source&&++reads===(stage==='initial'?1:2))read.structuredContent.thread.messages[0].author.session='wrong-original-author';};
  const r=await h.make().tickReminders({},h.context);counts(r);assert.equal(r.sent,0);assert.equal(r.incomplete,1);
  assert.equal(rows(h.ledger,'reminder_occurrences').length,stage==='initial'?0:1);assert.equal(h.telegram.requests.length,1);
});

test('tick-only SQLite busy_timeout0 fails closed promptly without changing publisher/admin connection semantics',async t=>{
  const h=fixture(t);await h.enroll();h.fresh();const locker=new DatabaseSync(h.ledger);locker.exec('BEGIN IMMEDIATE');
  const started=performance.now();try{const r=await h.make().tickReminders({},h.context);assert.equal(r.state,'held');assert.equal(r.selected,0);
    assert.ok(performance.now()-started<1500,'tick lock contention must not wait the ordinary10 seconds');
  }finally{locker.exec('ROLLBACK');locker.close();}
  assert.equal(rows(h.ledger,'reminder_occurrences').length,0);
});

test('stored predictable metadata/body protection holds before native observation and claim',async t=>{
  for(const field of ['native_project_id','body'] as const){const h=fixture(t);await h.enroll();h.fresh();const before=h.state.reads;
    const secret=String(rows(h.ledger,'pending_owner_requests')[0][field]);
    const prior=JSON.stringify(rows(h.ledger,'pending_owner_requests'));
    const r=await h.make(h.provider,[secret]).tickReminders({},h.context);counts(r);assert.equal(r.sent,0);
    assert.equal(JSON.stringify(rows(h.ledger,'pending_owner_requests')),prior,'payload protection precedes cursor mutation');
    assert.equal(h.state.reads,before);assert.equal(rows(h.ledger,'reminder_occurrences').length,0);assert.equal(h.telegram.requests.length,1);
  }
});

test('settled bad first observation isolates without overlap and does not starve healthy snapshot members',async t=>{
  const h=fixture(t);await h.enroll('bad');await h.enroll('healthy');h.fresh();const bad=rows(h.ledger,'pending_owner_requests').find(p=>p.decision_key==='bad').message_id;
  h.state.mutate=(read,source)=>{if(!source&&read.structuredContent.thread.messages[0].id===bad)read.structuredContent.thread.project.root+='/wrong';};
  const r=await h.make().tickReminders({},h.context);counts(r);assert.equal(r.selected,2);assert.equal(r.incomplete,1);assert.equal(r.processed,1);assert.equal(r.sent,1);assert.equal(r.remaining,0);
});

test('child timeout still poisons entire Tick when callback surfaces ordinary failure',async t=>{
  const h=fixture(t);await h.enroll('first');await h.enroll('second');h.fresh();let calls=0;
  h.state.onRead=async(_request,signal)=>{calls++;await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('ordinary callback failure')),{once:true}));};
  const r=await h.make().tickReminders({},h.context);counts(r);assert.equal(r.incomplete,1);assert.equal(r.remaining,1);assert.equal(calls,1);assert.equal(r.sent,0);assert.equal(rows(h.ledger,'reminder_occurrences').length,0);
});

test('HTTP completion after claimed-hour crossing retains unknown and never adopts a later slot',async t=>{
  const h=fixture(t);await h.enroll();h.fresh();const late=createTestTelegramHttpClient({outcome:'late'});
  const slot=canonicalUTCSlot(h.state.now),running=h.make(h.provider,[],late).tickReminders({},h.context);
  await waitForTestTelegramHttpRequest(late);h.state.now+=3600;completeLateTestTelegramHttp(late);
  const r=await running;counts(r);assert.equal(r.sent,0);assert.equal(r.incomplete,1);assert.equal(rows(h.ledger,'reminder_occurrences')[0].utc_slot,slot);
  assert.equal(rows(h.ledger,'deliveries').find(d=>d.purpose==='reminder').state,'delivery_unknown');
});

for(const at of [253402300800,NaN,Infinity,-0.25])test('invalid Tick epoch '+String(at)+' cannot write invalid v3 timestamps or native effects',async t=>{
  const h=fixture(t);await h.enroll();h.fresh();const prior=JSON.stringify(rows(h.ledger,'pending_owner_requests')),reads=h.state.reads;h.state.now=at;
  const r=await h.make().tickReminders({},h.context);assert.equal(r.state,'held');assert.equal(r.selected,0);assert.equal(h.state.reads,reads);
  assert.equal(JSON.stringify(rows(h.ledger,'pending_owner_requests')),prior);assert.equal(rows(h.ledger,'reminder_occurrences').length,0);
  const db=new DatabaseSync(h.ledger,{readOnly:true});try{validateSchema(db,3);}finally{db.close();}
});

test('clock jumps after sampled occurrence time retain VALID linked unknown, never invalid new v3 rows',async t=>{
  const h=fixture(t);await h.enroll();h.fresh();const prepare=DatabaseSync.prototype.prepare;let injected=false;
  DatabaseSync.prototype.prepare=function(sql:string){if(sql.includes('INSERT INTO reminder_occurrences')){h.state.now=253402300800;injected=true;}return prepare.call(this,sql);};
  // Clock changes after the validated sampled occurrence time. The immediate
  // following guard fails; already committed valid sampled rows remain unknown,
  // never format-invalid. No clock re-sampling can corrupt a paired transaction.
  let r;try{r=await h.make().tickReminders({},h.context);}finally{DatabaseSync.prototype.prepare=prepare;}
  counts(r);assert.ok(injected);assert.equal(r.sent,0);assert.equal(h.telegram.requests.length,1);
  const db=new DatabaseSync(h.ledger,{readOnly:true});try{validateSchema(db,3);}finally{db.close();}
  assert.equal(rows(h.ledger,'reminder_occurrences')[0].created_at,3600.25);
});

test('genuine recorded answer while future-snoozed pauses immediately rather than waiting for expiry',async t=>{
  const h=fixture(t);await h.enroll();await h.control('request','snooze',4000.5);h.fresh();
  const answer=createTestOwnerEvidenceProvider({outcome:'direct-answer'});h.state.provider=answer;
  const r=await h.make(answer).tickReminders({},h.context);counts(r);assert.equal(r.paused,1);assert.equal(r.snoozed,0);
  assert.equal(rows(h.ledger,'pending_owner_requests')[0].snoozed_until,4000.5);assert.equal(rows(h.ledger,'pending_owner_requests')[0].state,'paused_answer');
  assert.equal(rows(h.ledger,'reminder_occurrences').length,0);assert.equal(h.telegram.requests.length,1);
});

test('explicit new revision has its own hour identity; session/provider/path changes cannot replay an original',async t=>{
  const h=fixture(t);await h.enroll();
  const otherRevision='b'.repeat(64);assert.equal((await h.make().publishOwnerRequest({...h.args(),revision:otherRevision},h.context)).state,'sent');
  h.fresh();const r=await h.make().tickReminders({},h.context);assert.equal(r.sent,2);
  assert.equal(new Set(rows(h.ledger,'reminder_occurrences').map(row=>row.reminder_key)).size,2);
  h.context.observed={session_id:'third-session',project_path:h.root};
  assert.equal((await h.make(createTestOwnerEvidenceProvider()).tickReminders({},h.context)).duplicate,2);
  const otherRoot=path.join(h.directory,'other-project');fs.mkdirSync(otherRoot,{mode:0o700});
  const config=JSON.parse(fs.readFileSync(h.configPath,'utf8'));config.projects[0].project_path=otherRoot;fs.writeFileSync(h.configPath,JSON.stringify(config),{mode:0o600});
  h.context.observed={session_id:'new-path-session',project_path:otherRoot};
  assert.equal((await h.make().publishOwnerRequest(h.args(),h.context)).state,'duplicate');
  assert.equal((await h.make().tickReminders({},h.context)).selected,0,'changed path is not permission to adopt/re-enroll historical target');
  assert.equal(rows(h.ledger,'pending_owner_requests').length,2);assert.equal(rows(h.ledger,'reminder_occurrences').length,2);assert.equal(h.telegram.requests.length,4);
});

test('same NEW-v3 range guard covers FYIP claim/decision timestamps without changing ordinary delivery semantics',async t=>{
  const h=fixture(t);h.state.now=253402300800;
  const result=await h.make().publishFYIP({decision_key:'fyip/range',revision,candidate:{kind:'milestone',title:'Requested capability available',
    previous_state:'Capability not available',current_state:'Requested capability is usable now',materiality:'Owner can use the requested capability',
    evidence:[{kind:'milestone',detail:'Observed requested capability in the completed service'}],reconciled:true}},h.context);
  assert.equal(result.state,'held');assert.equal(h.clef.requests.length,0);assert.equal(h.state.sends,0);
  assert.equal(rows(h.ledger,'fyip_decisions').length,0);assert.equal(rows(h.ledger,'deliveries').length,0);
  const id={...h.identity('fyip/range'),purpose:'fyip'},fingerprints={candidate_sha256:'b'.repeat(64),question_sha256:'c'.repeat(64),config_sha256:'d'.repeat(64)};
  const valid=new DeliveryLedger(h.ledger,()=>100.5);let claim;
  try{claim=valid.claimFYIP(id,fingerprints);}finally{valid.close();}
  const prior=JSON.stringify(rows(h.ledger,'fyip_decisions')),invalid=new DeliveryLedger(h.ledger,()=>253402300800);
  try{assert.throws(()=>invalid.decideFYIP(id,claim.claim_id,'classified_no','no'));}finally{invalid.close();}
  assert.equal(JSON.stringify(rows(h.ledger,'fyip_decisions')),prior);
  const below=new DeliveryLedger(h.ledger,()=>253402300799.5);
  try{below.decideFYIP(id,claim.claim_id,'classified_no','no');}finally{below.close();}
  assert.equal(rows(h.ledger,'fyip_decisions')[0].created_at,100.5);assert.equal(rows(h.ledger,'fyip_decisions')[0].decided_at,253402300799.5);
  const db=new DatabaseSync(h.ledger,{readOnly:true});try{validateSchema(db,3);}finally{db.close();}
});

for(const outcome of ['success','ordinary-error'] as const)
 test('absolute2s elapsed native '+outcome+' before timer turn poisons WHOLE Tick',async t=>{
  const h=fixture(t);await h.enroll('first');await h.enroll('second');h.fresh();let elapsed=0,calls=0;
  h.state.onRead=async()=>{calls++;elapsed=2000;if(outcome==='ordinary-error')throw Error('ordinary settled Inbox error');};
  const r=await h.make(h.provider,[],h.telegram,()=>elapsed).tickReminders({},h.context);counts(r);
  assert.equal(r.selected,2);assert.equal(r.incomplete,1);assert.equal(r.remaining,1);assert.equal(r.processed,0);assert.equal(calls,1);
  assert.equal(h.state.signals[0].aborted,true);assert.equal(rows(h.ledger,'reminder_occurrences').length,0);assert.equal(h.telegram.requests.length,2);
});

test('absolute20s REQUEST expiry rejects HTTP success even within independent10s await budget',async t=>{
  const h=fixture(t);await h.enroll('first');await h.enroll('second');h.fresh();let elapsed=0;
  h.state.onHost=async()=>{elapsed+=1500;};h.state.onRead=async()=>{elapsed+=1500;};
  const late=createTestTelegramHttpClient({outcome:'late'}),running=h.make(h.provider,[],late,()=>elapsed).tickReminders({},h.context);
  await waitForTestTelegramHttpRequest(late);const atSend=elapsed;assert.ok(atSend>10000&&atSend<20000);
  elapsed=20000;assert.ok(elapsed-atSend<10000,'HTTP await itself has NOT expired');completeLateTestTelegramHttp(late);
  const r=await running;counts(r);assert.equal(r.selected,2);assert.equal(r.incomplete,1);assert.equal(r.remaining,1);assert.equal(r.sent,0);
  assert.equal(rows(h.ledger,'deliveries').find(d=>d.purpose==='reminder').state,'delivery_unknown');assert.equal(h.state.signals.at(-1)!.aborted,true);
});

test('independent monotonic clock just BELOW2s remains valid; UTC does not advance the budget',async t=>{
  const h=fixture(t);await h.enroll();h.fresh();let elapsed=0;
  h.state.onRead=async()=>{elapsed=1999.5;};
  const r=await h.make(h.provider,[],h.telegram,()=>elapsed).tickReminders({},h.context);counts(r);assert.equal(r.sent,1);
  assert.equal(r.utc_slot,canonicalUTCSlot(h.state.now));
});

for(const invalid of [NaN,Infinity,-1])test('invalid monotonic settlement '+String(invalid)+' aborts without later native/claim',async t=>{
  const h=fixture(t);await h.enroll('first');await h.enroll('second');h.fresh();let elapsed=0;
  h.state.onRead=async()=>{elapsed=invalid;};
  const r=await h.make(h.provider,[],h.telegram,()=>elapsed).tickReminders({},h.context);counts(r);assert.equal(r.incomplete,1);assert.equal(r.remaining,1);
  assert.equal(h.state.order.length,1);assert.equal(h.state.signals[0].aborted,true);assert.equal(rows(h.ledger,'reminder_occurrences').length,0);
});

test('positive BACKWARD monotonic settlement is invalid, not refreshed into a new budget',async t=>{
  const h=fixture(t);await h.enroll('first');await h.enroll('second');h.fresh();let elapsed=100;
  h.state.onRead=async()=>{elapsed=99;};
  const r=await h.make(h.provider,[],h.telegram,()=>elapsed).tickReminders({},h.context);counts(r);assert.equal(r.incomplete,1);assert.equal(r.remaining,1);
  assert.equal(h.state.order.length,1);assert.equal(h.state.signals[0].aborted,true);
});

for(const failure of ['sync-throw','async-reject','null','extra-key','wrong-session','wrong-path','numeric-session'] as const)
 test('first host '+failure+' poisons WHOLE two-member Tick; otherwise-successful later host never dispatches',async t=>{
  const h=fixture(t);await h.enroll('first');await h.enroll('second');h.fresh();let calls=0;
  h.context.hostCheck=()=>{
    if(++calls>1)return Promise.resolve({...h.context.observed});
    if(failure==='sync-throw')throw Error('ordinary synchronous host failure');
    if(failure==='async-reject')return Promise.reject(Error('ordinary asynchronous host failure'));
    return Promise.resolve(failure==='null'?null:failure==='extra-key'?{...h.context.observed,extra:true}:
      failure==='wrong-session'?{...h.context.observed,session_id:'other'}:failure==='wrong-path'?{...h.context.observed,project_path:h.root+'/other'}:
      {...h.context.observed,session_id:3}) as any;
  };
  const reads=h.state.reads,r=await h.make().tickReminders({},h.context);counts(r);
  assert.equal(calls,1);assert.equal(r.selected,2);assert.equal(r.incomplete,1);assert.equal(r.remaining,1);assert.equal(r.processed,0);
  assert.equal(r.reason,'tick_cancelled');assert.equal(h.state.reads,reads);assert.equal(rows(h.ledger,'reminder_occurrences').length,0);assert.equal(h.telegram.requests.length,2);
});

test('synchronous host success after elapsed2s is rejected BEFORE first native, not rescued by delayed timer',async t=>{
  const h=fixture(t);await h.enroll('first');await h.enroll('second');h.fresh();let elapsed=0,calls=0;
  h.context.hostCheck=()=>{calls++;elapsed=2000;return Promise.resolve({...h.context.observed});};
  const reads=h.state.reads,r=await h.make(h.provider,[],h.telegram,()=>elapsed).tickReminders({},h.context);counts(r);
  assert.equal(calls,1);assert.equal(r.incomplete,1);assert.equal(r.remaining,1);assert.equal(h.state.reads,reads);assert.equal(rows(h.ledger,'reminder_occurrences').length,0);
});

test('actual initial UTC slot secret4000.25 preflights ZERO cursor/native/claims/Telegram',async t=>{
  const h=fixture(t);await h.enroll();h.fresh();h.state.now=4000.25;const secret='1970-01-01T01:00:00+00:00';
  const pending=rows(h.ledger,'pending_owner_requests'),reads=h.state.reads,r=await h.make(h.provider,[secret]).tickReminders({},h.context);counts(r);
  assert.equal(r.state,'held');assert.equal(r.utc_slot,null);assert.equal(r.selected,0);assert.ok(!JSON.stringify(r).includes(secret));
  assert.deepEqual(rows(h.ledger,'pending_owner_requests'),pending);assert.equal(h.state.reads,reads);assert.equal(rows(h.ledger,'reminder_occurrences').length,0);assert.equal(h.telegram.requests.length,1);
});

test('post-read rollover slot secret stops BEFORE adoption/claim/send with safe honest initial-slot counts',async t=>{
  const h=fixture(t);await h.enroll('first');await h.enroll('second');h.fresh();h.state.now=7199.75;
  const secret=canonicalUTCSlot(7200.25);h.state.onRead=async()=>{h.state.now=7200.25;};
  const r=await h.make(h.provider,[secret]).tickReminders({},h.context);counts(r);
  assert.equal(r.selected,2);assert.equal(r.incomplete,1);assert.equal(r.remaining,1);assert.equal(r.sent,0);assert.ok(!JSON.stringify(r).includes(secret));
  assert.equal(r.utc_slot,canonicalUTCSlot(7199.75));assert.equal(rows(h.ledger,'reminder_occurrences').length,0);assert.equal(h.telegram.requests.length,2);
});

test('later rollover collision preserves earlier legitimate sent/processed counts, never a fabricated zero receipt',async t=>{
  const h=fixture(t);await h.enroll('first');await h.enroll('second');h.fresh();h.state.now=7199.75;
  const secret=canonicalUTCSlot(7200.25);let reads=0;h.state.onRead=async()=>{if(++reads===3)h.state.now=7200.25;};
  const r=await h.make(h.provider,[secret]).tickReminders({},h.context);counts(r);
  assert.equal(r.state,'incomplete');assert.equal(r.selected,2);assert.equal(r.processed,1);assert.equal(r.sent,1);assert.equal(r.incomplete,1);assert.equal(r.remaining,0);
  assert.ok(!JSON.stringify(r).includes(secret));assert.equal(rows(h.ledger,'reminder_occurrences').length,1);assert.equal(h.telegram.requests.length,3);
});

test('private elapsed test clock cannot enter production mode or public Tick args',async t=>{
  assert.throws(()=>createNotificationService({configPath:'/never-open',tickMonotonicClock:()=>0}),{message:'notification_held'});
  const h=fixture(t);await h.enroll();h.fresh();const prior=rows(h.ledger,'pending_owner_requests'),reads=h.state.reads;
  const r=await h.make().tickReminders({tickMonotonicClock:()=>0} as any,h.context);assert.equal(r.state,'held');
  assert.deepEqual(rows(h.ledger,'pending_owner_requests'),prior);assert.equal(h.state.reads,reads);
});

test('whole Tick receipt keys/codes AND fixed payload preflight BEFORE native/claim/Telegram',async t=>{
  const sample=fixture(t);await sample.enroll();const good=await sample.make().tickReminders({},sample.fresh());
  const secrets=new Set([...Object.keys(good),'status','choice','bypass_reason','bypassed','completed','incomplete','inactive','held','tick_cancelled','tick_held','request_unknown','owner_evidence_unavailable','reminder','unanswered owner reminder']);
  for(const secret of secrets){const h=fixture(t);await h.enroll();h.fresh();const reads=h.state.reads,prior=JSON.stringify(rows(h.ledger,'pending_owner_requests'));
    let r;try{r=await h.make(h.provider,[secret]).tickReminders({},h.context);}catch(error){assert.equal((error as Error).message,'notification_held');}
    if(r){assert.equal(r.sent,0);assert.ok(!JSON.stringify(r).includes(secret));}
    assert.equal(h.state.reads,reads,secret);assert.equal(JSON.stringify(rows(h.ledger,'pending_owner_requests')),prior,secret);assert.equal(rows(h.ledger,'reminder_occurrences').length,0,secret);assert.equal(h.telegram.requests.length,1,secret);
  }
});
