import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createNotificationExtension } from '../../index.ts';
import type { PublishFYIPArguments, FYIPReceipt } from '../../core/types.ts';
import { waitForTestClefRequest, completeLateTestClef } from '../../core/clef.ts';
import { READ, SEND } from '../../adapter/schema.ts';
import { deniedAttempts } from '../adapter/deny-runtime.ts';
import { fixture, revision } from './fixture.ts';
import type { ToolResult } from './fixture.ts';

const candidate = { kind: 'milestone', title: 'Requested capability available', previous_state: 'Capability not available',
  current_state: 'Requested capability is usable now', materiality: 'Owner can use the requested capability',
  evidence: [{ kind: 'milestone', detail: 'Observed requested capability in the completed service' }], reconciled: true } as const;
const args = (): PublishFYIPArguments => ({ decision_key: 'fyip/update', revision, candidate: structuredClone(candidate) });
function receipt(result: ToolResult): FYIPReceipt {
  assert.notEqual(result.isError, true, JSON.stringify(result.details));
  const value = result.details as FYIPReceipt;
  assert.ok(['sent', 'duplicate', 'held', 'unknown', 'suppressed'].includes(value.state)); return value;
}
after(() => { assert.equal(process.env.PATH, '/__notification_no_executables__'); assert.deepEqual(deniedAttempts, []); });

test('actual FYIP entry/core admits YES with strict model-only reach, canonical publication and frozen identity', async t => {
  const h = fixture(t, 'echo', { fyip: 'yes' });
  assert.deepEqual([...h.tools.keys()].sort(), ['notification_owner_request', 'notification_poke_hint', 'notification_publish', 'notification_publish_fyip', 'notification_reminder_tick']);
  const tool = h.tools.get('notification_publish_fyip') as any;
  assert.equal(tool.exposure, 'model-only'); assert.equal(tool.executionMode, 'sequential');
  assert.deepEqual(tool.reachesTools({}), [SEND, READ]);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.equal(tool.parameters.properties.candidate.additionalProperties, false);
  const first = receipt(await h.invokeFYIP({ ...args(), review_link: { label: 'Review', url: 'https://review.example.invalid/' } }));
  assert.equal(first.state, 'sent'); assert.equal(first.classification.status, 'classified_yes');
  assert.equal(first.admission.test_only, true); assert.equal(first.delivery.test_only, true);
  const row = h.rows('deliveries')[0];
  assert.equal(row.profile_id, 'test-only.primary'); assert.equal(row.destination_id, 'test-only.owner');
  assert.equal(row.purpose, 'fyip'); assert.equal(row.state, 'sent');
  assert.deepEqual(h.dispatches.map(c => c.name), [SEND, READ]);
  assert.equal(h.rows('canonical_associations')[0].read_verified, 1);
  assert.match(h.telegramHttpClient.messages[0].text, /^FYIP · classified yes\nSource: Pi session/);
  assert.equal(h.clefHttpClient!.requests.length, 1); assert.equal(h.telegramHttpClient.requests.length, 1);
  const frozen = h.rows('fyip_decisions');
  await h.restart(); h.host.session = 'another-session';
  const changed = { ...args(), candidate: { ...candidate, title: 'Changed assertion' },
    review_link: { label: 'Other', url: 'https://other.example.invalid/' } };
  assert.equal(receipt(await h.invokeFYIP(changed)).state, 'duplicate');
  assert.deepEqual(h.rows('fyip_decisions'), frozen);
  assert.equal(h.clefHttpClient!.requests.length, 1); assert.equal(h.dispatches.length, 2);
  assert.equal(h.telegramHttpClient.requests.length, 1);
});

test('valid NO including zero confidence is quiet, durable and test-only rather than a delivery receipt', async t => {
  for (const fyip of ['no', 'low-confidence-no'] as const) {
    const h = fixture(t, 'echo', { fyip });
    const result = receipt(await h.invokeFYIP(args()));
    assert.equal(result.state, 'suppressed'); assert.equal(result.classification.status, 'classified_no');
    assert.equal(result.delivery.status, 'not_attempted'); assert.equal(result.admission.test_only, true);
    assert.equal(h.dispatches.length, 0); assert.equal(h.telegramHttpClient.requests.length, 0);
    assert.equal(h.rows('deliveries').length, 0);
    assert.equal(h.rows('fyip_decisions')[0].profile_id, 'test-only.primary');
    assert.equal(h.rows('fyip_decisions')[0].destination_id, 'test-only.owner');
    await h.restart(); assert.equal(receipt(await h.invokeFYIP(args())).state, 'suppressed');
    assert.equal(h.clefHttpClient!.requests.length, 1);
  }
});

test('FYIP structural overrides reject; semantic invalid candidates remain core not_run without classifier/effects', async t => {
  const h = fixture(t, 'echo', { fyip: 'yes' });
  for (const extra of ['text', 'policy', 'profile', 'destination', 'owner', 'proof', 'verified', 'transport', 'clefConfigPath']) {
    const result = await h.invokeFYIP({ ...args(), [extra]: 'override' });
    assert.equal(result.isError, true); assert.deepEqual(result.details, { code: 'invalid_request' });
  }
  for (const value of [{ ...candidate, owner: 'forged' }, { ...candidate, evidence: [{ ...candidate.evidence[0], proof: true }] }, null])
    assert.equal((await h.invokeFYIP({ ...args(), candidate: value })).isError, true);
  for (const value of [{ ...candidate, reconciled: false }, { ...candidate, current_state: candidate.previous_state },
    { ...candidate, evidence: [] }, { ...candidate, evidence: [{ kind: 'raw_final_only', detail: 'An uncurated final' }] },
    { ...candidate, evidence: [{ kind: 'command_only', detail: 'Completed command' }] },
    { ...candidate, evidence: [{ kind: 'child_exit_only', detail: 'Child finished' }] }]) {
    const result = receipt(await h.invokeFYIP({ ...args(), candidate: value }));
    assert.equal(result.state, 'held'); assert.equal(result.classification.status, 'not_run');
  }
  assert.equal(h.clefHttpClient!.requests.length, 0); assert.equal(h.rows('fyip_decisions').length, 0);
  assert.equal(h.dispatches.length, 0); assert.equal(h.rows('deliveries').length, 0);
  assert.equal(h.telegramHttpClient.requests.length, 0);
});

test('only admitted live classifier failures enter labeled fallback, frozen once across restart', async t => {
  for (const fyip of ['invalid', 'error', 'duplicate-json', 'nonfinite', 'redirect', 'invalid-utf8', 'oversized', 'deep-json'] as const) {
    const h = fixture(t, 'echo', { fyip });
    const result = receipt(await h.invokeFYIP(args()));
    assert.equal(result.state, 'sent'); assert.match(result.classification.status, /^fallback_/);
    assert.match(h.telegramHttpClient.messages[0].text, /^FYIP · unclassified/);
    assert.equal(h.rows('fyip_decisions')[0].classification_status, result.classification.status);
    await h.restart(); assert.equal(receipt(await h.invokeFYIP(args())).state, 'duplicate');
    assert.equal(h.clefHttpClient!.requests.length, 1); assert.equal(h.dispatches.length, 2);
    assert.equal(h.telegramHttpClient.requests.length, 1);
  }
});

test('unrestricted Unicode FYIP admission/YES remains independent of held publication grammar', async t => {
  const h = fixture(t, 'echo', { fyip: 'yes' });
  const result = receipt(await h.invokeFYIP({ ...args(), candidate: { ...candidate, title: 'Διαθέσιμη δυνατότητα' } }));
  assert.equal(result.state, 'held'); assert.equal(result.classification.status, 'classified_yes');
  assert.equal(h.clefHttpClient!.requests.length, 1); assert.equal(h.rows('fyip_decisions')[0].choice, 'yes');
  assert.equal(h.rows('deliveries').length, 0); assert.equal(h.dispatches.length, 0);
  assert.equal(h.telegramHttpClient.requests.length, 0);
});

test('fresh originating cancellation fences late Clef YES; restart never falls back or reclassifies', async t => {
  const h = fixture(t, 'echo', { fyip: 'late' }); const controller = new AbortController();
  const running = h.invokeFYIP(args(), controller); await waitForTestClefRequest(h.clefHttpClient!);
  controller.abort(); const result = await running;
  assert.equal(result.isError, true); assert.deepEqual(result.details, { code: 'cancelled' });
  completeLateTestClef(h.clefHttpClient!); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.rows('fyip_decisions')[0].state, 'terminal_unknown');
  await h.restart(); assert.equal(receipt(await h.invokeFYIP(args())).state, 'held');
  assert.equal(h.clefHttpClient!.requests.length, 1); assert.equal(h.dispatches.length, 0);
  assert.equal(h.telegramHttpClient.requests.length, 0);
});

test('FYIP canonical readback failure preserves unknown and frozen YES without replay', async t => {
  const h = fixture(t, 'echo', { fyip: 'yes' });
  h.state.mutate = (stage, native) => { if (stage === 'read') native.structuredContent.thread.messages[0].body += ' changed'; };
  assert.equal(receipt(await h.invokeFYIP(args())).state, 'unknown');
  const rows = h.rows('deliveries'); h.state.mutate = undefined; await h.restart();
  assert.equal(receipt(await h.invokeFYIP(args())).state, 'unknown');
  assert.deepEqual(h.rows('deliveries'), rows); assert.equal(h.clefHttpClient!.requests.length, 1);
  assert.equal(h.dispatches.length, 2); assert.equal(h.telegramHttpClient.requests.length, 0);
});

test('actual construction rejects fake classifier without fake Telegram before config/lookup or native effects', async t => {
  const h = fixture(t, 'echo', { fyip: 'no' }); let tool: any;
  createNotificationExtension({ clefHttpClient: h.clefHttpClient })({
    registerFlag() {}, getFlag: () => h.configPath, on() {},
    registerTool(value: any) { if (value.name === 'notification_publish_fyip') tool = value; },
  } as unknown as ExtensionAPI);
  const result = await tool.execute('mixed-mode', args(), new AbortController().signal, undefined, h.ctx);
  assert.equal(result.isError, true); assert.deepEqual(result.details, { code: 'internal_error' });
  assert.equal(h.rows('fyip_decisions').length, 0); assert.equal(h.dispatches.length, 0);
  assert.equal(h.clefHttpClient!.requests.length, 0); assert.equal(h.telegramHttpClient.requests.length, 0);
});
