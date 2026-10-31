import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createNotificationExtension } from '../../index.ts';
import type { OwnerRequestReceipt } from '../../core/types.ts';
import { READ, SEND } from '../../adapter/schema.ts';
import { deniedAttempts } from '../adapter/deny-runtime.ts';
import { fixture, argument, receiptOf } from './fixture.ts';
import type { ToolResult } from './fixture.ts';

function receipt(result: ToolResult): OwnerRequestReceipt { return receiptOf(result) as OwnerRequestReceipt; }
after(() => { assert.equal(process.env.PATH, '/__notification_no_executables__'); assert.deepEqual(deniedAttempts, []); });

for (const owner of ['unanswered', 'direct-answer', 'snooze'] as const) {
  test('actual owner entry/core: ' + owner + ' uses canonical shared publication and durable controls', async t => {
    const h = fixture(t, 'echo', { owner });
    const tool = h.tools.get('notification_owner_request') as any;
    assert.equal(tool.exposure, 'model-only'); assert.equal(tool.executionMode, 'sequential');
    assert.deepEqual(tool.reachesTools({}), [SEND, READ]);
    assert.equal(tool.parameters.additionalProperties, false);
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['decision_key', 'review_link', 'revision', 'text']);
    h.state.onNative = stage => {
      if (stage === 'send') {
        assert.equal(h.rows('pending_owner_requests')[0].state, 'reserved');
        assert.equal(h.rows('deliveries')[0].state, 'in_flight');
      }
    };
    const result = receipt(await h.invokeOwner(argument()));
    assert.equal(result.state, 'sent'); assert.equal(result.classification.bypass_reason, 'owner_request');
    assert.equal(result.tracking?.status, owner === 'direct-answer' ? 'paused_answer' : 'active');
    assert.equal(result.admission.test_only, true); assert.equal(result.delivery.test_only, true);
    const row = h.rows('pending_owner_requests')[0];
    assert.equal(row.profile_id, 'test-only.primary'); assert.equal(row.destination_id, 'test-only.owner');
    assert.equal(row.original_session_id, 'synthetic-session');
    assert.equal(row.state, owner === 'direct-answer' ? 'paused_answer' : 'active');
    assert.equal(row.answer_evidence_json !== null, owner === 'direct-answer');
    assert.equal(row.snoozed_until, owner === 'snooze' ? 4000.5 : null);
    assert.equal(h.rows('canonical_associations')[0].read_verified, 1);
    assert.deepEqual(h.dispatches.map(call => call.name), [SEND, READ]);
    assert.match(h.telegramHttpClient.messages[0].text, /^Attention · owner request/);
    assert.equal(h.telegramHttpClient.requests.length, 1);
    const pending = h.rows('pending_owner_requests'), deliveries = h.rows('deliveries');
    await h.restart(); h.host.session = 'fresh-invocation';
    assert.equal(receipt(await h.invokeOwner({ ...argument(), text: 'Changed request does not refresh tracking.' })).state, 'duplicate');
    assert.deepEqual(h.rows('pending_owner_requests'), pending); assert.deepEqual(h.rows('deliveries'), deliveries);
    assert.equal(h.dispatches.length, 2); assert.equal(h.telegramHttpClient.requests.length, 1);
  });
}

test('actual unsupported owner holds early before any claim, native dispatch or delivery', async t => {
  const h = fixture(t, 'echo', { owner: 'actual' });
  h.start({ defaultEntry: true });
  const result = receipt(await h.invokeOwner());
  assert.equal(result.state, 'held'); assert.equal(result.admission.reason, 'owner_evidence_unavailable');
  assert.equal(result.tracking?.status, 'not_enrolled');
  assert.equal(h.rows('pending_owner_requests').length, 0); assert.equal(h.rows('deliveries').length, 0);
  assert.equal(h.dispatches.length, 0); assert.equal(h.telegramHttpClient.requests.length, 0);
});

test('owner structural selectors are rejected without second admission or effects', async t => {
  const h = fixture(t, 'echo', { owner: 'unanswered' });
  for (const field of ['owner', 'proof', 'verified', 'profile', 'destination', 'policy', 'hour', 'configPath',
    'ownerEvidenceProvider', 'transport', 'signal', 'project_path']) {
    const result = await h.invokeOwner({ ...argument(), [field]: 'override' });
    assert.equal(result.isError, true); assert.deepEqual(result.details, { code: 'invalid_request' });
  }
  assert.equal(h.rows('pending_owner_requests').length, 0); assert.equal(h.rows('deliveries').length, 0);
  assert.equal(h.dispatches.length, 0); assert.equal(h.telegramHttpClient.requests.length, 0);
});

test('fake owner without fake Telegram is rejected before configuration lookup/core effects', async t => {
  const h = fixture(t, 'echo', { owner: 'unanswered' }); let tool: any;
  createNotificationExtension({ ownerEvidenceProvider: h.ownerEvidenceProvider })({
    registerFlag() {}, getFlag: () => '/nonexistent-notification-config', on() {},
    registerTool(value: any) { if (value.name === 'notification_owner_request') tool = value; },
  } as unknown as ExtensionAPI);
  const result = await tool.execute('mixed-owner', argument(), new AbortController().signal, undefined, h.ctx);
  assert.equal(result.isError, true); assert.deepEqual(result.details, { code: 'internal_error' });
  assert.equal(h.rows('pending_owner_requests').length, 0); assert.equal(h.rows('deliveries').length, 0);
  assert.equal(h.dispatches.length, 0); assert.equal(h.telegramHttpClient.requests.length, 0);
});

test('actual owner entry cap32 holds next request without claim/read/send/Telegram', async t => {
  const h = fixture(t, 'echo', { owner: 'unanswered' });
  for (let i = 0; i < 32; i++) assert.equal(receipt(await h.invokeOwner(argument('request/' + i))).state, 'sent');
  assert.equal(h.rows('pending_owner_requests').length, 32);
  const result = receipt(await h.invokeOwner(argument('request/overflow')));
  assert.equal(result.state, 'held'); assert.equal(result.admission.reason, 'owner_capacity_held');
  assert.equal(h.rows('deliveries').length, 32); assert.equal(h.rows('pending_owner_requests').length, 32);
  assert.equal(h.dispatches.length, 64); assert.equal(h.telegramHttpClient.requests.length, 32);
});
