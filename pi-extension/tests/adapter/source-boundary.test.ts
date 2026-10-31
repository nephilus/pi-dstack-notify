import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { NotificationAdapter } from '../../adapter/runtime.ts';
import type { HostContext, NativeMcpResult, NotificationReceipt, PublicationContext } from '../../adapter/types.ts';
import { READ, SEND } from '../../adapter/schema.ts';

const root = new URL('../../', import.meta.url);

test('sanitized root excludes legacy bridge evidence and FULL activation manifest', () => {
  assert.equal(existsSync(new URL('evidence/', root)), false);
  assert.equal(existsSync(new URL('package.json', root)), false);
  assert.equal(existsSync(new URL('notification-python.py', root)), false);
  const manifest = JSON.parse(readFileSync(new URL('../package.json', root), 'utf8'));
  assert.deepEqual(manifest.pi.extensions, ['./pi-extension/minimal.ts']);
  assert.equal(Object.hasOwn(manifest, 'dependencies'), false);
});

test('owned active runtime graph is TS only with one direct core import and no subprocess path', () => {
  const entry = readFileSync(new URL('index.ts', root), 'utf8');
  assert.match(entry, /import \{ createNotificationService \} from '\.\/core\/service\.ts'/);
  for (const path of ['index.ts', 'adapter/register.ts', 'adapter/runtime.ts', 'adapter/schema.ts', 'adapter/types.ts']) {
    const text = readFileSync(new URL(path, root), 'utf8');
    assert.doesNotMatch(text, /child_process|\bspawn\s*\(|\bexecFile\s*\(|notification-python|alert_binding|protocol\.mjs|runtime\.mjs/);
    assert.doesNotMatch(text, /registerCommand|registerMcpServer|setActiveTools/);
  }
});

test('concurrent native callbacks are denied and completed context is revoked', async () => {
  let calls = 0;
  let old!: PublicationContext;
  const native: NativeMcpResult = { content: [{ type: 'text', text: 'Fixture' }], structuredContent: {} };
  let release!: (value: { isError: false; result: NativeMcpResult }) => void;
  const raw = { cwd: '/project', sessionManager: { getCwd: () => '/project', getSessionId: () => 'session' },
    tools: [{ name: SEND }, { name: READ }],
    executeTool: async () => new Promise(resolve => { release = resolve; }),
  };
  const adapter = new NotificationAdapter({ configPath: '/fixture', canonicalize: path => path,
    serviceFactory: () => ({ async publish(_args, context) {
      calls++;
      if (calls === 1) {
        old = context;
        const send = context.inboxSend({ body: 'Safe', idempotency_key: 'fixture' });
        await assert.rejects(context.inboxRead({ message_id: 'msg_' + '0'.repeat(26), thread_id: 'msg_' + '0'.repeat(26) }), /callback_failed/);
        release({ isError: false, result: native });
        await send;
      } else {
        await assert.rejects(old.hostCheck(), /cancelled/);
        assert.equal((await context.hostCheck()).session_id, 'session');
      }
      return { state: 'held', admission: { status: 'held' }, classification: { status: 'bypassed' }, delivery: { status: 'held' } };
    }, async publishFYIP() { throw Error('unexpected FYIP call'); },
    async publishOwnerRequest() { throw Error('unexpected owner request'); },
    async tickReminders() { throw Error('unexpected Tick unit call'); },
    planReminders() { throw Error('unexpected plan call'); } }) });
  const args = { text: 'Update', decision_key: 'key', revision: 'a'.repeat(40) };
  await adapter.publish(args, raw as unknown as HostContext, new AbortController().signal);
  await adapter.publish({ ...args, decision_key: 'second' }, raw as unknown as HostContext, new AbortController().signal);
  assert.equal(calls, 2);
});

test('cancelled A blocks B until native settlement; stale A callbacks cannot revoke active B', async () => {
  const mid = 'msg_' + '0'.repeat(26);
  const native: NativeMcpResult = { content: [{ type: 'text', text: 'Fixture' }], structuredContent: {} };
  const result: NotificationReceipt = { state: 'sent', admission: { status: 'admitted' },
    classification: { status: 'bypassed' }, delivery: { status: 'sent' } };
  let a!: PublicationContext, b!: PublicationContext;
  let enteredA!: () => void, enteredB!: () => void, finishAWork!: () => void, releaseB!: () => void;
  let resolveANative!: (value: { isError: false; result: NativeMcpResult }) => void;
  const aEntered = new Promise<void>(resolve => { enteredA = resolve; });
  const bEntered = new Promise<void>(resolve => { enteredB = resolve; });
  const aWorkFinished = new Promise<void>(resolve => { finishAWork = resolve; });
  const bHeld = new Promise<void>(resolve => { releaseB = resolve; });
  const dispatches: Array<{ name: string; args: unknown }> = [];
  const raw = { cwd: '/project', sessionManager: { getCwd: () => '/project', getSessionId: () => 'session' },
    tools: [{ name: SEND }, { name: READ }],
    executeTool(name: string, args: unknown) {
      dispatches.push({ name, args });
      if (dispatches.length === 1) {
        enteredA();
        return new Promise(resolve => { resolveANative = resolve; });
      }
      return Promise.resolve({ isError: false as const, result: native });
    },
  };
  const adapter = new NotificationAdapter({ configPath: '/fixture', canonicalize: path => path,
    serviceFactory: () => ({ async publish(args, context) {
      if (args.decision_key === 'A') {
        a = context;
        try {
          await context.inboxSend({ body: 'A update', idempotency_key: 'A' });
          await context.inboxRead({ message_id: mid, thread_id: mid });
          return result;
        } finally { finishAWork(); }
      }
      b = context;
      await context.inboxSend({ body: 'B update', idempotency_key: 'B' });
      enteredB();
      await bHeld;
      assert.equal((await context.hostCheck()).session_id, 'session');
      return result;
    }, async publishFYIP() { throw Error('unexpected FYIP call'); },
    async publishOwnerRequest() { throw Error('unexpected owner request'); },
    async tickReminders() { throw Error('unexpected Tick unit call'); },
    planReminders() { throw Error('unexpected plan call'); } }) });
  const args = { text: 'Update', decision_key: 'A', revision: 'a'.repeat(40) };
  const controllerA = new AbortController();
  const publicationA = adapter.publish(args, raw as unknown as HostContext, controllerA.signal);
  await aEntered;
  assert.deepEqual(dispatches.map(call => call.name), [SEND]);
  controllerA.abort();
  await assert.rejects(publicationA, /cancelled/);

  assert.equal(adapter.hasPendingNativeDispatch, true);
  await assert.rejects(adapter.publish({ ...args, decision_key: 'B' }, raw as unknown as HostContext,
    new AbortController().signal), /busy/);
  assert.equal(dispatches.length, 1);
  resolveANative({ isError: false, result: native });
  await aWorkFinished;
  assert.equal(adapter.hasPendingNativeDispatch, false);

  let bCompleted = false;
  const publicationB = adapter.publish({ ...args, decision_key: 'B' }, raw as unknown as HostContext,
    new AbortController().signal).then(value => { bCompleted = true; return value; });
  await bEntered;
  assert.deepEqual(dispatches.map(call => call.name), [SEND, SEND]);
  assert.equal(bCompleted, false, 'B must still be active while A resumes');
  assert.equal(b.signal.aborted, false);

  await assert.rejects(a.hostCheck(), /cancelled/);
  await assert.rejects(a.inboxSend({ body: 'Late A', idempotency_key: 'A-late' }), /cancelled/);
  await assert.rejects(a.inboxRead({ message_id: mid, thread_id: mid }), /cancelled/);
  assert.equal(a.signal.aborted, true);
  assert.equal(b.signal.aborted, false, 'late A must not invalidate B');
  assert.equal(bCompleted, false);
  assert.equal((await b.hostCheck()).project_path, '/project');
  assert.deepEqual(dispatches.map(call => call.name), [SEND, SEND], 'no late A dispatch or read');

  releaseB();
  assert.equal(await publicationB, result);
  assert.equal(bCompleted, true);
  assert.equal(dispatches.length, 2);
});
