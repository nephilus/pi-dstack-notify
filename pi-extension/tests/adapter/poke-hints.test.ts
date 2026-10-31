import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHint, fingerprint, progresses, VETO_STATES } from '../../adapter/poke-hints.ts';
const candidate = (steps: any[]) => ({ state: 'candidate', steps });
test('advisory normalization is detached, canonical across order/NFC/space and stable fingerprints', () => {
  const input = candidate([{ summary: ' z  z ', state: 'pending' }, { summary: 'e\u0301', state: 'done' }]);
  const normalized = normalizeHint(input)!;
  assert.equal(fingerprint(normalized), fingerprint(normalizeHint(candidate([
    { summary: 'é', state: 'done' }, { summary: 'z z', state: 'pending' }]))));
  input.steps[0].state = 'done'; assert.notEqual(fingerprint(normalized), fingerprint(normalizeHint(input)));
});
test('strict bounded advice refuses extra identity/grant/reset fields and malformed/resource shapes', () => {
  for (const input of [null, [], {}, { state: 'candidate' }, candidate([]), candidate(Array(33).fill({ summary: 'x', state: 'pending' })),
    candidate([{ summary: 'x'.repeat(241), state: 'pending' }]), candidate([{ summary: '\ud800', state: 'pending' }]),
    candidate([{ summary: ' ', state: 'pending' }]), candidate([{ summary: 'x', state: 'running' }]),
    candidate([{ summary: ' x ', state: 'pending' }, { summary: 'x', state: 'done' }]),
    candidate([{ summary: 'x', state: 'pending', owner: true }]), { state: 'done', steps: [] },
    ...['owner', 'role', 'proof', 'verified', 'id', 'timestamp', 'reset', 'epoch'].map(key => ({ state: 'done', [key]: true }))]) {
    assert.equal(normalizeHint(input), undefined, JSON.stringify(input));
  }
  assert.ok(normalizeHint(candidate([{ summary: '😀'.repeat(240), state: 'pending' }])));
  assert.equal(normalizeHint(candidate(Array.from({ length: 32 }, (_, i) => ({ summary: `${i}${'😀'.repeat(238)}`, state: 'pending' })))), undefined);
});
for (const state of ['pending', 'done'] as const) test('step state must be a literal string, not coercible ' + state, () => {
  for (const malformed of [[state], [[state]], new String(state), { toString: () => state }]) {
    const input = candidate([{ summary: 'a', state: malformed }, { summary: 'b', state: 'pending' }]);
    assert.equal(normalizeHint(input), undefined);
  }
  assert.deepEqual(normalizeHint(candidate([{ summary: 'a', state }, { summary: 'b', state: 'pending' }])),
    candidate([{ summary: 'a', state }, { summary: 'b', state: 'pending' }]));
});

test('every explicit terminal/wait state stays a veto and forward progress never accepts catalog churn/reversal/all done', () => {
  for (const state of VETO_STATES) assert.deepEqual(normalizeHint({ state }), { state });
  const hint = (states: string[], name = 'a') => normalizeHint(candidate(states.map((state, i) => ({ summary: name + i, state }))))!;
  const a = hint(['pending', 'pending', 'pending']);
  assert.ok(progresses(a, hint(['done', 'pending', 'pending'])));
  for (const b of [a, hint(['done', 'done', 'done']), hint(['done', 'pending', 'pending'], 'new'), { state: 'unknown' } as const])
    assert.equal(progresses(a, b), false);
  assert.equal(progresses(hint(['done', 'pending', 'pending']), hint(['pending', 'done', 'pending'])), false);
});
