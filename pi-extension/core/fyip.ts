import { normalize, record } from './safety.ts';
import { defaultCaseFold } from './casefold.ts';

/** Pure curated-baseline port of 715eef69 alert_fyip.py. No I/O, callbacks,
 * service wiring or delivery authorization. Final Stage-1 safety gates remain
 * mandatory when this minimized context is eventually integrated. */
export type CandidateKind = 'milestone' | 'outcome' | 'material_risk' | 'plan_change';
export type EvidenceKind = CandidateKind | 'test_only' | 'command_only' | 'child_exit_only' | 'raw_final_only';
export interface EvidencePoint { readonly kind: EvidenceKind; readonly detail: string }
export interface FYIPCandidate {
  readonly kind: CandidateKind; readonly title: string; readonly previous_state: string;
  readonly current_state: string; readonly materiality: string;
  readonly evidence: readonly EvidencePoint[]; readonly reconciled: boolean;
}
export interface ClassificationContext {
  readonly kind: CandidateKind; readonly title: string; readonly previous_state: string;
  readonly current_state: string; readonly materiality: string; readonly evidence: readonly EvidencePoint[];
}
export type AdmissionReason = 'admitted' | 'invalid_schema' | 'not_reconciled' | 'unchanged'
  | 'materiality_missing' | 'evidence_missing' | 'evidence_not_admissible'
  | 'execution_artifact_only' | 'context_too_large';
export type AdmissionResult = { readonly admitted: true; readonly reason: 'admitted'; readonly context: ClassificationContext }
  | { readonly admitted: false; readonly reason: Exclude<AdmissionReason, 'admitted'>; readonly context: null };
export type ClassificationStatus = 'not_run' | 'classified_yes' | 'classified_no' | 'fallback_unavailable'
  | 'fallback_uncertain' | 'fallback_invalid' | 'fallback_error' | 'bypassed';
export type BypassReason = 'explicit_attention' | 'reminder';
export interface ClassificationResult {
  readonly eligible: boolean; readonly status: ClassificationStatus; readonly choice: 'yes' | 'no' | null;
  readonly leading_status: string | null; readonly bypass_reason: BypassReason | null;
}
/** A completed observation, NOT a classifier capability; this helper invokes nothing. */
export type ClassifierObservation = { readonly kind: 'response'; readonly value: unknown }
  | { readonly kind: 'unavailable' | 'uncertain' | 'error' };
export const FYIP_LIMITS = Object.freeze({ title: 120, state: 240, materiality: 240,
  evidence_points: 3, evidence: 160, context: 1200, secrets: 32, secret: 4096 });
const kinds: readonly CandidateKind[] = ['milestone', 'outcome', 'material_risk', 'plan_change'];
const evidenceKinds: readonly EvidenceKind[] = [...kinds, 'test_only', 'command_only', 'child_exit_only', 'raw_final_only'];
const whitespace = /[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u;
const collapse = (text: string) => text.split(whitespace).filter(Boolean).join(' ');
const length = (text: string) => [...text].length;
const exactKeys = (value: unknown, keys: readonly string[]): value is Record<string, any> => record(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const rawField = (value: unknown, max: number): value is string => typeof value === 'string'
  && value.length <= max * 2 && length(value) > 0 && length(value) <= max;
// Python UTF-8 errors='replace' emits '?' for each malformed surrogate scalar.
const sourceNormalize = (text: string) => normalize([...text].map(s => {
  const cp = s.codePointAt(0)!; return cp >= 0xd800 && cp <= 0xdfff ? '?' : s;
}).join(''));

/** Python Unicode word/whitespace semantics for these source regexes. This is
 * context minimization, not an expansion of the Stage-1 publication grammar. */
function sourceRegex(pattern: RegExp): RegExp {
  const word = String.raw`\p{L}\p{N}_`;
  const boundary = `(?:(?<=[${word}])(?![${word}])|(?<![${word}])(?=[${word}]))`;
  let result = '', inClass = false;
  for (let i = 0; i < pattern.source.length; i++) {
    const char = pattern.source[i];
    if (char === '\\') {
      const next = pattern.source[++i];
      if (next === 's') result += inClass ? String.raw`\s\u0085` : String.raw`[\s\u0085]`;
      else if (next === 'S' && !inClass) result += String.raw`[^\s\u0085]`;
      else if (next === 'w') result += inClass ? word : `[${word}]`;
      else if (next === 'b' && !inClass) result += boundary;
      else if ((next === 'p' || next === 'P') && pattern.source[i + 1] === '{') {
        const end = pattern.source.indexOf('}',i + 2);
        result += '\\' + pattern.source.slice(i,end + 1); i = end;
      } else result += '\\' + next;
    } else if (char === '[') { inClass = true; result += char; }
    else if (char === ']') { inClass = false; result += char; }
    else if (pattern.ignoreCase && /[A-Za-z]/u.test(char)) {
      // Expand ASCII token literals/ranges, then REMOVE /i. Unicode word
      // properties must not acquire case-equivalent nonwords like U+0345.
      if (inClass && ((char === 'A' && pattern.source.slice(i,i+3) === 'A-Z')
          || (char === 'a' && pattern.source.slice(i,i+3) === 'a-z'))) {
        result += 'A-Za-zİıſK'; i += 2;
      } else {
        const cp = char.charCodeAt(0), lower = cp <= 90 ? cp + 32 : cp;
        const variants = String.fromCharCode(lower,lower - 32)
          + (lower === 105 ? 'İı' : lower === 115 ? 'ſ' : lower === 107 ? 'K' : '');
        result += inClass ? variants : '[' + variants + ']';
      }
    } else result += char;
  }
  return new RegExp(result, pattern.flags.replace('i',''));
}

/** Source formatter minimization for classifier context only, not publication. */
function clean(text: string, secrets: readonly string[]): string {
  let value = text;
  for (const secret of secrets) value = value.replaceAll(secret, '[redacted]');
  const protectedValues = [...secrets, ...secrets.map(sourceNormalize).filter(Boolean)];
  value = sourceNormalize([...value].slice(0, 16000).join(''));
  for (const secret of protectedValues) value = value.replaceAll(secret, '[redacted]');
  const apply = (pattern: RegExp, replacement: string): void => { value = value.replace(sourceRegex(pattern), replacement); };
  apply(/-----BEGIN [^-]+-----.*?(?:-----END [^-]+-----|$)/gsu, '[redacted]');
  apply(/\b[0-9]{5,}:[A-Za-z0-9_-]{20,}\b/gu, '[redacted]');
  apply(/\b(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{8,}\b/gu, '[redacted]');
  apply(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, 'Bearer [redacted]');
  apply(/(["'](?:[\p{L}\p{N}_-]+[_-])?(?:password|passwd|api[_ -]?key|(?:access[_ -]?|refresh[_ -]?|bot[_ -]?)?token|secret|authorization)["']\s*:\s*)(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s,}\]]+)/giu, '$1[redacted]');
  apply(/\b(password|passwd|api[_ -]?key|(?:access[_ -]?|refresh[_ -]?|bot[_ -]?)?token|secret|authorization)\b(\s*[:=]\s*)(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s,;]+)/giu, '$1$2[redacted]');
  apply(/(?:https?|wss?):\/\/[^\s<>]+/giu, '[link]');
  apply(/[\p{L}\p{N}_.+-]+@[\p{L}\p{N}_.-]+\.[A-Za-z]{2,}/gu, '[email]');
  apply(/(?<![\p{L}\p{N}_])(?:~?\/|[A-Za-z]:\\)[^\s,;]+/gu, '[path]');
  apply(/\[([^\]\n]+)\]\(\[link\]\)?/gu, '$1 [link]');
  apply(/\[([^\]\n]+)\]\([^\n)]*\)/gu, '$1');
  value = value.replaceAll('<[link]>', '').replaceAll('[link]', '');
  return collapse(value);
}

const executionPatterns = [
  String.raw`(?:(?:all\s+)?(?:(?:unit|integration|smoke|regression)\s+)?tests?|\d+\s+tests?)\s+(?:passed|failed|succeeded|completed|finished|run)`,
  String.raw`(?:pytest|npm\s+test|cargo\s+test|go\s+test|unittest)(?:\s+.*)?`,
  String.raw`(?:(?:child|subprocess|process|command)(?:\s+process)?\s+(?:exited?|finished|completed|status)|(?:child|command)\s+exit\s+code)(?:\s+(?:with\s+)?(?:exit\s+)?(?:code|status))?\s*[:=#-]?\s*(?:-?\d+|success|succeeded|failed|ok)?`,
  String.raw`(?:exit|return)(?:\s+(?:code|status))?\s*[:=#-]?\s*-?\d+`,
  String.raw`(?:git\s+(?:status|diff|log|show|rev-parse|fetch|pull|push|checkout|branch|commit)\b.*|python(?:3(?:\.\d+)?)?\s+(?:-[A-Za-z].*|[\w./-]+\.(?:py|sh)\b.*)|(?:npm|npx)\s+(?:test|run|install|build|exec)\b.*|cargo\s+(?:test|build|run|check)\b.*|go\s+(?:test|build|run)\b.*|(?:bash|sh)\s+-[A-Za-z].*|make\s+(?:test|build|install|clean)\b.*|pip(?:3)?\s+(?:install|uninstall|show|list)\b.*|docker\s+(?:run|build|exec|compose)\b.*|kubectl\s+.*|systemctl\s+(?:start|stop|restart|status)\b.*)`,
  String.raw`[>$]\s*\S.*`,
  String.raw`test\s+result\s*[:=-]?\s*(?:ok|passed|failed)(?:\s*[,;:].*)?`,
].map(pattern => new RegExp('^(?:' + sourceRegex(new RegExp(pattern.replaceAll('\\d', '\\p{Nd}'), 'iu')).source
  + ')$(?![\\s\\S])', 'u'));
function executionOnly(text: string): boolean {
  const value = collapse(text).replace(/[.!?]+$/u, '').trimEnd();
  // Python re.IGNORECASE additionally equates dotted/dotless I in ASCII words.
  const detection = value.replace(/[\u0130\u0131]/gu, 'i');
  return !!value && executionPatterns.some(pattern => pattern.test(detection));
}
function stateKey(text: string): string {
  return collapse(defaultCaseFold(text)).replace(/[.!?]+$/u, '').trim();
}
const reject = (reason: Exclude<AdmissionReason, 'admitted'>): AdmissionResult =>
  Object.freeze({ admitted: false, reason, context: null });

export function admitFYIPCandidate(candidate: unknown, secrets: unknown = []): AdmissionResult {
  if (!Array.isArray(secrets) || secrets.length > FYIP_LIMITS.secrets
      || secrets.some(s => typeof s !== 'string' || length(s) > FYIP_LIMITS.secret)) return reject('invalid_schema');
  if (!exactKeys(candidate, ['kind', 'title', 'previous_state', 'current_state', 'materiality', 'evidence', 'reconciled'])
      || !kinds.includes(candidate.kind) || typeof candidate.reconciled !== 'boolean'
      || !rawField(candidate.title, 120) || !rawField(candidate.previous_state, 240)
      || !rawField(candidate.current_state, 240) || !rawField(candidate.materiality, 240)
      || !Array.isArray(candidate.evidence) || candidate.evidence.length < 1 || candidate.evidence.length > 3)
    return reject('invalid_schema');
  if (!candidate.reconciled) return reject('not_reconciled');
  const suppliedSecrets = (secrets as string[]).filter(Boolean);
  const title = clean(candidate.title, suppliedSecrets), previous = clean(candidate.previous_state, suppliedSecrets),
    current = clean(candidate.current_state, suppliedSecrets), materiality = clean(candidate.materiality, suppliedSecrets);
  if (!title || !previous || !current) return reject('invalid_schema');
  if (stateKey(previous) === stateKey(current)) return reject('unchanged');
  if (materiality.split(whitespace).filter(Boolean).length < 3) return reject('materiality_missing');
  if (executionOnly(materiality)) return reject('execution_artifact_only');
  const evidence: EvidencePoint[] = [];
  for (const item of candidate.evidence) {
    if (!exactKeys(item, ['kind', 'detail']) || !evidenceKinds.includes(item.kind) || !rawField(item.detail, 160))
      return reject('invalid_schema');
    const detail = clean(item.detail, suppliedSecrets);
    if (!detail) return reject('invalid_schema');
    if (!kinds.includes(item.kind)) return reject('evidence_not_admissible');
    evidence.push(Object.freeze({ kind: item.kind as EvidenceKind, detail }));
  }
  const matching = evidence.filter(item => item.kind === candidate.kind);
  if (!matching.length) return reject('evidence_missing');
  if (!matching.some(item => !executionOnly(item.detail))) return reject('execution_artifact_only');
  if ([title, current, ...evidence.map(item => item.detail)].every(executionOnly)) return reject('execution_artifact_only');
  if ([title, previous, current, materiality, ...evidence.map(item => item.detail)]
    .reduce((sum, value) => sum + length(value), 0) > 1200) return reject('context_too_large');
  return Object.freeze({ admitted: true, reason: 'admitted', context: Object.freeze({
    kind: candidate.kind as CandidateKind, title, previous_state: previous, current_state: current,
    materiality, evidence: Object.freeze(evidence) }) });
}
const leading: Partial<Record<ClassificationStatus, string>> = {
  classified_yes: 'FYIP · classified yes',
  fallback_unavailable: 'FYIP · unclassified (classifier unavailable; included by curated baseline)',
  fallback_uncertain: 'FYIP · unclassified (classifier uncertain; included by curated baseline)',
  fallback_invalid: 'FYIP · unclassified (invalid classifier response; included by curated baseline)',
  fallback_error: 'FYIP · unclassified (classifier failed; included by curated baseline)',
};
export function fyipLeadingStatus(status: ClassificationStatus): string {
  const value = leading[status]; if (!value) throw new Error('notification_held'); return value;
}
function classification(eligible: boolean, status: ClassificationStatus, choice: 'yes' | 'no' | null = null,
  bypass_reason: BypassReason | null = null): ClassificationResult {
  return Object.freeze({ eligible, status, choice, leading_status: leading[status] ?? null, bypass_reason });
}
export function classifyFYIPAdmission(admission: AdmissionResult, observation?: ClassifierObservation): ClassificationResult {
  if (!admission.admitted || !admission.context) return classification(false, 'not_run');
  if (observation === undefined || observation.kind === 'unavailable'
      || (observation.kind === 'response' && (observation.value === null || observation.value === undefined)))
    return classification(true, 'fallback_unavailable');
  if (observation.kind === 'uncertain') return classification(true, 'fallback_uncertain');
  if (observation.kind === 'error') return classification(true, 'fallback_error');
  if (observation.kind === 'response' && observation.value === 'yes') return classification(true, 'classified_yes', 'yes');
  if (observation.kind === 'response' && observation.value === 'no') return classification(false, 'classified_no', 'no');
  return classification(true, 'fallback_invalid');
}
export function bypassFYIPClassification(reason: BypassReason): ClassificationResult {
  if (reason !== 'explicit_attention' && reason !== 'reminder') throw new Error('fyip_bypass_invalid');
  return classification(true, 'bypassed', null, reason);
}
