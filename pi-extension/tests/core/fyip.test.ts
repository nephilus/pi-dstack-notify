import './offline-guard.mjs';
import { attempts } from './offline-guard.mjs';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { admitFYIPCandidate, classifyFYIPAdmission, bypassFYIPClassification, FYIP_LIMITS } from '../../core/fyip.ts';
import type { CandidateKind, ClassifierObservation, FYIPCandidate } from '../../core/fyip.ts';
const reference = JSON.parse(readFileSync(new URL('../../fixtures/fyip-reference.json', import.meta.url), 'utf8'));
const candidate = (changes: Partial<FYIPCandidate> = {}): FYIPCandidate => ({ ...structuredClone(reference.candidate), ...changes });
after(() => { assert.deepEqual(attempts, []); assert.equal(process.env.PATH, '/nonexistent-notification-test-path'); });

test('translated reference admits four typed reconciled material kinds without performing classification or delivery', () => {
  for (const kind of ['milestone', 'outcome', 'material_risk', 'plan_change'] as CandidateKind[]) {
    const input = candidate({ kind, evidence: [{ kind, detail: 'Owner exercised the requested workflow' }] });
    const before = structuredClone(input), admission = admitFYIPCandidate(input);
    assert.equal(admission.admitted, true); assert.equal(admission.reason, 'admitted');
    assert.equal(admission.context?.kind, kind); assert.deepEqual(input, before);
    assert.ok(Object.isFrozen(admission)); assert.ok(Object.isFrozen(admission.context));
    assert.ok(Object.isFrozen(admission.context?.evidence));
    assert.equal('delivery' in admission, false);
  }
});

test('unreconciled, unchanged and missing materiality preserve reference rejection reasons', () => {
  for (const [changes, reason] of [ [{ reconciled: false }, 'not_reconciled'],
    [{ previous_state: 'Release is available to owners!' }, 'unchanged'],
    [{ previous_state: ' RELEASE  IS AVAILABLE TO OWNERS.?! ' }, 'unchanged'],
    [{ materiality: 'Tests passed' }, 'materiality_missing'] ] as const) {
    const result = admitFYIPCandidate(candidate(changes));
    assert.equal(result.admitted, false); assert.equal(result.reason, reason); assert.equal(result.context, null);
    // A supplied YES/failure observation cannot make rejected material eligible.
    for (const observation of [{ kind: 'response', value: 'yes' }, { kind: 'error' }] as ClassifierObservation[])
      assert.equal(classifyFYIPAdmission(result, observation).status, 'not_run');
  }
});

test('test, command, child exit and raw-final evidence is rejected even under an impressive heading', () => {
  for (const kind of ['test_only', 'command_only', 'child_exit_only', 'raw_final_only'] as const) {
    const admission = admitFYIPCandidate(candidate({ evidence: [{ kind, detail: 'Only this process result' }] }));
    assert.equal(admission.reason, 'evidence_not_admissible');
    assert.equal(classifyFYIPAdmission(admission, { kind: 'response', value: 'yes' }).eligible, false);
  }
  for (const artifact of reference.execution_only) {
    const admission = admitFYIPCandidate(candidate({ title: 'Validation update', current_state: artifact,
      materiality: 'Owners should know the validation result', evidence: [{ kind: 'outcome', detail: artifact }] }));
    assert.equal(admission.reason, 'execution_artifact_only', artifact);
    assert.equal(classifyFYIPAdmission(admission).status, 'not_run');
  }
  assert.equal(admitFYIPCandidate(candidate({ materiality: 'All tests passed' })).reason, 'execution_artifact_only');
});

test('evidence must be substantive and match the candidate kind; support cannot launder forbidden kinds', () => {
  assert.equal(admitFYIPCandidate(candidate({ evidence: [{ kind: 'milestone', detail: 'Deployment reached owners' }] })).reason,
    'evidence_missing');
  assert.equal(admitFYIPCandidate(candidate({ evidence: [reference.candidate.evidence[0],
    { kind: 'test_only', detail: 'All tests passed' }] })).reason, 'evidence_not_admissible');
  assert.equal(admitFYIPCandidate(candidate({ title: 'Latency halved', previous_state: 'Latency is 200 ms',
    current_state: 'Latency is 100 ms', materiality: 'Owners receive a faster response',
    evidence: [{ kind: 'outcome', detail: 'Latency halved' }] })).admitted, true);
});

test('casefold state comparison is Unicode 15.1 full/default, with exact source cleaning order and no NFC', () => {
  for (const [before, after] of [['Straße', 'STRASSE'], ['ẞ', 'ss'], ['Σς', 'σσ'], ['ДЕЛО', 'дело'],
    ['𐐀', '𐐨'], ['ǰ', 'j\u030c'], ['I', 'i']])
    assert.equal(admitFYIPCandidate(candidate({ previous_state: before, current_state: after })).reason, 'unchanged');
  for (const [before, after] of [['I', 'ı'], ['İ', 'i'], ['Å', 'A\u030a'], ['Balance is -5', 'Balance is +5'],
    ['Rule selects values <= 5', 'Rule selects values >= 5']])
    assert.equal(admitFYIPCandidate(candidate({ previous_state: before, current_state: after })).admitted, true);
  assert.equal(admitFYIPCandidate(candidate({ previous_state: 'Clean **TEXT**', current_state: 'clean text' })).reason, 'unchanged');
  assert.equal(admitFYIPCandidate(candidate({ previous_state: 'Same\u0085state', current_state: 'same state' })).reason, 'unchanged');
  assert.equal(admitFYIPCandidate(candidate({ previous_state: 'Bad\ud800', current_state: 'bad?' })).reason, 'unchanged');
});

test('accepted minimization redacts exact/formatter-normalized secrets before returning classifier context', () => {
  const secrets = ['opaque__value', 'private\x00token', 'explicit-synthetic-secret'];
  const input = candidate({ current_state: 'Release is available; opaque__value opaquevalue private\x00token privatetoken',
    materiality: 'Owners can validate explicit-synthetic-secret', evidence: [{ kind: 'outcome',
      detail: 'Owner confirmed workflow works opaque__value opaquevalue private\x00token privatetoken' }] });
  const admission = admitFYIPCandidate(input, secrets);
  assert.equal(admission.admitted, true);
  const context = JSON.stringify(admission.context);
  for (const secret of [...secrets, 'opaquevalue', 'privatetoken']) assert.ok(!context.includes(secret));
  assert.ok(context.includes('[redacted]'));
});

test('source formatter minimization omits credentials, links, paths, code and controls without claiming publication safety', () => {
  const admission = admitFYIPCandidate(candidate({ current_state:
    'Workflow usable sk-example123 https://example.invalid/x /tmp/private a@example.invalid **now**\u200b',
    evidence: [{ kind: 'outcome', detail: 'Owner verified workflow password=unlistedvalue' }] }));
  assert.equal(admission.admitted, true);
  const context = JSON.stringify(admission.context);
  for (const forbidden of ['sk-example123', 'https://', '/tmp/private', 'a@example.invalid', '**', '\u200b', 'unlistedvalue'])
    assert.ok(!context.includes(forbidden), forbidden);
  assert.ok(context.includes('[redacted]')); assert.ok(context.includes('[path]')); assert.ok(context.includes('[email]'));
  assert.equal(admitFYIPCandidate(candidate({ title: '```private code```' })).reason, 'invalid_schema');
});

test('minimization preserves Python Unicode word boundaries, whitespace and ignore-case detector behavior', () => {
  const admission = admitFYIPCandidate(candidate({ current_state:
    'Usable ésk-example123 https://example.invalid/x\u0085retained /tmp/private\u0085also-retained',
    evidence: [{ kind: 'outcome', detail: 'Owner verifies APİ_KEY=opaquevalue for workflow' }] }));
  assert.equal(admission.admitted, true);
  assert.ok(admission.context?.current_state.includes('ésk-example123')); // No Unicode word boundary before sk.
  assert.ok(admission.context?.current_state.includes('retained'));
  assert.ok(admission.context?.current_state.includes('also-retained'));
  assert.ok(!admission.context?.evidence[0].detail.includes('opaquevalue'));
  assert.equal(admitFYIPCandidate(candidate({ evidence: [{ kind: 'outcome', detail: 'GİT status --short' }] })).reason,
    'execution_artifact_only');
});

test('ignore-case token matching never changes Unicode word classification (U+0345)', () => {
  const admission = admitFYIPCandidate(candidate({ current_state: 'Available \u0345password=opaquevalue now' }));
  assert.equal(admission.admitted,true);
  assert.ok(!JSON.stringify(admission.context).includes('opaquevalue'));
  assert.equal(admission.context?.current_state,'Available \u0345password=[redacted] now');
  const command = admitFYIPCandidate(candidate({ evidence: [{kind:'outcome',detail:'python 文件.py'}] }));
  assert.equal(command.reason,'execution_artifact_only');
  assert.equal(classifyFYIPAdmission(command,{kind:'response',value:'yes'}).status,'not_run');
});

test('strict plain candidate/evidence shape, source scalar bounds, bounded explicit secret list', () => {
  for (const value of [null, [], 'raw final', { ...candidate(), extra: true },
    { ...candidate(), reconciled: 'true' }, { ...candidate(), kind: 'raw_final_only' },
    candidate({ title: '' }), candidate({ title: 'x'.repeat(121) }), candidate({ title: '𠀀'.repeat(121) }),
    candidate({ evidence: [] }), candidate({ evidence: Array(4).fill(reference.candidate.evidence[0]) }),
    candidate({ evidence: [{ kind: 'outcome', detail: 'x', extra: true }] as never }) ])
    assert.equal(admitFYIPCandidate(value).reason, 'invalid_schema');
  assert.equal(admitFYIPCandidate(candidate({ title: '𠀀'.repeat(120) })).admitted, true);
  for (const secrets of ['not-list', Array(33).fill('a'), [null], ['s'.repeat(4097)]])
    assert.equal(admitFYIPCandidate(candidate(), secrets).reason, 'invalid_schema');
  assert.equal(admitFYIPCandidate(candidate(), ['']).admitted, true);
  assert.equal(FYIP_LIMITS.context, 1200);
});

test('total context bound is independently enforced after minimization, including exact1200 boundary', () => {
  const input = candidate({ title: 'T'.repeat(120), previous_state: 'P'.repeat(240), current_state: 'C'.repeat(240),
    materiality: 'Owners now '.padEnd(240, 'm'), evidence: Array.from({ length: 3 }, () => ({ kind: 'outcome', detail: 'E'.repeat(120) })) });
  const admission = admitFYIPCandidate(input); assert.equal(admission.admitted, true);
  if (admission.admitted) assert.equal([admission.context.title, admission.context.previous_state, admission.context.current_state,
    admission.context.materiality, ...admission.context.evidence.map(e => e.detail)].reduce((n, s) => n + [...s].length, 0), 1200);
  const over = structuredClone(input); (over.evidence as {kind:'outcome';detail:string}[])[0].detail += 'E';
  assert.equal(admitFYIPCandidate(over).reason, 'context_too_large');
});

test('yes/no and failure provenance is pure, exact and failopen only after admitted baseline', () => {
  const admission = admitFYIPCandidate(candidate());
  for (const choice of ['yes', 'no'] as const) {
    const classification = classifyFYIPAdmission(admission, { kind: 'response', value: choice });
    assert.equal(classification.eligible, choice === 'yes'); assert.equal(classification.status, 'classified_' + choice);
    assert.equal(classification.choice, choice);
    assert.equal(classification.leading_status, choice === 'yes' ? 'FYIP · classified yes' : null);
  }
  for (const [observation, status] of [ [undefined, 'fallback_unavailable'],
    [{ kind: 'unavailable' }, 'fallback_unavailable'], [{ kind: 'uncertain' }, 'fallback_uncertain'],
    [{ kind: 'error' }, 'fallback_error'], [{ kind: 'response', value: null }, 'fallback_unavailable'],
    ...['YES', 'yes ', 'uncertain', true, { choice: 'yes' }].map(value => [{ kind: 'response', value }, 'fallback_invalid'])
  ] as Array<[ClassifierObservation | undefined, string]>) {
    const classification = classifyFYIPAdmission(admission, observation);
    assert.equal(classification.eligible, true); assert.equal(classification.status, status);
    assert.equal(classification.choice, null); assert.match(classification.leading_status!, /unclassified/);
    const rejected = admitFYIPCandidate(candidate({ reconciled: false }));
    assert.equal(classifyFYIPAdmission(rejected, observation).eligible, false);
    assert.equal(classifyFYIPAdmission(rejected, observation).status, 'not_run');
  }
});

test('attention and reminder bypass is honest and has no classifier/delivery result', () => {
  for (const reason of ['explicit_attention', 'reminder'] as const) {
    const result = bypassFYIPClassification(reason);
    assert.equal(result.eligible, true); assert.equal(result.status, 'bypassed');
    assert.equal(result.choice, null); assert.equal(result.leading_status, null); assert.equal(result.bypass_reason, reason);
    assert.equal('delivery' in result, false);
  }
  assert.throws(() => bypassFYIPClassification('attention' as never), { message: 'fyip_bypass_invalid' });
});
