import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import type { NotificationService, FYIPReceipt, PublicationContext } from '../../core/types.ts';
import type { HostContext } from '../../adapter/types.ts';
import { NotificationAdapter } from '../../adapter/runtime.ts';
import { SEND, READ } from '../../adapter/schema.ts';
import { deniedAttempts } from './deny-runtime.ts';

const candidate = { kind: 'milestone', title: 'Curated update', previous_state: 'Previously unavailable',
  current_state: 'Available now', materiality: 'Owner can use the capability',
  evidence: [{ kind: 'milestone', detail: 'Capability observed' }], reconciled: true };
const input = () => ({ candidate: structuredClone(candidate), decision_key: 'curated/update', revision: 'a'.repeat(64) });
const suppressed: FYIPReceipt = { state: 'suppressed', admission: { status: 'admitted' },
  classification: { status: 'classified_no', choice: 'no' }, delivery: { status: 'not_attempted' } };
function harness(spy: NotificationService['publishFYIP'] = async () => suppressed) {
  const effects: unknown[] = [], calls: unknown[] = [];
  let context!: PublicationContext;
  const adapter = new NotificationAdapter({ configPath: '/fixture/config', canonicalize: p => p,
    serviceFactory: () => ({
      async publish() { return { state: 'sent', admission: { status: 'admitted' },
        classification: { status: 'bypassed' }, delivery: { status: 'delivery-confirmed' } }; },
      async publishFYIP(args, ctx) { context = ctx; calls.push(args); return spy(args, ctx); },
      async publishOwnerRequest() { throw Error('unexpected owner request'); },
      async tickReminders() { throw Error('unexpected Tick unit call'); },
      planReminders() { throw Error('must not start scheduler/planner'); },
    }) });
  const ctx = { cwd: '/project', sessionManager: { getCwd: () => '/project', getSessionId: () => 'session' },
    tools: [{ name: SEND }, { name: READ }], async executeTool(name: string, args: unknown) {
      effects.push({ name, args }); return { isError: false, result: { content: [], structuredContent: {} } };
    } } as unknown as HostContext;
  return { adapter, ctx, effects, calls, get context() { return context; } };
}
after(() => { assert.deepEqual(deniedAttempts, []); assert.equal(process.env.PATH, '/__notification_no_executables__'); });

test('FYIP exact shape passes unchanged to sole core; suppression is not changed to attention success', async () => {
  const h = harness(); const args = input();
  const pending = h.adapter.publishFYIP(args, h.ctx, new AbortController().signal);
  args.candidate.title = 'Caller changed after invocation';
  assert.equal(await pending, suppressed);
  assert.deepEqual(h.calls[0], input());
  assert.equal(h.context.signal.aborted, true); assert.equal(h.effects.length, 0);
});

test('FYIP validates public structure, not admission/policy; nested and top overrides never reach core', async () => {
  const h = harness();
  for (const extra of [{ policy: 'bypass' }, { owner: 'owner' }, { profile: 'other' }, { text: 'raw final' }])
    await assert.rejects(h.adapter.publishFYIP({ ...input(), ...extra }, h.ctx, new AbortController().signal), /invalid_request/);
  for (const value of [{ ...candidate, proof: true }, { ...candidate, evidence: [{ ...candidate.evidence[0], verified: true }] }])
    await assert.rejects(h.adapter.publishFYIP({ ...input(), candidate: value }, h.ctx, new AbortController().signal), /invalid_request/);
  assert.equal(h.calls.length, 0);
  const args = { ...input(), candidate: { ...candidate, reconciled: false } };
  assert.equal(await h.adapter.publishFYIP(args, h.ctx, new AbortController().signal), suppressed);
  assert.deepEqual(h.calls[0], args, 'semantic admission belongs to core, not the shape adapter');
});

test('FYIP uses same fixed native capabilities and revokes every callback on normal return', async () => {
  const h = harness(async (_args, ctx) => {
    await ctx.hostCheck();
    await ctx.inboxSend({ body: 'Curated body', idempotency_key: 'claim' });
    await ctx.inboxRead({ message_id: 'msg_' + '0'.repeat(26), thread_id: 'msg_' + '0'.repeat(26) });
    return suppressed;
  });
  await h.adapter.publishFYIP(input(), h.ctx, new AbortController().signal);
  assert.equal(h.effects.length, 2);
  await assert.rejects(h.context.hostCheck(), /cancelled/);
  await assert.rejects(h.context.inboxSend({ body: 'late', idempotency_key: 'late' }), /cancelled/);
  await assert.rejects(h.context.inboxRead({ message_id: 'msg_' + '0'.repeat(26), thread_id: 'msg_' + '0'.repeat(26) }), /cancelled/);
  assert.equal(h.effects.length, 2);
});

test('FYIP cancellation races uncooperative core, shares busy lock with attention and fences late capabilities', async () => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const h = harness(async () => { entered(); await wait; return suppressed; });
  const controller = new AbortController(); const running = h.adapter.publishFYIP(input(), h.ctx, controller.signal);
  await ready;
  await assert.rejects(h.adapter.publish({ text: 'Attention', decision_key: 'other', revision: 'a'.repeat(40) },
    h.ctx, new AbortController().signal), /busy/);
  controller.abort(); await assert.rejects(running, /cancelled/);
  await assert.rejects(h.context.hostCheck(), /cancelled/);
  await assert.rejects(h.context.inboxSend({ body: 'late', idempotency_key: 'late' }), /cancelled/);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.effects.length, 0);
  assert.equal((await h.adapter.publish({ text: 'Attention', decision_key: 'other', revision: 'a'.repeat(40) },
    h.ctx, new AbortController().signal)).state, 'sent');
});
