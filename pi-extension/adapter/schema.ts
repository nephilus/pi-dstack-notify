import type { PublishArguments, PublishFYIPArguments } from './types.ts';

export const SEND = 'mcp__plannotator_inbox__send_message';
export const READ = 'mcp__plannotator_inbox__read_thread';
export const KEY_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:/@+\\-]{0,199}$';
export const REVISION_PATTERN = '^(?:[0-9a-f]{40}|[0-9a-f]{64})$';
export const INPUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['text', 'decision_key', 'revision'],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 16000, pattern: '\\S',
      description: 'Caller-asserted notification text; not independently verified.' },
    decision_key: { type: 'string', minLength: 1, maxLength: 200, pattern: KEY_PATTERN,
      description: 'Caller-asserted stable identity for bounded deduplication, not semantic duplicate prevention across changed keys.' },
    review_link: { type: 'object', additionalProperties: false, required: ['label', 'url'],
      properties: { label: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
        url: { type: 'string', minLength: 1, maxLength: 2048 } },
      description: 'Optional literal HTTPS review link; validated by the core, presentation only.' },
    revision: { type: 'string', minLength: 40, maxLength: 64, pattern: REVISION_PATTERN,
      description: 'Caller-asserted lowercase Git SHA-1 or content SHA-256 syntax; not a verified revision or snapshot.' },
  },
};
const CANDIDATE_KINDS = ['milestone', 'outcome', 'material_risk', 'plan_change'];
const EVIDENCE_KINDS = [...CANDIDATE_KINDS, 'test_only', 'command_only', 'child_exit_only', 'raw_final_only'];
export const FYIP_INPUT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['candidate', 'decision_key', 'revision'],
  properties: {
    decision_key: INPUT_SCHEMA.properties.decision_key,
    revision: INPUT_SCHEMA.properties.revision,
    review_link: INPUT_SCHEMA.properties.review_link,
    candidate: { type: 'object', additionalProperties: false,
      required: ['kind', 'title', 'previous_state', 'current_state', 'materiality', 'evidence', 'reconciled'],
      properties: {
        kind: { type: 'string', enum: CANDIDATE_KINDS },
        title: { type: 'string', minLength: 1, maxLength: 120 },
        previous_state: { type: 'string', minLength: 1, maxLength: 240 },
        current_state: { type: 'string', minLength: 1, maxLength: 240 },
        materiality: { type: 'string', minLength: 1, maxLength: 240 },
        reconciled: { type: 'boolean' },
        evidence: { type: 'array', maxItems: 3, items: { type: 'object', additionalProperties: false,
          required: ['kind', 'detail'], properties: { kind: { type: 'string', enum: EVIDENCE_KINDS },
            detail: { type: 'string', minLength: 1, maxLength: 160 } } } },
      } },
  },
};
/** Shape only. Reconciliation, materiality, evidence admission and Unicode are CORE decisions. */
export function validFYIPArguments(value: unknown): value is PublishFYIPArguments {
  if (!isObject(value) || !exact(value, Object.hasOwn(value, 'review_link')
    ? ['candidate', 'decision_key', 'revision', 'review_link'] : ['candidate', 'decision_key', 'revision'])) return false;
  const { candidate, ...rest } = value;
  if (!validArguments({ text: 'shape', ...rest }) || !exact(candidate,
    ['kind', 'title', 'previous_state', 'current_state', 'materiality', 'evidence', 'reconciled'])) return false;
  return typeof candidate.kind === 'string' && CANDIDATE_KINDS.includes(candidate.kind)
    && typeof candidate.reconciled === 'boolean'
    && [['title', 120], ['previous_state', 240], ['current_state', 240], ['materiality', 240]].every(([key, max]) => {
      const field = candidate[String(key)];
      return typeof field === 'string' && Array.from(field).length > 0 && Array.from(field).length <= Number(max);
    }) && Array.isArray(candidate.evidence) && candidate.evidence.length <= 3 && candidate.evidence.every(point =>
      exact(point, ['kind', 'detail']) && typeof point.kind === 'string' && EVIDENCE_KINDS.includes(point.kind)
      && typeof point.detail === 'string' && Array.from(point.detail).length > 0 && Array.from(point.detail).length <= 160);
}
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isObject(value) && keys.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => keys.includes(key));
}
export function validArguments(value: unknown): value is PublishArguments {
  return isObject(value) && exact(value, Object.hasOwn(value, 'review_link')
    ? ['text', 'decision_key', 'revision', 'review_link'] : ['text', 'decision_key', 'revision']) &&
    (!Object.hasOwn(value, 'review_link') || (exact(value.review_link, ['label', 'url']) &&
      typeof value.review_link.label === 'string' && /\S/.test(value.review_link.label) &&
      Array.from(value.review_link.label).length <= 200 &&
      typeof value.review_link.url === 'string' && value.review_link.url.length > 0 && value.review_link.url.length <= 2048)) &&
    typeof value.text === 'string' && /\S/.test(value.text) && Array.from(value.text).length <= 16000 &&
    typeof value.decision_key === 'string' && new RegExp(KEY_PATTERN).exec(value.decision_key)?.[0] === value.decision_key &&
    typeof value.revision === 'string' && new RegExp(REVISION_PATTERN).exec(value.revision)?.[0] === value.revision;
}
