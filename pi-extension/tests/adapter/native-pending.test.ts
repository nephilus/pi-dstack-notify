import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { NotificationAdapter } from '../../adapter/runtime.ts';
import type { HostContext } from '../../adapter/types.ts';
import type { NotificationService, PublicationContext, PublishArguments, NativeMcpResult, NotificationReceipt } from '../../core/types.ts';
import { READ, SEND } from '../../adapter/schema.ts';
import { deniedAttempts } from './deny-runtime.ts';

type ReadPort = (args: { message_id: string; thread_id: string }, options?: { signal?: AbortSignal }) => Promise<NativeMcpResult>;
const ids = { message_id: 'msg_' + '0'.repeat(26), thread_id: 'msg_' + '0'.repeat(26) };
const args = (key = 'first'): PublishArguments => ({ text: 'Deliberate update', decision_key: key, revision: 'a'.repeat(40) });
const result: NotificationReceipt = { state: 'held', admission: { status: 'held' },
  classification: { status: 'bypassed' }, delivery: { status: 'not_attempted' } };
const native: NativeMcpResult = { content: [], structuredContent: {} };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function harness(spy: (args: PublishArguments, context: PublicationContext) => Promise<NotificationReceipt>,
  AdapterClass = NotificationAdapter) {
  const state = { cwd: '/project', session: 'session', calls: 0, constructions: 0 };
  const dispatches: Array<{ name: string; args: unknown; signal: AbortSignal;
    resolve(value: { isError: boolean; result: NativeMcpResult }): void; reject(error: Error): void }> = [];
  const ctx = { get cwd() { return state.cwd; },
    sessionManager: { getCwd: () => state.cwd, getSessionId: () => state.session },
    tools: [{ name: SEND }, { name: READ }],
    executeTool(name: string, args: unknown, { signal }: { signal: AbortSignal }) {
      return new Promise((resolve, reject) => { dispatches.push({ name, args, signal, resolve, reject }); });
    } } as unknown as HostContext;
  const adapter = new AdapterClass({ configPath: '/fixture/config', canonicalize: p => p,
    serviceFactory: () => {
      state.constructions++;
      // Call-spy only. No fake state engine or synthetic delivery decisions.
      return { async publish(args: PublishArguments, context: PublicationContext) {
        state.calls++; return spy(args, context);
      }, async publishFYIP() { throw Error('unexpected FYIP'); },
      async publishOwnerRequest() { throw Error('owner tool remains unregistered'); },
      async tickReminders() { throw Error('unexpected Tick unit call'); },
      planReminders() { throw Error('must not wake a model'); } } as NotificationService;
    } });
  const publish = (key = 'first', controller = new AbortController()) => adapter.publish(args(key), ctx, controller.signal);
  return { adapter, state, dispatches, publish };
}
after(() => { assert.deepEqual(deniedAttempts, []); assert.equal(process.env.PATH, '/__notification_no_executables__'); });

test('child read timeout -> finally -> next-slot blocked until underlying settlement -> fresh operation only', async t => {
  let wall = Date.now(); t.mock.method(Date, 'now', () => wall);
  const child = new AbortController(); let old!: PublicationContext;
  const h = harness(async (_args, ctx) => {
    if (!old) { old = ctx; try { await (ctx.inboxRead as ReadPort)(ids, { signal: child.signal }); }
      catch { /* Ordinary wrapper/core failure cannot hide poisoned operation. */ } }
    return result;
  });
  const running = h.publish(); await flush();
  assert.equal(h.dispatches.length, 1); assert.equal(h.dispatches[0].name, READ);
  assert.equal(h.adapter.hasPendingNativeDispatch, true);
  assert.deepEqual(h.dispatches[0].args, { ...ids, project_path: '/project', agent_session: 'session', format: 'full' });
  child.abort(); await assert.rejects(running, /cancelled/);
  assert.equal(h.dispatches[0].signal.aborted, true); assert.equal(old.signal.aborted, true);
  // Advance the actual wall-clock observation to a new hour. The adapter guard
  // has no slot escape hatch; later scheduler eligibility cannot clear it either.
  wall += 3_600_000;
  await assert.rejects(h.publish('next-slot-fresh-key'), /busy/);
  assert.equal(h.state.calls, 1); assert.equal(h.state.constructions, 1); assert.equal(h.dispatches.length, 1);
  h.dispatches[0].resolve({ isError: false, result: native }); await flush();
  assert.equal(h.adapter.hasPendingNativeDispatch, false);
  await assert.rejects(old.hostCheck(), /cancelled/);
  await assert.rejects((old.inboxRead as ReadPort)(ids), /cancelled/);
  assert.equal(h.state.calls, 1, 'late settlement runs no fresh work automatically');
  assert.equal(await h.publish('later-fresh'), result); assert.equal(h.state.calls, 2);
});

test('parent abort of unresolved send survives scope/session/lifecycle changes until actual rejection', async () => {
  let old!: PublicationContext;
  const h = harness(async (_args, ctx) => { old = ctx; await ctx.inboxSend({ body: 'Safe', idempotency_key: 'claim' }); return result; });
  const controller = new AbortController(), running = h.publish('first', controller); await flush();
  assert.equal(h.dispatches[0].name, SEND); controller.abort(); await assert.rejects(running, /cancelled/);
  assert.equal(h.dispatches[0].signal.aborted, true);
  h.state.cwd = '/other'; h.state.session = 'new-session'; h.adapter.invalidate(); h.adapter.invalidate();
  await assert.rejects(h.publish('next-hour'), /busy/); assert.equal(h.adapter.hasPendingNativeDispatch, true);
  assert.equal(h.state.calls, 1); assert.equal(h.dispatches.length, 1);
  h.dispatches[0].reject(Error('late native failure')); await flush();
  assert.equal(h.adapter.hasPendingNativeDispatch, false);
  await assert.rejects(old.inboxSend({ body: 'late', idempotency_key: 'late' }), /cancelled/);
  assert.equal(h.dispatches.length, 1);
});

test('already aborted child poisons parent without dispatch, even if core ignores callback failure', async () => {
  const child = new AbortController(); child.abort(); let captured!: PublicationContext;
  const h = harness(async (_args, ctx) => { captured = ctx;
    try { await (ctx.inboxRead as ReadPort)(ids, { signal: child.signal }); } catch { /* ignore */ }
    return result;
  });
  await assert.rejects(h.publish(), /cancelled/);
  assert.equal(captured.signal.aborted, true); assert.equal(h.dispatches.length, 0);
  assert.equal(h.adapter.hasPendingNativeDispatch, false);
});

test('normal send/read serial operation, optional signal only in control options, no stale token clear', async () => {
  let old!: PublicationContext; const child = new AbortController();
  const h = harness(async (_args, ctx) => { old ??= ctx;
    await ctx.inboxSend({ body: 'Safe', idempotency_key: 'claim' });
    await (ctx.inboxRead as ReadPort)(ids, { signal: child.signal }); return result;
  });
  const first = h.publish(); await flush();
  assert.equal(h.adapter.hasPendingNativeDispatch, true); assert.equal(h.dispatches.length, 1);
  h.dispatches[0].resolve({ isError: false, result: native }); await flush();
  assert.equal(h.dispatches.length, 2); assert.equal(h.adapter.hasPendingNativeDispatch, true);
  assert.deepEqual(Object.keys(h.dispatches[1].args as object).sort(), ['agent_session', 'format', 'message_id', 'project_path', 'thread_id']);
  h.dispatches[1].resolve({ isError: false, result: native }); assert.equal(await first, result);
  assert.equal(h.adapter.hasPendingNativeDispatch, false);
  const second = h.publish('second'); await flush(); assert.equal(h.dispatches.length, 3);
  await assert.rejects(old.hostCheck(), /cancelled/);
  await assert.rejects((old.inboxRead as ReadPort)(ids), /cancelled/);
  h.dispatches[0].resolve({ isError: false, result: native }); await flush();
  assert.equal(h.adapter.hasPendingNativeDispatch, true, 'old settlement/cleanup cannot clear new token');
  h.dispatches[2].resolve({ isError: false, result: native }); await flush();
  h.dispatches[3].resolve({ isError: false, result: native }); assert.equal(await second, result);
  assert.equal(h.adapter.hasPendingNativeDispatch, false);
});

test('parent cancellation reaches combined read control signal without aborting child itself', async () => {
  const child = new AbortController();
  const h = harness(async (_args, ctx) => { await (ctx.inboxRead as ReadPort)(ids, { signal: child.signal }); return result; });
  const parent = new AbortController(), pending = h.publish('read', parent); await flush();
  assert.notEqual(h.dispatches[0].signal, child.signal); assert.equal(h.dispatches[0].signal.aborted, false);
  parent.abort(); await assert.rejects(pending, /cancelled/);
  assert.equal(child.signal.aborted, false); assert.equal(h.dispatches[0].signal.aborted, true);
  assert.equal(h.adapter.hasPendingNativeDispatch, true);
  h.dispatches[0].resolve({ isError: true, result: native }); await flush();
  assert.equal(h.adapter.hasPendingNativeDispatch, false);
});

for (const reload of [false, true]) test((reload ? 'fresh queried module' : 'second adapter instance')
  + ' shares pending settlement state without old dispatch authority', async () => {
  let oldContext!: PublicationContext;
  const old = harness(async (_args, ctx) => {
    oldContext = ctx; await ctx.inboxRead(ids); return result;
  });
  const parent = new AbortController(), original = old.publish('original', parent); await flush();
  assert.equal(old.dispatches.length, 1); parent.abort(); await assert.rejects(original, /cancelled/);
  // This import executes a FRESH copy of runtime.ts, not a cached class alias.
  const AdapterClass = reload ? (await import(new URL('../../adapter/runtime.ts?native-pending-reload', import.meta.url).href)).NotificationAdapter
    : NotificationAdapter;
  if (reload) assert.notEqual(AdapterClass, NotificationAdapter);
  const fresh = harness(async (_args, ctx) => { await ctx.inboxSend({ body: 'Fresh', idempotency_key: 'fresh' }); return result; }, AdapterClass);
  assert.equal(fresh.adapter.hasPendingNativeDispatch, true);
  await assert.rejects(fresh.publish('next-slot'), /busy/);
  assert.equal(fresh.state.constructions, 0); assert.equal(fresh.state.calls, 0);
  assert.equal(fresh.dispatches.length, 0);
  old.dispatches[0].resolve({ isError: false, result: native }); await flush();
  assert.equal(fresh.adapter.hasPendingNativeDispatch, false);
  assert.equal(fresh.state.calls, 0, 'settlement has no authority to start fresh work');
  const next = fresh.publish('eligible-fresh'); await flush();
  assert.equal(fresh.state.constructions, 1); assert.equal(fresh.dispatches.length, 1);
  assert.equal(old.adapter.hasPendingNativeDispatch, true, 'both module copies see the new token');
  await assert.rejects(oldContext.hostCheck(), /cancelled/);
  await assert.rejects(oldContext.inboxRead(ids), /cancelled/);
  old.adapter.invalidate(); old.dispatches[0].resolve({ isError: false, result: native }); await flush();
  assert.equal(fresh.adapter.hasPendingNativeDispatch, true, 'old cleanup does not clear new dispatch');
  fresh.dispatches[0].resolve({ isError: false, result: native }); assert.equal(await next, result);
  assert.equal(fresh.adapter.hasPendingNativeDispatch, false);
});

test('child abort after a settled read still poisons its originating operation', async () => {
  const child = new AbortController(); let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const h = harness(async (_args, ctx) => {
    await (ctx.inboxRead as ReadPort)(ids, { signal: child.signal }); await wait;
    await ctx.hostCheck(); return result;
  });
  const pending = h.publish(); await flush();
  h.dispatches[0].resolve({ isError: false, result: native }); await flush();
  assert.equal(h.adapter.hasPendingNativeDispatch, false);
  child.abort(); await assert.rejects(pending, /cancelled/);
  release(); await flush(); assert.equal(h.dispatches.length, 1);
});

test('premature core return with unresolved callback cannot clear pending guard', async () => {
  let discarded!: Promise<NativeMcpResult>;
  const h = harness(async (_args, ctx) => { discarded = ctx.inboxRead(ids); void discarded.catch(() => {}); return result; });
  await assert.rejects(h.publish(), /internal_error/); assert.equal(h.adapter.hasPendingNativeDispatch, true);
  await assert.rejects(h.publish('another'), /busy/); assert.equal(h.dispatches.length, 1);
  h.dispatches[0].resolve({ isError: false, result: native }); await assert.rejects(discarded, /cancelled/);
  assert.equal(h.adapter.hasPendingNativeDispatch, false);
});
