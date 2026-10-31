import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import notificationExtension from '../../index.ts';
import { READ, SEND } from '../../adapter/schema.ts';
import { waitForTestTelegramHttpRequest, completeLateTestTelegramHttp } from '../../core/transport.ts';
import { deniedAttempts } from '../adapter/deny-runtime.ts';
import { argument, fixture, receiptOf, revision, writePrivate } from './fixture.ts';

// Actual entry + actual TS service/policy/profile/SQLite ledger/readback/rendering
// + core-branded fake Telegram. Native Inbox is synthetic source-shaped I/O.
after(() => {
  assert.equal(process.env.PATH, '/__notification_no_executables__');
  assert.deepEqual(deniedAttempts, [], 'no intercepted process/network attempt, even if caught');
});

test('real entry and actual core: two distinct updates one session, unchanged config, durable confirmed replay', async t => {
  const h = fixture(t);
  const configBytes = fs.readFileSync(h.configPath);
  const profileBytes = fs.readFileSync(h.profile);
  for (const [key, rev] of [['owner/repo:first@branch+1', 'b'.repeat(40)], ['owner/repo:second', revision]]) {
    const args = argument(key, rev);
    const result = receiptOf(await h.invoke(args));
    assert.equal(result.state, 'sent');
    assert.equal(result.classification.bypass_reason, 'explicit_attention');
    assert.equal(result.admission.identity_binding?.status, 'canonical-bound');
    assert.equal(result.admission.inbox_target?.revision, rev);
    assert.equal(result.admission.inbox_target?.revision_semantics, rev.length === 40 ? 'git-sha1' : 'content-sha256');
    assert.equal(result.delivery.receipt?.identity.decision_key, key);
    assert.equal(result.delivery.receipt?.identity.profile_id, 'test-only.primary');
    assert.equal(result.delivery.receipt?.identity.destination_id, 'test-only.owner');
    assert.equal(result.admission.reachability, 'not_verified');
  }
  assert.deepEqual(h.dispatches.map(call => call.name), [SEND, READ, SEND, READ]);
  assert.equal(h.telegramHttpClient.messages.length, 2);
  assert.deepEqual(fs.readFileSync(h.configPath), configBytes);
  assert.deepEqual(fs.readFileSync(h.profile), profileBytes);
  assert.equal(h.host.session, 'synthetic-session');
  const before = h.rows('deliveries');
  assert.equal(before.length, 2); assert.ok(before.every(row => row.state === 'sent'));
  const associations = h.rows('canonical_associations');
  assert.equal(associations.length, 2); assert.ok(associations.every(row => row.read_verified === 1));
  const first = argument('owner/repo:first@branch+1', 'b'.repeat(40));
  assert.equal(receiptOf(await h.invoke(first)).state, 'duplicate');
  await h.restart(); h.host.session = 'another-session';
  assert.equal(receiptOf(await h.invoke(first)).state, 'duplicate');
  assert.equal(h.dispatches.length, 4); assert.equal(h.telegramHttpClient.messages.length, 2);
  assert.deepEqual(h.rows('deliveries'), before);
  const message = h.telegramHttpClient.messages[0];
  assert.match(message.text, /^Attention · explicit request · unclassified/);
  assert.ok(message.text.includes('https://inbox.example.invalid/#thread='));
  assert.ok(message.entities.some(entity => entity.type === 'text_link' &&
    message.text.slice(entity.offset, entity.offset + entity.length) === entity.url));
});

test('actual ledger is claimed durably before native Inbox invocation', async t => {
  const h = fixture(t);
  let witnessed = false;
  h.state.onNative = stage => {
    if (stage === 'send') {
      assert.equal(h.rows('deliveries')[0].state, 'in_flight');
      assert.equal(h.telegramHttpClient.messages.length, 0); witnessed = true;
    }
  };
  assert.equal(receiptOf(await h.invoke()).state, 'sent');
  assert.equal(witnessed, true);
});

test('actual default no-config entry is inert without host/config/transport initialization', async () => {
  let tool: any, observed = 0, nativeCalls = 0;
  const flags: string[] = [];
  const pi = { registerFlag: (name: string) => flags.push(name), getFlag: () => undefined,
    on() {}, registerTool(value: unknown) { tool = value; } };
  notificationExtension(pi as unknown as ExtensionAPI);
  const result = await tool.execute('no-config', argument(), new AbortController().signal, undefined, {
    get cwd() { observed++; throw new Error('must not observe'); },
    async executeTool() { nativeCalls++; throw new Error('must not dispatch'); },
  });
  assert.equal(result.isError, true); assert.deepEqual(result.details, { code: 'configuration_unavailable' });
  assert.equal(observed, 0); assert.equal(nativeCalls, 0);
  assert.deepEqual(flags, ['notification-config']);
});

test('default configured entry with disabled project holds without production HTTP attempts', async t => {
  const h = fixture(t); h.config.projects[0].enabled = false; h.save();
  h.start({ defaultEntry: true });
  const result = receiptOf(await h.invoke());
  assert.equal(result.state, 'held');
  assert.equal(h.dispatches.length, 0); assert.equal(h.telegramHttpClient.messages.length, 0);
  assert.equal(h.rows('deliveries').length, 0);
});

test('wrong canonical project and disabled project/config hold before all effects', async t => {
  const h = fixture(t);
  h.host.cwd = h.host.managerCwd = h.directory;
  assert.equal(receiptOf(await h.invoke()).state, 'held');
  h.host.cwd = h.host.managerCwd = h.project;
  h.config.projects[0].enabled = false; h.save();
  assert.equal(receiptOf(await h.invoke()).state, 'held');
  h.config.projects[0].enabled = true; h.config.enabled = false; h.save();
  assert.equal(receiptOf(await h.invoke()).state, 'held');
  assert.equal(h.dispatches.length, 0); assert.equal(h.telegramHttpClient.messages.length, 0);
  assert.equal(h.rows('deliveries').length, 0);
});

test('recipient/profile/role/project/transport overrides are unrepresentable at actual entry', async t => {
  const h = fixture(t);
  for (const field of ['recipient', 'destination', 'destination_id', 'profile', 'profile_path', 'role',
    'project_path', 'configPath', 'transport', 'telegramTransport', 'telegramHttpClient', 'policy', 'url']) {
    const result = await h.invoke({ ...argument(), [field]: 'override' });
    assert.equal(result.isError, true); assert.deepEqual(result.details, { code: 'invalid_request' });
  }
  assert.equal(h.dispatches.length, 0); assert.equal(h.telegramHttpClient.messages.length, 0);
  assert.equal(h.rows('deliveries').length, 0);
});

test('actual core safe-body and secret gates reject before Inbox or durable claims', async t => {
  const h = fixture(t);
  for (const text of ['![x](../local.png)', '<IMG SRC="&#47;tmp/private.png">', '&lt;img src=x&gt;',
    '[local](file:///tmp/secret)', 'attachment: private.png', '/tmp/secret', 'synthetic-credential',
    '＜img src=x＞', 'a\u200bb', 'x'.repeat(16000)]) {
    const result = receiptOf(await h.invoke({ ...argument(), text }));
    assert.equal(result.state, 'held');
    assert.equal(JSON.stringify(result).includes('synthetic-credential'), false);
  }
  assert.equal(h.dispatches.length, 0); assert.equal(h.telegramHttpClient.messages.length, 0);
  assert.equal(h.rows('deliveries').length, 0);
});

test('credential-shaped caller text holds before claims, Inbox and Telegram without known-secret registration', async t => {
  const h = fixture(t);
  const assignments = ['access', 'refresh', 'bot'].flatMap(prefix =>
    ['', '_', ' ', '-'].map(separator => `${prefix}${separator}token=unlistedvalue`));
  for (const text of ['password=unlistedvalue', 'sk-example123', 'ghp_example123', ...assignments]) {
    const result = receiptOf(await h.invoke({ ...argument(), text }));
    assert.equal(result.state, 'held', text);
    assert.equal(JSON.stringify(result).includes(text), false);
    assert.equal(h.rows('deliveries').length, 0);
    assert.equal(h.dispatches.length, 0); assert.equal(h.telegramHttpClient.messages.length, 0);
  }
  // Valid host-session syntax reaches final generated-body protection, rather
  // than obtaining an incidental hold from the adapter's session grammar.
  for (const session of ['sk-example123', 'ghp_example123']) {
    assert.equal(/^[A-Za-z0-9._-]{1,128}$/.exec(session)?.[0], session);
    h.host.session = session;
    const result = receiptOf(await h.invoke());
    assert.equal(result.state, 'held');
    assert.equal(JSON.stringify(result).includes(session), false);
  }
  assert.equal(h.rows('deliveries').length, 0);
  assert.equal(h.dispatches.length, 0); assert.equal(h.telegramHttpClient.messages.length, 0);
});

test('configured regular-file project root rejects before claim or native effects', async t => {
  const h = fixture(t);
  const fileRoot = h.directory + '/not-a-project-directory';
  writePrivate(fileRoot, 'Synthetic regular file, never a project root.');
  h.config.projects[0].project_path = fileRoot; h.save();
  h.host.cwd = h.host.managerCwd = fileRoot;
  const result = await h.invoke();
  assert.equal(result.isError, true);
  assert.equal((result.details as { code: string }).code, 'internal_error');
  assert.equal(h.rows('deliveries').length, 0);
  assert.equal(h.dispatches.length, 0); assert.equal(h.telegramHttpClient.messages.length, 0);
});

test('malformed send/read and readback mismatches persist unknown across actual entry restarts', async t => {
  const h = fixture(t);
  const mutations: Array<{ stage: 'send' | 'read'; mutate: (result: any) => void }> = [
    { stage: 'send', mutate: r => { delete r.content; } },
    { stage: 'read', mutate: r => { delete r.content; } },
    { stage: 'read', mutate: r => { r.structuredContent.thread.project.root = '/other'; } },
    { stage: 'read', mutate: r => { r.structuredContent.thread.messages[0].author.session = 'other'; } },
    { stage: 'read', mutate: r => { r.structuredContent.thread.messages[0].body += ' modified'; } },
    { stage: 'read', mutate: r => { r.structuredContent.url = 'https://other.example.invalid/#thread=changed'; } },
  ];
  for (const [index, mutation] of mutations.entries()) {
    const args = argument('owner/repo:malformed-' + index);
    h.state.mutate = (stage, result) => { if (stage === mutation.stage) mutation.mutate(result); };
    const result = receiptOf(await h.invoke(args));
    assert.equal(result.state, 'unknown');
    if (mutation.stage === 'read') assert.equal(result.admission.identity_binding?.status, 'canonical-bound');
    assert.equal(result.admission.inbox_target, undefined);
    const count = h.dispatches.length;
    h.state.mutate = undefined;
    await h.restart();
    assert.equal(receiptOf(await h.invoke(args)).state, 'unknown');
    assert.equal(h.dispatches.length, count, 'unknown cannot repeat Inbox publication/read');
  }
  assert.equal(h.telegramHttpClient.messages.length, 0);
  assert.ok(h.rows('deliveries').every(row => row.state === 'delivery_unknown'));
});

test('unknown or malformed Telegram outcomes never replay Inbox/Telegram after restart', async t => {
  for (const outcome of ['unknown', 'malformed'] as const) {
    const h = fixture(t, outcome);
    assert.equal(receiptOf(await h.invoke()).state, 'unknown');
    assert.equal(h.dispatches.length, 2); assert.equal(h.telegramHttpClient.messages.length, 1);
    await h.restart();
    assert.equal(receiptOf(await h.invoke()).state, 'unknown');
    assert.equal(h.dispatches.length, 2); assert.equal(h.telegramHttpClient.messages.length, 1);
    assert.equal(h.rows('deliveries')[0].state, 'delivery_unknown');
  }
});

test('known canonical identity rejects changed assertions after confirmed and read-unknown', async t => {
  for (const prior of ['confirmed', 'unknown'] as const) {
    const h = fixture(t);
    if (prior === 'unknown') h.state.mutate = (stage, result) => { if (stage === 'read') delete result.content; };
    assert.equal(receiptOf(await h.invoke()).state, prior === 'confirmed' ? 'sent' : 'unknown');
    const original = h.rows('canonical_associations');
    assert.equal(original.length, 1);
    assert.equal(original[0].read_verified, prior === 'confirmed' ? 1 : 0);
    const originalDeliveries = h.rows('deliveries');
    h.state.mutate = undefined;
    h.state.reuseMessage = [...h.records.keys()][0];
    const reads = h.state.reads, telegram = h.telegramHttpClient.messages.length;
    for (const args of [argument('owner/repo:changed'), argument('owner/repo:first', 'b'.repeat(64)),
      argument('owner/repo:both', 'c'.repeat(40))]) {
      await h.restart();
      const result = receiptOf(await h.invoke(args));
      assert.equal(result.state, 'held'); assert.equal(result.admission.reason, 'canonical_identity_conflict');
      assert.equal(result.admission.identity_binding?.status, 'canonical-conflict');
      assert.equal(result.admission.identity_binding?.asserted.decision_key, args.decision_key);
      assert.equal(result.admission.identity_binding?.asserted.revision, args.revision);
      assert.equal(h.state.reads, reads);
      assert.equal(h.telegramHttpClient.messages.length, telegram);
      assert.deepEqual(h.rows('canonical_associations'), original, 'immutable first association must not be reassigned');
      const attempted = h.rows('deliveries').find(row => row.decision_key === args.decision_key && row.event_revision === args.revision);
      assert.equal(attempted?.state, 'delivery_unknown');
      const sends = h.state.sends;
      assert.equal(receiptOf(await h.invoke(args)).state, 'unknown');
      assert.equal(h.state.sends, sends, 'conflicting attempted identity becomes terminal');
    }
    const originalAfter = h.rows('deliveries').find(row => row.decision_key === originalDeliveries[0].decision_key &&
      row.event_revision === originalDeliveries[0].event_revision);
    assert.deepEqual(originalAfter, originalDeliveries[0]);
  }
});

test('signal abort during native await returns controlled cancellation, persists unknown, fences late read', async t => {
  const h = fixture(t);
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const heldNative = new Promise<void>(resolve => { release = resolve; });
  h.state.onNative = async stage => { if (stage === 'send') { entered(); await heldNative; } };
  const controller = new AbortController();
  const running = h.invoke(argument(), controller);
  await ready;
  assert.deepEqual(h.dispatches.map(call => call.name), [SEND]);
  controller.abort();
  const result = await running;
  assert.equal(result.isError, true); assert.deepEqual(result.details, { code: 'cancelled' });
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.dispatches.map(call => call.name), [SEND]);
  assert.equal(h.telegramHttpClient.messages.length, 0);
  assert.equal(h.rows('deliveries')[0].state, 'delivery_unknown');
  h.state.onNative = undefined; await h.restart();
  assert.equal(receiptOf(await h.invoke()).state, 'unknown');
  assert.equal(h.dispatches.length, 1); assert.equal(h.telegramHttpClient.messages.length, 0);
});

test('lifecycle shutdown retains pending-native block; fresh session resumes only after settlement', async t => {
  const h = fixture(t);
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const nativeWait = new Promise<void>(resolve => { release = resolve; });
  h.state.onNative = async stage => { if (stage === 'send') { entered(); await nativeWait; } };
  const first = h.invoke(); await ready;
  await h.events.get('session_shutdown')!();
  const cancelled = await first;
  assert.equal(cancelled.isError, true); assert.deepEqual(cancelled.details, { code: 'cancelled' });
  h.state.onNative = undefined;
  await h.restart(); h.host.session = 'new-session';
  const blocked = await h.invoke(argument('owner/repo:second'));
  assert.equal(blocked.isError, true); assert.deepEqual(blocked.details, { code: 'busy' });
  assert.equal(h.dispatches.length, 1, 'new session cannot bypass unresolved native dispatch');
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.dispatches.length, 1, 'late result grants no new dispatch');
  assert.equal(receiptOf(await h.invoke(argument('owner/repo:second'))).state, 'sent');
  const count = h.dispatches.length;
  assert.equal(receiptOf(await h.invoke()).state, 'unknown');
  assert.equal(h.dispatches.length, count);
  assert.equal(h.telegramHttpClient.messages.length, 1);
});

test('profile mutation after send and current project change fence later effects', async t => {
  for (const change of ['profile', 'project'] as const) {
    const h = fixture(t);
    h.state.onNative = stage => { if (stage === 'send') {
      if (change === 'profile') writePrivate(h.profile, fs.readFileSync(h.profile, 'utf8').replace('-1009876543210', '-1001234567891'));
      else h.host.cwd = h.host.managerCwd = h.directory;
    } };
    const result = await h.invoke();
    if (change === 'profile') assert.equal(receiptOf(result).state, 'unknown');
    else { assert.equal(result.isError, true); assert.deepEqual(result.details, { code: 'cancelled' }); }
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.dispatches.map(call => call.name), [SEND]);
    assert.equal(h.telegramHttpClient.messages.length, 0);
    assert.equal(h.rows('deliveries')[0].state, 'delivery_unknown');
  }
});

test('migrated unmapped destination blocks every fresh asserted identity without bypass', async t => {
  const h = fixture(t, 'echo', { legacyUnmapped: true });
  const before = h.rows('deliveries'), associations = h.rows('canonical_associations');
  assert.equal(associations.length, 1); assert.equal(associations[0].legacy_unmapped, 1);
  assert.equal(associations[0].message_id, null);
  for (const args of [argument('owner/repo:new-first'), argument('owner/repo:new-second', 'b'.repeat(40)),
    argument('owner/repo:legacy', 'c'.repeat(64))]) {
    const result = receiptOf(await h.invoke(args));
    assert.equal(result.state, 'held'); assert.equal(result.admission.reason, 'legacy_history_unmapped');
    await h.restart();
  }
  assert.equal(receiptOf(await h.invoke(argument('owner/repo:legacy'))).state, 'unknown');
  assert.deepEqual(h.rows('deliveries'), before);
  assert.deepEqual(h.rows('canonical_associations'), associations);
  assert.equal(h.dispatches.length, 0); assert.equal(h.telegramHttpClient.messages.length, 0);
});

test('test fixture provisioning is explicit v2; no ordinary production identities or credential receipts', async t => {
  const h = fixture(t);
  const result = receiptOf(await h.invoke());
  assert.equal(result.state, 'sent');
  const manifest = JSON.parse(fs.readFileSync(h.ledger + '.cutover-v2.json', 'utf8'));
  assert.equal(manifest.version, 2); assert.equal(manifest.kind, 'new-ledger');
  assert.equal(manifest.assertions.no_prior_history, true);
  assert.ok(h.rows('deliveries').every(row => row.profile_id.startsWith('test-only.') && row.destination_id.startsWith('test-only.')));
  assert.equal(JSON.stringify(result).includes('synthetic-credential'), false);
  assert.equal(JSON.stringify(result).includes('synthetic-destination'), false);
});


test('optional literal review link and approved Unicode survive actual Inbox and HTTP bytes exactly', async t => {
  const h = fixture(t);
  const args = { ...argument(), text: 'Café 漢字 한글 𠀀 needs attention.',
    review_link: { label: 'Révision 文書', url: 'https://review.example.invalid/change/42?view=full#note' } };
  const result = receiptOf(await h.invoke(args));
  assert.equal(result.state, 'sent');
  assert.equal(result.admission.test_only, true); assert.equal(result.delivery.test_only, true);
  const body = h.dispatches[0].args.body;
  assert.equal(body, args.text + '\n\nReview: ' + args.review_link.label + '\n' + args.review_link.url +
    '\n\nPi notification; session synthetic-session; revision ' + revision);
  const request = h.telegramHttpClient.requests[0];
  assert.equal(request.origin, 'https://api.telegram.org'); assert.equal(request.method, 'POST');
  assert.equal(request.endpoint, '/bot[redacted]/sendMessage'); assert.equal(request.chat_id, -1009876543210);
  assert.equal(request.deadline_ms, 10000); assert.ok(request.body_bytes > 0);
  assert.deepEqual(Object.keys(request.message).sort(), ['text', 'entities', 'disable_notification', 'link_preview_options'].sort());
  assert.equal(request.message.disable_notification, false);
  assert.deepEqual(request.message.link_preview_options, { is_disabled: true });
  assert.match(request.message.text, /^Attention · explicit request · unclassified/);
  assert.ok(request.message.text.indexOf('Inbox:') < request.message.text.indexOf(args.text));
  assert.ok(request.message.text.includes(args.review_link.url));
  for (const entity of request.message.entities) if (entity.type === 'text_link')
    assert.equal(request.message.text.slice(entity.offset, entity.offset + entity.length), entity.url);
  const before = h.rows('deliveries');
  assert.equal(receiptOf(await h.invoke({ ...args, review_link: { label: 'Other', url: 'https://other.example.invalid/' } })).state, 'duplicate');
  await h.restart();
  assert.equal(receiptOf(await h.invoke(args)).state, 'duplicate');
  assert.equal(h.dispatches.length, 2); assert.equal(h.telegramHttpClient.requests.length, 1);
  assert.deepEqual(h.rows('deliveries'), before);
});

test('review shape and URL/content rejection happen before all claims and native/HTTP effects', async t => {
  const h = fixture(t);
  for (const link of [null, [], {}, { label: 'Review', url: 'https://review.example.invalid/', destination: 'other' },
    { label: 3, url: 'https://review.example.invalid/' }, { label: 'Review', url: null }]) {
    const result = await h.invoke({ ...argument(), review_link: link });
    assert.equal(result.isError, true); assert.deepEqual(result.details, { code: 'invalid_request' });
  }
  for (const url of ['http://review.example.invalid/', 'https://User@review.example.invalid/',
    'https://REVIEW.example.invalid/', 'https://review.example.invalid', 'https://localhost/',
    'https://127.0.0.1/', 'https://xn--example.invalid/', 'https://review.example.invalid/%61',
    'https://review.example.invalid/![x](local.png)', 'https://review.example.invalid/?password=private']) {
    assert.equal(receiptOf(await h.invoke({ ...argument(), review_link: { label: 'Review', url } })).state, 'held', url);
  }
  for (const text of ['![x](local.png)', '\uFF01[x](local.png)', '&lt;IMG src=x&gt;',
    'password=private', 'ｐａｓｓｗｏｒｄ=private', 'a\u202Eb', 'e\u0301', '\uD800']) {
    assert.equal(receiptOf(await h.invoke({ ...argument(), text })).state, 'held');
  }
  for (const label of ['synthetic-credential', 'password=private', '＜img src=x＞'])
    assert.equal(receiptOf(await h.invoke({ ...argument(), review_link: { label, url: 'https://review.example.invalid/' } })).state, 'held');
  assert.equal(h.rows('deliveries').length, 0); assert.equal(h.dispatches.length, 0);
  assert.equal(h.telegramHttpClient.requests.length, 0);
});

test('shared HTTP parser rejects nonconfirmations and never replays unknown after restart', async t => {
  for (const outcome of ['wrong-chat', 'wrong-text', 'extra-entity', 'duplicate-entity', 'bad-entity-boundary',
    'bad-message-id', 'missing-entities', 'redirect', 'bad-status', 'oversized', 'invalid-utf8', 'duplicate-json', 'deep-json'] as const) {
    const h = fixture(t, outcome);
    assert.equal(receiptOf(await h.invoke()).state, 'unknown', outcome);
    assert.equal(h.telegramHttpClient.requests.length, 1);
    await h.restart(); assert.equal(receiptOf(await h.invoke()).state, 'unknown');
    assert.equal(h.dispatches.length, 2); assert.equal(h.telegramHttpClient.requests.length, 1);
    assert.equal(h.rows('deliveries')[0].state, 'delivery_unknown');
  }
});


test('actual HTTP deadline returns unknown and late completion cannot confirm', async t => {
  const h = fixture(t, 'late');
  const running = h.invoke();
  await waitForTestTelegramHttpRequest(h.telegramHttpClient);
  const result = receiptOf(await running);
  assert.equal(result.state, 'unknown');
  completeLateTestTelegramHttp(h.telegramHttpClient);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.rows('deliveries')[0].state, 'delivery_unknown');
  await h.restart(); assert.equal(receiptOf(await h.invoke()).state, 'unknown');
  assert.equal(h.telegramHttpClient.requests.length, 1); assert.equal(h.dispatches.length, 2);
});

test('abort at actual HTTP boundary fences late confirmation durably', async t => {
  const h = fixture(t, 'late'); const controller = new AbortController();
  const running = h.invoke(argument(), controller);
  await waitForTestTelegramHttpRequest(h.telegramHttpClient); controller.abort();
  const result = await running;
  assert.equal(result.isError, true); assert.deepEqual(result.details, { code: 'cancelled' });
  completeLateTestTelegramHttp(h.telegramHttpClient);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.rows('deliveries')[0].state, 'delivery_unknown');
  await h.restart(); assert.equal(receiptOf(await h.invoke()).state, 'unknown');
  assert.equal(h.telegramHttpClient.requests.length, 1); assert.equal(h.dispatches.length, 2);
});


test('literal review block readback mismatches and native capture metadata stay terminal unknown', async t => {
  for (const change of ['label', 'url', 'attachment', 'image', 'project', 'thread'] as const) {
    const h = fixture(t);
    const args = { ...argument(), review_link: { label: 'Review', url: 'https://review.example.invalid/' } };
    h.state.mutate = (stage, native) => { if (stage !== 'read') return;
      const message = native.structuredContent.thread.messages[0];
      if (change === 'label') message.body = message.body.replace('Review: Review', 'Review: Other');
      if (change === 'url') message.body = message.body.replace(args.review_link.url, 'https://other.example.invalid/');
      if (change === 'attachment') message.attachments = [{ name: 'local.png' }];
      if (change === 'image') message.inline_images = [{ source: 'local.png' }];
      if (change === 'project') native.structuredContent.thread.project.id = 'other';
      if (change === 'thread') message.thread_id = 'msg_' + '9'.repeat(26);
    };
    assert.equal(receiptOf(await h.invoke(args)).state, 'unknown', change);
    assert.equal(h.telegramHttpClient.requests.length, 0);
    assert.equal(h.rows('canonical_associations')[0].read_verified, 0);
    h.state.mutate = undefined; await h.restart();
    assert.equal(receiptOf(await h.invoke(args)).state, 'unknown');
    assert.equal(h.dispatches.length, 2);
  }
});

test('supplementary summary truncation retains leading provenance and both exact links', async t => {
  const h = fixture(t);
  const review_link = { label: 'Review', url: 'https://review.example.invalid/' };
  const text = '𠀀'.repeat(4500);
  assert.equal(receiptOf(await h.invoke({ ...argument(), text, review_link })).state, 'sent');
  const message = h.telegramHttpClient.messages[0];
  assert.ok(message.text.length <= 4096);
  assert.match(message.text, /^Attention · explicit request · unclassified/);
  assert.ok(message.text.includes('synthetic-session')); assert.ok(message.text.includes('Inbox:'));
  assert.ok(message.text.includes(review_link.url));
  assert.equal(new TextDecoder().decode(new TextEncoder().encode(message.text)), message.text);
  for (const entity of message.entities) if (entity.type === 'text_link')
    assert.equal(message.text.slice(entity.offset, entity.offset + entity.length), entity.url);
});
