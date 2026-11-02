// Preload for actual packaged CLI subprocesses only. No network, child or model fallback.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
const require=createRequire(import.meta.url),attempts=[],sqliteOpens=[],faultEvents=[];
const deny=name=>(..._args)=>{attempts.push(name);throw Error('offline_admin_effect');};
for(const [m,names] of [['node:child_process',['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']],['node:http',['request','get']],['node:https',['request','get']],['node:net',['connect','createConnection','createServer']],['node:tls',['connect','createServer']],['node:dgram',['createSocket']],['node:dns',['lookup','resolve','resolve4','resolve6']]]){const target=require(m);for(const n of names)target[n]=deny(m+'.'+n);}
require('node:net').Socket.prototype.connect=deny('socket');globalThis.fetch=deny('fetch');process.env.PATH='';
const fault=process.env.NOTIFY_ADMIN_TEST_FAULT,target=process.env.NOTIFY_ADMIN_TEST_TARGET;
const originalReadFileSync=fs.readFileSync,originalWriteFileSync=fs.writeFileSync;
let lockCreated=false,sidecarInjected=false,activeFencePublished=false,createdDatabaseFd=-1;
const activeFenceDirectoryFds=new Set();
const sqlite=require('node:sqlite'),NativeDatabaseSync=sqlite.DatabaseSync;
sqlite.DatabaseSync=new Proxy(NativeDatabaseSync,{construct(targetClass,args,newTarget){sqliteOpens.push({filename:String(args[0]),options:args[1]??null});return Reflect.construct(targetClass,args,newTarget);}});
const originalMkdirSync=fs.mkdirSync;
fs.mkdirSync=function(filename,...args){const result=originalMkdirSync.call(this,filename,...args);if(target&&String(filename)===target+'.cutover-v2.lock'){lockCreated=true;faultEvents.push({stage:'exclusive_admin_lock_created'});}return result;};
const originalOpenSync=fs.openSync;
fs.openSync=function(filename,...args){const fd=originalOpenSync.call(this,filename,...args);if(fault==='post-db-create'&&target&&String(filename)===target&&typeof args[0]==='number'&&(args[0]&fs.constants.O_CREAT)!==0&&(args[0]&fs.constants.O_EXCL)!==0){createdDatabaseFd=fd;faultEvents.push({stage:'exclusive_main_db_created',size:fs.fstatSync(fd).size});}if(fault==='post-active-fence-publication'&&activeFencePublished&&target&&String(filename)===path.dirname(target))activeFenceDirectoryFds.add(fd);return fd;};
const originalRenameSync=fs.renameSync;
fs.renameSync=function(from,to){const result=originalRenameSync.call(this,from,to);if(fault==='post-active-fence-publication'&&target&&String(to)===target+'.cutover-v2.json'){const state=JSON.parse(originalReadFileSync.call(fs,String(to),'utf8')).state;if(state==='active'){activeFencePublished=true;faultEvents.push({stage:'active_fence_published',state});}}return result;};
const originalFsyncSync=fs.fsyncSync;
fs.fsyncSync=function(fd){
  if(lockCreated&&fs.fstatSync(fd).isDirectory()){
    if(fault?.startsWith('introduce-')&&!sidecarInjected){const suffix=fault.slice('introduce'.length);const bytes=Buffer.from('synthetic sidecar introduced after CLI preflight: '+suffix);originalWriteFileSync.call(fs,target+suffix,bytes,{flag:'wx',mode:0o600});sidecarInjected=true;faultEvents.push({stage:'sidecar_injected_after_cli_preflight_before_locked_guard',suffix,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});}
    if(fault==='fsync'){faultEvents.push({stage:'initial_admin_lock_parent_directory_sync'});throw Error('synthetic-fsync-fault');}
  }
  if(fault==='post-db-create'&&fd===createdDatabaseFd){faultEvents.push({stage:'after_exclusive_main_db_creation_before_file_sync',size:fs.fstatSync(fd).size});throw Error('synthetic-post-db-create-fault');}
  if(fault==='post-active-fence-publication'&&activeFenceDirectoryFds.has(fd)){faultEvents.push({stage:'after_active_fence_publication_before_parent_sync'});throw Error('synthetic-post-active-fence-publication-fault');}
  return originalFsyncSync.call(this,fd);
};
if(process.env.NOTIFY_ADMIN_TEST_FAULT==='owner'){const original=fs.lstatSync;fs.lstatSync=function(...a){const result=original.apply(this,a);return new Proxy(result,{get(t,p){return p==='uid'?process.getuid()+1:Reflect.get(t,p);}});};}
syncBuiltinESMExports();
process.on('exit',()=>{fs.writeFileSync(process.env.NOTIFY_ADMIN_REPORT,JSON.stringify({attempts,sqliteOpens,faultEvents}));if(attempts.length)process.exitCode=1;});
