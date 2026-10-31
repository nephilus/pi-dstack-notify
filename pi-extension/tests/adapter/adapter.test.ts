import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { installUnitEntryHook, UNIT_ENTRY_URL, HOST_TYPEBOX_URL } from './unit-entry-hook.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { HostContext, NativeMcpResult, NotificationReceipt, PublicationContext, PublishArguments } from '../../adapter/types.ts';
import { NotificationAdapter } from '../../adapter/runtime.ts';
import { INPUT_SCHEMA, FYIP_INPUT_SCHEMA, KEY_PATTERN, READ, SEND } from '../../adapter/schema.ts';
import { registerNotificationExtension } from '../../adapter/register.ts';
import { deniedAttempts } from './deny-runtime.ts';

// UNIT ONLY: injected core call-spy. No ledger/policy/configuration implementation.
const receipt = (state: NotificationReceipt['state'] = 'sent'): NotificationReceipt => ({
  state, admission: { status: 'admitted' }, classification: { status: 'bypassed' }, delivery: { status: state },
});
const input = (key = 'legacy/key:team@owner+one'): PublishArguments => ({
  text: 'A deliberate update', decision_key: key, revision: 'a'.repeat(40),
});
const MID = 'msg_' + '0'.repeat(26);
const native: NativeMcpResult = { content: [{ type: 'text', text: 'Native fixture' }],
  structuredContent: { message_id: MID, thread_id: MID }, isError: false, _meta: { fixture: true } };
type Spy = (args: PublishArguments, context: PublicationContext) => Promise<NotificationReceipt>;
function harness(spy: Spy = async () => receipt(), configPath: unknown = '/fixture/config.json') {
  let cwd = '/project', session = 'session-1', managerCwd: string | undefined;
  let constructions = 0;
  const coreCalls: Array<{ args: PublishArguments; context: PublicationContext }> = [];
  const effects: Array<{ name: string; args: unknown; signal: AbortSignal }> = [];
  const rawCtx = {
    get cwd() { return cwd; },
    sessionManager: { getCwd: () => managerCwd ?? cwd, getSessionId: () => session },
    tools: [{ name: SEND }, { name: READ }],
    async executeTool(name: string, args: unknown, { signal }: { signal: AbortSignal }) {
      assert.equal(signal.aborted, false);
      effects.push({ name, args, signal });
      return { isError: false, result: native };
    },
  };
  const factory = (options: { configPath: string }) => {
    assert.equal(options.configPath, configPath);
    constructions++;
    return { async publish(args: PublishArguments, context: PublicationContext) {
      coreCalls.push({ args, context }); return spy(args, context);
    }, async publishFYIP() { throw Error('unexpected FYIP unit call'); },
    async publishOwnerRequest() { throw Error('unexpected owner request'); },
    async tickReminders() { throw Error('unexpected Tick unit call'); },
    planReminders() { return { status: 'inactive' as const, reason: 'no_due_work' as const, utc_slot: null, due_count: 0 }; } };
  };
  const adapter = new NotificationAdapter({ configPath, canonicalize: p => p, serviceFactory: factory });
  return { adapter, factory, ctx: rawCtx as unknown as HostContext, rawCtx, coreCalls, effects,
    constructions: () => constructions, setCwd: (v: string) => { cwd = v; },
    setSession: (v: string) => { session = v; }, setManagerCwd: (v: string) => { managerCwd = v; } };
}
const signal = () => new AbortController().signal;

after(() => {
  assert.equal(process.env.PATH, '/__notification_no_executables__');
  assert.deepEqual(deniedAttempts, [], 'no child/Python/network attempt is allowed, even if caught');
});

test('exact tool schema preserves attention identity and Git/content revision forms', async () => {
  assert.equal(INPUT_SCHEMA.additionalProperties, false);
  assert.equal(INPUT_SCHEMA.properties.decision_key.pattern, KEY_PATTERN);
  assert.equal(INPUT_SCHEMA.properties.decision_key.maxLength, 200);
  const h = harness();
  for (const revision of ['a'.repeat(40), 'b'.repeat(64)]) {
    const args = { ...input(), revision };
    await h.adapter.publish(args, h.ctx, signal());
    assert.deepEqual(h.coreCalls.at(-1)?.args, args); // no path hash/normalization
  }
  for (const extra of [{ destination: 'elsewhere' }, { profile: 'other' }, { project_path: '/wrong' },
    { role: 'manager' }, { url: 'https://example.invalid' }, { policy: 'other' }]) {
    await assert.rejects(h.adapter.publish({ ...input(), ...extra }, h.ctx, signal()), /invalid_request/);
  }
  for (const bad of [{ text: ' ' }, { text: 'x'.repeat(16001) }, { decision_key: 'x'.repeat(201) },
    { decision_key: 'valid\n' }, { decision_key: '-invalid' }, { revision: 'a'.repeat(40) + '\n' },
    { revision: 'A'.repeat(40) }, { revision: '1'.repeat(41) }]) {
    await assert.rejects(h.adapter.publish({ ...input(), ...bad }, h.ctx, signal()), /invalid_request/);
  }
  const linked = { ...input(), review_link: { label: 'Review', url: 'https://review.example.invalid/' } };
  await h.adapter.publish(linked, h.ctx, signal());
  assert.deepEqual(h.coreCalls.at(-1)?.args, linked);
  assert.equal(INPUT_SCHEMA.properties.review_link.additionalProperties, false);
  for (const review_link of [null, [], { ...linked.review_link, transport: 'other' },
    { label: 'Review' }, { ...linked.review_link, label: 4 }]) {
    await assert.rejects(h.adapter.publish({ ...input(), review_link }, h.ctx, signal()), /invalid_request/);
  }
  assert.equal(h.coreCalls.length, 3);
});

test('two distinct updates in same session reuse direct core instance without rebind (unit)', async () => {
  const h = harness();
  assert.equal(h.constructions(), 0);
  await h.adapter.publish(input('first'), h.ctx, signal());
  await h.adapter.publish(input('second'), h.ctx, signal());
  assert.equal(h.constructions(), 1);
  assert.equal(h.coreCalls.length, 2);
  assert.notEqual(h.coreCalls[0].context.operationId, h.coreCalls[1].context.operationId);
  for (const call of h.coreCalls) {
    assert.deepEqual(call.context.observed, { session_id: 'session-1', project_path: '/project' });
    assert.equal(call.context.signal.aborted, true); // revoked on tool return
  }
});

test('duplicate/held/unknown receipts are core decisions, not adapter policy', async () => {
  for (const state of ['duplicate', 'held', 'unknown'] as const) {
    const result = receipt(state), h = harness(async () => result);
    assert.equal(await h.adapter.publish(input(), h.ctx, signal()), result);
    assert.equal(h.effects.length, 0);
  }
});

test('fixed Inbox callbacks inject exact scope/provenance and preserve whole native object', async () => {
  const h = harness(async (_args, context) => {
    assert.deepEqual(await context.hostCheck(), { session_id: 'session-1', project_path: '/project' });
    assert.equal(await context.inboxSend({ body: 'Safe final fixture', idempotency_key: 'fixture-key' }), native);
    assert.equal(await context.inboxRead({ message_id: MID, thread_id: MID }), native);
    return receipt();
  });
  await h.adapter.publish(input(), h.ctx, signal());
  assert.deepEqual(h.effects.map(e => e.name), [SEND, READ]);
  assert.deepEqual(h.effects[0].args, { body: 'Safe final fixture', idempotency_key: 'fixture-key',
    project_path: '/project', agent_session: 'session-1', agent_host: 'pi', agent_name: 'Pi notification publisher' });
  assert.deepEqual(h.effects[1].args, { message_id: MID, thread_id: MID, project_path: '/project',
    agent_session: 'session-1', format: 'full' });
});

test('missing/relative config disables before core construction or host filesystem observation', async () => {
  for (const configPath of [undefined, false, '', 'relative.json']) {
    let touched = false;
    const adapter = new NotificationAdapter({ configPath, canonicalize: () => { touched = true; throw new Error(); },
      serviceFactory: () => { touched = true; throw new Error(); } });
    await assert.rejects(adapter.publish(input(), {} as HostContext, signal()), /configuration_unavailable/);
    assert.equal(touched, false);
  }
});

test('canonical cwd/manager mismatch, invalid session or stale accessor rejects before core', async () => {
  const h = harness(); h.setManagerCwd('/wrong');
  await assert.rejects(h.adapter.publish(input(), h.ctx, signal()), /cancelled/);
  assert.equal(h.constructions(), 0);
  h.setManagerCwd('/project'); h.setSession('session\n');
  await assert.rejects(h.adapter.publish(input(), h.ctx, signal()), /cancelled/);
  Object.defineProperty(h.rawCtx, 'cwd', { get() { throw new Error('PRIVATE-DETAIL'); } });
  await assert.rejects(h.adapter.publish(input(), h.ctx, signal()), /^Error: cancelled$/);
});

test('actual canonicalization output, not caller alias, supplies observation', async () => {
  const h = harness(); h.setCwd('/alias'); h.setManagerCwd('/canonical');
  const adapter = new NotificationAdapter({ configPath: '/fixture/config.json', serviceFactory: h.factory,
    canonicalize: p => p === '/alias' ? '/canonical' : p });
  await adapter.publish(input(), h.ctx, signal());
  assert.equal(h.coreCalls[0].context.observed.project_path, '/canonical');
});

test('missing callable tools hold without activation/exposure/fallback', async () => {
  const h = harness(async (_args, context) => {
    await assert.rejects(context.inboxSend({ body: 'Safe', idempotency_key: 'fixture' }), /callback_failed/);
    return receipt('held');
  });
  h.rawCtx.tools = [];
  await h.adapter.publish(input(), h.ctx, signal());
  assert.equal(h.effects.length, 0);
});

test('outer errors/exceptions controlled; native isError remains for core validation', async () => {
  for (const mode of ['outer', 'throw', 'native']) {
    const h = harness(async (_args, context) => {
      if (mode === 'native') assert.equal((await context.inboxSend({ body: 'Safe', idempotency_key: 'key' })).isError, true);
      else await assert.rejects(context.inboxSend({ body: 'Safe', idempotency_key: 'key' }), /^Error: callback_failed$/);
      return receipt('held');
    });
    h.rawCtx.executeTool = async () => {
      if (mode === 'throw') throw new Error('PRIVATE-EXCEPTION');
      return { isError: mode === 'outer', result: { ...native, isError: true } };
    };
    await h.adapter.publish(input(), h.ctx, signal());
  }
});

test('callback selectors/extra fields rejected before any native call', async () => {
  const h = harness(async (_args, context) => {
    await assert.rejects(context.inboxSend({ body: 'Safe', idempotency_key: 'key',
      attachments: ['/private'] } as never), /invalid_request/);
    await assert.rejects(context.inboxRead({ message_id: MID, thread_id: MID, project_path: '/wrong' } as never), /invalid_request/);
    await assert.rejects(context.inboxRead({ message_id: MID + '\n', thread_id: MID }), /invalid_request/);
    return receipt('held');
  });
  await h.adapter.publish(input(), h.ctx, signal());
  assert.equal(h.effects.length, 0);
});

test('abort promptly revokes uncooperative core and all retained callbacks', async () => {
  let captured!: PublicationContext, entered!: () => void, finish!: (r: NotificationReceipt) => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const h = harness(async (_args, context) => {
    captured = context; entered(); return new Promise(resolve => { finish = resolve; });
  });
  const controller = new AbortController();
  const running = h.adapter.publish(input(), h.ctx, controller.signal);
  await ready; controller.abort();
  await assert.rejects(running, /cancelled/);
  assert.equal(captured.signal.aborted, true);
  await assert.rejects(captured.hostCheck(), /cancelled/);
  await assert.rejects(captured.inboxSend({ body: 'Safe', idempotency_key: 'key' }), /cancelled/);
  finish(receipt());
  assert.equal(h.effects.length, 0);
});

test('scope change after async Inbox return cancels; late native success is not success', async () => {
  for (const kind of ['session', 'project']) {
    const h = harness(async (_args, context) => {
      await context.inboxSend({ body: 'Safe', idempotency_key: 'key' }); return receipt();
    });
    h.rawCtx.executeTool = async () => {
      if (kind === 'session') h.setSession('new-session'); else h.setCwd('/changed');
      return { isError: false, result: native };
    };
    await assert.rejects(h.adapter.publish(input(), h.ctx, signal()), /cancelled/);
  }
});

test('lifecycle cancellation during native await rejects late result without further dispatch', async () => {
  let entered!: () => void, finish!: (r: { isError: boolean; result: NativeMcpResult }) => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const h = harness(async (_args, context) => {
    await context.inboxSend({ body: 'Safe', idempotency_key: 'key' });
    await context.inboxRead({ message_id: MID, thread_id: MID }); return receipt();
  });
  h.rawCtx.executeTool = (name, args, { signal }) => {
    h.effects.push({ name, args, signal });
    if (h.effects.length === 1) {
      entered();
      return new Promise(resolve => { finish = resolve; });
    }
    return Promise.resolve({ isError: false, result: native });
  };
  const running = h.adapter.publish(input(), h.ctx, signal());
  await ready;
  assert.deepEqual(h.effects.map(effect => effect.name), [SEND]);
  h.adapter.invalidate();
  await assert.rejects(running, /cancelled/);
  finish({ isError: false, result: native });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.effects.map(effect => effect.name), [SEND]);
  assert.equal(h.effects.length, 1, 'late send completion must not dispatch read_thread');
});

test('after normal return every callback is revoked', async () => {
  let captured!: PublicationContext;
  const h = harness(async (_args, context) => { captured = context; return receipt(); });
  await h.adapter.publish(input(), h.ctx, signal());
  await assert.rejects(captured.hostCheck(), /cancelled/);
  await assert.rejects(captured.inboxRead({ message_id: MID, thread_id: MID }), /cancelled/);
  assert.equal(h.effects.length, 0);
});

test('busy or aborted invocation cannot start another core operation', async () => {
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const h = harness(async () => { entered(); return new Promise(() => {}); });
  const already = new AbortController(); already.abort();
  await assert.rejects(h.adapter.publish(input(), h.ctx, already.signal), /cancelled/);
  const controller = new AbortController();
  const running = h.adapter.publish(input(), h.ctx, controller.signal);
  await ready;
  await assert.rejects(h.adapter.publish(input(), h.ctx, signal()), /busy/);
  controller.abort(); await assert.rejects(running, /cancelled/);
  assert.equal(h.coreCalls.length, 1);
});

test('constructor failures and malformed core receipts do not leak errors or orphan cancellation', async () => {
  const h = harness(async () => ({ private: 'SECRET' }) as unknown as NotificationReceipt);
  await assert.rejects(h.adapter.publish(input(), h.ctx, signal()), /^Error: internal_error$/);
  const adapter = new NotificationAdapter({ configPath: '/fixture/config.json', canonicalize: p => p,
    serviceFactory: () => { throw new Error('PRIVATE-EXCEPTION'); } });
  await assert.rejects(adapter.publish(input(), h.ctx, signal()), /^Error: internal_error$/);
});

test('fake Pi registration is inert with only config flag and no commands; normal sessions need no rebind', async () => {
  const h = harness();
  let tool: any;
  const handlers = new Map<string, () => Promise<void>>(), flags: string[] = [];
  const pi = { registerFlag: (name: string) => flags.push(name), getFlag: () => '/fixture/config.json',
    on: (name: string, fn: () => Promise<void>) => handlers.set(name, fn), registerTool: (value: unknown) => { tool = value; } };
  const adapter = registerNotificationExtension(pi as unknown as ExtensionAPI, {
    parameters: INPUT_SCHEMA, fyipParameters: FYIP_INPUT_SCHEMA, pokeParameters: {}, tickParameters: { type: 'object', properties: {}, additionalProperties: false }, serviceFactory: h.factory, canonicalize: p => p,
  });
  assert.equal(h.constructions(), 0);
  assert.deepEqual(flags, ['notification-config']);
  assert.equal(tool.exposure, 'model-only'); assert.equal(tool.executionMode, 'sequential');
  assert.deepEqual(tool.reachesTools(), [SEND, READ]);
  await handlers.get('session_start')!();
  assert.equal((await tool.execute('one', input(), signal(), undefined, h.ctx)).details.state, 'sent');
  await handlers.get('session_shutdown')!(); h.setSession('session-2');
  await handlers.get('session_start')!();
  assert.equal((await tool.execute('two', input('second'), signal(), undefined, h.ctx)).details.state, 'sent');
  assert.equal(h.constructions(), 2);
  adapter.invalidate();
  await handlers.get('session_shutdown')!();
});

test('actual TS entry uses direct service import through fake dependency spy (unit, not E2E)', async () => {
  const dispose = installUnitEntryHook();
  try {
    // Unique URL keeps this explicit unit stub out of actual-entry E2E imports.
    const { default: entry } = await import(UNIT_ENTRY_URL);
    let tool: any;
    entry({ registerFlag() {}, getFlag: () => undefined, on() {}, registerTool: (v: unknown) => { tool = v; } } as unknown as ExtensionAPI);
    assert.equal(tool.parameters.additionalProperties, false);
    const result = await tool.execute('id', input(), signal(), undefined, {});
    assert.equal(result.details.code, 'configuration_unavailable');
    assert.equal(result.isError, true);
  } finally { dispose(); }
});

test('fresh ordinary entry resolves actual TypeBox while exact unit-parent stubs are installed', async () => {
  const ordinaryURL = new URL('../../index.ts?ordinary-isolation-regression', import.meta.url).href;
  const edges: Array<{ parent: string | undefined; url: string }> = [];
  const dispose = installUnitEntryHook((parent, url) => edges.push({ parent, url }));
  try {
    // Fresh entry URL forces a new resolution edge; cached E2E entry cannot
    // satisfy this assertion. The ordinary core edge is never substituted.
    const { default: entry } = await import(ordinaryURL);
    assert.deepEqual(edges.filter(edge => edge.parent === ordinaryURL),
      [{ parent: ordinaryURL, url: HOST_TYPEBOX_URL }]);
    const { Type } = await import(HOST_TYPEBOX_URL);
    assert.equal(typeof Type.String, 'function');
    assert.equal(Type.Object({ value: Type.String() }).properties.value.type, 'string');
    let tool: any;
    entry({ registerFlag() {}, getFlag: () => undefined, on() {},
      registerTool: (value: unknown) => { tool = value; } } as unknown as ExtensionAPI);
    assert.equal(tool.parameters.properties.decision_key.maxLength, 200);
    const result = await tool.execute('ordinary', input(), signal(), undefined, {});
    assert.equal(result.details.code, 'configuration_unavailable');
  } finally { dispose(); }
});
