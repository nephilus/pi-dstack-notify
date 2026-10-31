import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, argument } from './fixture.ts';
import { POKE_REQUEST_TYPE } from '../../adapter/poke-controller.ts';
import { VETO_STATES } from '../../adapter/poke-hints.ts';
import { deniedAttempts } from '../adapter/deny-runtime.ts';
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
class Clock {
  mono = 0; wall = Date.parse('2026-01-02T23:00:00Z');
  jobs = new Set<() => void>(); reminders = new Set<() => void>();
  elapsed = () => this.mono; now = () => this.wall;
  immediate = (fn: () => void) => { this.jobs.add(fn); return () => { this.jobs.delete(fn); }; };
  schedule = (fn: () => void, _delay: number) => { this.reminders.add(fn); return () => { this.reminders.delete(fn); }; };
  async check() { for (const fn of [...this.jobs]) { this.jobs.delete(fn); fn(); } await flush(); }
  async pulse() { for (const fn of [...this.reminders]) { this.reminders.delete(fn); fn(); } await flush(); }
}
const hint = (done = 0, count = 5, reorder = false) => ({ state: 'candidate', steps:
  Array.from({ length: count }, (_, i) => ({ summary: reorder ? `  step   ${i} ` : `step ${i}`, state: i < done ? 'done' : 'pending' })).sort(() => reorder ? -1 : 0) });
function harness(t: Parameters<typeof fixture>[0], owner: 'actual' | 'unanswered' = 'actual') {
  const clock = new Clock();
  const h = fixture(t, 'echo', { owner, fyip: 'yes', reminderClock: clock, pokeClock: clock, clock: () => clock.wall / 1000 });
  const emit = async (name: string, event: any = {}) => { assert.ok(h.events.has(name), name); await h.events.get(name)!(event); };
  const report = (args: unknown = hint(), signal = new AbortController().signal) =>
    h.tools.get('notification_poke_hint')!.execute('poke-report', args, signal, undefined, Object.create(h.ctx));
  async function normalStart(text = 'ordinary work', source = 'interactive', event: any = {}) {
    h.host.idle = true;
    await emit('input', { text, source, ...event });
    h.host.idle = false;
    await emit('before_agent_start', { messageType: 'user', prompt: text, images: event.images });
    await emit('agent_start'); await emit('turn_start', { turnIndex: 0 });
  }
  async function end(outcome = 'completed', aborted = false) {
    await emit('turn_end', { outcome }); h.host.idle = true;
    await emit('agent_settled', { aborted });
  }
  async function normal(args: unknown = hint(), reorder = false) {
    await normalStart(reorder ? 'fresh wrapper' : 'ordinary work');
    assert.notEqual((await report(args)).isError, true);
    clock.mono += 6000; await end(); await clock.check();
  }
  async function begin(message = h.modelRequests.at(-1)!.message, initial = true) {
    h.host.idle = false;
    await emit('before_agent_start', { messageType: 'custom', message });
    await emit('agent_start'); await emit('turn_start', { turnIndex: 0 });
    if (initial) await emit('message_start', { message: { role: 'custom', ...message } });
  }
  async function poke(args: unknown, initial = true) { await begin(undefined, initial); const result = await report(args); await end(); await clock.check(); return result; }
  return { ...h, clock, emit, report, normalStart, end, normal, begin, poke,
    requests: () => h.modelRequests.filter(x => x.message.customType === POKE_REQUEST_TYPE) };
}
after(() => { assert.equal(process.env.PATH, '/__notification_no_executables__'); assert.deepEqual(deniedAttempts, []); });

test('actual entry advisory tool is sequential model-only, fixed ack and fixed send; expected initial supports genuine progress', async t => {
  const h = harness(t); await h.emit('session_start');
  const tool = h.tools.get('notification_poke_hint') as any;
  assert.equal(tool.exposure, 'model-only'); assert.equal(tool.executionMode, 'sequential'); assert.equal(tool.reachesTools, undefined);
  assert.equal((await h.report()).isError, true, 'no startup anchor');
  await h.normal(); assert.equal(h.requests().length, 1);
  const { message, control } = h.requests()[0];
  assert.deepEqual(control, { triggerTurn: true, deliverAs: 'followUp' });
  assert.equal(message.display, false); assert.deepEqual(Object.keys(message.details), ['poke_request_token']);
  assert.match(message.content, /not new user instructions or permission/); assert.doesNotMatch(message.content, /step 0/);
  assert.deepEqual((await h.poke(hint(1))).details, { recorded: true, advisory: true });
  assert.equal(h.requests().length, 2, 'ONE expected initial is not contamination');
  assert.equal(h.dispatches.length, 0); assert.equal(h.telegramHttpClient.requests.length, 0); assert.equal(h.clefHttpClient!.requests.length, 0);
  assert.equal((await h.invokeTick()).isError, true, 'poke cannot borrow Tick permit');
});

test('three TOTAL attempts then final unattempted progress; no-op normal and cross-root reorder cannot refill', async t => {
  const h = harness(t); await h.emit('session_start'); await h.normal();
  await h.poke(hint(1)); await h.poke(hint(2)); assert.equal(h.requests().length, 3);
  assert.notEqual((await h.poke(hint(3))).isError, true, 'exhaustion does not revoke existing recorder authority');
  assert.equal(h.requests().length, 3);
  await h.normal(hint(3)); assert.equal(h.requests().length, 3);
  await h.normal(hint(3, 5, true), true); assert.equal(h.requests().length, 3);
  await h.normal(hint(4)); assert.equal(h.requests().length, 4, 'new normal actual change can anchor');
});

// Deliberately call the ACTUAL registered execute callback with malformed JSON-shaped
// arguments. Host JSON-schema validation already string-restricts these states;
// these are recorder-contract tests, NOT evidence of a real-loader schema bypass.
for (const state of ['pending', 'done'] as const) {
  const malformed = () => ({ ...hint(1), steps: hint(1).steps.map((step, i) =>
    ({ ...step, state: i === 0 ? [state] : step.state })) });
  test('registered recorder rejects array ' + state + '; malformed-only genuine NORMAL stays quiet', async t => {
    const h = harness(t); await h.emit('session_start'); await h.normalStart();
    const schema = h.tools.get('notification_poke_hint')!.parameters as any;
    assert.equal(schema.properties.steps.items.properties.state.type, 'string');
    const result = await h.report(malformed());
    assert.equal(result.isError, true); assert.deepEqual(result.details, { code: 'invalid_or_stale_hint' });
    assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(result.details) }]);
    h.clock.mono += 6000; await h.end(); await h.clock.check();
    assert.equal(h.requests().length, 0); assert.equal(h.clock.jobs.size, 0);
    assert.equal(h.dispatches.length, 0);
    await h.normal(hint(1)); assert.equal(h.requests().length, 1, 'rejection did not manufacture an accepted baseline');
  });
  test('registered recorder rejected array ' + state + ' preserves prior accepted FINAL/latest observation', async t => {
    const h = harness(t); await h.emit('session_start'); await h.normal();
    assert.equal(h.requests().length, 1);
    await h.normalStart(); assert.deepEqual((await h.report(hint(1))).details, { recorded: true, advisory: true });
    const result = await h.report(malformed());
    assert.equal(result.isError, true); assert.deepEqual(result.details, { code: 'invalid_or_stale_hint' });
    h.clock.mono += 6000; await h.end(); await h.clock.check();
    assert.equal(h.requests().length, 1, 'malformed final report cannot nominate continuation');
    // Observe cache preservation through the existing PRE-RUN/FINAL comparison,
    // without exposing or mutating private controller state. Re-reporting the last
    // valid accepted projection is a no-op even after the rejected report.
    await h.normal(hint(1, 5, true)); assert.equal(h.requests().length, 1, 'no latest replacement/no-op refill');
    await h.normal(hint(2)); assert.equal(h.requests().length, 2, 'fresh valid change still works');
  });
}

for (const state of VETO_STATES) test('actual hook sticky veto, no delegated/wait polling or candidate override: ' + state, async t => {
  const h = harness(t); await h.emit('session_start'); await h.normalStart();
  assert.notEqual((await h.report({ state })).isError, true); await h.report(hint());
  h.clock.mono += 6000; await h.end(); await h.clock.check();
  h.clock.wall += 86400000; await h.clock.pulse(); await h.emit('agent_settled', { aborted: false }); await h.clock.check();
  assert.equal(h.requests().length, 0); assert.equal(h.dispatches.length, 0);
});

for (const variant of ['unchanged', 'rename', 'reversal', 'all_done', 'missing', 'duplicate_initial', 'no_initial', 'repeated_start'] as const)
  test('actual poke progression closes conservatively: ' + variant, async t => {
    const h = harness(t); await h.emit('session_start'); await h.normal();
    await h.begin(undefined, variant !== 'no_initial');
    if (variant === 'duplicate_initial') await h.emit('message_start', { message: { role: 'custom', ...h.requests()[0].message } });
    if (variant === 'repeated_start') { await h.emit('agent_start'); await h.emit('turn_start', { turnIndex: 0 });
      await h.emit('message_start', { message: { role: 'custom', ...h.requests()[0].message } }); }
    let args: any = hint(1);
    if (variant === 'unchanged') args = hint();
    if (variant === 'rename') args.steps[0].summary = 'renamed timestamp 123';
    if (variant === 'all_done') args = hint(5);
    if (variant === 'reversal') {
      await h.report(hint(1)); await h.end(); await h.clock.check(); await h.begin(); args = hint();
    }
    if (variant !== 'missing') await h.report(args);
    await h.end(); await h.clock.check();
    assert.equal(h.requests().length, variant === 'reversal' ? 2 : 1);
  });

for (const source of ['extension', 'rpc', 'interactive']) test('observed input correlation source and transformed/streaming false negatives: ' + source, async t => {
  const h = harness(t); await h.emit('session_start');
  await h.normalStart('work', source); await h.report(); h.clock.mono += 6000; await h.end(); await h.clock.check();
  assert.equal(h.requests().length, source === 'extension' ? 0 : 1);
  const n = h.requests().length;
  h.host.idle = true; await h.emit('input', { source, text: '/template raw' });
  h.host.idle = false; await h.emit('before_agent_start', { messageType: 'user', prompt: 'expanded' });
  await h.emit('agent_start'); await h.emit('turn_start'); assert.equal((await h.report(hint(1))).isError, true);
  await h.end(); await h.clock.check(); assert.equal(h.requests().length, n);
  h.host.idle = false; await h.emit('input', { source, text: 'queued', streamingBehavior: 'followUp' });
  await h.emit('before_agent_start', { messageType: 'user', prompt: 'queued' }); await h.emit('agent_start'); await h.emit('turn_start');
  await h.report(hint(2)); await h.end(); await h.clock.check(); assert.equal(h.requests().length, n);
});

test('actual hook exact input images, handled input, stale ticket, raw finals and tool success do not anchor', async t => {
  const h = harness(t); await h.emit('session_start');
  h.host.idle = true; await h.emit('input', { source: 'interactive', text: 'image', images: [{ data: 'a', mimeType: 'image/png' }] });
  await h.emit('before_agent_start', { messageType: 'user', prompt: 'image', images: [{ data: 'b', mimeType: 'image/png' }] });
  await h.emit('agent_start'); await h.emit('turn_start'); assert.equal((await h.report()).isError, true); await h.end();
  await h.emit('input', { source: 'interactive', text: 'handled' });
  await h.emit('before_agent_start', { messageType: 'custom', message: { customType: 'other' } });
  await h.emit('before_agent_start', { messageType: 'user', prompt: 'handled' }); await h.emit('agent_start'); await h.emit('turn_start');
  assert.equal((await h.report()).isError, true); await h.end();
  await h.normalStart(); await h.emit('message_start', { message: { role: 'assistant', content: 'unfinished step' } });
  await h.end(); await h.clock.check(); assert.equal(h.requests().length, 0);
});

for (const customType of [POKE_REQUEST_TYPE, 'notification-reminder-request', 'herdsman-result', 'other'])
  test('custom origin never NORMAL, including unmatched/restart/queued message delivery: ' + customType, async t => {
    const h = harness(t); await h.emit('session_start');
    await h.begin({ customType, details: {} }); assert.equal((await h.report()).isError, true); await h.end(); await h.clock.check();
    await h.normalStart(); await h.emit('message_start', { message: { role: 'custom', customType, details: {} } });
    assert.equal((await h.report()).isError, true); h.clock.mono += 6000; await h.end(); await h.clock.check();
    assert.equal(h.requests().length, 0);
  });

test('queued matching token alone cannot recognize, and stale receiving run cannot consume a newer arm', async t => {
  const h = harness(t); await h.emit('session_start'); await h.normal(); const old = structuredClone(h.requests()[0].message);
  await h.normal(hint(1)); const fresh = h.requests().at(-1)!.message;
  await h.begin(old); await h.emit('message_start', { message: { role: 'custom', ...fresh } });
  assert.equal((await h.report(hint(2))).isError, true); await h.end(); await h.clock.check();
  await h.begin(fresh); assert.notEqual((await h.report(hint(2))).isError, true);
  await h.end(); await h.clock.check(); assert.equal(h.requests().length, 3);
});

for (const event of ['input', 'ui_prompt_start', 'session_before_switch', 'session_before_fork', 'session_before_tree', 'session_tree', 'session_shutdown'])
  test('event-only discard cancels deferred opportunity and stays dormant: ' + event, async t => {
    const h = harness(t); await h.emit('session_start'); await h.normalStart(); await h.report(); h.clock.mono += 6000; await h.end();
    assert.equal(h.clock.jobs.size, 1);
    await h.emit(event, event === 'input' ? { source: 'interactive', text: 'handled' } : {});
    if (event === 'ui_prompt_start') await h.emit('ui_prompt_end');
    await h.clock.check(); h.clock.mono += 100000; await h.clock.check(); await h.emit('agent_settled', { aborted: false });
    assert.equal(h.requests().length, 0); assert.equal(h.clock.jobs.size, 0, 'no recovery timers or parked checks');
    if (event !== 'session_shutdown') { await h.normal(hint(1)); assert.equal(h.requests().length, 1, 'future real normal recovers without fictitious start'); }
  });

test('input after send, abort and restart refuse stale credit without retracting already submitted advice', async t => {
  const h = harness(t); await h.emit('session_start'); await h.normal(); const old = h.requests()[0].message;
  h.host.idle = true; await h.emit('input', { source: 'interactive', text: 'handled' });
  await h.begin(old); assert.equal((await h.report(hint(1))).isError, true); await h.end(); await h.clock.check();
  await h.restart(); await h.begin(old); assert.equal((await h.report(hint(2))).isError, true); await h.end(); await h.clock.check();
  assert.equal(h.requests().length, 1); assert.equal(h.clock.jobs.size, 0);
});

for (const failure of ['error', 'aborted', 'settled_abort', 'preparation_failure', 'no_report'])
  test('errors/unknown submissions stay spent without retry: ' + failure, async t => {
    const h = harness(t); await h.emit('session_start'); await h.normal();
    if (failure !== 'preparation_failure') {
      await h.begin(); if (failure !== 'no_report') await h.report(hint(1));
      await h.end(failure === 'error' ? 'error' : failure === 'aborted' ? 'aborted' : 'completed', failure === 'settled_abort');
    }
    h.clock.mono += 40000; await h.clock.check(); await h.clock.pulse(); assert.equal(h.requests().length, 1);
  });

for (const guard of ['busy', 'pending', 'scope', 'deadline', 'backward', 'nan', 'infinite', 'disabled', 'non_product'])
  test('fresh final guards close opportunity: ' + guard, async t => {
    const h = harness(t); await h.emit('session_start'); await h.normalStart(); await h.report(); h.clock.mono += 6000; await h.end();
    if (guard === 'busy') h.host.idle = false;
    if (guard === 'pending') h.host.pending = true;
    if (guard === 'scope') h.host.session = 'other';
    if (guard === 'deadline') h.clock.mono += 30000;
    if (guard === 'backward') h.clock.mono--;
    if (guard === 'nan') h.clock.mono = NaN;
    if (guard === 'infinite') h.clock.mono = Infinity;
    if (guard === 'disabled') { h.config.enabled = false; h.save(); }
    if (guard === 'non_product') { h.config.projects[0].policy = 'explicit_attention'; h.save(); }
    await h.clock.check(); assert.equal(h.requests().length, 0);
    h.host.idle = true; h.host.pending = false; h.clock.mono = 7000; await h.clock.check(); assert.equal(h.requests().length, 0);
  });

test('deadline starts at normal settlement not execution and expired bookkeeping still accepts attributed final observations', async t => {
  const h = harness(t); await h.emit('session_start'); await h.normalStart(); await h.report(); h.clock.mono = 100000;
  await h.end(); await h.clock.check(); assert.equal(h.requests().length, 1);
  await h.begin(); h.clock.mono += 30000; assert.notEqual((await h.report(hint(1))).isError, true);
  await h.end(); await h.clock.check(); assert.equal(h.requests().length, 1);
  await h.normal(hint(1, 5, true)); assert.equal(h.requests().length, 1, 'latest expired-run observation prevents no-op refill');
});

test('actual current-slot admissible reminder wins, then spent still-due slot allows later genuine normal poke without Tick', async t => {
  const h = harness(t, 'unanswered'); await h.invokeOwner(argument());
  await h.emit('session_start');
  await h.normalStart(); await h.report(); h.clock.mono += 6000; await h.end(); await h.clock.check();
  assert.equal(h.requests().length, 0, 'unspent and actually due reminder takes precedence');
  await h.clock.pulse(); assert.equal(h.modelRequests.length, 1);
  const reminder = h.modelRequests[0].message; assert.equal(reminder.customType, 'notification-reminder-request');
  await h.begin(reminder); assert.equal((await h.report()).isError, true); await h.end(); await h.clock.check();
  assert.equal(h.requests().length, 0, 'reminder settlement cannot release dropped poke');
  await h.normal(hint(1)); assert.equal(h.requests().length, 1, 'slot spent though real due work remains');
  await h.clock.pulse(); assert.equal(h.modelRequests.length, 2, 'no reminder retry');
  assert.ok(h.rows('deliveries').every(r => r.profile_id === 'test-only.primary' && r.destination_id === 'test-only.owner'));
});

test('actual underlying native timeout pending blocks both routes through restart; late settlement wakes nothing', async t => {
  const h = harness(t, 'unanswered'); await h.invokeOwner(); await h.emit('session_start');
  h.clock.mono = 6000; await h.clock.pulse();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const atRead = new Promise<void>(resolve => { entered = resolve; });
  t.after(() => release());
  h.state.onNative = async stage => { if (stage === 'read') { entered(); await gate; } };
  await h.begin(h.modelRequests[0].message); const running = h.invokeTick(); await atRead;
  assert.deepEqual((await running).details, { code: 'cancelled' }); await h.end();
  const dispatches = h.dispatches.length;
  await h.restart({ owner: 'unknown' }); h.clock.wall += 3600000; h.clock.mono += 6000;
  await h.normal(); await h.clock.pulse(); assert.equal(h.requests().length, 0);
  assert.equal(h.dispatches.length, dispatches); assert.deepEqual((await h.invokeTick()).details, { code: 'busy' });
  release(); await flush(); h.state.onNative = undefined;
  await h.clock.check(); assert.equal(h.requests().length, 0, 'actual settlement alone neither wakes nor rearms');
  assert.equal(h.dispatches.length, dispatches);
  await h.normal(hint(1)); assert.equal(h.requests().length, 1, 'only a fresh changed genuine normal root can anchor');
});

test('observed input before settlement and during plan microtask gap defeats offers; deferred unobserved prompt is only qualified priority', async t => {
  const h = harness(t); await h.emit('session_start'); await h.normalStart(); await h.report();
  await h.emit('input', { source: 'rpc', text: 'streamed', streamingBehavior: 'steer' });
  h.clock.mono += 6000; await h.end(); await h.clock.check(); assert.equal(h.requests().length, 0);
  await h.normalStart(); await h.report(hint(1)); h.clock.mono += 6000; await h.end();
  // Fire actual one-shot callback but interrupt before its awaited plan continuation.
  for (const fn of [...h.clock.jobs]) { h.clock.jobs.delete(fn); fn(); }
  await h.emit('input', { source: 'interactive', text: 'deferred observed input' }); await flush();
  assert.equal(h.requests().length, 0);
  await h.normalStart(); await h.report(hint(2)); h.clock.mono += 6000; await h.end();
  h.host.pending = true; await h.clock.check(); assert.equal(h.requests().length, 0, 'pending host guard for deferred/unobserved input');
  h.host.pending = false; await h.clock.check(); assert.equal(h.requests().length, 0);
});

test('aborted recorder invocation never commits; later valid ordinary tool authority remains unchanged', async t => {
  const h = harness(t); await h.emit('session_start'); await h.normalStart();
  const controller = new AbortController(); controller.abort();
  assert.equal((await h.report(hint(), controller.signal)).isError, true);
  assert.notEqual((await h.report(hint(1))).isError, true); h.clock.mono += 6000; await h.end(); await h.clock.check();
  assert.equal(h.requests().length, 1);
});

test('no/relative startup config remains inert and disabled tool cannot manufacture an anchor', async t => {
  const h = harness(t); h.start({ noConfig: true }); await h.emit('session_start');
  await h.normalStart(); assert.equal((await h.report()).isError, true); h.clock.mono += 6000; await h.end(); await h.clock.check();
  assert.equal(h.requests().length, 0); assert.equal(h.clock.reminders.size, 0); assert.equal(h.clock.jobs.size, 0);
});
