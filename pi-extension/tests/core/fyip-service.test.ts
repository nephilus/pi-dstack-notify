import "./offline-guard.mjs";
import { attempts } from "./offline-guard.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createNotificationService } from "../../core/service.ts";
import { createTestTelegramHttpClient } from "../../core/transport.ts";
import type { TestTelegramOutcome } from "../../core/transport.ts";
import { initializeLedgerV2, initializeLedgerV3 } from "../../core/migration.ts";
import { createTestClefHttpClient, waitForTestClefRequest, completeLateTestClef, loadClefConfiguration, clefPayload, CLEF_QUESTION_SHA256, testClefResponseBytes } from "../../core/clef.ts";
import type { TestClefOutcome } from "../../core/clef.ts";
import { createTestOwnerEvidenceProvider } from "../../core/owner-evidence.ts";
import { admitFYIPCandidate } from "../../core/fyip.ts";
import { DeliveryLedger } from "../../core/ledger.ts";
import { digest, strictJson } from "../../core/safety.ts";
import { validateClefChoice } from "../../core/clef-choice.ts";
import type { PublicationContext, DeliveryIdentity, PublishArguments, PublishFYIPArguments } from "../../core/types.ts";
const nativeFixture = JSON.parse(fs.readFileSync(new URL('../../fixtures/inbox-native.json', import.meta.url), 'utf8'));
const profileFixture = fs.readFileSync(new URL('../../fixtures/shared-profile.toml', import.meta.url), 'utf8');
const revision = 'a'.repeat(64);
function write(filename: string, text: string): void { fs.writeFileSync(filename, text, { mode: 0o600 }); fs.chmodSync(filename, 0o600); }
const cutover = { dispatchDisabled: true, allOldWritersQuiesced: true, walConsistentBackupVerified: true } as const;
function deliveryCount(filename: string): number {
  if (!fs.existsSync(filename)) return 0;
  const db = new DatabaseSync(filename);
  try { return Number((db.prepare('SELECT COUNT(*) AS n FROM deliveries').get() as any).n); } finally { db.close(); }
}
function fixture(t: any, choice: TestClefOutcome = 'yes', outcome: TestTelegramOutcome = 'echo', provision = true) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notification-ts-core-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project'); fs.mkdirSync(root, { mode: 0o700 });
  const profile = path.join(directory, 'profile.toml'), configPath = path.join(directory, 'config.json');
  const ledger = path.join(directory, 'delivery.sqlite'); write(profile, profileFixture);
  const config = { version: 1, enabled: true, projects: [{ project_path: root, enabled: true,
    profile_path: profile, ledger_path: ledger, policy: 'notification_product', inbox_base_url: 'https://inbox.example.invalid/' }] };
  const save = () => write(configPath, JSON.stringify(config)); save();
  const telegramTransport = createTestTelegramHttpClient({ outcome });
  if (provision) initializeLedgerV3(ledger, { ...cutover, noPriorHistory: true });
  const clef = createTestClefHttpClient({outcome:choice});
  const makeService = () => createNotificationService({ configPath, telegramHttpClient: telegramTransport,
    clefHttpClient:clef, knownSecrets: ['synthetic-credential'] });
  let service = makeService();
  const host = { session_id: 'synthetic-session', project_path: root };
  const state = { sends: 0, reads: 0, checks: 0, body: '', hook: undefined as undefined | ((name: string) => void),
    mutate: undefined as undefined | ((name: string, value: any) => void) };
  const controller = new AbortController();
  const identity = (key = 'owner/repo:decision', rev = revision, fake = true): DeliveryIdentity => ({
    profile_id: (fake ? 'test-only.' : '') + 'primary', destination_id: (fake ? 'test-only.' : '') + 'owner',
    decision_key: key, event_revision: rev, purpose: 'explicit_attention' });
  const argument = (key = 'owner/repo:decision', rev = revision): PublishArguments => ({ text: 'A decision needs attention.', decision_key: key, revision: rev });
  function native(which: 'send' | 'read'): any {
    const result = structuredClone(nativeFixture[which]);
    const mid = 'msg_' + String(state.sends).padStart(26, '0');
    const data = result.structuredContent;
    data.url = config.projects[0].inbox_base_url + '#thread=' + mid;
    if (which === 'send') {
      data.message_id = data.thread_id = mid; data.project.root = host.project_path;
    } else {
      data.thread.thread_id = mid; data.thread.project.root = host.project_path;
      const message = data.thread.messages[0]; message.id = message.thread_id = mid;
      message.author.session = host.session_id; message.body = state.body;
    }
    state.mutate?.(which, result); return result;
  }
  const context: PublicationContext = {
    operationId: 'op.1', observed: { ...host }, signal: controller.signal,
    async hostCheck() { state.checks++; state.hook?.('host'); return { ...host }; },
    async inboxSend({ body }) { state.sends++; state.body = body; state.hook?.('send'); return native('send'); },
    async inboxRead() { state.reads++; state.hook?.('read'); return native('read'); },
  };
  return { directory, root, profile, configPath, ledger, config, save, telegramTransport, makeService,
    host, state, controller, context, identity, argument, native, clef,
    get service() { return service; }, restart() { service = makeService(); } };
}
after(() => { assert.deepEqual(attempts,[]); assert.equal(process.env.PATH,'/nonexistent-notification-test-path'); });
const candidate = { kind:'milestone', title:'Requested capability available', previous_state:'Capability not available',
  current_state:'Requested capability is usable now', materiality:'Owner can use the requested capability',
  evidence:[{kind:'milestone',detail:'Observed requested capability in the completed service'}], reconciled:true } as const;
const fyipArgs = (key = 'fyip/update'): PublishFYIPArguments => ({decision_key:key,revision,candidate:structuredClone(candidate)});
function rows(file: string, table: string): any[] {
  const db = new DatabaseSync(file); try { return db.prepare('SELECT * FROM ' + table).all(); } finally { db.close(); }
}
test('FYIP yes uses SAME canonical readback/ledger/Telegram pipeline with honest leading classification',async t => {
  const h=fixture(t); const result=await h.service.publishFYIP(fyipArgs(),h.context);
  assert.equal(result.state,'sent'); assert.equal(result.classification.status,'classified_yes');
  assert.equal(result.delivery.receipt?.identity.purpose,'fyip');
  assert.equal(h.state.sends,1); assert.equal(h.state.reads,1); assert.equal(h.clef.requests.length,1);
  assert.match(h.telegramTransport.messages[0].text,/^FYIP · classified yes\nSource: Pi session/);
  assert.equal(rows(h.ledger,'canonical_associations')[0].read_verified,1);
  const decision=rows(h.ledger,'fyip_decisions')[0];
  const admitted=admitFYIPCandidate(candidate); assert.equal(admitted.admitted,true); if (!admitted.admitted) assert.fail();
  assert.equal(decision.candidate_sha256,digest(JSON.stringify(admitted.context)));
  assert.equal(decision.question_sha256,CLEF_QUESTION_SHA256); assert.equal(decision.choice,'yes');
  h.restart(); h.host.session_id='other-session'; h.context.observed={...h.host};
  const changed=fyipArgs(); changed.candidate={...candidate,title:'Changed asserted candidate'};
  changed.review_link={label:'Review this',url:'https://review.example.invalid/change'};
  assert.equal((await h.service.publishFYIP(changed,h.context)).state,'duplicate');
  assert.equal(h.clef.requests.length,1); assert.equal(h.state.sends,1);
  assert.equal(rows(h.ledger,'fyip_decisions')[0].candidate_sha256,decision.candidate_sha256);
});
for (const outcome of ['no','low-confidence-no'] as const) test('FYIP '+outcome+' is durable quiet suppression, never delivery success',async t => {
  const h=fixture(t,outcome); const first=await h.service.publishFYIP(fyipArgs(),h.context);
  assert.equal(first.state,'suppressed'); assert.equal(first.classification.status,'classified_no');
  assert.equal(h.state.sends,0); assert.equal(h.state.reads,0); assert.equal(deliveryCount(h.ledger),0);
  h.restart(); assert.equal((await h.service.publishFYIP(fyipArgs(),h.context)).state,'suppressed');
  assert.equal(h.clef.requests.length,1); assert.equal(rows(h.ledger,'fyip_decisions')[0].state,'decided');
});
for (const outcome of ['invalid','error','redirect','duplicate-json','nonfinite','invalid-utf8','oversized','deep-json'] as const)
  test('admitted live '+outcome+' freezes fallback and publishes once',async t => {
    const h=fixture(t,outcome); const result=await h.service.publishFYIP(fyipArgs(),h.context);
    assert.equal(result.state,'sent'); assert.match(result.classification.status,/^fallback_/);
    assert.match(h.telegramTransport.messages[0].text,/^FYIP · unclassified/);
    assert.equal(rows(h.ledger,'fyip_decisions')[0].classification_status,result.classification.status);
    h.restart(); assert.equal((await h.service.publishFYIP(fyipArgs(),h.context)).state,'duplicate');
    assert.equal(h.clef.requests.length,1); assert.equal(h.state.sends,1);
  });
test('admission FIRST rejects invalid/unreconciled/execution-only with no model, claims or native effects',async t => {
  const h=fixture(t);
  for (const bad of [null,{...candidate,reconciled:false},{...candidate,current_state:candidate.previous_state},
    {...candidate,evidence:[{kind:'milestone',detail:'python 文件.py'}]}]) {
    assert.equal((await h.service.publishFYIP({...fyipArgs(),candidate:bad as any},h.context)).state,'held');
  }
  assert.equal(h.clef.requests.length,0); assert.equal(rows(h.ledger,'fyip_decisions').length,0);
  assert.equal(deliveryCount(h.ledger),0); assert.equal(h.state.sends,0);
});
test('arbitrary Unicode admission/classification succeeds independently while publication holds',async t => {
  const h=fixture(t); const args=fyipArgs(); args.candidate={...candidate,title:'Διαθέσιμη δυνατότητα'};
  assert.equal(admitFYIPCandidate(args.candidate).admitted,true);
  const result=await h.service.publishFYIP(args,h.context);
  assert.equal(result.state,'held'); assert.equal(result.classification.status,'classified_yes');
  assert.equal(h.clef.requests.length,1); assert.equal(rows(h.ledger,'fyip_decisions')[0].choice,'yes');
  assert.equal(deliveryCount(h.ledger),0); assert.equal(h.state.sends,0);
});
test('cancelled classification is terminal-held across restart; late yes cannot fallback or publish',async t => {
  const h=fixture(t,'late'); const pending=h.service.publishFYIP(fyipArgs(),h.context);
  await waitForTestClefRequest(h.clef); h.controller.abort();
  assert.equal((await pending).state,'held'); completeLateTestClef(h.clef);
  assert.equal(rows(h.ledger,'fyip_decisions')[0].state,'terminal_unknown');
  h.context.signal=new AbortController().signal; h.restart();
  assert.equal((await h.service.publishFYIP(fyipArgs(),h.context)).state,'held');
  assert.equal(h.clef.requests.length,1); assert.equal(h.state.sends,0); assert.equal(deliveryCount(h.ledger),0);
});
test('concurrent independent services share atomic classifying claim, not parallel model requests',async t => {
  const h=fixture(t,'late'); const first=h.service.publishFYIP(fyipArgs(),h.context);
  await waitForTestClefRequest(h.clef);
  assert.equal((await h.makeService().publishFYIP(fyipArgs(),h.context)).state,'held');
  assert.equal(h.clef.requests.length,1); completeLateTestClef(h.clef);
  assert.equal((await first).state,'sent'); assert.equal(h.state.sends,1);
});
test('interrupted classifying row never becomes NO or automatic reclassification',async t => {
  const h=fixture(t); const id={...h.identity('fyip/update'),purpose:'fyip'};
  const ledger=new DeliveryLedger(h.ledger,undefined,3);
  try { ledger.claimFYIP(id,{candidate_sha256:digest('candidate'),question_sha256:CLEF_QUESTION_SHA256,config_sha256:digest('config')}); }
  finally { ledger.close(); }
  h.restart(); assert.equal((await h.service.publishFYIP(fyipArgs(),h.context)).state,'held');
  assert.equal(h.clef.requests.length,0); assert.equal(h.state.sends,0);
  assert.equal(rows(h.ledger,'fyip_decisions')[0].state,'classifying');
});
test('model payload is frozen QUESTION and curated-only mapping, not review/session/history',async t => {
  const h=fixture(t); await h.service.publishFYIP({...fyipArgs(),review_link:{label:'Review',url:'https://review.example.invalid/'}},h.context);
  const question=JSON.parse(fs.readFileSync(new URL('../../fixtures/clef-question.json',import.meta.url),'utf8'));
  const sent=h.clef.requests[0] as any;
  assert.deepEqual(sent.questions.publish,question);
  const mapping=JSON.parse(fs.readFileSync(new URL('../../fixtures/clef-curated-mapping.json',import.meta.url),'utf8'));
  assert.deepEqual(candidate,mapping.candidate);assert.deepEqual(sent.state,mapping.state);
  const admitted=admitFYIPCandidate(candidate); if (!admitted.admitted) assert.fail();
  assert.deepEqual(sent,clefPayload(admitted.context,'test-clef'));
  assert.equal(sent.state.current_public_final,sent.state.candidate_text);
  assert.equal(sent.state.previous_public_final,candidate.previous_state);
  assert.equal(sent.state.last_published_update,null); assert.equal(sent.state.attention_state,'unknown');
  assert.ok(!JSON.stringify(sent).includes('review.example')); assert.ok(!JSON.stringify(sent).includes(h.host.session_id));
});
test('closed fake construction rejects mixed dependencies BEFORE configuration or ledger lookup',t => {
  const fake=createTestClefHttpClient({outcome:'no'}), owner=createTestOwnerEvidenceProvider();
  const configPath='/definitely-missing-notification-config.json';
  for (const options of [{configPath,clefHttpClient:fake},{configPath,ownerEvidenceProvider:owner},
    {configPath,clefHttpClient:{} as any},{configPath,telegramHttpClient:createTestTelegramHttpClient(),clefConfigPath:'/private/model.json'},
    {configPath,telegramHttpClient:createTestTelegramHttpClient(),clefHttpClient:fake,clefConfigPath:'/private/model.json'}]) {
    assert.throws(()=>createNotificationService(options),/notification_held/);
  }
});
test('fake NO cannot suppress production FYIP history; production uses exact configured IDs',async t=>{
  const h=fixture(t,'no');assert.equal((await h.service.publishFYIP(fyipArgs(),h.context)).state,'suppressed');
  const production=createNotificationService({configPath:h.configPath});
  // Fail canonical read before Telegram: this probes real-mode identity/decision
  // isolation without permitting ANY production classifier or Telegram request.
  h.state.mutate=(which,result)=>{if(which==='read')result.structuredContent.thread.messages[0].body+=' mismatch';};
  assert.equal((await production.publishFYIP(fyipArgs(),h.context)).state,'unknown');
  const decisions=rows(h.ledger,'fyip_decisions');assert.equal(decisions.length,2);
  assert.equal(decisions.find(row=>row.profile_id==='primary').classification_status,'fallback_unavailable');
  assert.equal(decisions.find(row=>row.profile_id==='test-only.primary').classification_status,'classified_no');
  const deliveries=rows(h.ledger,'deliveries');assert.equal(deliveries.length,1);
  assert.equal(deliveries[0].profile_id,'primary');assert.equal(deliveries[0].destination_id,'owner');
  assert.equal(h.telegramTransport.messages.length,0);assert.equal(h.clef.requests.length,1);
});
test('missing configured ledger is never created by FYIP fallback',async t => {
  const h=fixture(t,'yes','echo',false);
  assert.equal((await h.service.publishFYIP(fyipArgs(),h.context)).state,'held');
  assert.equal(fs.existsSync(h.ledger),false); assert.equal(h.clef.requests.length,0); assert.equal(h.state.sends,0);
});
test('unsafe classifier payload and fixed/receipt metadata collisions hold before model/claims',async t => {
  for (const secret of ['classified_yes','FYIP','unknown','current_public_final','included by curated baseline','Source: Pi session','identity_binding']) {
    const h=fixture(t);
    const service=createNotificationService({configPath:h.configPath,telegramHttpClient:h.telegramTransport,clefHttpClient:h.clef,knownSecrets:[secret]});
    const result=await service.publishFYIP(fyipArgs(),h.context);
    assert.equal(result.state,'held'); assert.ok(!JSON.stringify(result).includes(secret));
    assert.equal(h.clef.requests.length,0); assert.equal(rows(h.ledger,'fyip_decisions').length,0); assert.equal(h.state.sends,0);
  }
  for (const secret of ['live','classification','status']) {
    const h=fixture(t);const service=createNotificationService({configPath:h.configPath,telegramHttpClient:h.telegramTransport,clefHttpClient:h.clef,knownSecrets:[secret]});
    await assert.rejects(service.publishFYIP(fyipArgs(),h.context),{message:'notification_held'});
    assert.equal(h.clef.requests.length,0);assert.equal(rows(h.ledger,'fyip_decisions').length,0);assert.equal(h.state.sends,0);
  }
  const h=fixture(t); const args=fyipArgs(); args.candidate={...candidate,current_state:'Now available data:image png'};
  assert.equal(admitFYIPCandidate(args.candidate).admitted,true);
  assert.equal((await h.service.publishFYIP(args,h.context)).state,'held');
  assert.equal(h.clef.requests.length,0); assert.equal(rows(h.ledger,'fyip_decisions').length,0);
});
test('readback mismatch and uncertain Telegram remain terminal under frozen YES across restart',async t => {
  for (const failure of ['read','telegram']) {
    const h=fixture(t,'yes',failure==='telegram'?'wrong-text':'echo');
    if (failure==='read') h.state.mutate=(which,result)=>{if(which==='read') result.structuredContent.thread.messages[0].body+=' changed';};
    assert.equal((await h.service.publishFYIP(fyipArgs(),h.context)).state,'unknown');
    h.restart(); assert.equal((await h.service.publishFYIP(fyipArgs(),h.context)).state,'unknown');
    assert.equal(h.clef.requests.length,1); assert.equal(h.state.sends,1);
  }
});
test('service planning port with actual unsupported owner is held zero due, never a model/native wake',t => {
  const h=fixture(t); const plan=h.service.planReminders({observed:h.host});
  assert.equal(plan.status,'held'); assert.equal(plan.reason,'owner_evidence_unavailable'); assert.equal(plan.due_count,0);
  assert.equal(h.clef.requests.length,0); assert.equal(h.state.sends,0); assert.equal(rows(h.ledger,'fyip_decisions').length,0);
});
test('private Clef config is strict, bounded, explicit origin/key/model and no read at construction',t => {
  const h=fixture(t); const keyFile=path.join(h.directory,'clef.key'), config=path.join(h.directory,'clef.json');
  write(keyFile,'synthetic-model-private-key');
  const value={version:1,base_url:'https://clef.example.invalid',key_file:keyFile,model:'test/model',expected_model:'test/model',timeout_seconds:5};
  write(config,JSON.stringify(value)); const loaded=loadClefConfiguration(config)!;
  assert.equal(loaded.origin,value.base_url); assert.equal(loaded.timeout_ms,5000); assert.equal(loaded.key,'synthetic-model-private-key');
  for (const extra of [{...value,timeout_seconds:5.1},{...value,timeout_seconds:0},{...value,selector:'public'},
    ...['https://user@clef.example.invalid','http://clef.example.invalid','https://clef.example.invalid/path','https://clef.example.invalid?x','https://clef.example.invalid#x'].map(base_url=>({...value,base_url}))]) {
    write(config,JSON.stringify(extra)); assert.throws(()=>loadClefConfiguration(config));
  }
  assert.doesNotThrow(()=>createNotificationService({clefConfigPath:'/not-opened-on-construction'}));
});
test('missing Clef is admitted durable fallback, not disabled product publication',async t=>{
  const h=fixture(t);
  const service=createNotificationService({configPath:h.configPath,telegramHttpClient:h.telegramTransport});
  const result=await service.publishFYIP(fyipArgs(),h.context);
  assert.equal(result.state,'sent');assert.equal(result.classification.status,'fallback_unavailable');
  assert.equal(rows(h.ledger,'fyip_decisions')[0].classification_status,'fallback_unavailable');
  assert.equal(h.clef.requests.length,0);assert.equal(h.state.sends,1);
});
test('changed candidate evidence never resets a decision or borrows a frozen YES for a new effect',async t=>{
  const h=fixture(t);const first=fyipArgs();first.candidate={...candidate,title:'Διαθέσιμη δυνατότητα'};
  assert.equal((await h.service.publishFYIP(first,h.context)).state,'held');
  assert.equal(rows(h.ledger,'fyip_decisions')[0].choice,'yes');
  h.restart();const result=await h.service.publishFYIP(fyipArgs(),h.context);
  assert.equal(result.state,'held');assert.equal(result.admission.reason,'candidate_evidence_changed');
  assert.equal(h.clef.requests.length,1);assert.equal(deliveryCount(h.ledger),0);assert.equal(h.state.sends,0);
});
test('total classifier deadline freezes live fallback once and discards later success',async t=>{
  const h=fixture(t,'late'); const result=await h.service.publishFYIP(fyipArgs(),h.context);
  assert.equal(result.state,'sent');assert.equal(result.classification.status,'fallback_error');
  completeLateTestClef(h.clef);h.restart();
  assert.equal((await h.service.publishFYIP(fyipArgs(),h.context)).state,'duplicate');
  assert.equal(h.clef.requests.length,1);assert.equal(h.state.sends,1);
});
test('configuration/host drift during classification cannot freeze fallback or cause later publication',async t=>{
  const h=fixture(t,'late');const pending=h.service.publishFYIP(fyipArgs(),h.context);
  await waitForTestClefRequest(h.clef);h.config.projects[0].enabled=false;h.save();completeLateTestClef(h.clef);
  assert.equal((await pending).state,'held');assert.equal(rows(h.ledger,'fyip_decisions')[0].state,'terminal_unknown');
  assert.equal(h.state.sends,0);assert.equal(deliveryCount(h.ledger),0);
  const next=fixture(t);next.state.hook=which=>{if(which==='host'){next.config.projects[0].enabled=false;next.save();}};
  assert.equal((await next.service.publishFYIP(fyipArgs(),next.context)).state,'held');
  assert.equal(next.clef.requests.length,0);assert.equal(rows(next.ledger,'fyip_decisions').length,0);
});
test('product FYIP does not upgrade a v2 ledger or alter attention-compatible claims',async t=>{
  const h=fixture(t,'yes','echo',false);
  initializeLedgerV2(h.ledger,{...cutover,noPriorHistory:true});
  const before=fs.readFileSync(h.ledger),fence=fs.readFileSync(h.ledger+'.cutover-v2.json');
  assert.equal((await h.service.publishFYIP(fyipArgs(),h.context)).state,'held');
  assert.equal(h.clef.requests.length,0);assert.equal(h.state.sends,0);
  assert.deepEqual(fs.readFileSync(h.ledger),before);assert.deepEqual(fs.readFileSync(h.ledger+'.cutover-v2.json'),fence);
});

test('already-read invalid private profile credential cannot escape any held receipt',async t=>{
  for(const fyip of [false,true]){
    const h=fixture(t);const secret='configured_admission_held';
    write(h.profile,profileFixture.replace(/telegram_bot_token = .*/,`telegram_bot_token = "${secret}"`));
    const result=fyip?await h.service.publishFYIP(fyipArgs(),h.context):await h.service.publish(h.argument(),h.context);
    assert.equal(result.state,'held');assert.ok(!JSON.stringify(result).includes(secret));
    assert.equal(h.clef.requests.length,0);assert.equal(h.state.sends,0);assert.equal(h.state.reads,0);
    assert.equal(h.telegramTransport.requests.length,0);assert.equal(deliveryCount(h.ledger),0);
    assert.equal(rows(h.ledger,'fyip_decisions').length,0);
    if(fyip){assert.equal(result.classification.status,'not_run');assert.notEqual(result.classification.bypass_reason,'explicit_attention');}
  }
});

test('unadmitted FYIP secret redaction preserves not_run or opaque provenance, never attention bypass',async t=>{
  for(const knownSecrets of [['candidate_not_admitted'],['candidate_not_admitted','not_run','receipt_protected']]){
    const h=fixture(t);const service=createNotificationService({configPath:h.configPath,telegramHttpClient:h.telegramTransport,
      clefHttpClient:h.clef,knownSecrets});
    const result=await service.publishFYIP({...fyipArgs(),candidate:null as any},h.context);
    assert.equal(result.state,'held');for(const secret of knownSecrets)assert.ok(!JSON.stringify(result).includes(secret));
    assert.equal(result.classification.status,knownSecrets.length===1?'not_run':'');
    assert.notEqual(result.classification.bypass_reason,'explicit_attention');assert.notEqual(result.classification.status,'bypassed');
    assert.equal(h.clef.requests.length,0);assert.equal(h.state.sends,0);assert.equal(h.telegramTransport.requests.length,0);
    assert.equal(deliveryCount(h.ledger),0);assert.equal(rows(h.ledger,'fyip_decisions').length,0);
  }
});

for(const outcome of ['max-size','oversized','valid-utf8','invalid-utf8'] as const)
  test('isolated Clef '+outcome+' keeps an otherwise valid Choice including ignored metadata',async t=>{
    const h=fixture(t,outcome);const result=await h.service.publishFYIP(fyipArgs(),h.context);
    assert.equal(result.state,'sent');
    assert.equal(result.classification.status,outcome==='oversized'?'fallback_uncertain':outcome==='invalid-utf8'?'fallback_invalid':'classified_yes');
    const [bytes]=testClefResponseBytes(h.clef);assert.ok(bytes);
    // Counterfactuals use the ACTUAL canned response sent through service HTTP
    // parsing. Removing only the byte/fatal-UTF8 gate leaves a strict valid Choice.
    if(outcome==='max-size'||outcome==='oversized'){
      assert.equal(bytes.byteLength,outcome==='max-size'?262144:262145);
      const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      const parsed=strictJson(text);assert.equal(validateClefChoice(parsed,'test-clef').choice,'yes');
      assert.equal(typeof parsed.metadata,'string');assert.ok(parsed.metadata.length>260000);
    }else{
      const permissive=new TextDecoder('utf-8').decode(bytes),parsed=strictJson(permissive);
      assert.equal(validateClefChoice(parsed,'test-clef').choice,'yes');assert.equal(typeof parsed.metadata,'string');
      if(outcome==='invalid-utf8'){
        assert.ok(permissive.includes('"metadata":"�"'));assert.throws(()=>new TextDecoder('utf-8',{fatal:true}).decode(bytes));
      }else{assert.equal(parsed.metadata,'Café 日本語');assert.doesNotThrow(()=>new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
    }
    assert.equal(h.clef.requests.length,1);assert.equal(h.state.sends,1);assert.equal(h.telegramTransport.requests.length,1);
  });

for(const field of ['session_id','project_path'] as const)test('pending model response plus ACTUAL host '+field+' drift holds with no fallback/publication',async t=>{
  const h=fixture(t,'late');const pending=h.service.publishFYIP(fyipArgs(),h.context);
  await waitForTestClefRequest(h.clef);
  if(field==='session_id')h.host.session_id='new-actual-session';
  else{const root=path.join(h.directory,'other-project');fs.mkdirSync(root,{mode:0o700});h.host.project_path=root;}
  completeLateTestClef(h.clef);const result=await pending;
  assert.equal(result.state,'held');assert.equal(result.classification.status,'not_run');
  assert.equal(rows(h.ledger,'fyip_decisions')[0].state,'terminal_unknown');
  assert.equal(h.state.sends,0);assert.equal(h.state.reads,0);assert.equal(h.telegramTransport.requests.length,0);assert.equal(deliveryCount(h.ledger),0);
});

for(const loss of ['configuration','key'] as const)test('valid private Clef '+loss+' loss while classification claim awaits fresh host holds before model access',async t=>{
  const h=fixture(t),keyFile=path.join(h.directory,'clef.key'),clefConfigPath=path.join(h.directory,'clef.json');
  write(keyFile,'synthetic-private-clef-key');
  write(clefConfigPath,JSON.stringify({version:1,base_url:'https://clef.example.invalid',key_file:keyFile,
    model:'configured/model',expected_model:'configured/model',timeout_seconds:5}));
  assert.ok(loadClefConfiguration(clefConfigPath));
  const service=createNotificationService({configPath:h.configPath,clefConfigPath});
  let reach!:()=>void,release!:()=>void,checks=0;const reached=new Promise<void>(resolve=>{reach=resolve;});
  const gate=new Promise<void>(resolve=>{release=resolve;});
  h.context.hostCheck=async()=>{if(++checks===2){reach();await gate;}return {...h.host};};
  const pending=service.publishFYIP(fyipArgs(),h.context);await reached;
  assert.equal(rows(h.ledger,'fyip_decisions')[0].state,'classifying');
  const lost=loss==='key'?keyFile:clefConfigPath;fs.renameSync(lost,lost+'.lost');release();
  const result=await pending;assert.equal(result.state,'held');assert.equal(result.classification.status,'not_run');
  assert.equal(rows(h.ledger,'fyip_decisions')[0].state,'terminal_unknown');
  assert.equal(h.state.sends,0);assert.equal(h.state.reads,0);assert.equal(h.telegramTransport.requests.length,0);
  assert.equal(h.clef.requests.length,0);assert.equal(deliveryCount(h.ledger),0);
  // No mixed fake/production override is introduced to test this real private
  // origin. The operation expires at its pending pre-model host fence.
});

test('unsupported publication script ONLY in previous_state admits, classifies and publishes safe current fields',async t=>{
  const h=fixture(t);const args=fyipArgs();args.candidate={...candidate,previous_state:'Προηγούμενη κατάσταση'};
  assert.equal(admitFYIPCandidate(args.candidate).admitted,true);
  const result=await h.service.publishFYIP(args,h.context);
  assert.equal(result.state,'sent');assert.equal(result.classification.status,'classified_yes');
  assert.equal((h.clef.requests[0] as any).state.previous_public_final,args.candidate.previous_state);
  assert.ok(!h.state.body.includes(args.candidate.previous_state));assert.ok(!h.telegramTransport.messages[0].text.includes(args.candidate.previous_state));
  assert.equal(h.state.sends,1);assert.equal(h.state.reads,1);assert.equal(h.telegramTransport.requests.length,1);
});
