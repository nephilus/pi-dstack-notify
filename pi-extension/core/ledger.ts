import type { DatabaseSync } from 'node:sqlite';
import { canonicalUTCSlot, reminderDeliveryIdentity } from './reminder-time.ts';
import { randomUUID } from 'node:crypto';
import { held, messagePattern, safeBody, digest, validateReviewLink, strictJson } from './safety.ts';
import { ownerObservationData } from './owner-control.ts';
import type { OwnerObservation, StoredOwnerOriginal } from './owner-control.ts';
import type { CanonicalTarget, ReviewLink } from './types.ts';
import { validateSchema, versionOf } from './schema.ts';
import { validateDispatchFence } from './migration.ts';
import { existingDatabase, transaction } from './storage.ts';
import type { DeliveryIdentity, DeliveryReceipt, CanonicalSendEvidence, CanonicalRequestCorrelation } from './types.ts';
export { schema } from './schema.ts';
/** Conflicts never disclose either the prior or attempted identity. */
export class CanonicalConflict extends Error {
  constructor() { super('canonical_identity_conflict'); }
}
export class LegacyMappingRequired extends Error {
  constructor() { super('legacy_history_unmapped'); }
}
const where = 'profile_id=? AND destination_id=? AND decision_key=? AND event_revision=? AND purpose=?';
const tuple = (id: DeliveryIdentity) => [id.profile_id, id.destination_id, id.decision_key, id.event_revision, id.purpose];
function validateIdentity(id: DeliveryIdentity): void {
  for (const [value, limit] of tuple(id).map((v, i) => [v, [128, 128, 512, 256, 128][i]] as const)) {
    if (typeof value !== 'string' || value.length > limit || !/^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$(?![\s\S])/.test(value)) held();
  }
  if ([id.profile_id, id.destination_id].some(v => /^[a-fA-F0-9]{64}$/.test(v))) held();
}
export interface Claim { action: 'claimed' | 'suppressed' | 'held'; receipt: DeliveryReceipt }
export class OwnerCapacityHeld extends Error { constructor(){super('owner_capacity_held');} }
export interface OwnerTickScope { profile_id:string;destination_id:string;project_root:string }
export type ReminderClaim = {action:'claimed'|'duplicate';identity:DeliveryIdentity;claim_id:string}
  | {action:'paused'|'snoozed'};
export type OwnerTrackingStatus='not_enrolled'|'reserved_unknown'|'active'|'paused_answer';
function testOwnerIdentity(id:DeliveryIdentity):void {
  validateIdentity(id);if(id.purpose!=='owner_request'||!id.profile_id.startsWith('test-only.')||!id.destination_id.startsWith('test-only.'))held();
}
export class DeliveryLedger {
  #db: DatabaseSync;
  #clock: () => number;
  constructor(filename: string, clock: () => number = () => Date.now() / 1000, requiredVersion?: 3, tickOwned = false) {
    this.#clock = clock;
    this.#filename = filename;
    this.#db = existingDatabase(filename,false,tickOwned ? 0 : 10000); // Missing/v1/partial state NEVER initializes here.
    try {
      if (requiredVersion !== undefined && this.schemaVersion() !== requiredVersion) held();
      this.transaction(() => this.checkFence());
      const mode = this.#db.prepare('PRAGMA journal_mode=WAL').get() as any;
      if (mode.journal_mode !== 'wal') held();
    } catch (e) { this.#db.close(); throw e; }
  }
  #filename: string;
  schemaVersion(): 2 | 3 {
    const version = versionOf(this.#db);
    if (version !== 2 && version !== 3) held();
    return version;
  }
  checkFence(): void {
    validateSchema(this.#db, this.schemaVersion());
    validateDispatchFence(this.#db, this.#filename);
  }
  close(): void { this.#db.close(); }
  private transaction<T>(fn: () => T): T { return transaction(this.#db, fn); }
  private now(): number {
    const value = this.#clock();
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) held();
    return Math.floor(value);
  }
  /** NEW v3 state timestamps (owner, occurrence, FYIP) have a narrower range
   * than historical deliveries. Sample ONCE before writes; retain fractions. */
  private v3Now():number {
    const at=this.#clock();canonicalUTCSlot(at);return at;
  }
  inspect(id: DeliveryIdentity): DeliveryReceipt | null {
    validateIdentity(id);
    const row = this.#db.prepare('SELECT state,claim_id,created_at,updated_at,confirmed_at,confirmation_ref,source,migration_id FROM deliveries WHERE ' + where).get(...tuple(id));
    return row ? { identity: { ...id }, ...row } as unknown as DeliveryReceipt : null;
  }
  claim(id: DeliveryIdentity): Claim {
    validateIdentity(id);
    return this.transaction(() => {
      this.checkFence();
      const now = this.now(); let receipt = this.inspect(id);
      if (!receipt) {
        if (this.schemaVersion() === 3 && id.purpose === 'reminder') held();
        if (this.#db.prepare('SELECT 1 FROM canonical_associations WHERE profile_id=? AND destination_id=? AND legacy_unmapped=1 LIMIT 1')
          .get(id.profile_id, id.destination_id)) throw new LegacyMappingRequired();
        const claim = randomUUID().replaceAll('-', '');
        this.#db.prepare(`INSERT INTO deliveries (profile_id,destination_id,decision_key,event_revision,purpose,state,claim_id,created_at,updated_at,confirmed_at,confirmation_ref,source,migration_id)
          VALUES (?,?,?,?,?,'in_flight',?,?,?,NULL,NULL,'live',NULL)`).run(...tuple(id), claim, now, now);
        return { action: 'claimed', receipt: this.inspect(id)! };
      }
      if (receipt.state === 'sent' || receipt.state === 'duplicate') return { action: 'suppressed', receipt };
      if (receipt.state === 'in_flight') {
        this.#db.prepare("UPDATE deliveries SET state='delivery_unknown',updated_at=? WHERE " + where).run(now, ...tuple(id));
        receipt = this.inspect(id)!;
      }
      if (receipt.state !== 'delivery_unknown') held();
      return { action: 'held', receipt };
    });
  }
  ownerTracking(id:DeliveryIdentity):OwnerTrackingStatus {
    testOwnerIdentity(id);
    const row=this.#db.prepare('SELECT state FROM pending_owner_requests WHERE '+where).get(...tuple(id));
    return !row?'not_enrolled':row.state==='reserved'?'reserved_unknown':row.state as OwnerTrackingStatus;
  }
  /** Atomic cap+original claim+reservation. New arrivals join the FIFO TAIL. */
  reserveOwnerRequest(id:DeliveryIdentity,original:{body:string;project_root:string;session_id:string;review_link?:ReviewLink}):Claim {
    testOwnerIdentity(id);safeBody(original.body,[],original.review_link);
    if(this.schemaVersion()!==3)held();
    return this.transaction(()=>{
      this.checkFence();const existing=this.inspect(id),at=this.v3Now(),now=Math.floor(at);
      if(existing){
        if(['sent','duplicate'].includes(existing.state))return {action:'suppressed',receipt:existing};
        if(existing.state==='in_flight')this.#db.prepare("UPDATE deliveries SET state='delivery_unknown',updated_at=? WHERE "+where).run(now,...tuple(id));
        return {action:'held',receipt:this.inspect(id)!};
      }
      if(this.#db.prepare('SELECT 1 FROM canonical_associations WHERE profile_id=? AND destination_id=? AND legacy_unmapped=1 LIMIT 1')
        .get(id.profile_id,id.destination_id))throw new LegacyMappingRequired();
      const scope=[id.profile_id,id.destination_id,original.project_root];
      const count=this.#db.prepare("SELECT COUNT(*) n FROM pending_owner_requests WHERE profile_id=? AND destination_id=? AND project_root=? AND state IN ('reserved','active')").get(...scope)!.n;
      if(Number(count)>=32)throw new OwnerCapacityHeld();
      const tail=Number(this.#db.prepare('SELECT MAX(processing_sequence) n FROM pending_owner_requests WHERE profile_id=? AND destination_id=? AND project_root=?').get(...scope)!.n??0)+1;
      if(!Number.isSafeInteger(tail)||tail<1)held();
      const claim=randomUUID().replaceAll('-','');
      this.#db.prepare("INSERT INTO deliveries VALUES (?,?,?,?,?,'in_flight',?,?,?,NULL,NULL,'live',NULL)").run(...tuple(id),claim,now,now);
      this.#db.prepare(`INSERT INTO pending_owner_requests (profile_id,destination_id,decision_key,event_revision,purpose,state,
        project_root,original_session_id,body,review_link_json,processing_sequence,created_at,updated_at)
        VALUES (?,?,?,?,?,'reserved',?,?,?,?,?,?,?)`).run(...tuple(id),original.project_root,original.session_id,original.body,
          original.review_link?JSON.stringify(original.review_link):null,tail,at,at);
      return {action:'claimed',receipt:this.inspect(id)!};
    });
  }
  storedOwnerOriginal(id:DeliveryIdentity):StoredOwnerOriginal|null {
    testOwnerIdentity(id);this.checkFence();
    const row=this.#db.prepare("SELECT * FROM pending_owner_requests WHERE "+where+" AND state!='reserved'").get(...tuple(id));
    if(!row)return null;
    const target:CanonicalTarget={project_id:String(row.native_project_id),project_root:String(row.project_root),session_id:String(row.original_session_id),
      message_id:String(row.message_id),thread_id:String(row.thread_id),url:String(row.canonical_url),revision:id.event_revision,
      revision_semantics:id.event_revision.length===40?'git-sha1':'content-sha256'};
    return {identity:{...id},target,body:String(row.body),...(row.review_link_json===null?{}:{review_link:validateReviewLink(strictJson(String(row.review_link_json)))})};
  }
  activateOwnerRequest(id:DeliveryIdentity,claim:string,target:CanonicalTarget,observation:OwnerObservation):OwnerTrackingStatus {
    testOwnerIdentity(id);
    return this.transaction(()=>{
      this.checkFence();const original=this.#db.prepare('SELECT * FROM pending_owner_requests WHERE '+where).get(...tuple(id));
      const receipt=this.inspect(id),association=this.#db.prepare('SELECT * FROM canonical_associations WHERE '+where).get(...tuple(id));
      if(!original||original.state!=='reserved'||!receipt||receipt.claim_id!==claim||receipt.state!=='in_flight'||!association||association.legacy_unmapped!==0
        ||association.inbox_authority!==new URL(target.url).origin||association.message_id!==target.message_id||association.thread_id!==target.thread_id
        ||association.native_project_id!==target.project_id||association.project_root!==target.project_root||association.session_id!==target.session_id
        ||original.project_root!==target.project_root||original.original_session_id!==target.session_id||id.event_revision!==target.revision)held();
      this.assertOwnerObservation(id,original,target,observation);
      const at=this.v3Now(),now=Math.floor(at);
      this.#db.prepare('UPDATE canonical_associations SET read_verified=1,verified_at=? WHERE '+where).run(now,...tuple(id));
      this.#db.prepare(`UPDATE pending_owner_requests SET state='active',inbox_authority=?,message_id=?,thread_id=?,canonical_url=?,native_project_id=?,updated_at=? WHERE ${where}`)
        .run(new URL(target.url).origin,target.message_id,target.thread_id,target.url,target.project_id,at,...tuple(id));
      this.applyOwnerControlTx(id,observation);return this.ownerTracking(id);
    });
  }
  private assertOwnerObservation(id:DeliveryIdentity,row:Record<string,any>,target:CanonicalTarget,observation:OwnerObservation):void {
    const data=ownerObservationData(observation);
    if(JSON.stringify(tuple(data.identity))!==JSON.stringify(tuple(id))||data.body_sha256!==digest(String(row.body))
      ||JSON.stringify(data.review_link??null)!==JSON.stringify(row.review_link_json===null?null:validateReviewLink(strictJson(String(row.review_link_json))))
      ||(Object.keys(target) as (keyof CanonicalTarget)[]).some(key=>data.target[key]!==target[key])
      ||Object.keys(data.target).length!==Object.keys(target).length)held();
  }
  private applyOwnerControlTx(id:DeliveryIdentity,observation:OwnerObservation):void {
    const row=this.#db.prepare('SELECT * FROM pending_owner_requests WHERE '+where).get(...tuple(id));
    if(!row||row.state==='reserved')held();
    // Re-read canonical coverage INSIDE this same write transaction. A genuine
    // capsule for a different native target is no authority for this stored row.
    const original=this.storedOwnerOriginal(id);if(!original)held();
    const association=this.#db.prepare('SELECT * FROM canonical_associations WHERE '+where).get(...tuple(id));
    if(!association||association.legacy_unmapped!==0||association.read_verified!==1
      ||association.inbox_authority!==row.inbox_authority||association.message_id!==row.message_id
      ||association.thread_id!==row.thread_id||association.native_project_id!==row.native_project_id
      ||association.project_root!==row.project_root||association.session_id!==row.original_session_id
      ||new URL(original.target.url).origin!==row.inbox_authority)held();
    this.assertOwnerObservation(id,row,original.target,observation);
    const data=ownerObservationData(observation),now=this.v3Now();
    if(data.status==='answer'&&row.state!=='paused_answer'){
      this.#db.prepare("UPDATE pending_owner_requests SET state='paused_answer',answer_evidence_json=?,updated_at=? WHERE "+where)
        .run(JSON.stringify(data.proof),now,...tuple(id));
    }else if(data.status==='snooze'){
      // Repeated exact evidence is idempotent. Unordered conflicting controls
      // cannot silently shorten/extend an existing durable OWNER instruction.
      if(row.snooze_evidence_json!==null&&row.snooze_evidence_json!==JSON.stringify(data.proof))held();
      this.#db.prepare('UPDATE pending_owner_requests SET snoozed_until=?,snooze_evidence_json=?,updated_at=? WHERE '+where)
        .run(data.snoozed_until,JSON.stringify(data.proof),now,...tuple(id));
    }
  }
  applyOwnerObservation(id:DeliveryIdentity,observation:OwnerObservation):OwnerTrackingStatus {
    testOwnerIdentity(id);return this.transaction(()=>{this.checkFence();this.applyOwnerControlTx(id,observation);return this.ownerTracking(id);});
  }
  /** One exact initial identity set, not a rolling query/substitution selector. */
  ownerTickSnapshot(scope:OwnerTickScope):DeliveryIdentity[] {
    testOwnerIdentity({...scope,decision_key:'scope',event_revision:'a'.repeat(64),purpose:'owner_request'});
    return this.transaction(()=>{
      this.checkFence();this.ownerScopeGuard(scope);
      const rows=this.#db.prepare(`SELECT profile_id,destination_id,decision_key,event_revision,purpose FROM pending_owner_requests
        WHERE profile_id=? AND destination_id=? AND project_root=? AND state='active'
        ORDER BY processing_sequence,created_at,decision_key,event_revision,purpose`).all(scope.profile_id,scope.destination_id,scope.project_root);
      if(rows.length>32)held();return rows.map(row=>({...row}) as unknown as DeliveryIdentity);
    });
  }
  private ownerScopeGuard(scope:OwnerTickScope):void {
    if(this.schemaVersion()!==3||this.#db.prepare('SELECT 1 FROM canonical_associations WHERE profile_id=? AND destination_id=? AND legacy_unmapped=1 LIMIT 1')
      .get(scope.profile_id,scope.destination_id))held();
  }
  /** Cursor transaction commits BEFORE ANY selected-request host/native await. */
  moveOwnerTick(id:DeliveryIdentity,scope:OwnerTickScope):StoredOwnerOriginal {
    testOwnerIdentity(id);
    return this.transaction(()=>{
      this.checkFence();this.ownerScopeGuard(scope);
      if(id.profile_id!==scope.profile_id||id.destination_id!==scope.destination_id)held();
      const original=this.storedOwnerOriginal(id);if(!original||original.target.project_root!==scope.project_root)held();
      const tail=Number(this.#db.prepare('SELECT MAX(processing_sequence) n FROM pending_owner_requests WHERE profile_id=? AND destination_id=? AND project_root=?')
        .get(scope.profile_id,scope.destination_id,scope.project_root)!.n??0)+1;
      if(!Number.isSafeInteger(tail)||tail<1)held();
      this.#db.prepare('UPDATE pending_owner_requests SET processing_sequence=?,updated_at=? WHERE '+where).run(tail,this.v3Now(),...tuple(id));
      return original;
    });
  }
  ownerReminderState(id:DeliveryIdentity):'active'|'paused'|'snoozed' {
    testOwnerIdentity(id);this.checkFence();const now=this.#clock();canonicalUTCSlot(now);
    const row=this.#db.prepare('SELECT state,snoozed_until FROM pending_owner_requests WHERE '+where).get(...tuple(id));
    if(!row||row.state==='reserved')held();
    return row.state==='paused_answer'?'paused':row.snoozed_until!==null&&Number(row.snoozed_until)>now?'snoozed':'active';
  }
  claimReminder(id:DeliveryIdentity,slot:string,observation:OwnerObservation,operationId:string):ReminderClaim {
    testOwnerIdentity(id);const identity=reminderDeliveryIdentity(id,slot);
    if(!/^[A-Za-z0-9._-]{1,80}$(?![\s\S])/.test(operationId))held();
    return this.transaction(()=>{
      this.checkFence();this.applyOwnerControlTx(id,observation);
      const original=this.storedOwnerOriginal(id);if(!original)held();this.ownerScopeGuard({...id,project_root:original.target.project_root});
      const status=this.ownerReminderState(id);if(status!=='active')return {action:status};
      const data=ownerObservationData(observation);if(!['unanswered','snooze'].includes(data.status))held();
      const at=this.v3Now();if(canonicalUTCSlot(at)!==slot)held();
      const prior=this.inspect(identity);
      if(prior)return {action:'duplicate',identity,claim_id:prior.claim_id!};
      const claim=randomUUID().replaceAll('-',''),now=Math.floor(at);
      this.#db.prepare("INSERT INTO deliveries VALUES (?,?,?,?,?,'in_flight',?,?,?,NULL,NULL,'live',NULL)")
        .run(...tuple(identity),claim,now,now);
      this.#db.prepare(`INSERT INTO reminder_occurrences (profile_id,destination_id,decision_key,event_revision,original_purpose,utc_slot,purpose,
        reminder_key,claim_operation_id,created_at,send_started_at) VALUES (?,?,?,?,?,?,'reminder',?,?,?,NULL)`)
        .run(...tuple(id),slot,identity.decision_key,operationId,at);
      return {action:'claimed',identity,claim_id:claim};
    });
  }
  startReminderSend(id:DeliveryIdentity,slot:string,claim:string,observation:OwnerObservation):boolean {
    testOwnerIdentity(id);const identity=reminderDeliveryIdentity(id,slot);
    return this.transaction(()=>{
      this.checkFence();this.applyOwnerControlTx(id,observation);
      if(this.ownerReminderState(id)!=='active')return false;
      if(!['unanswered','snooze'].includes(ownerObservationData(observation).status))held();
      const at=this.v3Now();if(canonicalUTCSlot(at)!==slot)held();
      const receipt=this.inspect(identity);if(!receipt||receipt.claim_id!==claim||receipt.state!=='in_flight')held();
      const result=this.#db.prepare(`UPDATE reminder_occurrences SET send_started_at=? WHERE profile_id=? AND destination_id=? AND decision_key=?
        AND event_revision=? AND original_purpose=? AND utc_slot=? AND purpose='reminder' AND send_started_at IS NULL`)
        .run(at,...tuple(id),slot);
      if(result.changes!==1)held();return true;
    });
  }
  private reminderConfirmationCoverage(id:DeliveryIdentity,claim:string):boolean {
    const occurrence=this.#db.prepare(`SELECT * FROM reminder_occurrences WHERE profile_id=? AND destination_id=? AND reminder_key=?
      AND event_revision=? AND purpose='reminder'`).get(id.profile_id,id.destination_id,id.decision_key,id.event_revision);
    if(!occurrence||occurrence.send_started_at===null||canonicalUTCSlot(this.#clock())!==occurrence.utc_slot)return false;
    const originalId={profile_id:id.profile_id,destination_id:id.destination_id,decision_key:String(occurrence.decision_key),
      event_revision:id.event_revision,purpose:'owner_request'};
    testOwnerIdentity(originalId);
    if(reminderDeliveryIdentity(originalId,String(occurrence.utc_slot)).decision_key!==id.decision_key)return false;
    const original=this.storedOwnerOriginal(originalId);if(!original)return false;
    this.ownerScopeGuard({...originalId,project_root:original.target.project_root});
    return this.inspect(id)?.claim_id===claim;
  }
  /** Classification claim and frozen outcome share the existing ledger transaction/fence. */
  claimFYIP(id: DeliveryIdentity, fingerprints: { candidate_sha256: string; question_sha256: string; config_sha256: string }):
    { action: 'claimed'|'decided'|'held'; claim_id: string; status: string | null; choice: 'yes'|'no'|null; candidate_sha256: string } {
    validateIdentity(id);
    if (id.purpose !== 'fyip' || this.schemaVersion() !== 3
        || Object.values(fingerprints).some(v => !/^[0-9a-f]{64}$(?![\s\S])/.test(v))) held();
    return this.transaction(() => {
      this.checkFence();
      const row = this.#db.prepare('SELECT * FROM fyip_decisions WHERE ' + where).get(...tuple(id));
      if (row) return { action: row.state === 'decided' ? 'decided' : 'held', claim_id: String(row.decision_claim_id),
        status: row.classification_status as string | null, choice: row.choice as 'yes'|'no'|null,
        candidate_sha256:String(row.candidate_sha256) };
      if (this.inspect(id)) held(); // Never reinterpret earlier delivery history as a fresh classification.
      if (this.#db.prepare('SELECT 1 FROM canonical_associations WHERE profile_id=? AND destination_id=? AND legacy_unmapped=1 LIMIT 1')
        .get(id.profile_id,id.destination_id)) throw new LegacyMappingRequired();
      const claim = randomUUID().replaceAll('-','');
      this.#db.prepare(`INSERT INTO fyip_decisions (profile_id,destination_id,decision_key,event_revision,purpose,
        candidate_sha256,question_sha256,config_sha256,decision_claim_id,state,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,'classifying',?)`).run(...tuple(id),fingerprints.candidate_sha256,
          fingerprints.question_sha256,fingerprints.config_sha256,claim,this.v3Now());
      return { action:'claimed',claim_id:claim,status:null,choice:null,candidate_sha256:fingerprints.candidate_sha256 };
    });
  }
  decideFYIP(id: DeliveryIdentity, claim: string, status: string, choice: 'yes'|'no'|null): void {
    if (!['classified_yes','classified_no','fallback_unavailable','fallback_uncertain','fallback_invalid','fallback_error'].includes(status)
        || choice !== (status === 'classified_yes' ? 'yes' : status === 'classified_no' ? 'no' : null)) held();
    this.transaction(() => {
      this.checkFence();
      const result = this.#db.prepare(`UPDATE fyip_decisions SET state='decided',classification_status=?,choice=?,decided_at=?
        WHERE ${where} AND decision_claim_id=? AND state='classifying'`).run(status,choice,this.v3Now(),...tuple(id),claim);
      if (result.changes !== 1) held();
    });
  }
  interruptFYIP(id: DeliveryIdentity, claim: string): void {
    this.transaction(() => {
      this.#db.prepare(`UPDATE fyip_decisions SET state='terminal_unknown' WHERE ${where}
        AND decision_claim_id=? AND state='classifying'`).run(...tuple(id),claim);
    });
  }
  canonicalFor(id: DeliveryIdentity): CanonicalRequestCorrelation | null {
    validateIdentity(id);
    const row = this.#db.prepare('SELECT inbox_authority AS authority,message_id,thread_id FROM canonical_associations WHERE legacy_unmapped=0 AND ' + where).get(...tuple(id));
    return row ? { ...row } as unknown as CanonicalRequestCorrelation : null;
  }
  /** First association is immutable. Path/session are first-seen scope evidence,
   * never keys or authorization. Known send IDs reserve before full readback.
   */
  associate(id: DeliveryIdentity, claim: string, evidence: CanonicalSendEvidence, verified = false): CanonicalRequestCorrelation {
    validateIdentity(id);
    if (!messagePattern.test(evidence.message_id) || !messagePattern.test(evidence.thread_id)
        || new URL(evidence.authority).origin !== evidence.authority
        || !evidence.authority.startsWith('https://')) held();
    return this.transaction(() => {
      validateSchema(this.#db, this.schemaVersion()); validateDispatchFence(this.#db, this.#filename, true);
      const receipt = this.inspect(id);
      if (!receipt || receipt.claim_id !== claim || receipt.source !== 'live'
          || !['in_flight', 'delivery_unknown'].includes(receipt.state)) held();
      const byRequest = this.#db.prepare('SELECT * FROM canonical_associations WHERE profile_id=? AND destination_id=? AND inbox_authority=? AND message_id=?')
        .get(id.profile_id, id.destination_id, evidence.authority, evidence.message_id) as any;
      const byIdentity = this.#db.prepare('SELECT * FROM canonical_associations WHERE ' + where).get(...tuple(id)) as any;
      for (const row of [byRequest, byIdentity].filter(Boolean)) {
        if (row.legacy_unmapped !== 0 || row.inbox_authority !== evidence.authority || row.message_id !== evidence.message_id
            || row.thread_id !== evidence.thread_id || row.native_project_id !== evidence.native_project_id
            || row.decision_key !== id.decision_key || row.event_revision !== id.event_revision || row.purpose !== id.purpose) {
          throw new CanonicalConflict();
        }
      }
      const now = this.now();
      if (!byRequest && !byIdentity) {
        this.#db.prepare(`INSERT INTO canonical_associations
          (profile_id,destination_id,inbox_authority,message_id,thread_id,decision_key,event_revision,purpose,native_project_id,project_root,session_id,legacy_unmapped,read_verified,created_at,verified_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id.profile_id, id.destination_id, evidence.authority,
          evidence.message_id, evidence.thread_id, id.decision_key, id.event_revision, id.purpose,
          evidence.native_project_id, evidence.project_root, evidence.session_id, 0, verified ? 1 : 0, now, verified ? now : null);
      } else if (verified && byRequest.read_verified === 0) {
        this.#db.prepare('UPDATE canonical_associations SET read_verified=1,verified_at=? WHERE ' + where).run(now, ...tuple(id));
      }
      return { authority: evidence.authority, message_id: evidence.message_id, thread_id: evidence.thread_id };
    });
  }
  unknown(id: DeliveryIdentity, claim: string): DeliveryReceipt {
    return this.transaction(() => {
      const row = this.inspect(id);
      if (!row || row.claim_id !== claim || row.source !== 'live' || !['in_flight', 'delivery_unknown'].includes(row.state)) held();
      this.#db.prepare("UPDATE deliveries SET state='delivery_unknown',updated_at=? WHERE " + where).run(this.now(), ...tuple(id));
      return this.inspect(id)!;
    });
  }
  confirmed(id: DeliveryIdentity, claim: string, messageId: number): DeliveryReceipt {
    if (!Number.isSafeInteger(messageId) || messageId <= 0 || messageId > 2 ** 52 - 1) held();
    return this.transaction(() => {
      const row = this.inspect(id);
      if (!row || row.claim_id !== claim || row.source !== 'live' || !['in_flight', 'delivery_unknown'].includes(row.state)) held();
      this.checkFence();
      if (id.purpose==='reminder'&&this.schemaVersion()===3) {
        if(!this.reminderConfirmationCoverage(id,claim))held();
      } else if (!this.canonicalFor(id)) held();
      const now = this.now();
      this.#db.prepare("UPDATE deliveries SET state='sent',updated_at=?,confirmed_at=?,confirmation_ref=? WHERE " + where).run(now, now, String(messageId), ...tuple(id));
      return this.inspect(id)!;
    });
  }
}
