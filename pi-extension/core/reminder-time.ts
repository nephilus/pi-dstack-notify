import { digest, held, keyPattern, revisionPattern } from './safety.ts';
import type { DeliveryIdentity } from './types.ts';

export const MAX_REMINDER_EPOCH = 253402300800;
/** Finite fractional epoch seconds, supported UTC years 1970..9999. */
export function canonicalUTCSlot(seconds: unknown): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds >= MAX_REMINDER_EPOCH) held();
  return new Date(Math.floor(seconds / 3600) * 3600000).toISOString().slice(0, 19) + '+00:00';
}
export function validateUTCSlot(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\+00:00$(?![\s\S])/.test(value)
      || canonicalUTCSlot(Date.parse(value) / 1000) !== value) held();
}
/** New internal occurrence encoding, NOT Python-history compatibility. Original
 * identity is never rewritten; native IDs/origin/path/session are NOT keys. */
export function reminderDeliveryIdentity(original: DeliveryIdentity, utcSlot: string): DeliveryIdentity {
  validateUTCSlot(utcSlot);
  if (!keyPattern.test(original.decision_key) || !revisionPattern.test(original.event_revision)
      || original.purpose !== 'owner_request') held();
  for (const value of [original.profile_id, original.destination_id]) {
    if (typeof value !== 'string' || value.length > 128
        || !/^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$(?![\s\S])/.test(value)) held();
  }
  const key = digest(JSON.stringify([original.decision_key, original.event_revision,
    original.purpose, utcSlot, 'reminder']));
  return Object.freeze({ profile_id: original.profile_id, destination_id: original.destination_id,
    decision_key: 'reminder:' + key, event_revision: original.event_revision, purpose: 'reminder' });
}
