import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, argument, revision, receiptOf } from './fixture.ts';
import type { FYIPReceipt } from '../../core/types.ts';
import type { ReminderClock } from '../../adapter/reminder-scheduler.ts';
import type { PokeClock } from '../../adapter/poke-controller.ts';
import { SEND, READ } from '../../adapter/schema.ts';
import { deniedAttempts } from '../adapter/deny-runtime.ts';
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const fyipArgs = () => ({ decision_key: 'minimal/milestone', revision, candidate: {
  kind: 'milestone', title: 'Requested capability available', previous_state: 'Capability not available',
  current_state: 'Requested capability is usable now', materiality: 'Owner can use the requested capability',
  evidence: [{ kind: 'milestone', detail: 'Observed requested capability in the completed service' }], reconciled: true } });
class NoAutomaticClock implements ReminderClock, PokeClock {
  timers = 0; immediates = 0;
  now = () => Date.parse('2026-01-02T23:00:00Z'); elapsed = () => 10_000;
  schedule = (_fn: () => void, _delay: number) => { this.timers++; return () => {}; };
  immediate = (_fn: () => void) => { this.immediates++; return () => {}; };
}
after(() => { assert.equal(process.env.PATH, '/__notification_no_executables__'); assert.deepEqual(deniedAttempts, []); });

test('actual minimal entry exposes ONLY two strict sequential publishers with same fixed native reach', async t => {
  const h = fixture(t, 'echo', { minimal: true, fyip: 'yes', owner: 'unanswered' });
  assert.deepEqual([...h.tools.keys()].sort(), ['notification_publish', 'notification_publish_fyip']);
  for (const tool of h.tools.values() as Iterable<any>) {
    assert.equal(tool.exposure, 'model-only'); assert.equal(tool.executionMode, 'sequential');
    assert.deepEqual(tool.reachesTools({}), [SEND, READ]); assert.equal(tool.parameters.additionalProperties, false);
  }
  assert.equal(h.flag.reads, 0, 'factory does not capture unbound SDK flags');
  assert.equal(h.state.observations, 0); assert.equal(h.dispatches.length, 0);
  await h.events.get('session_start')!();
  const result = receiptOf(await h.invoke()); assert.equal(result.state, 'sent');
  assert.equal(receiptOf(await h.invoke()).state, 'duplicate');
  assert.deepEqual(h.dispatches.map(d => d.name), [SEND, READ]);
  assert.ok(h.rows('deliveries').every(r => r.profile_id === 'test-only.primary' && r.destination_id === 'test-only.owner'));
  assert.equal(h.modelRequests.length, 0);
});

test('actual selected default minimal export is inert without config and registers only two tools', async t => {
  const h = fixture(t, 'echo', { minimal: true, fyip: 'yes' });
  h.start({ noConfig: true, defaultEntry: true });
  assert.equal(h.flag.reads, 0); await h.events.get('session_start')!();
  assert.deepEqual([...h.tools.keys()].sort(), ['notification_publish', 'notification_publish_fyip']);
  assert.equal(h.state.observations, 0); assert.equal(h.modelRequests.length, 0);
  assert.deepEqual((await h.invoke()).details, { code: 'configuration_unavailable' });
  assert.equal(h.dispatches.length, 0); await h.events.get('session_shutdown')!();
});

for (const fyip of ['yes', 'no', 'invalid'] as const) test('minimal actual entry preserves core FYIP ' + fyip, async t => {
  const h = fixture(t, 'echo', { minimal: true, fyip, owner: 'unanswered' });
  await h.events.get('session_start')!();
  const result = await h.invokeFYIP(fyipArgs()); assert.notEqual(result.isError, true);
  const receipt = result.details as FYIPReceipt;
  assert.equal(receipt.state, fyip === 'no' ? 'suppressed' : 'sent');
  if (fyip === 'yes') assert.equal(receipt.classification.status, 'classified_yes');
  if (fyip === 'invalid') assert.match(receipt.classification.status, /^fallback_/);
  assert.equal(h.clefHttpClient!.requests.length, 1);
  assert.equal(h.telegramHttpClient.requests.length, fyip === 'no' ? 0 : 1);
  assert.equal(h.dispatches.length, fyip === 'no' ? 0 : 2);
  assert.equal(h.modelRequests.length, 0);
});

for (const minimal of [true, false]) test('actual ' + (minimal ? 'minimal' : 'full') + ' factory undefined → SDK-bound absolute → session_start uses one captured path', async t => {
  const h = fixture(t, 'echo', { minimal, fyip: 'yes', owner: 'unanswered' });
  h.start({ deferFlag: true }); assert.equal(h.flag.value, undefined); assert.equal(h.flag.reads, 0);
  h.flag.value = h.configPath; // Mirrors SDK binding AFTER extension factory, BEFORE session_start.
  await h.events.get('session_start')!(); assert.equal(h.flag.reads, 1);
  assert.equal(receiptOf(await h.invoke()).state, 'sent');
  h.flag.value = 'later-relative-rebind-is-not-supported';
  await h.events.get('session_start')!();
  assert.equal(receiptOf(await h.invoke(argument('minimal/second'))).state, 'sent');
  assert.equal(h.flag.reads, 1, 'lifecycle changes revoke operations, not reconfigure the adapter');
});

for (const minimal of [true, false]) for (const kind of ['missing', 'relative', 'invalid', 'getter_error'] as const)
  test('actual ' + (minimal ? 'minimal' : 'full') + ' postbinding flag ' + kind + ' holds before observations/effects', async t => {
    const clock = new NoAutomaticClock();
    const h = fixture(t, 'echo', { minimal, fyip: 'yes', reminderClock: clock, pokeClock: clock });
    h.start({ deferFlag: true });
    h.flag.value = kind === 'relative' ? 'relative.json' : kind === 'invalid' ? { path: h.configPath } : undefined;
    h.flag.error = kind === 'getter_error';
    await h.events.get('session_start')!();
    assert.equal(h.flag.reads, 1); assert.equal(h.state.observations, 0);
    assert.deepEqual((await h.invoke()).details, { code: 'configuration_unavailable' });
    assert.deepEqual((await h.invokeFYIP(fyipArgs())).details, { code: 'configuration_unavailable' });
    assert.equal(h.state.observations, 0); assert.equal(h.dispatches.length, 0);
    assert.equal(h.clefHttpClient!.requests.length, 0); assert.equal(h.telegramHttpClient.requests.length, 0);
    assert.equal(clock.timers, 0); assert.equal(clock.immediates, 0); assert.equal(h.modelRequests.length, 0);
    h.flag.error = false; h.flag.value = h.configPath; await h.events.get('session_start')!();
    assert.deepEqual((await h.invoke()).details, { code: 'configuration_unavailable' });
    assert.equal(h.flag.reads, 1, 'invalid first resolution stays configure-once inert');
  });

for (const minimal of [true, false]) test('actual ' + (minimal ? 'minimal' : 'full') + ' postbinding valid disabled project holds', async t => {
  const h = fixture(t, 'echo', { minimal, fyip: 'yes' });
  h.start({ deferFlag: true }); h.config.projects[0].enabled = false; h.save(); h.flag.value = h.configPath;
  await h.events.get('session_start')!();
  assert.equal(receiptOf(await h.invoke()).state, 'held');
  assert.equal((await h.invokeFYIP(fyipArgs())).isError, undefined);
  assert.equal(h.dispatches.length, 0); assert.equal(h.clefHttpClient!.requests.length, 0);
  assert.equal(h.telegramHttpClient.requests.length, 0); assert.equal(h.modelRequests.length, 0);
});

test('minimal enabled product + seeded due owner state has no controllers, automatic hooks, timers, plans or model requests', async t => {
  const clock = new NoAutomaticClock();
  const h = fixture(t, 'echo', { minimal: true, fyip: 'yes', owner: 'unanswered', reminderClock: clock,
    pokeClock: clock, clock: () => clock.now() / 1000 });
  // Seed real due state through the preserved full entry in this disposable fixture,
  // BEFORE constructing the minimal entry. Not a minimal tool/activation route.
  h.start({ minimal: false }); assert.notEqual((await h.invokeOwner()).isError, true);
  assert.equal(h.rows('pending_owner_requests').length, 1); await h.events.get('session_shutdown')!();
  h.start(); const dispatches = h.dispatches.length, observations = h.state.observations;
  assert.deepEqual([...h.tools.keys()].sort(), ['notification_publish', 'notification_publish_fyip']);
  await h.events.get('session_start')!();
  for (const event of ['input', 'before_agent_start', 'agent_start', 'turn_start', 'message_start', 'turn_end', 'agent_settled',
    'ui_prompt_start', 'ui_prompt_end', 'session_before_switch', 'session_before_fork', 'session_before_tree', 'session_tree'])
    await h.events.get(event)?.({ source: 'interactive', text: 'ordinary work', messageType: 'user', prompt: 'ordinary work',
      message: { role: 'assistant', content: 'raw final unfinished work' }, outcome: 'completed', aborted: false });
  assert.equal(h.events.has('agent_settled'), false); assert.equal(h.events.has('before_agent_start'), false);
  assert.equal(clock.timers, 0); assert.equal(clock.immediates, 0);
  assert.equal(h.modelRequests.length, 0); assert.equal(h.dispatches.length, dispatches);
  assert.equal(h.rows('reminder_occurrences').length, 0);
  assert.equal(h.state.observations, observations, 'minimal lifecycle did not observe scope or plan seeded due work');
});

for (const event of ['session_before_switch', 'session_before_fork', 'session_before_tree', 'session_tree', 'session_shutdown', 'session_start', 'input', 'scope'])
  test('minimal pending publication lifetime is revoked by ' + event + ' without replay after late settlement', async t => {
    const h = fixture(t, 'echo', { minimal: true, fyip: 'yes' }); await h.events.get('session_start')!();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; }); t.after(() => release());
    h.state.onNative = async () => { entered(); await gate; };
    const running = h.invoke(); await reached;
    if (event === 'scope') { h.host.session = 'changed-scope'; release(); }
    else await h.events.get(event)!();
    const result = await running; assert.equal(result.isError, true); assert.deepEqual(result.details, { code: 'cancelled' });
    release(); await flush(); h.state.onNative = undefined;
    assert.equal(h.dispatches.length, 1); assert.equal(h.modelRequests.length, 0);
    assert.equal(h.telegramHttpClient.requests.length, 0);
    if (event !== 'session_shutdown') {
      assert.equal(receiptOf(await h.invoke(argument('minimal/fresh'))).state, 'sent', 'late settlement grants no old callback; fresh invocation may proceed');
      assert.equal(h.dispatches.length, 3);
    }
  });

test('minimal publisher retains originating abort, unavailable-native and strict no-selector boundaries', async t => {
  const h = fixture(t, 'echo', { minimal: true, fyip: 'yes' }); await h.events.get('session_start')!();
  const abort = new AbortController(); abort.abort();
  assert.deepEqual((await h.invoke(argument(), abort)).details, { code: 'cancelled' });
  for (const extra of ['owner', 'policy', 'minimal', 'features', 'configPath', 'transport', 'purpose'])
    assert.deepEqual((await h.invoke({ ...argument(), [extra]: 'override' })).details, { code: 'invalid_request' });
  h.ctx.tools.length = 0;
  assert.equal(receiptOf(await h.invoke(argument('minimal/no-native'))).state, 'unknown');
  assert.equal(h.dispatches.length, 0); assert.equal(h.telegramHttpClient.requests.length, 0);
});
