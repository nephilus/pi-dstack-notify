import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import type {TestContext} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {digest} from '../../core/safety.ts';import {adoptOpaqueHistoryV3} from '../../core/migration.ts';
import {legacyDestination,legacyPairCommitment} from '../../core/adoption.ts';
import {createMinimalNotificationExtension} from '../../minimal.ts';import {SEND,READ} from '../../adapter/schema.ts';
import {builtinMcpResult} from '../adapter/native-result.ts';
/** Production admission with synthetic credentials and CLOSED native fixtures.
 * Deliberate READ refusal stops BEFORE Telegram; no production transport bypass. */
export function adoptionFixture(t:TestContext,text='One genuinely new setup acceptance event.'){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'adoption-entry-')));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const write=(name:string,s:string)=>{const f=path.join(dir,name);fs.writeFileSync(f,s,{mode:0o600});return f;};
 const token='123456789:synthetic_credential_material',chat='987654321',env=write('material.env',`TELEGRAM_BOT_TOKEN=${token}\nTELEGRAM_CHAT_ID=${chat}\n`);
 const legacy=write('legacy.json',JSON.stringify({version:1,requests:{[digest(legacyDestination(token,chat)+'\0old/exact')]:{at:1,message_id:1}}}));
 const ledger=path.join(dir,'ledger.sqlite'),profile=path.join(dir,'profile.toml'),session='synthetic-session',base='https://inbox.example.invalid/';
 const args={text,decision_key:'setup/new',revision:'a'.repeat(64)};
 const spec=write('operator.json',JSON.stringify({version:1,origin:'owner-current-one-new-setup-acceptance',current_request:'synthetic explicit current setup request',selected_source_commit:'b'.repeat(40),env_path:env,env_sha256:digest(fs.readFileSync(env)),pair_sha256:legacyPairCommitment(token,chat),legacy_path:legacy,legacy_sha256:digest(fs.readFileSync(legacy)),profile_path:profile,profile_id:'primary',destination_id:'owner',intent:{...args,project_root:dir,session_id:session,inbox_base_url:base}}));
 adoptOpaqueHistoryV3(ledger,spec,{dispatchDisabled:true,allOldWritersQuiesced:true,walConsistentBackupVerified:true});
 const config=write('config.json',JSON.stringify({version:1,enabled:true,projects:[{project_path:dir,enabled:true,profile_path:profile,ledger_path:ledger,policy:'notification_product',inbox_base_url:base}]}));
 const tools=new Map<string,any>(),events=new Map<string,any>(),dispatches:string[]=[];
 const state:{sendHook?:()=>void|Promise<void>}={};
 const ctx={cwd:dir,sessionManager:{getCwd:()=>dir,getSessionId:()=>session},isIdle:()=>true,hasPendingMessages:()=>false,tools:[{name:SEND},{name:READ}],async executeTool(name:string,_args:unknown){
  dispatches.push(name);if(name===READ)throw Error('closed synthetic full READ refusal; never reach Telegram');
  await state.sendHook?.();
  const native=JSON.parse(fs.readFileSync(new URL('../../fixtures/inbox-native.json',import.meta.url),'utf8')).send;
  native.structuredContent.project.root=dir;
  return {isError:false,result:builtinMcpResult(native)};
 }};
 createMinimalNotificationExtension()({registerFlag(){},getFlag:()=>config,on(name:string,handler:any){events.set(name,handler);},registerTool(tool:any){tools.set(tool.name,tool);}} as any);
 t.after(async()=>{await events.get('session_shutdown')?.({},ctx);});
 const invoke=(value:unknown=args,controller=new AbortController())=>tools.get('notification_publish').execute('synthetic-adoption',value,controller.signal,undefined,ctx);
 const rows=(table:string)=>{const db=new DatabaseSync(ledger,{readOnly:true});try{return db.prepare('SELECT * FROM '+table).all() as any[];}finally{db.close();}};
 return {dir,args,tools,events,ctx,invoke,rows,dispatches,state,ledger,profile,env,legacy,config,token,chat};
}
