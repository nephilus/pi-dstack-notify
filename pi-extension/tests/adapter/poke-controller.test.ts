import test from 'node:test';
import assert from 'node:assert/strict';
import { createPokeController } from '../../adapter/poke-controller.ts';
import type { PokeHost } from '../../adapter/poke-controller.ts';
import type { ReminderPlan } from '../../core/reminder-plan.ts';
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const advice = (done = 0) => ({ state: 'candidate', steps: Array.from({ length: 5 }, (_, i) => ({ summary: `step ${i}`, state: i < done ? 'done' : 'pending' })) });
function harness() {
  let now = 0, idle = true, pending = false, scope = 's', state: 'unspent' | 'spent' | 'pending' | 'unknown' = 'spent';
  let planner: () => Promise<ReminderPlan | undefined> = async () => ({ status: 'held', reason: 'owner_evidence_unavailable', due_count: 0, utc_slot: null });
  const jobs = new Set<() => void>(), sends: any[] = [];
  let fail = false;
  const host: PokeHost = { observe: () => ({ session_id: scope, project_path: '/project' }), isIdle: () => idle,
    hasPendingMessages: () => pending, sendMessage(message) { sends.push(message); if (fail) throw Error('private'); idle = false; } };
  const controller = createPokeController({ clock: { elapsed: () => now, immediate(fn) { jobs.add(fn); return () => { jobs.delete(fn); }; } },
    plan: () => planner(), opportunity: () => ({ state, currentSlot: 0 }) });
  controller.start(host);
  function normal() { idle = true; controller.input({ source: 'interactive', text: 'normal' }); idle = false;
    controller.beforeAgentStart({ messageType: 'user', prompt: 'normal' }); controller.agentStart(); controller.turnStart(); }
  function end() { controller.turnEnd({ outcome: 'completed' }); idle = true; controller.settled({ aborted: false }); }
  function report(value: unknown = advice(), signal = new AbortController().signal) { return controller.record(value, signal); }
  function poke() { const message = sends.at(-1); controller.beforeAgentStart({ messageType: 'custom', message });
    controller.agentStart(); controller.turnStart(); controller.messageStart({ message: { role: 'custom', ...message } }); }
  async function check() { for (const fn of [...jobs]) { jobs.delete(fn); fn(); } await flush(); }
  return { controller, sends, jobs, normal, end, report, poke, check,
    set now(value: number) { now = value; }, set idle(value: boolean) { idle = value; }, set pending(value: boolean) { pending = value; },
    set scope(value: string) { scope = value; }, set state(value: typeof state) { state = value; },
    set fail(value: boolean) { fail = value; }, set planner(value: typeof planner) { planner = value; } };
}
for (const change of ['input', 'navigation', 'ui', 'shutdown', 'busy', 'pending', 'scope', 'deadline', 'backward', 'nan', 'reminder_pending', 'unknown_view'])
  test('after every asynchronous arbitration await rechecks ' + change, async () => {
    const h = harness(); let release!: (p: ReminderPlan) => void;
    h.planner = () => new Promise(resolve => { release = resolve; }); h.normal(); h.report(); h.end();
    const checking = h.check();
    if (change === 'input') h.controller.input({ source: 'interactive', text: 'handled' });
    if (change === 'navigation') h.controller.invalidate();
    if (change === 'ui') h.controller.uiPrompt(true);
    if (change === 'shutdown') h.controller.stop();
    if (change === 'busy') h.idle = false;
    if (change === 'pending') h.pending = true;
    if (change === 'scope') h.scope = 'other';
    if (change === 'deadline') h.now = 30000;
    if (change === 'backward') h.now = -1;
    if (change === 'nan') h.now = NaN;
    if (change === 'reminder_pending') h.state = 'pending';
    if (change === 'unknown_view') h.state = 'unknown';
    release({ status: 'held', reason: 'owner_evidence_unavailable', due_count: 0, utc_slot: null });
    await checking; assert.equal(h.sends.length, 0); await h.check(); assert.equal(h.sends.length, 0);
  });

test('send failure consumes submission; no repeated settle, callback or clock reset retries', async () => {
  const h = harness(); h.fail = true; h.normal(); h.report(); h.end(); await h.check(); assert.equal(h.sends.length, 1);
  h.fail = false; h.now = 1000; h.controller.settled({ aborted: false }); await h.check(); assert.equal(h.sends.length, 1);
  h.normal(); h.report(); h.end(); await h.check(); assert.equal(h.sends.length, 1, 'latest observation not last send controls reset');
});

for (const reason of ['disabled', 'planning_held', 'malformed', 'throw']) test('core plan map fails quiet: ' + reason, async () => {
  const h = harness(); h.planner = async () => {
    if (reason === 'throw') throw Error('private');
    return reason === 'malformed' ? undefined : { status: reason === 'disabled' ? 'inactive' : 'held', reason: reason as any, due_count: 0, utc_slot: null };
  };
  h.normal(); h.report(); h.end(); await h.check(); assert.equal(h.sends.length, 0);
});

for (const revoke of ['input', 'navigation', 'abort', 'replace_run', 'contaminate']) test('synchronous captured recorder cannot reattribute reentrant validation to newer run: ' + revoke, async () => {
  const h = harness(); h.normal();
  const abort = new AbortController();
  const value = { state: 'candidate', get steps() {
    if (revoke === 'input') h.controller.input({ source: 'interactive', text: 'new' });
    if (revoke === 'navigation') h.controller.invalidate();
    if (revoke === 'abort') abort.abort();
    if (revoke === 'replace_run') h.normal();
    if (revoke === 'contaminate') h.controller.messageStart({ message: { role: 'custom', customType: 'other' } });
    return advice(1).steps;
  } };
  assert.equal(h.report(value, abort.signal), false); h.end(); await h.check(); assert.equal(h.sends.length, 0);
  // No stale commit polluted the ABSENT baseline of a fresh real episode.
  h.normal(); assert.equal(h.report(advice(1)), true); h.end(); await h.check(); assert.equal(h.sends.length, 1);
});

test('budget exhausted recorder commits FINAL terminal/unattempted observation; no model-only refill', async () => {
  const h = harness(); h.normal(); h.report(); h.end(); await h.check();
  for (const done of [1, 2, 3]) { h.poke(); assert.ok(h.report(advice(done))); h.end(); await h.check(); }
  assert.equal(h.sends.length, 3);
  h.normal(); h.report(advice(3)); h.end(); await h.check(); assert.equal(h.sends.length, 3);
  h.normal(); h.report({ state: 'done' }); h.end(); await h.check(); assert.equal(h.sends.length, 3);
  h.normal(); h.report({ state: 'done' }); h.report(advice(4)); h.end(); await h.check(); assert.equal(h.sends.length, 3, 'sticky normal-root veto');
});

test('invalid shape and invalid in-chain catalog cannot replace latest accepted cache or bypass veto', async () => {
  const h = harness(); h.normal(); h.report(); h.report({ state: 'candidate', steps: [] }); h.end(); await h.check(); assert.equal(h.sends.length, 0);
  h.normal(); h.report(advice(1)); h.end(); await h.check(); assert.equal(h.sends.length, 1);
  h.poke(); const churn = advice(2); churn.steps[0].summary = 'new'; assert.equal(h.report(churn), false); h.end(); await h.check();
  h.normal(); h.report(advice(1)); h.end(); await h.check(); assert.equal(h.sends.length, 1, 'invalid chain catalog was never accepted as reset baseline');
});
