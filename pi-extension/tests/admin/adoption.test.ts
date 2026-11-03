import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {digest,strictJson} from '../../core/safety.ts';
import {parseLegacyEnv,legacyDestination,legacyPairCommitment,opaqueReceipts} from '../../core/adoption.ts';
import {DeliveryLedger} from '../../core/ledger.ts';
import {loadProfile,profileSecrets} from '../../core/profile.ts';
const entry=fileURLToPath(new URL('../../admin.ts',import.meta.url)),guard=fileURLToPath(new URL('./guard.mjs',import.meta.url));
const switches=['--dispatch-disabled','--all-old-writers-quiesced','--wal-consistent-backup-verified'];
const runs:unknown[]=[];
process.on('exit',()=>{if(process.env.NOTIFY_ADOPTION_REPORT)fs.writeFileSync(process.env.NOTIFY_ADOPTION_REPORT,JSON.stringify(runs,null,2));});
function fixture(t:any){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'notify-adoption-')));fs.chmodSync(dir,0o700);
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const write=(name:string,data:string|Buffer)=>{const f=path.join(dir,name);fs.writeFileSync(f,data,{mode:0o600});return f;};
 const token='123456789:synthetic_credential_material',chat='987654321',destination=legacyDestination(token,chat);
 const env=write('material.env',`TELEGRAM_BOT_TOKEN=${token}\r\nTELEGRAM_CHAT_ID=${chat}\r\n`);
 const oldKey=digest(destination+'\0old/exact');
 const oldBytes=Buffer.from(JSON.stringify({version:1,requests:{[oldKey]:{at:100,message_id:1},[digest('unattributed')]:{at:101,message_id:2}}})+'\n');
 const legacy=write('legacy.json',oldBytes),profile=path.join(dir,'profile.toml'),ledger=path.join(dir,'ledger.sqlite');
 const spec={version:1,origin:'owner-current-one-new-setup-acceptance',current_request:'synthetic current setup request',selected_source_commit:'b'.repeat(40),env_path:env,env_sha256:digest(fs.readFileSync(env)),pair_sha256:legacyPairCommitment(token,chat),legacy_path:legacy,legacy_sha256:digest(oldBytes),profile_path:profile,profile_id:'continued',destination_id:'same',intent:{text:'One genuinely new setup acceptance event.',decision_key:'setup/new',revision:'a'.repeat(64),project_root:dir,session_id:'synthetic-session',inbox_base_url:'https://inbox.example.invalid/'}};
 const specPath=write('operator.json',JSON.stringify(spec));let n=0;
 const save=()=>write('operator.json',JSON.stringify(spec));
 const cli=(extra:string[]=[],fault?:string)=>{const report=path.join(dir,'audit-'+(++n)+'.json');
  const args=['adopt-one-current-intent','--ledger',ledger,'--spec',specPath,...switches,...extra];
  const r=spawnSync(process.execPath,['--import',guard,entry,...args],{cwd:dir,env:{HOME:dir,PATH:'',TMPDIR:dir,PI_CODING_AGENT_DIR:dir,NOTIFY_ADMIN_REPORT:report,...(fault?{NOTIFY_ADMIN_TEST_FAULT:fault,NOTIFY_ADMIN_TEST_TARGET:ledger}:{})},encoding:'utf8',timeout:30000});
  assert.equal(r.error,undefined);const audit=JSON.parse(fs.readFileSync(report,'utf8'));assert.deepEqual(audit.attempts,[]);
  assert(![r.stdout,r.stderr].join('').includes(token));assert(![r.stdout,r.stderr].join('').includes(chat));
  runs.push({args,status:r.status,stdout:r.stdout,stderr:r.stderr,audit,fault});return Object.assign(r,{audit});};
 const id={profile_id:'continued',destination_id:'same',decision_key:spec.intent.decision_key,event_revision:spec.intent.revision,purpose:'explicit_attention'};
 const context=()=>({text:spec.intent.text,project_root:dir,session_id:spec.intent.session_id,inbox_base_url:spec.intent.inbox_base_url,profile_sha256:loadProfile(profile).fingerprint});
 return {dir,write,env,legacy,oldBytes,spec,specPath,save,profile,ledger,id,context,cli,token,chat};
}
test('literal configured ENV grammar: CRLF/universal newlines, order, no shell/env fallback',()=>{
 const good='TELEGRAM_BOT_TOKEN=123:synth\nTELEGRAM_CHAT_ID=456';
 assert.deepEqual(parseLegacyEnv(Buffer.from(good)),['123:synth','456']);
 assert.deepEqual(parseLegacyEnv(Buffer.from(good.replace(/\n/g,'\r'))),['123:synth','456']);
 for(const bad of [good+'\n\n',good+'\nTELEGRAM_CHAT_ID=456',good.replace('123:synth','"123:synth"'),good.replace('123:synth','${TOKEN}'),good.replace('TELEGRAM_BOT_TOKEN','export TELEGRAM_BOT_TOKEN'),good+'\n#comment',good.replace('456','-456'),good.replace('123:synth','123:synth '),'', 'TELEGRAM_CHAT_ID=456'])assert.throws(()=>parseLegacyEnv(Buffer.from(bad)));
 assert.throws(()=>parseLegacyEnv(Buffer.from([0xff])));
});
test('literal ENV parser rejects initial UTF8 BOM bytes before shared decoding',()=>{
 const literal=Buffer.from('TELEGRAM_BOT_TOKEN=123:synth\nTELEGRAM_CHAT_ID=456\n');
 assert.deepEqual(parseLegacyEnv(literal),['123:synth','456']);
 const bom=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),literal]);
 assert.throws(()=>parseLegacyEnv(bom),/^Error: notification_held$/);
 assert.throws(()=>parseLegacyEnv(new Uint8Array(bom)),/^Error: notification_held$/);
});
test('actual shipped CLI rejects BOM-bearing ENV with matching byte/pair commitments before any output or SQLite',t=>{
 const h=fixture(t),literal=fs.readFileSync(h.env),bom=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),literal]);
 assert.deepEqual(parseLegacyEnv(literal),[h.token,h.chat]);
 fs.writeFileSync(h.env,bom);h.spec.env_sha256=digest(bom);h.save();
 const specBefore=fs.readFileSync(h.specPath);
 // These are VALID commitments to the malformed bytes and known synthetic pair:
 // refusal must reach the literal parser, not a stale expected-hash guard.
 assert.equal(digest(fs.readFileSync(h.env)),h.spec.env_sha256);
 assert.equal(legacyPairCommitment(h.token,h.chat),h.spec.pair_sha256);
 assert.equal(digest(fs.readFileSync(h.legacy)),h.spec.legacy_sha256);
 const r=h.cli();assert.equal(r.status,1);assert.equal(r.stdout,'');
 assert.deepEqual(JSON.parse(r.stderr.trim().split('\n').at(-1)!),{code:'ledger_cutover_ambiguous',retry:false,preserve_artifacts:true});
 assert(!r.stderr.includes(h.dir));assert.deepEqual(r.audit.sqliteOpens,[]);assert.deepEqual(r.audit.faultEvents,[]);
 for(const file of [h.profile,h.ledger,h.ledger+'.opaque-json-v1.archive',h.ledger+'.cutover-v2.json',h.ledger+'-journal',h.ledger+'-wal',h.ledger+'-shm'])assert.equal(fs.existsSync(file),false,file);
 assert.equal(fs.lstatSync(h.ledger+'.cutover-v2.lock').isDirectory(),true);
 assert.equal(fs.statSync(h.ledger+'.cutover-v2.lock').mode&0o777,0o700);
 assert.deepEqual(fs.readFileSync(h.env),bom);assert.deepEqual(fs.readFileSync(h.legacy),h.oldBytes);assert.deepEqual(fs.readFileSync(h.specPath),specBefore);
 assert.deepEqual(fs.readdirSync(h.dir).sort(),['audit-1.json','ledger.sqlite.cutover-v2.lock','legacy.json','material.env','operator.json'].sort());
});
test('opaque archive strict duplicate/malformed/UTF8/shape checks, no tuple invention',()=>{
 for(const bad of ['{"version":1,"version":1,"requests":{}}','{"version":1,"requests":[]}','{"version":1,"requests":{"x":{"at":1,"message_id":1}}}',JSON.stringify({version:1,requests:{['a'.repeat(64)]:{at:1,message_id:1,extra:true}}})])assert.throws(()=>opaqueReceipts(Buffer.from(bad)));
 assert.throws(()=>strictJson('{"x":1,"x":2}'));
});
test('actual adoption CLI reuses SAME material, exact archive; distinct truthful typed fence; one claim only, unknown never retried',t=>{
 const h=fixture(t),envBefore=fs.readFileSync(h.env),r=h.cli();assert.equal(r.status,0,r.stderr);assert.equal(r.audit.sqliteOpens.length,1);
 assert.deepEqual(fs.readFileSync(h.env),envBefore);assert.deepEqual(fs.readFileSync(h.legacy),h.oldBytes);assert.deepEqual(fs.readFileSync(h.ledger+'.opaque-json-v1.archive'),h.oldBytes);
 assert.deepEqual(profileSecrets(loadProfile(h.profile)),[h.token,h.chat]);
 const f=JSON.parse(fs.readFileSync(h.ledger+'.cutover-v2.json','utf8'));assert.equal(f.kind,'opaque-continuation');assert.equal(f.assertions.no_prior_history,false);
 assert.equal(f.original_count,0);assert.equal(f.adoption.opaque_receipt_count,2);assert.equal(f.adoption.legacy_unknown_attempts,'unavailable');assert.equal(f.adoption.legacy_volatile_cache,'unavailable');
 for(const name of [h.profile,h.ledger,h.ledger+'.opaque-json-v1.archive',h.ledger+'.cutover-v2.json'])assert.equal(fs.statSync(name).mode&0o777,0o600);
 const l=new DeliveryLedger(h.ledger,()=>200,3);try{
  const claim=l.claim(h.id,h.context());assert.equal(claim.action,'claimed');assert.equal(l.canonicalFor(h.id),null);
  l.unknown(h.id,claim.receipt.claim_id!);assert.equal(l.claim(h.id,h.context()).action,'held');assert.equal(l.inspect(h.id)?.state,'delivery_unknown');
 }finally{l.close();}
});
test('known exact legacy key guard survives new labels/revision/purpose; missing context and every changed intent fail specifically',t=>{
 const h=fixture(t);assert.equal(h.cli().status,0);const l=new DeliveryLedger(h.ledger,()=>200,3);try{
  for(const purpose of ['explicit_attention','fyip','owner_request'])assert.throws(()=>l.claim({...h.id,profile_id:'newlabel',destination_id:'renamed',decision_key:'old/exact',event_revision:'b'.repeat(40),purpose},h.context()),/continuation_legacy_exact_key/);
  assert.throws(()=>l.claim(h.id),/continuation_one_item_mismatch/);
  for(const changed of [{decision_key:'new/key'},{event_revision:'b'.repeat(64)},{purpose:'fyip'},{profile_id:'renamed'},{destination_id:'renamed'}])assert.throws(()=>l.claim({...h.id,...changed},h.context()),/continuation_one_item_mismatch/);
  for(const changed of [{text:'Changed payload'},{session_id:'other'},{project_root:path.dirname(h.dir)},{inbox_base_url:'https://elsewhere.example.invalid/'},{profile_sha256:'b'.repeat(64)},{review_link:{label:'Review',url:'https://review.example.invalid/'}}])assert.throws(()=>l.claim(h.id,{...h.context(),...changed}),/continuation_one_item_mismatch/);
  assert.throws(()=>l.claimFYIP({...h.id,purpose:'fyip'},{candidate_sha256:'a'.repeat(64),question_sha256:'a'.repeat(64),config_sha256:'a'.repeat(64)}),/continuation_one_item_mismatch/);
  assert.equal(l.inspect(h.id),null);const c=l.claim(h.id,h.context());l.associate(h.id,c.receipt.claim_id!,{authority:'https://inbox.example.invalid',message_id:'msg_'+'0'.repeat(26),thread_id:'msg_'+'0'.repeat(26),native_project_id:'synthetic',project_root:h.dir,session_id:'synthetic-session'},true);l.confirmed(h.id,c.receipt.claim_id!,55);assert.equal(l.claim(h.id,h.context()).action,'suppressed');
 }finally{l.close();}
});
test('operator origin/known old item is refused before database; no public novelty boolean',t=>{
 for(const change of ['origin','oldkey','boolean']){const h=fixture(t);if(change==='origin')h.spec.origin='a-new-key-is-new';if(change==='oldkey')h.spec.intent.decision_key='old/exact';if(change==='boolean')(h.spec as any).novel=true;h.save();const r=h.cli();assert.equal(r.status,1);assert.equal(r.audit.sqliteOpens.length,0);assert(!fs.existsSync(h.ledger));assert(fs.existsSync(h.ledger+'.cutover-v2.lock'));}
});
test('actual CLI strict grammar does not accept no-prior-history/fresh flags/duplicates',t=>{
 for(const extra of [['--no-prior-history'],['--spec','/not-used'],['--novel'],['--current-request','x']]){const h=fixture(t),r=h.cli(extra);assert.equal(r.status,2);assert.equal(r.audit.sqliteOpens.length,0);assert(!fs.existsSync(h.profile));}
});
test('private input guards: size/UTF8/duplicates/links/symlinks/UID/mode and hash drift never repaired',t=>{
 for(const kind of ['size','utf8','duplicate','hardlink','symlink','mode','hash','pair','owner']){const h=fixture(t);
  if(kind==='size')fs.writeFileSync(h.env,Buffer.alloc(65537));if(kind==='utf8')fs.writeFileSync(h.env,Buffer.from([255]));
  if(kind==='duplicate')fs.writeFileSync(h.specPath,fs.readFileSync(h.specPath,'utf8').replace('"version":1','"version":1,"version":1'));
  if(kind==='hardlink')fs.linkSync(h.env,path.join(h.dir,'alias'));if(kind==='symlink'){fs.renameSync(h.env,path.join(h.dir,'material-copy'));fs.symlinkSync(path.join(h.dir,'material-copy'),h.env);}
  if(kind==='pair'){h.spec.pair_sha256='b'.repeat(64);h.save();}
  if(kind==='mode')fs.chmodSync(h.env,0o644);if(kind==='hash')fs.appendFileSync(h.env,'\n');
  const r=h.cli([],kind==='owner'?'owner':undefined);assert.equal(r.status,1,kind);assert.equal(r.audit.sqliteOpens.length,0);assert(!fs.existsSync(h.ledger));
 }
});
test('source/archive/material/profile/operator drift blocks dispatch without resetting durable receipt',t=>{
 for(const target of ['source','archive','material','profile','operator']){const h=fixture(t);assert.equal(h.cli().status,0);const l=new DeliveryLedger(h.ledger,()=>200,3);const c=l.claim(h.id,h.context());l.unknown(h.id,c.receipt.claim_id!);
  const file={source:h.legacy,archive:h.ledger+'.opaque-json-v1.archive',material:h.env,profile:h.profile,operator:h.specPath}[target]!;fs.appendFileSync(file,' ');
  assert.throws(()=>l.claim(h.id,h.context()));assert.equal(l.inspect(h.id)?.state,'delivery_unknown');l.close();
 }
});
test('actual no-overwrite: preexisting DB/profile/archive/fence/lock and sidecars preserved, no SQLite',t=>{
 for(const suffix of ['','-journal','-wal','-shm','.opaque-json-v1.archive','.cutover-v2.json','.cutover-v2.lock','profile']){const h=fixture(t),file=suffix==='profile'?h.profile:h.ledger+suffix;fs.writeFileSync(file,'retained synthetic bytes',{mode:0o600});const r=h.cli();assert.equal(r.status,1,suffix);assert.equal(r.audit.sqliteOpens.length,0);assert.equal(fs.readFileSync(file,'utf8'),'retained synthetic bytes');}
});
test('actual sidecar injection INSIDE lock before SQLite; partial DB/fence/fsync faults retain artifacts and locks',t=>{
 for(const fault of ['introduce-journal','introduce-wal','introduce-shm','post-db-create','post-active-fence-publication','post-profile-create','post-archive-create','fsync']){const h=fixture(t),r=h.cli([],fault);assert.equal(r.status,1,fault);assert(fs.existsSync(h.ledger+'.cutover-v2.lock'));assert.equal(JSON.parse(r.stderr.trim().split('\n').at(-1)!).retry,false);
  if(fault.startsWith('introduce')||fault==='fsync')assert.equal(r.audit.sqliteOpens.length,0);
  if(fault==='post-profile-create'||fault==='post-archive-create'){assert(fs.existsSync(h.profile));assert.equal(r.audit.sqliteOpens.length,0);assert(!fs.existsSync(h.ledger));assert(r.audit.faultEvents.some((e:any)=>e.stage==='after_exclusive_adoption_artifact_creation_before_file_sync'));}
  if(fault==='post-db-create'){assert(fs.existsSync(h.profile));assert(fs.existsSync(h.ledger+'.opaque-json-v1.archive'));assert.equal(fs.statSync(h.ledger).size,0);assert.equal(r.audit.sqliteOpens.length,0);}
  if(fault==='post-active-fence-publication'){assert.equal(r.audit.sqliteOpens.length,1);assert.equal(JSON.parse(fs.readFileSync(h.ledger+'.cutover-v2.json','utf8')).state,'active');assert.throws(()=>new DeliveryLedger(h.ledger));}
  const before=fs.readFileSync(h.legacy);assert.equal(h.cli().status,1);assert.deepEqual(fs.readFileSync(h.legacy),before);
 }
});
