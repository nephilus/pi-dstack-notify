import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { held, messagePattern } from './safety.ts';
import { validateSchema } from './schema.ts';
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
export class DeliveryLedger {
  #db: DatabaseSync;
  #clock: () => number;
  constructor(filename: string, clock: () => number = () => Date.now() / 1000) {
    this.#clock = clock;
    this.#filename = filename;
    this.#db = existingDatabase(filename); // Missing/v1/partial state NEVER initializes here.
    try {
      this.transaction(() => this.checkFence());
      const mode = this.#db.prepare('PRAGMA journal_mode=WAL').get() as any;
      if (mode.journal_mode !== 'wal') held();
    } catch (e) { this.#db.close(); throw e; }
  }
  #filename: string;
  checkFence(): void {
    validateSchema(this.#db, 2);
    validateDispatchFence(this.#db, this.#filename);
  }
  close(): void { this.#db.close(); }
  private transaction<T>(fn: () => T): T { return transaction(this.#db, fn); }
  private now(): number {
    const value = this.#clock();
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) held();
    return Math.floor(value);
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
      validateSchema(this.#db, 2); validateDispatchFence(this.#db, this.#filename, true);
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
      if (!this.canonicalFor(id)) held();
      const now = this.now();
      this.#db.prepare("UPDATE deliveries SET state='sent',updated_at=?,confirmed_at=?,confirmation_ref=? WHERE " + where).run(now, now, String(messageId), ...tuple(id));
      return this.inspect(id)!;
    });
  }
}
