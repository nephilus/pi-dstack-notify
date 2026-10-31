import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestTelegramHttpClient, waitForTestTelegramHttpRequest, completeLateTestTelegramHttp } from '../../core/transport.ts';
import type { ReminderClock } from '../../adapter/reminder-scheduler.ts';
import type { ReminderTickReceipt } from '../../core/types.ts';
import { deniedAttempts } from '../adapter/deny-runtime.ts';
import { fixture, argument } from './fixture.ts';
import type { ToolResult } from './fixture.ts';
import { SEND, READ } from '../../adapter/schema.ts';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
class Clock implements ReminderClock {
  wall = Date.parse('2026-01-02T23:00:00Z'); mono = 0;
  jobs = new Set<{ at: number; fn: () => void }>();
  now = () => this.wall; elapsed = () => this.mono;
  schedule = (fn: () => void, delay: number) => {
    const job = { at: this.mono + delay, fn }; this.jobs.add(job); return () => { this.jobs.delete(job); };
  };
  async pulse(ms = 5000) {
    this.wall += ms; this.mono += ms;
    for (const job of [...this.jobs]) if (job.at <= this.mono) { this.jobs.delete(job); job.fn(); }
    await flush();
  }
  async hour() { this.wall = Math.floor(this.wall / 3600000) * 3600000 + 3600000; await this.pulse(); }
}
function tick(result: ToolResult): ReminderTickReceipt {
  assert.notEqual(result.isError, true, JSON.stringify(result.details));
  return result.details as ReminderTickReceipt;
}
function harness(t: Parameters<typeof fixture>[0], owner: 'unanswered' | 'actual' | 'unknown' = 'unanswered') {
  const clock = new Clock();
  const h = fixture(t, 'echo', { owner, reminderClock: clock, clock: () => clock.wall / 1000 });
  const emit = async (name: string, event?: any) => { await h.events.get(name)?.(event); };
  const start = () => emit('session_start');
  async function begin(message = h.modelRequests.at(-1)?.message) {
    assert.ok(message); h.host.idle = false;
    await emit('before_agent_start', { messageType: 'custom', message });
    await emit('agent_start');
    await emit('turn_start');
  }
  async function end() {
    await emit('turn_end'); h.host.idle = true; await emit('agent_settled', { aborted: false });
  }
  async function run(message = h.modelRequests.at(-1)?.message) { await begin(message); const result = await h.invokeTick(); await end(); return result; }
  return { ...h, clock, emit, startScheduler: start, begin, end, run };
}
after(() => { assert.equal(process.env.PATH, '/__notification_no_executables__'); assert.deepEqual(deniedAttempts, []); });

test('actual registered Tick strict empty schema, scheduled custom/run/first-turn only, healthy32 real originals', async t => {
  const h = harness(t); const tool = h.tools.get('notification_reminder_tick') as any;
  assert.equal(tool.exposure, 'model-only'); assert.equal(tool.executionMode, 'sequential');
  assert.equal(tool.parameters.additionalProperties, false); assert.deepEqual(tool.parameters.properties, {});
  assert.deepEqual(tool.reachesTools({}), [SEND, READ]);
  for (const args of [{ hour: 'now' }, { owner: 'proof' }, { target: 'override' }, { token: 'forged' }, null, []]) {
    const result = await h.invokeTick(args); assert.equal(result.isError, true); assert.deepEqual(result.details, { code: 'invalid_request' });
  }
  assert.deepEqual((await h.invokeTick()).details, { code: 'cancelled' });
  for (let i = 0; i < 32; i++) assert.equal((await h.invokeOwner(argument('request/' + i))).isError, undefined);
  const originals = h.rows('canonical_associations'); const sends = h.state.sends;
  await h.startScheduler(); await h.clock.pulse(); assert.equal(h.modelRequests.length, 1);
  const request = h.modelRequests[0];
  assert.deepEqual(request.control, { triggerTurn: true, deliverAs: 'followUp' });
  assert.equal(request.message.customType, 'notification-reminder-request'); assert.equal(request.message.display, false);
  assert.deepEqual(Object.keys(request.message.details), ['notification_reminder_token']);
  const result = tick(await h.run());
  assert.equal(result.state, 'completed'); assert.equal(result.selected, 32); assert.equal(result.processed, 32);
  assert.equal(result.sent, 32); assert.equal(result.incomplete, 0); assert.equal(result.remaining, 0);
  assert.equal(h.state.sends, sends, 'tick never publishes another Inbox message');
  assert.equal(h.state.reads, 96); assert.equal(h.telegramHttpClient.requests.length, 64);
  assert.deepEqual(h.rows('canonical_associations'), originals);
  assert.equal(h.rows('reminder_occurrences').length, 32);
  assert.ok(h.rows('deliveries').every(row => row.profile_id === 'test-only.primary' && row.destination_id === 'test-only.owner'));
  assert.deepEqual((await h.invokeTick()).details, { code: 'cancelled' });
  await h.clock.pulse(); assert.equal(h.modelRequests.length, 1, 'no same-slot continuation');
});

test('overnight weekend hourly, coalescing, hour jumps and restart request current slot only', async t => {
  const h = harness(t); await h.invokeOwner(); await h.startScheduler(); await h.clock.pulse();
  assert.equal(tick(await h.run()).sent, 1);
  await h.clock.hour(); assert.equal(h.modelRequests.length, 2); assert.equal(tick(await h.run()).sent, 1);
  assert.match(h.rows('reminder_occurrences').at(-1).utc_slot, /2026-01-03T00:/);
  h.clock.wall += 5 * 3600000; await h.clock.pulse(); assert.equal(h.modelRequests.length, 3);
  assert.equal(tick(await h.run()).sent, 1); assert.equal(h.rows('reminder_occurrences').length, 3);
  await h.restart(); await h.clock.pulse(); assert.equal(h.modelRequests.length, 3, 'same-hour terminal core plan suppresses restart');
  await h.clock.hour(); assert.equal(h.modelRequests.length, 4); assert.equal(tick(await h.run()).sent, 1);
  h.clock.wall -= 3600000; await h.clock.pulse(); assert.equal(h.modelRequests.length, 4);
});

for (const owner of ['unanswered', 'actual', 'unknown'] as const) test('zero unnecessary model turns: ' + owner, async t => {
  const h = harness(t, owner); if (owner !== 'unanswered') await h.invokeOwner();
  await h.startScheduler(); await h.clock.pulse(); await h.clock.hour();
  assert.equal(h.modelRequests.length, 0); assert.equal(h.dispatches.length, owner === 'unknown' ? 2 : 0);
});

test('actual Tick observes recorded answer and snooze before claims, then planner stays quiet', async t => {
  for (const owner of ['direct-answer', 'snooze'] as const) {
    const h = harness(t); await h.invokeOwner(); await h.restart({ owner }); await h.clock.pulse();
    assert.equal(h.modelRequests.length, 1);
    const result = tick(await h.run());
    assert.equal(result.sent, 0); assert.equal(result[owner === 'direct-answer' ? 'paused' : 'snoozed'], 1);
    assert.equal(h.rows('reminder_occurrences').length, 0); assert.equal(h.telegramHttpClient.requests.length, 1);
    assert.equal(h.rows('pending_owner_requests')[0].state, owner === 'direct-answer' ? 'paused_answer' : 'active');
    await h.clock.hour(); assert.equal(h.modelRequests.length, 1);
  }
});

test('stale queued followup cannot borrow new arm, wrong run/extra details and second turn cannot execute', async t => {
  const h = harness(t); await h.invokeOwner(); await h.startScheduler(); await h.clock.pulse();
  const stale = structuredClone(h.modelRequests[0].message); h.host.idle = true;
  await h.clock.hour(); const fresh = h.modelRequests.at(-1)!.message; assert.equal(h.modelRequests.length, 2);
  await h.begin(stale); assert.deepEqual((await h.invokeTick()).details, { code: 'cancelled' });
  await h.emit('turn_end');
  await h.begin({ ...fresh, details: { ...fresh.details, forged: true } });
  assert.deepEqual((await h.invokeTick()).details, { code: 'cancelled' });
  await h.begin(fresh); const result = tick(await h.invokeTick()); assert.equal(result.sent, 1);
  await h.emit('turn_end'); await h.emit('turn_start');
  assert.deepEqual((await h.invokeTick()).details, { code: 'cancelled' }); await h.end();
});

test('input, pending messages, UI and navigation cancel admissions; handled/failed leases recover without session_start', async t => {
  const h = harness(t); await h.invokeOwner(); await h.startScheduler();
  h.host.pending = true; await h.clock.pulse(); assert.equal(h.modelRequests.length, 0);
  h.host.pending = false; await h.emit('ui_prompt_start'); await h.clock.pulse(); assert.equal(h.modelRequests.length, 0);
  await h.emit('ui_prompt_end');
  for (const event of ['input', 'session_before_switch', 'session_before_fork', 'session_before_tree']) {
    await h.emit(event); h.clock.wall -= 3600000; await h.clock.pulse(4999); assert.equal(h.modelRequests.length, 0);
    // No agent_start/session_start: e.g. handled/rejected input or cancelled navigation.
  }
  await h.clock.pulse(5001); assert.equal(h.modelRequests.length, 1);
  await h.begin(); await h.emit('input');
  assert.deepEqual((await h.invokeTick()).details, { code: 'cancelled' }); await h.end();
  await h.clock.hour(); assert.equal(h.modelRequests.length, 2);
  await h.emit('session_before_tree'); h.host.session = 'tree-branch'; await h.emit('session_tree'); h.host.idle = true;
  await h.clock.pulse(); assert.equal(h.modelRequests.length, 3, 'successful tree rebase without fictitious start');
  await h.emit('session_shutdown'); await h.emit('session_shutdown'); const count = h.modelRequests.length;
  await h.clock.hour(); assert.equal(h.modelRequests.length, count); assert.equal(h.clock.jobs.size, 0);
});

test('real child read timeout returns cancellation; next slot cannot wake/dispatch until underlying settlement; fresh fair resume', async t => {
  const h = harness(t); for (let i = 0; i < 3; i++) await h.invokeOwner(argument('fair/' + i));
  await h.startScheduler(); await h.clock.pulse();
  let release!: () => void, entered!: () => void;
  const atRead = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const before = h.dispatches.length;
  h.state.onNative = async stage => { if (stage === 'read') { entered(); await gate; } };
  await h.begin(); const running = h.invokeTick(); await atRead;
  const result = await running; assert.equal(result.isError, true); assert.deepEqual(result.details, { code: 'cancelled' });
  assert.equal(h.dispatches[before].signal.aborted, true);
  assert.ok(!Object.hasOwn(h.dispatches[before].args, 'signal'));
  assert.equal(h.dispatches.length, before + 1); assert.equal(h.rows('reminder_occurrences').length, 0);
  await h.end(); const requests = h.modelRequests.length;
  await h.clock.hour(); assert.equal(h.modelRequests.length, requests, 'known pending native blocks model wake');
  assert.deepEqual((await h.invokeTick()).details, { code: 'busy' });
  assert.equal(h.dispatches.length, before + 1); assert.equal(h.rows('reminder_occurrences').length, 0);
  release(); await flush(); h.state.onNative = undefined;
  assert.equal(h.dispatches.length, before + 1, 'late result grants no dispatch');
  await h.clock.pulse(); assert.equal(h.modelRequests.length, requests + 1);
  const resumed = tick(await h.run()); assert.equal(resumed.selected, 3); assert.equal(resumed.sent, 3);
  assert.equal(h.dispatches[before + 1].args.message_id, 'msg_' + '2'.padStart(26, '0'), 'unvisited original first');
  assert.equal(h.state.sends, 3); assert.equal(h.telegramHttpClient.requests.length, 6);
});

test('observed input cancels active original reread and late native result cannot claim or confirm', async t => {
  const h = harness(t); await h.invokeOwner(); await h.startScheduler(); await h.clock.pulse();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  h.state.onNative = async () => { entered(); await gate; };
  await h.begin(); const work = h.invokeTick(); await reached;
  await h.emit('input'); assert.deepEqual((await work).details, { code: 'cancelled' });
  release(); await flush(); await h.end();
  assert.equal(h.rows('reminder_occurrences').length, 0); assert.equal(h.telegramHttpClient.requests.length, 1);
});

test('late Tick HTTP echo after admission cancellation cannot confirm or retry same slot', async t => {
  const h = harness(t); await h.invokeOwner();
  const late = createTestTelegramHttpClient({ outcome: 'late' });
  await h.restart({ telegramHttpClient: late }); await h.clock.pulse();
  await h.begin(); const running = h.invokeTick(); await waitForTestTelegramHttpRequest(late);
  await h.emit('input'); assert.deepEqual((await running).details, { code: 'cancelled' });
  completeLateTestTelegramHttp(late); await flush(); await h.end();
  const reminders = h.rows('deliveries').filter(row => row.purpose === 'reminder');
  assert.equal(reminders.length, 1); assert.notEqual(reminders[0].state, 'sent');
  assert.equal(late.requests.length, 1); assert.equal(h.state.sends, 1);
  const count = h.modelRequests.length; await h.clock.pulse(); assert.equal(h.modelRequests.length, count);
});

test('one failing canonical host check stops whole Tick before a later member, even if subsequent observations recover', async t => {
  const h = harness(t); await h.invokeOwner(argument('host/a')); await h.invokeOwner(argument('host/b'));
  await h.startScheduler(); await h.clock.pulse();
  const getCwd = h.ctx.sessionManager.getCwd; let failOnce = false;
  h.ctx.sessionManager.getCwd = () => { if (failOnce) { failOnce = false; throw Error('synthetic host loss'); } return getCwd(); };
  const before = h.dispatches.length;
  h.state.onNative = stage => { if (stage === 'read') failOnce = true; };
  await h.begin(); assert.deepEqual((await h.invokeTick()).details, { code: 'cancelled' }); await h.end();
  assert.equal(h.dispatches.length, before + 1); assert.equal(h.rows('reminder_occurrences').length, 0);
  assert.equal(h.telegramHttpClient.requests.length, 2);
  h.state.onNative = undefined; await h.clock.hour();
  assert.equal(tick(await h.run()).sent, 2, 'a later fresh eligible operation may resume');
});

test('native read crossing current slot revokes admission before reminder claims or HTTP effects', async t => {
  const h = harness(t); await h.invokeOwner(); await h.startScheduler(); await h.clock.pulse();
  h.state.onNative = stage => { if (stage === 'read') h.clock.wall += 3600000; };
  const result = await h.run(); assert.deepEqual(result.details, { code: 'cancelled' });
  assert.equal(h.rows('reminder_occurrences').length, 0); assert.equal(h.telegramHttpClient.requests.length, 1);
});

test('registered lifecycle discards asynchronous planning after observed input, scope/hour change or stop', async t => {
  for (const change of ['input', 'scope', 'hour', 'stop']) {
    const h = harness(t); await h.invokeOwner(); await h.startScheduler();
    const pendingPulse = h.clock.pulse(); // callback schedules plan microtasks, not native work
    if (change === 'input') await h.emit('input');
    if (change === 'scope') h.host.session = 'replacement-scope';
    if (change === 'hour') h.clock.wall += 3600000;
    if (change === 'stop') await h.emit('session_shutdown');
    await pendingPulse;
    assert.equal(h.modelRequests.length, 0, change); assert.equal(h.dispatches.length, 2);
  }
});
