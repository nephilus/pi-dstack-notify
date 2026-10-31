import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { deniedAttempts } from '../adapter/deny-runtime.ts';
import { argument, fixture, receiptOf } from './fixture.ts';

after(() => {
  assert.equal(process.env.PATH, '/__notification_no_executables__');
  assert.deepEqual(deniedAttempts, []);
});

test('actual public entry rejects unsafe native project identities before association and HTTP', async t => {
  for (const unsafe of ['prj_\u202eX', 'prj_\u0001X', 'prj_\ud800X', 'prj_\u200bX', 'prj_\uffffX']) {
    const h = fixture(t);
    // Consistent forged send/read identity: rejection must not rely on mismatch.
    h.state.mutate = (stage, native) => {
      if (stage === 'send') {
        native.structuredContent.project.id = unsafe;
        for (const record of h.records.values()) {
          record.read.structuredContent.thread.project.id = unsafe;
          record.read.structuredContent.thread.messages[0].project_id = unsafe;
        }
      }
    };
    const result = receiptOf(await h.invoke());
    assert.equal(result.state, 'unknown');
    assert.equal(JSON.stringify(result).includes(JSON.stringify(unsafe).slice(1, -1)), false);
    assert.equal(h.rows('canonical_associations').length, 0);
    assert.equal(h.rows('deliveries')[0].state, 'delivery_unknown');
    assert.equal(h.telegramHttpClient.requests.length, 0);
    assert.equal(h.dispatches.length, 1, 'unsafe send identity must not reach full read');
    h.state.mutate = undefined;
    await h.restart();
    assert.equal(receiptOf(await h.invoke()).state, 'unknown');
    assert.equal(h.dispatches.length, 1); assert.equal(h.telegramHttpClient.requests.length, 0);
    assert.equal(h.rows('canonical_associations').length, 0);
  }
});

test('public binding-status secret collision holds before effects without reflected metadata', async t => {
  const h = fixture(t);
  await h.restart({ knownSecrets: ['canonical-bound'] });
  const result = receiptOf(await h.invoke());
  assert.equal(result.state, 'held');
  assert.equal(JSON.stringify(result).includes('canonical-bound'), false);
  assert.equal(h.rows('deliveries').length, 0); assert.equal(h.rows('canonical_associations').length, 0);
  assert.equal(h.dispatches.length, 0); assert.equal(h.telegramHttpClient.requests.length, 0);
});

test('receipt metadata protection across restart never releases sent or unknown durable suppression', async t => {
  for (const outcome of ['echo', 'unknown'] as const) {
    const h = fixture(t, outcome);
    const initial = receiptOf(await h.invoke());
    assert.equal(initial.state, outcome === 'echo' ? 'sent' : 'unknown');
    const before = h.rows('deliveries'), associations = h.rows('canonical_associations');
    const effects = h.dispatches.length, requests = h.telegramHttpClient.requests.length;
    await h.restart({ knownSecrets: ['canonical-bound'] });
    const protectedResult = receiptOf(await h.invoke());
    assert.equal(protectedResult.state, 'held'); // Predictable collision preflight.
    assert.equal(JSON.stringify(protectedResult).includes('canonical-bound'), false);
    assert.equal(protectedResult.admission.identity_binding, undefined);
    assert.deepEqual(h.rows('deliveries'), before);
    assert.deepEqual(h.rows('canonical_associations'), associations);
    assert.equal(h.dispatches.length, effects); assert.equal(h.telegramHttpClient.requests.length, requests);
    await h.restart();
    assert.equal(receiptOf(await h.invoke(argument())).state, outcome === 'echo' ? 'duplicate' : 'unknown');
    assert.deepEqual(h.rows('deliveries'), before);
    assert.equal(h.dispatches.length, effects); assert.equal(h.telegramHttpClient.requests.length, requests);
  }
});
