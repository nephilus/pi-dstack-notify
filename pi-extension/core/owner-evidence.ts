import { exact, held, record } from './safety.ts';
import { MAX_REMINDER_EPOCH } from './reminder-time.ts';

/** Closed synthetic fixture boundary, NOT evidence of a supported actual native
 * OWNER decoder. No callback, caller-selected owner or native proof is accepted. */
export interface TestOwnerEvidenceProvider { readonly mode: 'test-owner-only' }
export type TestOwnerOutcome = 'unanswered' | 'direct-answer' | 'verified-mirror' | 'unverified-mirror'
  | 'wrong-owner' | 'wrong-request' | 'wrong-revision' | 'snooze' | 'unknown';
interface State { readonly outcome: TestOwnerOutcome; readonly snoozedUntil?: number }
const providers = new WeakMap<object, Readonly<State>>();
export function createTestOwnerEvidenceProvider(options: { outcome?: TestOwnerOutcome; snoozedUntil?: number } = {}): TestOwnerEvidenceProvider {
  if (!record(options)) held();
  const keys = Object.keys(options);
  exact(options, keys.includes('snoozedUntil') ? ['outcome','snoozedUntil'] : keys.includes('outcome') ? ['outcome'] : []);
  const outcome = options.outcome ?? 'unanswered';
  if (!['unanswered','direct-answer','verified-mirror','unverified-mirror','wrong-owner','wrong-request',
    'wrong-revision','snooze','unknown'].includes(outcome)) held();
  if (outcome === 'snooze') {
    if (typeof options.snoozedUntil !== 'number' || !Number.isFinite(options.snoozedUntil)
        || options.snoozedUntil < 0 || options.snoozedUntil >= MAX_REMINDER_EPOCH) held();
  } else if (keys.includes('snoozedUntil')) held();
  const provider = Object.freeze({ mode: 'test-owner-only' as const });
  providers.set(provider,Object.freeze({ outcome, ...(outcome === 'snooze' ? { snoozedUntil: options.snoozedUntil } : {}) }));
  return provider;
}
export function isTestOwnerEvidenceProvider(value: unknown): value is TestOwnerEvidenceProvider {
  return value !== null && typeof value === 'object' && providers.has(value);
}
/** Internal canned observation selector. It grants no canonical correlation or
 * authority itself; the service must independently validate raw native readback
 * before consuming a synthetic observation. Not a model/tool entry point. */
export function testOwnerOutcome(provider: TestOwnerEvidenceProvider): Readonly<State> {
  return providers.get(provider) ?? held();
}
