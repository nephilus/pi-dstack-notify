import { DeliveryLedger } from './ledger.ts';
import { readOwnerObservation } from './owner-observation.ts';
import { ownerObservationData } from './owner-control.ts';
import { testOwnerOutcome } from './owner-evidence.ts';
import { canonicalUTCSlot } from './reminder-time.ts';
import { canonicalDirectoryPath, loadConfiguration, selectProject } from './config.ts';
import { loadProfile, profileSecrets } from './profile.ts';
import { preflightAttentionBounds, renderAttention } from './policy.ts';
import { sendTelegram, validateTelegramCredentials } from './telegram.ts';
import type { TelegramMode } from './telegram.ts';
import { exact, held, protect, protectScalars, sessionPattern } from './safety.ts';
import type { DeliveryIdentity, NotificationServiceOptions, PublicationContext, ReminderTickReceipt } from './types.ts';

const REASONS=['busy','disabled','no_due_work','owner_evidence_unavailable','tick_held','request_unknown','tick_cancelled'] as const;
function receipt():ReminderTickReceipt {
  return {state:'held',classification:{status:'bypassed',choice:null,bypass_reason:'reminder'},utc_slot:null,
    selected:0,processed:0,incomplete:0,remaining:0,sent:0,duplicate:0,paused:0,snoozed:0,held:0};
}
class TickStop extends Error {}
/** Private same-service workflow. No scheduler, source-admin, public targets,
 * model calls or original Inbox publication. Native capability lives ONLY here. */
export async function runReminderTick(input:Record<string,never>,context:PublicationContext,
  options:NotificationServiceOptions,mode:TelegramMode,
  safeReceipt:(value:unknown,secrets:readonly string[],includeKeys?:boolean)=>void,
  busy=false):Promise<ReminderTickReceipt>{
  const result=receipt();let secrets:readonly string[]=options.knownSecrets??[];
  let ledger:DeliveryLedger|undefined,poisoned=false,adoptedSlot:string|undefined;
  const clock=options.clock??(()=>Date.now()/1000);
  const monotonicClock=options.tickMonotonicClock??(()=>performance.now());
  const finish=():ReminderTickReceipt=>{
    result.remaining=result.selected-result.processed-result.incomplete;
    if(result.incomplete||result.remaining)result.state='incomplete';
    try{safeReceipt(result,secrets,true);return result;}catch{
      // Preserve actual accounting even after prior effects. Only omit unsafe
      // presentation metadata; if the counts/shape cannot be safe, reject rather
      // than inventing an all-zero held receipt.
      const redacted={...result,utc_slot:null};delete redacted.reason;
      safeReceipt(redacted,secrets,true);return redacted;
    }
  };
  try{
    exact(input,[]);
    if(busy){result.reason='busy';return finish();}
    if(!context||typeof context.operationId!=='string'||!/^[A-Za-z0-9._-]{1,80}$(?![\s\S])/.test(context.operationId)
      ||!(context.signal instanceof AbortSignal)||context.signal.aborted
      ||[context.hostCheck,context.inboxRead,context.inboxSend].some(value=>typeof value!=='function'))held();
    exact(context.observed,['session_id','project_path']);
    const observed={...context.observed};
    if(typeof observed.session_id!=='string'||!sessionPattern.test(observed.session_id))held();canonicalDirectoryPath(observed.project_path);
    result.utc_slot=canonicalUTCSlot(clock());
    const config=loadConfiguration(options.configPath);
    const configured=config.projects.find(p=>p.project_path===observed.project_path&&p.enabled);
    if(!config.enabled||!configured||configured.policy!=='notification_product'){
      result.state='inactive';result.reason='disabled';return finish();
    }
    const project=selectProject(config,observed.project_path),profile=loadProfile(project.profile_path);
    secrets=[...secrets,...profileSecrets(profile)];
    safeReceipt(result,secrets,true); // ACTUAL sampled slot, not a null placeholder
    const credentials=validateTelegramCredentials(profileSecrets(profile));
    const provider=options.ownerEvidenceProvider;
    if(!provider||testOwnerOutcome(provider).outcome==='unknown'){
      result.reason='owner_evidence_unavailable';return finish();
    }
    if(!mode.testOnly)held();
    const scope={profile_id:'test-only.'+profile.profile_id,destination_id:'test-only.'+profile.destination_id,project_root:observed.project_path};
    if(scope.profile_id.length>128||scope.destination_id.length>128)held();
    protect(Object.values(scope),secrets);protectScalars([observed,project.inbox_base_url],secrets);
    // Use the SAME complete receipt gate as publication. Derive every aggregate
    // key from its actual shape; preflight all bounded states/codes before DB or
    // native calls. Final assembled receipt is checked independently again.
    safeReceipt({...result,reason:REASONS[0]},secrets,true);
    protectScalars([...REASONS,'completed','incomplete','inactive','held','reminder'],secrets);
    let activeChild:AbortController|undefined;
    const stop=():never=>{poisoned=true;activeChild?.abort();throw new TickStop('notification_held');};
    let lastMonotonic=-Infinity,requestExpiresAt:number|undefined;
    const elapsed=():number=>{
      let at:number;try{at=monotonicClock();}catch{return stop();}
      if(!Number.isFinite(at)||at<0||at<lastMonotonic)stop();lastMonotonic=at;return at;
    };
    const budgetEnd=(at:number,budget:number):number=>{
      const end=at+budget;if(!Number.isFinite(end)||end<=at)stop();return end;
    };
    const checkElapsed=(awaitExpiresAt?:number):void=>{
      const at=elapsed();
      if(requestExpiresAt!==undefined&&at>=requestExpiresAt||awaitExpiresAt!==undefined&&at>=awaitExpiresAt)stop();
    };
    const database=<T>(operation:()=>T):T=>{
      try{guard();const value=operation();guard();return value;}catch{return stop();}
    };
    const guard=():void=>{
      if(poisoned||context.signal.aborted)stop();
      checkElapsed();
      try{
        ledger?.checkFence();
        const fresh=loadConfiguration(options.configPath),p=selectProject(fresh,observed.project_path);
        if(fresh.fingerprint!==config.fingerprint||loadProfile(p.profile_path).fingerprint!==profile.fingerprint)stop();
        if(adoptedSlot&&canonicalUTCSlot(clock())!==adoptedSlot)stop();
        checkElapsed();
      }catch{stop();}
    };
    ledger=new DeliveryLedger(project.ledger_path,clock,3,true);
    guard();const snapshot=ledger.ownerTickSnapshot(scope);result.selected=snapshot.length;result.remaining=snapshot.length;
    if(!snapshot.length){result.state='inactive';result.reason='no_due_work';return finish();}
    result.state='completed';
    for(const id of snapshot){
      let identity:DeliveryIdentity|undefined,claim:string|undefined;
      const child=new AbortController();activeChild=child;
      const abort=()=>{poisoned=true;child.abort();};
      context.signal.addEventListener('abort',abort,{once:true});if(context.signal.aborted)abort();
      let deadline:ReturnType<typeof setTimeout>|undefined;
      // Race ONLY for prompt controlled return. An abort poisons the entire Tick;
      // NEVER proceed to another request on a raced-but-unsettled native call.
      const bounded=<T>(start:()=>Promise<T>,milliseconds=2000):Promise<T>=>new Promise((resolve,reject)=>{
        let timer:ReturnType<typeof setTimeout>|undefined;
        const cleanup=()=>{if(timer)clearTimeout(timer);child.signal.removeEventListener('abort',cancel);};
        const cancel=()=>{cleanup();reject(new TickStop('notification_held'));};
        child.signal.addEventListener('abort',cancel,{once:true});
        if(child.signal.aborted){cancel();return;}
        const settle=(complete:()=>void,expiresAt:number):void=>{
          cleanup();
          try{guard();checkElapsed(expiresAt);if(child.signal.aborted)stop();complete();}catch(error){reject(error);}
        };
        let expiresAt:number|undefined;
        try{
          guard();expiresAt=budgetEnd(elapsed(),milliseconds);
          timer=setTimeout(abort,milliseconds);
          Promise.resolve(start()).then(value=>settle(()=>resolve(value),expiresAt!),
            error=>settle(()=>reject(error),expiresAt!));
        }catch(error){
          cleanup();try{checkElapsed(expiresAt);reject(error);}catch(expired){reject(expired);}
        }
      });
      try{
        requestExpiresAt=budgetEnd(elapsed(),20000);deadline=setTimeout(abort,20000);
        guard();const original=database(()=>ledger!.storedOwnerOriginal(id));if(!original)held();
        protectScalars(original,secrets);
        // Predictable complete rendered payload/provenance gates precede native
        // observation as well as occurrence claim. No second rendering engine.
        preflightAttentionBounds(project.inbox_base_url,original.target.session_id,id.event_revision,original.review_link,undefined,false,true);
        if(original.target.url!==project.inbox_base_url+'#thread='+original.target.thread_id)held();
        renderAttention(original.body,original.target,secrets,original.review_link,undefined,false,true);
        database(()=>ledger!.moveOwnerTick(id,scope));
        if(database(()=>ledger!.ownerReminderState(id))==='paused'){result.processed++;result.paused++;continue;}
        const requestContext:PublicationContext={operationId:context.operationId,observed,signal:child.signal,
          hostCheck:()=>bounded(async()=>{
            try{
              const fresh=await context.hostCheck();exact(fresh,['session_id','project_path']);
              if(typeof fresh.session_id!=='string'||typeof fresh.project_path!=='string'
                ||fresh.session_id!==observed.session_id||fresh.project_path!==observed.project_path)stop();return fresh;
            }catch{return stop();}
          }),
          inboxRead:(args)=>bounded(()=>context.inboxRead(args,{signal:child.signal})),
          inboxSend:async()=>held()};
        const observe=async()=>{
          const observation=await readOwnerObservation(original,provider,requestContext,secrets,guard);
          guard();if(child.signal.aborted)stop();
          database(()=>ledger!.applyOwnerObservation(id,observation)); // IMMEDIATE, before any later await/effect
          return observation;
        };
        const first=await observe();
        const status=database(()=>ledger!.ownerReminderState(id));
        if(status!=='active'){result.processed++;result[status==='paused'?'paused':'snoozed']++;continue;}
        if(ownerObservationData(first).status==='unknown'){result.incomplete++;result.held++;continue;}
        // Initial read rollover adopts only CURRENT slot, never a missed slot.
        const slot=canonicalUTCSlot(clock());
        try{safeReceipt({...result,utc_slot:slot},secrets,true);}catch{stop();}
        adoptedSlot??=slot;if(slot!==adoptedSlot)stop();result.utc_slot=slot;
        guard();const reservation=database(()=>ledger!.claimReminder(id,slot,first,context.operationId));
        if(reservation.action==='paused'||reservation.action==='snoozed'){
          result.processed++;result[reservation.action==='paused'?'paused':'snoozed']++;continue;
        }
        if(reservation.action==='duplicate'){result.processed++;result.duplicate++;continue;}
        if(reservation.action!=='claimed')held();
        const claimedIdentity=reservation.identity,claimedId=reservation.claim_id;
        identity=claimedIdentity;claim=claimedId;
        const final=await observe();
        // Fresh host gate AFTER controls have committed. Nothing async between
        // final local latch/guard and starting the shared Telegram sender.
        await requestContext.hostCheck();guard();
        const finalStatus=database(()=>ledger!.ownerReminderState(id));
        if(finalStatus!=='active'){
          database(()=>ledger!.unknown(claimedIdentity,claimedId));claim=undefined;result.processed++;result[finalStatus==='paused'?'paused':'snoozed']++;continue;
        }
        if(ownerObservationData(final).status==='unknown')held();
        const message=renderAttention(original.body,original.target,secrets,original.review_link,undefined,false,true);
        if(!database(()=>ledger!.startReminderSend(id,slot,claimedId,final)))held();
        guard();
        const messageId=await bounded(()=>sendTelegram(message,credentials,secrets,child.signal,mode),10000);
        guard();if(child.signal.aborted)stop();
        database(()=>ledger!.confirmed(claimedIdentity,claimedId,messageId));claim=undefined;result.processed++;result.sent++;
      }catch(error){
        if(identity&&claim){try{ledger.unknown(identity,claim);}catch{/* In-flight is terminal too. */}}
        result.incomplete++;result.held++;result.reason=poisoned||context.signal.aborted||error instanceof TickStop?'tick_cancelled':'request_unknown';
        if(poisoned||context.signal.aborted||error instanceof TickStop)break;
      }finally{if(deadline)clearTimeout(deadline);context.signal.removeEventListener('abort',abort);activeChild=undefined;requestExpiresAt=undefined;}
    }
    return finish();
  }catch{
    result.reason='tick_held';return finish();
  }finally{try{ledger?.close();}catch{/* No filesystem/SQL detail reflected. */}}
}
