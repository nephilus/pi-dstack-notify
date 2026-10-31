import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createReminderScheduler, REMINDER_REQUEST_TYPE } from '../../adapter/reminder-scheduler.ts';
import type { ReminderClock } from '../../adapter/reminder-scheduler.ts';
import { deniedAttempts } from './deny-runtime.ts';

const HOUR = 3_600_000;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
class Clock implements ReminderClock {
  time = Date.parse('2026-01-03T23:59:50Z'); // Saturday night -> Sunday UTC.
  timers = new Map<number, { at: number; callback: () => void }>();
  sequence = 0;
  elapsedTime = 0;
  now = () => this.time;
  elapsed = () => this.elapsedTime;
  schedule = (callback: () => void, delay: number) => {
    const id = ++this.sequence; this.timers.set(id, { at: this.elapsedTime + delay, callback });
    return () => { this.timers.delete(id); };
  };
  async step(wallMs = 5_000, elapsedMs = Math.max(0, wallMs)) {
    this.time += wallMs;
    this.elapsedTime += elapsedMs;
    for (const [id, timer] of [...this.timers]) if (timer.at <= this.elapsedTime) {
      this.timers.delete(id); timer.callback();
    }
    await flush();
  }
}
function harness(plan: () => Promise<boolean> = async () => true) {
  const clock = new Clock();
  const observed = { session_id: 'session-1', project_path: '/synthetic/project' };
  const state = { idle: true, pending: false, plans: 0 };
  const messages: Array<{ customType: string; content: string; display: boolean; details: unknown }> = [];
  const scheduler = createReminderScheduler({ clock, duePlan: async value => {
    state.plans++; assert.deepEqual(value, observed); return plan();
  } });
  const host = { observe: () => ({ ...observed }), isIdle: () => state.idle,
    hasPendingMessages: () => state.pending,
    sendMessage(message: typeof messages[number], options: unknown) {
      assert.deepEqual(options, { triggerTurn: true, deliverAs: 'followUp' }); messages.push(message);
    } };
  const begin = (message = messages.at(-1)!) => {
    state.idle = false; scheduler.beforeAgentStart({ messageType: 'custom', message });
  };
  scheduler.start(host);
  return { scheduler, clock, host, state, observed, messages, begin };
}
test('readonly opportunity view does not plan, spend, schedule, claim or consume permits', async () => {
  const h = harness();
  const timers = h.clock.sequence;
  for (let i = 0; i < 20; i++) assert.equal(h.scheduler.opportunity().state, 'unspent');
  assert.equal(h.state.plans, 0); assert.equal(h.clock.sequence, timers);
  await h.clock.step(); assert.equal(h.scheduler.opportunity().state, 'pending');
  h.begin(); assert.equal(h.scheduler.opportunity().state, 'pending');
  const permit = h.scheduler.take(h.observed); assert.ok(permit, 'read did not consume Tick permit');
  assert.equal(h.scheduler.opportunity().state, 'pending'); permit.close(); h.scheduler.settled(); h.state.idle = true;
  const plans = h.state.plans;
  for (let i = 0; i < 20; i++) assert.equal(h.scheduler.opportunity().state, 'spent');
  assert.equal(h.state.plans, plans); await h.clock.step(1); assert.equal(h.messages.length, 1);
  h.scheduler.stop(); assert.equal(h.scheduler.opportunity().state, 'inactive');
});

after(() => {
  assert.equal(process.env.PATH, '/__notification_no_executables__');
  assert.deepEqual(deniedAttempts, []);
});

test('24/7 UTC weekend/midnight slots coalesce; timer requests only fixed fresh custom turns', async () => {
  const h = harness(); assert.equal(h.messages.length, 0);
  await h.clock.step(); assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].customType, REMINDER_REQUEST_TYPE);
  assert.match(h.messages[0].content, /notification_reminder_tick\(\{\}\)/);
  assert.equal(h.messages[0].display, false);
  await h.clock.step(); assert.equal(h.messages.length, 2, 'Sunday midnight is not quiet time');
  await h.clock.step(); assert.equal(h.messages.length, 2);
  h.scheduler.stop();
});

test('jump and restart request current hour only; rollback never replays a submitted local slot', async () => {
  const h = harness(); await h.clock.step();
  await h.clock.step(72 * HOUR); assert.equal(h.messages.length, 2);
  await h.clock.step(-2 * HOUR); await h.clock.step(); assert.equal(h.messages.length, 2);
  h.scheduler.stop(); h.scheduler.start(h.host);
  await h.clock.step(); assert.equal(h.messages.length, 3, 'fresh instance may request current slot; core owns durable claims');
  h.scheduler.stop();
});

test('only recognized idle custom details token authorizes one execution in its actual run', async () => {
  const h = harness(); await h.clock.step();
  assert.equal(h.scheduler.take(h.observed), undefined, 'arm alone is not admission');
  h.begin(); const admission = h.scheduler.take(h.observed);
  assert.ok(admission); assert.equal(admission.check(h.observed), true);
  assert.equal(h.scheduler.take(h.observed), undefined);
  admission.close(); assert.equal(admission.check(h.observed), false);
  h.scheduler.stop();
});

test('stale queued follow-up cannot acquire a newer arm or steal its token', async () => {
  const h = harness(); await h.clock.step(); const old = h.messages[0];
  await h.clock.step(HOUR); const current = h.messages[1];
  h.begin(old); assert.equal(h.scheduler.take(h.observed), undefined);
  h.begin(current); const admission = h.scheduler.take(h.observed); assert.ok(admission);
  h.scheduler.turnEnd(); assert.equal(admission.check(h.observed), false);
  // Streaming follow-ups have no before_agent_start: no first-turn admission survives.
  assert.equal(h.scheduler.take(h.observed), undefined);
  h.scheduler.stop();
});

test('wrong custom token/type, ordinary user runs and extra details cannot bind pending arm', async () => {
  const h = harness(); await h.clock.step(); const message = h.messages[0];
  for (const bad of [{ ...message, customType: 'other' }, { ...message, details: {} },
    { ...message, details: { ...(message.details as object), extra: true } }]) {
    h.begin(bad); assert.equal(h.scheduler.take(h.observed), undefined);
  }
  h.scheduler.beforeAgentStart({ messageType: 'user' }); assert.equal(h.scheduler.take(h.observed), undefined);
  h.begin(message); assert.ok(h.scheduler.take(h.observed)); h.scheduler.stop();
});

test('observed input invalidates effects; handled/rejected/failed input lease releases without agent_start', async () => {
  for (const outcome of ['handled', 'rejected', 'failed']) {
    const h = harness(); h.scheduler.observedInput();
    await h.clock.step(1_000); assert.equal(h.messages.length, 0, outcome);
    await h.clock.step(4_000); assert.equal(h.messages.length, 1, outcome);
    h.begin(); const admission = h.scheduler.take(h.observed); assert.ok(admission);
    h.scheduler.observedInput(); assert.equal(admission.check(h.observed), false);
    assert.equal(h.scheduler.take(h.observed), undefined); h.scheduler.stop();
  }
});

test('busy, pending and UI defer with no model send until clear; observed deferred-settlement input wins', async () => {
  const h = harness(); h.state.idle = false; await h.clock.step(); assert.equal(h.messages.length, 0);
  h.state.idle = true; h.state.pending = true; await h.clock.step(); assert.equal(h.messages.length, 0);
  h.state.pending = false; h.scheduler.uiPrompt(true); await h.clock.step(); assert.equal(h.messages.length, 0);
  h.scheduler.uiPrompt(false); h.scheduler.settled(); h.scheduler.observedInput();
  await h.clock.step(1_000); assert.equal(h.messages.length, 0);
  await h.clock.step(4_000); assert.equal(h.messages.length, 1);
  // An input submitted but not observed by SDK cannot be known here. Once observed,
  // even an already submitted custom prompt cannot create an effects permit.
  h.scheduler.observedInput(); h.begin(); assert.equal(h.scheduler.take(h.observed), undefined);
  h.scheduler.stop();
});

test('navigation invalidates effects but timer survives cancelled switch/fork/new/tree with no start', async () => {
  for (const path of ['cancel-switch', 'cancel-fork', 'cancel-new', 'cancel-tree', 'tree']) {
    const h = harness(); h.scheduler.beforeNavigation();
    if (path === 'tree') h.scheduler.rebase();
    assert.equal(h.clock.timers.size, 1, path);
    await h.clock.step(); assert.equal(h.messages.length, 1, path);
    h.begin(); const admission = h.scheduler.take(h.observed); assert.ok(admission);
    h.scheduler.beforeNavigation(); assert.equal(admission.check(h.observed), false);
    h.scheduler.stop();
  }
});

test('scope/hour/settlement expire admissions and retained close cannot revoke a later operation', async () => {
  const h = harness(); await h.clock.step(); h.begin(); const first = h.scheduler.take(h.observed)!;
  h.observed.project_path = '/synthetic/other'; assert.equal(first.check(h.observed), false);
  h.state.idle = true; await h.clock.step(); h.begin(); const second = h.scheduler.take(h.observed)!;
  assert.ok(second); first.close(); assert.equal(second.check(h.observed), true);
  await h.clock.step(HOUR); assert.equal(second.check(h.observed), false);
  h.state.idle = true; await h.clock.step(); h.begin(); const third = h.scheduler.take(h.observed)!;
  assert.ok(third); h.scheduler.settled(); assert.equal(third.check(h.observed), false);
  h.scheduler.stop();
});

test('execution mismatch consumes permit, not pending arm; stop before microtask never plans', async () => {
  const h = harness(); await h.clock.step();
  assert.equal(h.scheduler.take({ ...h.observed, session_id: 'other' }), undefined);
  h.begin();
  assert.equal(h.scheduler.take({ ...h.observed, session_id: 'other' }), undefined);
  assert.equal(h.scheduler.take(h.observed), undefined);
  h.scheduler.stop();
  const stopped = harness();
  const callback = [...stopped.clock.timers.values()][0].callback;
  callback(); stopped.scheduler.stop(); await flush();
  assert.equal(stopped.state.plans, 0); assert.equal(stopped.messages.length, 0);
});

test('lost/empty current observations revoke permits before take and cannot resurrect on recovery', async () => {
  for (const field of ['session_id', 'project_path'] as const) {
    const h = harness(); await h.clock.step(); h.begin();
    const previous = { ...h.observed };
    h.observed[field] = '';
    assert.equal(h.scheduler.take(previous), undefined);
    Object.assign(h.observed, previous);
    assert.equal(h.scheduler.take(previous), undefined);
    h.begin(h.messages[0]);
    assert.equal(h.scheduler.take(previous), undefined, 'old token was revoked, not merely deferred');
    h.scheduler.stop();
  }
  const h = harness(); await h.clock.step(); h.begin();
  const observe = h.host.observe;
  h.host.observe = () => undefined as unknown as ReturnType<typeof observe>;
  assert.equal(h.scheduler.take(h.observed), undefined);
  h.host.observe = observe;
  assert.equal(h.scheduler.take(h.observed), undefined);
  h.scheduler.stop();
});

test('observation loss during active admission aborts signal even when check receives previously valid data', async () => {
  for (const field of ['session_id', 'project_path'] as const) {
    const h = harness(); await h.clock.step(); h.begin();
    const previous = { ...h.observed }, admission = h.scheduler.take(previous)!;
    assert.ok(admission); h.observed[field] = '';
    assert.equal(admission.check(previous), false); assert.equal(admission.signal.aborted, true);
    Object.assign(h.observed, previous);
    assert.equal(admission.check(previous), false);
    assert.equal(h.scheduler.take(previous), undefined); h.scheduler.stop();
  }
  const h = harness(); await h.clock.step(); h.begin();
  const admission = h.scheduler.take(h.observed)!, observe = h.host.observe;
  h.host.observe = () => undefined as unknown as ReturnType<typeof observe>;
  assert.equal(admission.check(h.observed), false); assert.equal(admission.signal.aborted, true);
  h.host.observe = observe; assert.equal(admission.check(h.observed), false); h.scheduler.stop();
});

test('input/navigation leases expire after monotonic five seconds despite independent UTC rollback', async () => {
  for (const action of ['observedInput', 'beforeNavigation'] as const) {
    const h = harness(); h.scheduler[action]();
    const originalWall = h.clock.time;
    await h.clock.step(-48 * HOUR, 4_999);
    assert.equal(h.messages.length, 0); assert.equal(h.state.plans, 0);
    await h.clock.step(0, 1); // Elapsed timers progress; UTC remains two days behind.
    assert.equal(h.messages.length, 1); assert.equal(h.clock.time, originalWall - 48 * HOUR);
    h.begin(); const admission = h.scheduler.take(h.observed)!; assert.ok(admission);
    assert.equal(admission.check(h.observed), true); h.scheduler.stop();
  }
});

test('absent eligible tracked work, held/inactive plans and plan errors never request model turns', async () => {
  for (const result of [
    { status: 'ready', due_count: 0 }, { status: 'held', due_count: 4 },
    { status: 'inactive', due_count: 4 }, { status: 'held', due_count: 0 },
  ]) {
    // Exact private port mapping required at future integration; never Boolean(plan).
    const h = harness(async () => result.status === 'ready' && result.due_count > 0);
    for (const delta of [5_000, 5_000, 12 * HOUR]) await h.clock.step(delta);
    assert.equal(h.messages.length, 0, result.status); assert.equal(h.state.plans, 3);
    assert.equal(h.scheduler.take(h.observed), undefined); h.scheduler.stop();
  }
  const h = harness(async () => { throw Error('plan_held'); });
  await h.clock.step(); await h.clock.step(HOUR);
  assert.equal(h.messages.length, 0); assert.equal(h.scheduler.take(h.observed), undefined);
  h.scheduler.stop();
});

test('async effect-free plan is serialized, discarded after input/stop; disabled/errors never send', async () => {
  let resolve!: (due: boolean) => void;
  const h = harness(() => new Promise(r => { resolve = r; }));
  await h.clock.step(); await h.clock.step(); assert.equal(h.state.plans, 1);
  h.scheduler.observedInput(); resolve(true); await flush(); assert.equal(h.messages.length, 0);
  await h.clock.step(); h.scheduler.stop(); resolve(true); await flush();
  assert.equal(h.messages.length, 0); assert.equal(h.clock.timers.size, 0);
  h.scheduler.stop(); h.scheduler.beforeNavigation(); h.scheduler.rebase(); h.scheduler.settled();
  await h.clock.step(4 * HOUR); assert.equal(h.messages.length, 0); assert.equal(h.clock.timers.size, 0);
  for (const plan of [async () => false, async () => { throw Error('held'); }]) {
    const held = harness(plan); await held.clock.step(); assert.equal(held.messages.length, 0); held.scheduler.stop();
  }
});
