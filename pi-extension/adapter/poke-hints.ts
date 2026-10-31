/** Model assertions only: no execution, ownership or permission is established. */
export const VETO_STATES = ['permission_wait', 'dependency_wait', 'waiting_owner', 'blocked',
  'delegated', 'done', 'cancelled', 'unknown'] as const;
export type Projection = { state: 'candidate'; steps: { summary: string; state: 'pending' | 'done' }[] }
  | { state: typeof VETO_STATES[number] };
export const POKE_HINT_SCHEMA = { type: 'object', additionalProperties: false,
  properties: { state: { type: 'string', enum: ['candidate', ...VETO_STATES] },
    steps: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', additionalProperties: false,
      required: ['summary', 'state'], properties: { summary: { type: 'string', minLength: 1, maxLength: 480 },
        state: { type: 'string', enum: ['pending', 'done'] } } } } }, required: ['state'] };
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
export function normalizeHint(value: unknown): Projection | undefined {
  try {
    if (!object(value) || Buffer.byteLength(JSON.stringify(value), 'utf8') > 16384) return;
    if (value.state !== 'candidate') {
      if (Object.keys(value).length !== 1 || !VETO_STATES.includes(value.state as typeof VETO_STATES[number])) return;
      return { state: value.state as typeof VETO_STATES[number] };
    }
    if (Object.keys(value).length !== 2 || !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 32) return;
    const steps: { summary: string; state: 'pending' | 'done' }[] = [];
    for (const row of value.steps) {
      if (!object(row) || Object.keys(row).length !== 2 || typeof row.summary !== 'string'
          || (row.state !== 'pending' && row.state !== 'done')) return;
      const summary = row.summary.normalize('NFC').trim().replace(/\s+/gu, ' ');
      if (!summary || [...summary].length > 240 || /[\uD800-\uDFFF]/u.test(summary)
          || steps.some(step => step.summary === summary)) return;
      steps.push({ summary, state: row.state });
    }
    steps.sort((a, b) => a.summary < b.summary ? -1 : a.summary > b.summary ? 1 : 0);
    return { state: 'candidate', steps };
  } catch { return; }
}
export const fingerprint = (hint: Projection | undefined): string => JSON.stringify(hint ?? null);
/** Same sealed catalog, forward status progress only. */
export function progresses(previous: Projection, next: Projection): boolean {
  return previous.state === 'candidate' && next.state === 'candidate'
    && previous.steps.length === next.steps.length
    && next.steps.some(s => s.state === 'pending')
    && previous.steps.every((s, i) => s.summary === next.steps[i].summary
      && !(s.state === 'done' && next.steps[i].state !== 'done'))
    && previous.steps.some((s, i) => s.state === 'pending' && next.steps[i].state === 'done');
}
