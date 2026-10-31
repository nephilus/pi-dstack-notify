import { isTestOwnerEvidenceProvider, testOwnerOutcome } from './owner-evidence.ts';
import type { TestOwnerEvidenceProvider } from './owner-evidence.ts';
import { digest, held, protectScalars, record, messagePattern } from './safety.ts';
import { structured, verifyStoredOriginalRead } from './inbox.ts';
import type { CanonicalTarget, DeliveryIdentity, NativeMcpResult, ReviewLink } from './types.ts';

export interface StoredOwnerOriginal {
  identity: DeliveryIdentity; target: CanonicalTarget; body: string; review_link?: ReviewLink;
}
/** Opaque internal capsule; no public verified flag or caller proof constructor. */
export interface OwnerObservation { readonly mode: 'closed-owner-observation' }
interface Data {
  identity: DeliveryIdentity; target: CanonicalTarget; review_link?: ReviewLink; body_sha256: string;
  status: 'unknown'|'unanswered'|'answer'|'snooze'; proof: Record<string,unknown>|null; snoozed_until: number|null;
}
const observations = new WeakMap<object,Data>();
const OWNER = 'synthetic-owner-source', CHIEF = 'synthetic-chief-source';
const ANSWER = 'Recorded owner response; not approval.';
function synthetic(original: StoredOwnerOriginal): void {
  if (original.identity.purpose !== 'owner_request' || !original.identity.profile_id.startsWith('test-only.')
      || !original.identity.destination_id.startsWith('test-only.')) held();
}
const msg = (seed:string) => 'msg_' + digest(seed).slice(0,26).toUpperCase();
function sourceIds(original:StoredOwnerOriginal) {
  return { message_id:msg(original.target.message_id+'/owner-source'),thread_id:msg(original.target.message_id+'/owner-thread') };
}
/** CLOSED synthetic fixtures, not actual native OWNER authentication. No callbacks,
 * configurable principal, raw history or arbitrary proof is accepted. */
export function testOwnerNativeFixtures(provider:TestOwnerEvidenceProvider, original:StoredOwnerOriginal):
  { messages: Record<string,unknown>[]; source_read:NativeMcpResult|null } {
  synthetic(original); const outcome=testOwnerOutcome(provider).outcome, t=original.target;
  const answerId=msg(t.message_id+'/answer');
  const message=(id:string,thread:string,author:string,body=ANSWER):Record<string,unknown> => ({
    id,thread_id:thread,project_id:t.project_id,reply_to:t.message_id,
    author:{kind:'agent',host:'pi',session:author,name:null},body,attachments:[],inline_images:[],
  });
  if (outcome==='unanswered'||outcome==='unknown')return {messages:[],source_read:null};
  if (outcome==='verified-mirror'||outcome==='unverified-mirror') {
    const ids=sourceIds(original), source=message(ids.message_id,ids.thread_id,OWNER);
    return { messages:[message(answerId,t.thread_id,CHIEF,'Mirrored recorded owner response.')],
      source_read: outcome==='unverified-mirror'?null:{content:[{type:'text',text:'Synthetic source read; not owner authority.'}],
        structuredContent:{thread:{thread_id:ids.thread_id,project:{id:t.project_id,root:t.project_root},messages:[source]},
          url:original.target.url.slice(0,original.target.url.indexOf('#thread='))+'#thread='+ids.thread_id}} };
  }
  const answer=message(answerId,t.thread_id,outcome==='wrong-owner'?'synthetic-other-source':OWNER,
    outcome==='snooze'?'Explicit recorded owner snooze.':ANSWER);
  if(outcome==='wrong-request')answer.reply_to=msg('wrong-request');
  return {messages:[answer],source_read:null};
}
export function ownerSourceRequest(provider:TestOwnerEvidenceProvider, original:StoredOwnerOriginal):
  {message_id:string;thread_id:string}|null {
  synthetic(original);
  return testOwnerOutcome(provider).outcome==='verified-mirror'?sourceIds(original):null;
}
function sourceMessage(read:NativeMcpResult,id:string,threadId:string,original:StoredOwnerOriginal):Record<string,any> {
  const data=structured(read),thread=data.thread;
  if(!record(thread)||!record(thread.project)||thread.project.id!==original.target.project_id
      ||thread.project.root!==original.target.project_root||thread.thread_id!==threadId||!Array.isArray(thread.messages))held();
  const matches=thread.messages.filter((m:any)=>record(m)&&m.id===id);if(matches.length!==1)held();
  const m=matches[0];
  if(m.project_id!==original.target.project_id||m.thread_id!==threadId||m.reply_to!==original.target.message_id
      ||!record(m.author)||m.author.kind!=='agent'||m.author.host!=='pi'
      ||!Array.isArray(m.attachments??[])||(m.attachments??[]).length||m.attachments===null
      ||!Array.isArray(m.inline_images??[])||(m.inline_images??[]).length||m.inline_images===null)held();
  if(!messagePattern.test(m.id))held();return m;
}
/** Always checks the fresh ORIGINAL read before considering the canned synthetic
 * source binding. ACTUAL decoding is deliberately unsupported and never calls this. */
export function decodeOwnerObservation(provider:TestOwnerEvidenceProvider,original:StoredOwnerOriginal,
  read:NativeMcpResult,sourceRead:NativeMcpResult|null,secrets:readonly string[]):OwnerObservation {
  if(!isTestOwnerEvidenceProvider(provider))held();
  // Verify and bind ONE detached snapshot, never retain a caller's mutable target
  // or re-read it after verification. Native envelopes are detached for the same reason.
  original=structuredClone(original);read=structuredClone(read);sourceRead=structuredClone(sourceRead);
  synthetic(original);
  const target=verifyStoredOriginalRead(read,original.target,original.body,secrets,original.review_link);
  if(original.identity.event_revision!==target.revision)held();
  const outcome=testOwnerOutcome(provider);
  const data:Data={identity:{...original.identity},target,
    ...(original.review_link?{review_link:{...original.review_link}}:{}),
    body_sha256:digest(original.body),status:'unknown',proof:null,snoozed_until:null};
  if(outcome.outcome==='unanswered')data.status='unanswered';
  else if(!['unknown','wrong-revision','unverified-mirror'].includes(outcome.outcome)) {
    try {
      protectScalars(read,secrets);if(sourceRead)protectScalars(sourceRead,secrets);
      const mirror=outcome.outcome==='verified-mirror',answerId=msg(original.target.message_id+'/answer');
      const reply=sourceMessage(read,answerId,original.target.thread_id,original);
      let source=reply,sourceThread=original.target.thread_id;
      if(mirror){
        if(reply.author.session!==CHIEF||reply.body!=='Mirrored recorded owner response.'||!sourceRead)held();
        const ids=sourceIds(original);source=sourceMessage(sourceRead,ids.message_id,ids.thread_id,original);sourceThread=ids.thread_id;
        const url=original.target.url.slice(0,original.target.url.indexOf('#thread='))+'#thread='+ids.thread_id;
        if(structured(sourceRead).url!==url)held();
      }
      if(source.author.session!==OWNER||source.body!==(outcome.outcome==='snooze'?'Explicit recorded owner snooze.':ANSWER))held();
      data.status=outcome.outcome==='snooze'?'snooze':'answer';data.snoozed_until=outcome.snoozedUntil??null;
      data.proof={version:1,source_mode:'closed_test',kind:data.status==='snooze'?'snooze':mirror?'mirror_answer':'direct_answer',
        original:{...original.identity},source:{owner_principal:'closed-test-owner',message_id:source.id,thread_id:sourceThread,native_project_id:source.project_id},
        reply_to:original.target.message_id,mirror:mirror?{message_id:reply.id,thread_id:reply.thread_id,
          source_message_id:source.id,source_owner_principal:'closed-test-owner'}:null,
        original_body_sha256:data.body_sha256,source_observation_sha256:digest(JSON.stringify(source)),snoozed_until:data.snoozed_until};
      protectScalars(data.proof,secrets);
    }catch{data.status='unknown';data.proof=null;data.snoozed_until=null;}
  }
  const capsule=Object.freeze({mode:'closed-owner-observation' as const});observations.set(capsule,data);return capsule;
}
export function ownerObservationData(observation:OwnerObservation):Readonly<Data> {
  const data=observations.get(observation)??held();return structuredClone(data);
}
