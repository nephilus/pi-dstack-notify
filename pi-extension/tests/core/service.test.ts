import './offline-guard.mjs';
import { attempts } from './offline-guard.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createNotificationService } from '../../core/service.ts';
import { createTestTelegramHttpClient, createTestTelegramTransport, completeLateTestTelegramHttp,
  waitForTestTelegramHttpRequest, confirmed } from '../../core/transport.ts';
import type { TestTelegramOutcome } from '../../core/transport.ts';
import { DeliveryLedger } from '../../core/ledger.ts';
import { initializeLedgerV2, migrateLedgerV1ToV2 } from '../../core/migration.ts';
import { loadConfiguration } from '../../core/config.ts';
import { loadProfile } from '../../core/profile.ts';
import { strictJson, digest, prepareBody, sessionPattern } from '../../core/safety.ts';
import type { PublicationContext, DeliveryIdentity, PublishArguments } from '../../core/types.ts';
const nativeFixture = JSON.parse(fs.readFileSync(new URL('../../fixtures/inbox-native.json', import.meta.url), 'utf8'));
const profileFixture = fs.readFileSync(new URL('../../fixtures/shared-profile.toml', import.meta.url), 'utf8');
const schemaFixture = fs.readFileSync(new URL('../../fixtures/delivery-v1.sql', import.meta.url), 'utf8');
const revision = 'a'.repeat(64);
const fixtureToken = '987654321:NOT_A_REAL_TOKEN_fixture_abcdefghijk';
function write(filename: string, text: string): void { fs.writeFileSync(filename, text, { mode: 0o600 }); fs.chmodSync(filename, 0o600); }
const cutover = { dispatchDisabled: true, allOldWritersQuiesced: true, walConsistentBackupVerified: true } as const;
function deliveryCount(filename: string): number {
  if (!fs.existsSync(filename)) return 0;
  const db = new DatabaseSync(filename);
  try { return Number((db.prepare('SELECT COUNT(*) AS n FROM deliveries').get() as any).n); } finally { db.close(); }
}
function fixture(t: any, outcome: TestTelegramOutcome = 'echo', provision = true) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notification-ts-core-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project'); fs.mkdirSync(root, { mode: 0o700 });
  const profile = path.join(directory, 'profile.toml'), configPath = path.join(directory, 'config.json');
  const ledger = path.join(directory, 'delivery.sqlite'); write(profile, profileFixture);
  const config = { version: 1, enabled: true, projects: [{ project_path: root, enabled: true,
    profile_path: profile, ledger_path: ledger, policy: 'explicit_attention', inbox_base_url: 'https://inbox.example.invalid/' }] };
  const save = () => write(configPath, JSON.stringify(config)); save();
  const telegramTransport = createTestTelegramHttpClient({ outcome });
  if (provision) initializeLedgerV2(ledger, { ...cutover, noPriorHistory: true });
  const makeService = () => createNotificationService({ configPath, telegramHttpClient: telegramTransport,
    knownSecrets: ['synthetic-credential'] });
  let service = makeService();
  const host = { session_id: 'synthetic-session', project_path: root };
  const state = { sends: 0, reads: 0, checks: 0, body: '', hook: undefined as undefined | ((name: string) => void),
    mutate: undefined as undefined | ((name: string, value: any) => void) };
  const controller = new AbortController();
  const identity = (key = 'owner/repo:decision', rev = revision, fake = true): DeliveryIdentity => ({
    profile_id: (fake ? 'test-only.' : '') + 'primary', destination_id: (fake ? 'test-only.' : '') + 'owner',
    decision_key: key, event_revision: rev, purpose: 'explicit_attention' });
  const argument = (key = 'owner/repo:decision', rev = revision): PublishArguments => ({ text: 'A decision needs attention.', decision_key: key, revision: rev });
  function native(which: 'send' | 'read'): any {
    const result = structuredClone(nativeFixture[which]);
    const mid = 'msg_' + String(state.sends).padStart(26, '0');
    const data = result.structuredContent;
    data.url = config.projects[0].inbox_base_url + '#thread=' + mid;
    if (which === 'send') {
      data.message_id = data.thread_id = mid; data.project.root = host.project_path;
    } else {
      data.thread.thread_id = mid; data.thread.project.root = host.project_path;
      const message = data.thread.messages[0]; message.id = message.thread_id = mid;
      message.author.session = host.session_id; message.body = state.body;
    }
    state.mutate?.(which, result); return result;
  }
  const context: PublicationContext = {
    operationId: 'op.1', observed: { ...host }, signal: controller.signal,
    async hostCheck() { state.checks++; state.hook?.('host'); return { ...host }; },
    async inboxSend({ body }) { state.sends++; state.body = body; state.hook?.('send'); return native('send'); },
    async inboxRead() { state.reads++; state.hook?.('read'); return native('read'); },
  };
  return { directory, root, profile, configPath, ledger, config, save, telegramTransport, makeService,
    host, state, controller, context, identity, argument, native,
    get service() { return service; }, restart() { service = makeService(); } };
}
after(() => { assert.deepEqual(attempts, []); assert.equal(process.env.PATH, '/nonexistent-notification-test-path'); });

test('two distinct updates one session; exact durable replay has no further effects', async t => {
  const h = fixture(t);
  for (const key of ['owner/repo:first', 'owner/repo:second']) {
    const receipt = await h.service.publish(h.argument(key), h.context);
    assert.equal(receipt.state, 'sent');
    assert.equal(receipt.classification.bypass_reason, 'explicit_attention');
    assert.equal(receipt.admission.inbox_target?.revision_semantics, 'content-sha256');
    assert.equal(receipt.delivery.receipt?.identity.decision_key, key);
    assert.equal(receipt.delivery.receipt?.identity.profile_id, 'test-only.primary');
    assert.equal(receipt.delivery.receipt?.identity.destination_id, 'test-only.owner');
    assert.equal(receipt.admission.test_only, true); assert.equal(receipt.delivery.test_only, true);
  }
  assert.equal(h.state.sends, 2); assert.equal(h.telegramTransport.messages.length, 2);
  h.restart(); h.host.session_id = 'new-session'; h.context.observed = { ...h.host };
  assert.equal((await h.service.publish(h.argument('owner/repo:first'), h.context)).state, 'duplicate');
  assert.equal(h.state.sends, 2); assert.equal(h.state.checks, 6);
  const ledger = new DeliveryLedger(h.ledger);
  try { assert.equal(ledger.inspect(h.identity('owner/repo:first', revision, false)), null); } finally { ledger.close(); }
  assert.match(h.telegramTransport.messages[0].text, /^Attention · explicit request · unclassified/);
  const message = h.telegramTransport.messages[0], entity = message.entities[0];
  assert.equal(entity.type, 'text_link');
  if (entity.type !== 'text_link') assert.fail('Inbox link entity must be text_link');
  assert.equal(message.text.slice(entity.offset, entity.offset + entity.length), entity.url);
});

test('supported exact key grammar and SHA1 revision; key never enters body', async t => {
  const h = fixture(t); const args = h.argument('owner/repo:decision@branch+1', 'b'.repeat(40));
  const result = await h.service.publish(args, h.context);
  assert.equal(result.state, 'sent'); assert.equal(result.admission.inbox_target?.revision_semantics, 'git-sha1');
  assert.equal(result.delivery.receipt?.identity.event_revision, args.revision);
  assert.ok(!h.state.body.includes(args.decision_key)); assert.ok(!JSON.stringify(result).includes('snapshot'));
});

test('claim is visible durably before the first Inbox send', async t => {
  const h = fixture(t);
  h.state.hook = name => { if (name === 'send') {
    const ledger = new DeliveryLedger(h.ledger); try { assert.equal(ledger.inspect(h.identity())?.state, 'in_flight'); } finally { ledger.close(); }
  } };
  assert.equal((await h.service.publish(h.argument(), h.context)).state, 'sent');
});

test('safe ASCII body rejects local/encoded/HTML/markdown/embed/directive inputs before any effect', async t => {
  const h = fixture(t);
  for (const text of ['![x](file:///tmp/x.png)', '![x](../x.png)', '<IMG SRC="&#47;tmp/x.png">',
    '<img src=local.png>', '&lt;img src=x&gt;', '[open](local.html)', '`![x](local.png)`',
    'attachment: x.png', '/tmp/x.png', 'C:\\tmp\\x.png', '＜img src=x＞', 'a\u200bb', 'a\x00b',
    '![x](%2ftmp%2fx.png)', 'a\ud800b', 'x'.repeat(16000)]) {
    assert.equal((await h.service.publish({ ...h.argument(), text }, h.context)).state, 'held');
  }
  assert.equal(h.state.sends, 0); assert.equal(h.state.checks, 0); assert.equal(deliveryCount(h.ledger), 0);
});

test('credential-shaped text and generated session markers hold before claim or effects', async t => {
  const h = fixture(t);
  for (const text of ['password=unlistedvalue', 'accesstoken=unlistedvalue', 'refreshtoken=unlistedvalue',
    'bottoken=unlistedvalue', 'sk-example123', 'ghp_example123']) {
    const result = await h.service.publish({ ...h.argument(), text }, h.context);
    assert.equal(result.state, 'held');
    assert.ok(!JSON.stringify(result).includes(text));
  }
  for (const session of ['sk-session-example123', 'ghp_session_example123',
    'xoxb-session-example123', 'AKIA1234567890ABCD']) {
    assert.ok(sessionPattern.test(session), 'generated-marker case must satisfy session grammar');
    h.host.session_id = session;
    h.context.observed = { ...h.host };
    const sessionResult = await h.service.publish(h.argument(), h.context);
    assert.equal(sessionResult.state, 'held');
    assert.ok(!JSON.stringify(sessionResult).includes(session));
  }
  assert.equal(h.state.checks, 0); assert.equal(h.state.sends, 0); assert.equal(h.state.reads, 0);
  assert.equal(h.telegramTransport.messages.length, 0); assert.equal(deliveryCount(h.ledger), 0);
});

test('optional structured review link persists literally and renders exact UTF-16 URL entities', async t => {
  const h = fixture(t);
  const reviewLink = { label: 'Review 𠀀 レビュー', url: 'https://review.example.invalid/pull/123?view=files#diff' };
  const result = await h.service.publish({ ...h.argument(), review_link: reviewLink }, h.context);
  assert.equal(result.state, 'sent'); assert.equal(result.admission.test_only, true);
  assert.ok(h.state.body.includes(`Review: ${reviewLink.label}\n${reviewLink.url}`));
  assert.ok(h.state.body.endsWith(`\n\nPi notification; session ${h.host.session_id}; revision ${revision}`));
  assert.ok(result.admission.inbox_target?.url.startsWith('https://inbox.example.invalid/#thread='));
  assert.ok(!Object.hasOwn(result.admission, 'review_link'));
  const message = h.telegramTransport.messages[0];
  assert.equal(message.link_preview_options.is_disabled, true);
  assert.equal(message.entities.length, 2);
  const reviewEntity = message.entities[1];
  assert.equal(reviewEntity.type, 'text_link');
  if (reviewEntity.type !== 'text_link') assert.fail('Review URL entity must be text_link');
  assert.equal(reviewEntity.url, reviewLink.url);
  assert.equal(message.text.slice(reviewEntity.offset, reviewEntity.offset + reviewEntity.length), reviewLink.url);
  assert.equal(reviewEntity.offset, message.text.indexOf(reviewLink.url));
  assert.equal(h.telegramTransport.requests[0].origin, 'https://api.telegram.org');
  assert.equal(h.telegramTransport.requests[0].method, 'POST');
  assert.equal(h.telegramTransport.requests[0].endpoint, '/bot[redacted]/sendMessage');
  assert.equal(h.telegramTransport.requests[0].deadline_ms, 10000);
  assert.ok(h.telegramTransport.requests[0].body_bytes <= 65536);
  const sent = h.state.sends, reads = h.state.reads, requests = h.telegramTransport.requests.length;
  assert.equal((await h.service.publish({ ...h.argument(), review_link: { ...reviewLink, url: 'https://review.example.invalid/pull/124' } }, h.context)).state, 'duplicate');
  assert.equal(h.state.sends, sent); assert.equal(h.state.reads, reads); assert.equal(h.telegramTransport.requests.length, requests);
});

test('optional review link exact shape, frozen URL grammar and fixed-section bounds hold before claim', async t => {
  const h = fixture(t);
  const bad = [
    { ...h.argument(), review_link: null },
    { ...h.argument(), review_link: { label: 'safe', url: 'https://review.example.invalid/pull/1', extra: true } },
    { ...h.argument(), review_link: { label: 'safe\nline', url: 'https://review.example.invalid/pull/1' } },
    { ...h.argument(), review_link: { label: 'x'.repeat(201), url: 'https://review.example.invalid/pull/1' } },
    { ...h.argument(), review_link: { label: 'sk-example123', url: 'https://review.example.invalid/pull/1' } },
    { ...h.argument(), review_link: { label: 'safe', url: 'https://review.example.invalid/pull/![x](local.png)' } },
    { ...h.argument(), review_link: { label: 'safe', url: 'https://review.example.invalid/?access_token=unlistedvalue' } },
    { ...h.argument(), review_link: { label: 'safe', url: 'https://review.example.invalid/' + 'a'.repeat(2048) } },
    { ...h.argument(), destination: 'override' },
  ];
  for (const input of bad) assert.equal((await h.service.publish(input as any, h.context)).state, 'held');
  h.config.projects[0].inbox_base_url = 'https://inbox.example.invalid/' + 'a'.repeat(4000); h.save();
  assert.equal((await h.service.publish({ ...h.argument(), review_link: { label: 'R', url: 'https://review.example.invalid/pull/1' } }, h.context)).state, 'held');
  assert.equal(h.state.checks, 0); assert.equal(h.state.sends, 0); assert.equal(h.state.reads, 0);
  assert.equal(h.telegramTransport.requests.length, 0); assert.equal(deliveryCount(h.ledger), 0);
});

test('all secrets loaded before final gate; raw, normalized and identity values hold', async t => {
  const h = fixture(t);
  for (const args of [{ ...h.argument(), text: 'synthetic-credential' }, h.argument('repo/synthetic-credential'),
    h.argument(fixtureToken), h.argument(fixtureToken.replace('__', ''))]) {
    const receipt = await h.service.publish(args, h.context); assert.equal(receipt.state, 'held');
    assert.ok(!JSON.stringify(receipt).includes('synthetic-credential'));
    assert.ok(!JSON.stringify(receipt).includes(fixtureToken));
  }
  assert.equal(h.state.sends, 0); assert.equal(h.telegramTransport.requests.length, 0); assert.equal(deliveryCount(h.ledger), 0);
});

test('disabled, wrong project, override and malformed public values have zero effects', async t => {
  const h = fixture(t);
  for (const field of ['destination', 'profile_path', 'role', 'project_path', 'transport', 'policy']) {
    assert.equal((await h.service.publish({ ...h.argument(), [field]: 'override' }, h.context)).state, 'held');
  }
  for (const args of [h.argument('x'.repeat(201)), h.argument('x\n'), h.argument('valid', 'A'.repeat(40)),
    h.argument('valid', 'a'.repeat(41)), { ...h.argument(), text: ' ' }]) {
    assert.equal((await h.service.publish(args, h.context)).state, 'held');
  }
  h.context.observed = { ...h.host, project_path: h.directory };
  assert.equal((await h.service.publish(h.argument(), h.context)).state, 'held');
  h.context.observed = { ...h.host }; h.config.enabled = false; h.save();
  assert.equal((await h.service.publish(h.argument(), h.context)).state, 'held');
  h.config.enabled = true; h.config.projects[0].enabled = false; h.save();
  assert.equal((await h.service.publish(h.argument(), h.context)).state, 'held');
  assert.equal(h.state.sends, 0); assert.equal(deliveryCount(h.ledger), 0);
});

test('project roots must be canonical existing directories; profile files remain valid paths', async t => {
  const h = fixture(t);
  assert.equal(loadConfiguration(h.configPath).projects[0].profile_path, h.profile);
  const fileRoot = path.join(h.directory, 'project-root-file'); write(fileRoot, 'not a directory');

  h.config.projects[0].project_path = fileRoot; h.save();
  assert.throws(() => loadConfiguration(h.configPath));
  assert.equal((await h.service.publish(h.argument(), h.context)).state, 'held');

  h.config.projects[0].project_path = h.root; h.save();
  h.host.project_path = fileRoot; h.context.observed = { ...h.host };
  assert.equal((await h.service.publish(h.argument(), h.context)).state, 'held');
  assert.equal(h.state.checks, 0); assert.equal(h.state.sends, 0); assert.equal(h.state.reads, 0);
  assert.equal(h.telegramTransport.messages.length, 0); assert.equal(deliveryCount(h.ledger), 0);
});

test('native send/read whole envelopes, roots, sessions, IDs, body and canonical URLs all bind', async t => {
  const h = fixture(t);
  const mutations = [
    (r: any) => { delete r.content; }, (r: any) => { r.content = [{ type: 'image', text: 'bad' }]; },
    (r: any) => { r.isError = true; }, (r: any) => { r.structuredContent.thread.project.root = '/other'; },
    (r: any) => { r.structuredContent.thread.project.id = 'other'; },
    (r: any) => { r.structuredContent.thread.messages[0].author.session = 'other'; },
    (r: any) => { r.structuredContent.thread.messages[0].author.host = 'other'; },
    (r: any) => { r.structuredContent.thread.messages[0].body += ' changed'; },
    (r: any) => { r.structuredContent.thread.messages[0].id = 'msg_' + 'Z'.repeat(26); },
    (r: any) => { r.structuredContent.thread.messages[0].attachments = [{ path: 'private.png' }]; },
    (r: any) => { r.structuredContent.thread.messages[0].inline_images = [{ path: 'private.png' }]; },
    (r: any) => { r.structuredContent.thread.messages.push(r.structuredContent.thread.messages[0]); },
    (r: any) => { r.structuredContent.url = 'https://other.example.invalid/#thread=x'; },
    (r: any) => { r.structuredContent.url = r.structuredContent.url.replace('/#', '#'); },
  ];
  for (const [i, mutate] of mutations.entries()) {
    h.state.mutate = (which, value) => { if (which === 'read') mutate(value); };
    assert.equal((await h.service.publish(h.argument('repo/read-' + i), h.context)).state, 'unknown');
  }
  h.state.mutate = (which, r) => { if (which === 'send') { delete r.content; r.error = 'synthetic-credential'; } };
  const result = await h.service.publish(h.argument('repo/send-error'), h.context);
  assert.equal(result.state, 'unknown'); assert.ok(!JSON.stringify(result).includes('synthetic-credential'));
  assert.equal(h.telegramTransport.messages.length, 0);
});

test('native identity scalar hazards never associate or reflect even with matching send/read identities', async t => {
  for (const suffix of ['\u202eX', '\u0001X', '\u0085X', '\u200bX', '\u034fX', '\ufe0fX',
    '\u{e0100}X', '\ud800X', '\udc00X', '\ufdd0X', '\u{10ffff}X']) {
    const h = fixture(t); const unsafe = 'prj_' + suffix;
    h.state.mutate = (which, r) => {
      const data = r.structuredContent;
      if (which === 'send') data.project.id = unsafe;
      else { data.thread.project.id = unsafe; data.thread.messages[0].project_id = unsafe; }
    };
    const receipt = await h.service.publish(h.argument(), h.context);
    assert.equal(receipt.state, 'unknown'); assert.equal(h.state.reads, 0);
    assert.equal(h.telegramTransport.requests.length, 0);
    assert.ok(!JSON.stringify(receipt).includes(JSON.stringify(unsafe).slice(1, -1)));
    assert.equal(receipt.admission.identity_binding?.status, 'notification-only');
    const db = new DatabaseSync(h.ledger);
    try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM canonical_associations').get()!.n, 0); }
    finally { db.close(); }
    h.restart(); assert.equal((await h.service.publish(h.argument(), h.context)).state, 'unknown');
    assert.equal(h.state.sends, 1);
  }
});

test('native prose is not subjected to identity scalar or caller-script grammar', async t => {
  const h = fixture(t);
  h.state.mutate = (which, r) => {
    r.content[0].text = 'Native prose Ελληνικά العربية \u200b';
    const safeId = 'prj_Ελληνικά_日本語_𠀀';
    if (which === 'send') r.structuredContent.project.id = safeId;
    else { r.structuredContent.thread.project.id = safeId; r.structuredContent.thread.messages[0].project_id = safeId; }
  };
  assert.equal((await h.service.publish(h.argument(), h.context)).state, 'sent');
});

test('unknown send and read remain non-replayable across restart', async t => {
  const h = fixture(t);
  for (const stage of ['send', 'read']) {
    h.state.hook = name => { if (name === stage) throw new Error('synthetic-credential'); };
    assert.equal((await h.service.publish(h.argument('repo/' + stage), h.context)).state, 'unknown');
    h.state.hook = undefined; h.restart(); const sends = h.state.sends;
    assert.equal((await h.service.publish(h.argument('repo/' + stage), h.context)).state, 'unknown');
    assert.equal(h.state.sends, sends);
  }
  assert.equal(h.telegramTransport.messages.length, 0);
});

test('unknown and malformed Telegram echo persist terminal unknown', async t => {
  for (const outcome of ['unknown', 'malformed'] as const) {
    const h = fixture(t, outcome);
    assert.equal((await h.service.publish(h.argument(), h.context)).state, 'unknown');
    h.restart(); assert.equal((await h.service.publish(h.argument(), h.context)).state, 'unknown');
    assert.equal(h.telegramTransport.messages.length, 1); assert.equal(h.state.sends, 1);
  }
});

test('cancel during unresolved publication wakes core; no late callbacks or replay', async t => {
  const h = fixture(t); let began!: () => void, late!: (value: any) => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const unresolved = new Promise<any>(resolve => { late = resolve; });
  h.context.inboxSend = async ({ body }) => { h.state.sends++; h.state.body = body; began(); return unresolved; };
  const running = h.service.publish(h.argument(), h.context); await started;
  h.controller.abort(); assert.equal((await running).state, 'unknown');
  late(h.native('send')); await Promise.resolve(); assert.equal(h.state.reads, 0);
  assert.equal(h.telegramTransport.messages.length, 0);
  h.restart(); const second = { ...h.context, signal: new AbortController().signal };
  assert.equal((await h.service.publish(h.argument(), second)).state, 'unknown');
  assert.equal(h.state.sends, 1);
});

test('busy during active publication; preclaim abort has no durable effect', async t => {
  const h = fixture(t); h.controller.abort();
  assert.equal((await h.service.publish(h.argument(), h.context)).state, 'held'); assert.equal(deliveryCount(h.ledger), 0);
  const controller = new AbortController(); h.context.signal = controller.signal;
  let began!: () => void; const started = new Promise<void>(r => { began = r; });
  h.context.hostCheck = async () => { began(); return new Promise(() => {}); };
  const running = h.service.publish(h.argument(), h.context); await started;
  assert.equal((await h.service.publish(h.argument('repo/other'), h.context)).admission.reason, 'busy');
  controller.abort(); assert.equal((await running).state, 'unknown');
});

test('configuration/profile/host changes after awaits fence effects', async t => {
  for (const change of ['config', 'profile', 'host']) {
    const h = fixture(t);
    h.state.hook = name => { if (name === 'host') {
      if (change === 'config') { h.config.enabled = false; h.save(); }
      if (change === 'profile') write(h.profile, profileFixture.replace('-1009876543210', '-1001234567891'));
      if (change === 'host') h.host.session_id = 'other';
    } };
    assert.equal((await h.service.publish(h.argument(), h.context)).state, 'unknown');
    assert.equal(h.state.sends, 0); assert.equal(h.telegramTransport.messages.length, 0);
  }
});

test('confirmed and unknown identity survive session/project rename and credential rotation', async t => {
  for (const outcome of ['echo', 'unknown'] as const) {
    const h = fixture(t, outcome);
    const first = await h.service.publish(h.argument(), h.context);
    assert.equal(first.state, outcome === 'echo' ? 'sent' : 'unknown');
    const renamed = path.join(h.directory, 'renamed'); fs.renameSync(h.root, renamed);
    h.config.projects[0].project_path = renamed; h.save(); h.host.project_path = renamed; h.host.session_id = 'second-session';
    h.context.observed = { ...h.host };
    write(h.profile, profileFixture.replace(fixtureToken, '123456790:ABCDEFGHIJKLMNOPQRSTUVWXYZ__abcdefghi'));
    h.restart(); assert.equal((await h.service.publish(h.argument(), h.context)).state, outcome === 'echo' ? 'duplicate' : 'unknown');
    assert.equal(h.state.sends, 1); assert.equal(h.telegramTransport.messages.length, 1);
  }
});

test('private strict config and supported TOML subset; no discovery or repr credentials', t => {
  const h = fixture(t);
  assert.equal(loadConfiguration(null).enabled, false);
  for (const raw of ['{"version":1,"version":1}', '{}', '{"version":NaN}', '[]']) {
    write(h.configPath, raw); assert.throws(() => loadConfiguration(h.configPath));
  }
  h.save(); fs.chmodSync(h.configPath, 0o644); assert.throws(() => loadConfiguration(h.configPath)); fs.chmodSync(h.configPath, 0o600);
  const link = path.join(h.directory, 'link'); fs.symlinkSync(h.configPath, link); assert.throws(() => loadConfiguration(link)); fs.unlinkSync(link);
  fs.linkSync(h.configPath, link); assert.throws(() => loadConfiguration(h.configPath)); fs.unlinkSync(link);
  const profile = loadProfile(h.profile); assert.ok(!JSON.stringify(profile).includes(fixtureToken));
  for (const raw of [profileFixture.replace('telegram_enabled = true', 'telegram_enabled = false'),
    profileFixture.replace('primary', 'test-only.primary'), profileFixture + '\n[safety]\n',
    profileFixture.replace(JSON.stringify(fixtureToken), '"""unsupported multiline"""')]) {
    write(h.profile, raw); assert.throws(() => loadProfile(h.profile));
  }
  assert.throws(() => strictJson('{"a":{"x":1,"\\u0078":2}}'));
  assert.throws(() => strictJson('{"x":1e999}'));
});

test('ordinary historical ledger schema/aliases retained and TEST_ONLY does not relabel history', async t => {
  const h = fixture(t, 'echo', false); const db = new DatabaseSync(h.ledger); fs.chmodSync(h.ledger, 0o600);
  db.exec(schemaFixture);
  db.prepare('INSERT INTO migrations VALUES (?,?,?,?)').run('legacy-migration', '0'.repeat(64), 2, 1);
  const insert = db.prepare("INSERT INTO deliveries VALUES (?,?,?,?,?,'sent',NULL,1,1,1,'legacy-confirmed','legacy_attention','legacy-migration')");
  insert.run('primary', 'owner', 'owner/repo:decision', revision, 'explicit_attention');
  insert.run('test-only.primary', 'test-only.owner', 'repo/imported-fixture', revision, 'explicit_attention'); db.close();
  migrateLedgerV1ToV2(h.ledger, cutover);
  let ledger = new DeliveryLedger(h.ledger);
  try { assert.equal(ledger.claim(h.identity('owner/repo:decision', revision, false)).action, 'suppressed'); } finally { ledger.close(); }
  assert.equal((await h.service.publish(h.argument('repo/imported-fixture'), h.context)).state, 'duplicate'); assert.equal(h.state.sends, 0);
  const unmapped = await h.service.publish(h.argument(), h.context);
  assert.equal(unmapped.state, 'held'); assert.equal(unmapped.admission.reason, 'legacy_history_unmapped');
  assert.equal(h.state.sends, 0);
  ledger = new DeliveryLedger(h.ledger);
  try { assert.equal(ledger.inspect(h.identity('owner/repo:decision', revision, false))?.source, 'legacy_attention'); } finally { ledger.close(); }
});

test('unsupported legacy schemas are refused unchanged before WAL or reset', t => {
  const h = fixture(t, 'echo', false); const db = new DatabaseSync(h.ledger); fs.chmodSync(h.ledger, 0o600);
  db.exec('CREATE TABLE private_legacy (value TEXT); PRAGMA user_version=77'); db.close();
  const before = digest(fs.readFileSync(h.ledger)); assert.throws(() => new DeliveryLedger(h.ledger));
  assert.equal(digest(fs.readFileSync(h.ledger)), before);
  const check = new DatabaseSync(h.ledger); assert.equal(check.prepare('PRAGMA journal_mode').get()!.journal_mode, 'delete'); check.close();
});

test('inflight crash claim and confirmation write failure stay terminal', async t => {
  const h = fixture(t); const ledger = new DeliveryLedger(h.ledger); ledger.claim(h.identity()); ledger.close();
  assert.equal((await h.service.publish(h.argument(), h.context)).state, 'unknown'); assert.equal(h.state.sends, 0);
  const original = DeliveryLedger.prototype.confirmed;
  DeliveryLedger.prototype.confirmed = () => { throw new Error('synthetic write failure'); };
  try { assert.equal((await h.service.publish(h.argument('repo/write-failure'), h.context)).state, 'unknown'); }
  finally { DeliveryLedger.prototype.confirmed = original; }
  h.restart();
  assert.equal((await h.service.publish(h.argument('repo/write-failure'), h.context)).state, 'unknown');
  assert.equal(h.telegramTransport.messages.length, 1);
});

test('lazy production mode uses exact IDs; test namespace cannot suppress it and no-config stays inert', async t => {
  const h = fixture(t);
  assert.equal((await h.service.publish(h.argument(), h.context)).state, 'sent');
  const production = createNotificationService({ configPath: h.configPath });
  h.state.mutate = (which, result) => { if (which === 'read') result.structuredContent.thread.messages[0].body += ' changed'; };
  const uncertain = await production.publish(h.argument(), h.context);
  assert.equal(uncertain.state, 'unknown');
  assert.equal(uncertain.admission.identity_binding?.notification_identity.profile_id, 'primary');
  assert.equal(uncertain.admission.identity_binding?.notification_identity.destination_id, 'owner');
  assert.equal(uncertain.admission.test_only, undefined); assert.equal(uncertain.delivery.test_only, undefined);
  const ledger = new DeliveryLedger(h.ledger);
  try {
    assert.equal(ledger.inspect(h.identity())?.state, 'sent');
    assert.equal(ledger.inspect(h.identity('owner/repo:decision', revision, false))?.state, 'delivery_unknown');
  } finally { ledger.close(); }
  assert.equal(h.telegramTransport.requests.length, 1); assert.equal(h.state.sends, 2);

  const disabled = createNotificationService({ configPath: null });
  assert.equal((await disabled.publish(h.argument('repo/no-config'), h.context)).state, 'held');
  assert.equal(h.telegramTransport.requests.length, 1);
  assert.throws(() => createNotificationService({ configPath: h.configPath,
    telegramHttpClient: { mode: 'test-http-only', messages: [], requests: [] } as any }));
  assert.throws(() => createNotificationService({ configPath: h.configPath,
    telegramTransport: { mode: 'test-only', messages: [] } }));
  assert.throws(() => createNotificationService({ configPath: h.configPath,
    telegramHttpClient: h.telegramTransport, telegramTransport: createTestTelegramTransport() }));
});

test('protected binding metadata preflights fresh, sent and unknown identities without changing terminal rows', async t => {
  for (const prior of ['fresh', 'sent', 'unknown'] as const) {
    const h = fixture(t, prior === 'unknown' ? 'unknown' : 'echo');
    if (prior !== 'fresh') assert.equal((await h.service.publish(h.argument(), h.context)).state, prior);
    const before = { sends: h.state.sends, requests: h.telegramTransport.requests.length };
    const db = new DatabaseSync(h.ledger);
    const rows = () => db.prepare('SELECT * FROM deliveries').all();
    try {
      const saved = rows();
      const service = createNotificationService({ configPath: h.configPath, telegramHttpClient: h.telegramTransport,
        knownSecrets: ['canonical-bound'] });
      const receipt = await service.publish(h.argument(), h.context);
      assert.equal(receipt.state, 'held'); assert.ok(!JSON.stringify(receipt).includes('canonical-bound'));
      assert.equal(h.state.sends, before.sends); assert.equal(h.telegramTransport.requests.length, before.requests);
      assert.deepEqual(rows(), saved);
      h.restart();
      assert.equal((await h.service.publish(h.argument(), h.context)).state,
        prior === 'fresh' ? 'sent' : prior === 'sent' ? 'duplicate' : 'unknown');
    } finally { db.close(); }
  }
});

test('final complete receipt gate redacts error metadata without releasing terminal claims', async t => {
  const h = fixture(t, 'unknown');
  const protectedReason = 'publication_or_delivery_unknown_no_retry';
  const service = createNotificationService({ configPath: h.configPath, telegramHttpClient: h.telegramTransport,
    knownSecrets: [protectedReason] });
  const receipt = await service.publish(h.argument(), h.context);
  assert.equal(receipt.state, 'unknown'); assert.ok(!JSON.stringify(receipt).includes(protectedReason));
  assert.equal(receipt.admission.identity_binding, undefined);
  assert.equal(h.telegramTransport.requests.length, 1);
  const replayService = createNotificationService({ configPath: h.configPath, telegramHttpClient: h.telegramTransport,
    knownSecrets: ['prior_attempt_terminal'] });
  const replay = await replayService.publish(h.argument(), h.context);
  assert.equal(replay.state, 'unknown'); assert.ok(!JSON.stringify(replay).includes('prior_attempt_terminal'));
  assert.equal(replay.admission.identity_binding, undefined);
  h.restart(); assert.equal((await h.service.publish(h.argument(), h.context)).state, 'unknown');
  assert.equal(h.telegramTransport.requests.length, 1); assert.equal(h.state.sends, 1);
});

test('early held receipts cannot bypass final metadata protection before profile loading', async t => {
  const h = fixture(t);
  for (const secret of ['configured_admission_held', 'explicit_attention', 'bypassed']) {
    const service = createNotificationService({ configPath: h.configPath, telegramHttpClient: h.telegramTransport,
      knownSecrets: [secret] });
    const receipt = await service.publish({ ...h.argument(), text: '' }, h.context);
    assert.equal(receipt.state, 'held'); assert.ok(!JSON.stringify(receipt).includes(secret));
  }
  assert.equal(h.state.sends, 0); assert.equal(deliveryCount(h.ledger), 0);
});

test('fixed rendered provenance secrets hold before any claim or native callback', async t => {
  const h = fixture(t);
  for (const secret of ['unclassified', 'Source: Pi', 'Inbox: https://inbox']) {
    const service = createNotificationService({ configPath: h.configPath, telegramHttpClient: h.telegramTransport,
      knownSecrets: [secret] });
    assert.equal((await service.publish(h.argument(), h.context)).state, 'held');
  }
  assert.equal(h.state.checks, 0); assert.equal(h.state.sends, 0);
  assert.equal(h.telegramTransport.requests.length, 0); assert.equal(deliveryCount(h.ledger), 0);
});

test('invalid synthetic Telegram token/destination profiles hold before claim or Inbox', async t => {
  const h = fixture(t);
  for (const token of ['synthetic-token', '1234:short', '123456789:abc/def', '123456789:' + 'a'.repeat(129)]) {
    write(h.profile, profileFixture.replace(fixtureToken, token));
    assert.equal((await h.service.publish(h.argument(), h.context)).state, 'held');
  }
  for (const chat of ['synthetic-destination', '@review-room', '+123', '0123', '-0',
    '4503599627370496', '-4503599627370496']) {
    write(h.profile, profileFixture.replace('-1009876543210', chat));
    assert.equal((await h.service.publish(h.argument(), h.context)).state, 'held');
  }
  assert.equal(h.state.checks, 0); assert.equal(h.state.sends, 0); assert.equal(h.state.reads, 0);
  assert.equal(h.telegramTransport.requests.length, 0); assert.equal(deliveryCount(h.ledger), 0);
});

test('strict Telegram HTTP responses never confirm uncertain or mismatched sends and never retry', async t => {
  const outcomes: TestTelegramOutcome[] = ['unknown', 'malformed', 'wrong-chat', 'wrong-text', 'extra-entity',
    'duplicate-entity', 'bad-entity-boundary', 'bad-message-id', 'missing-entities', 'redirect', 'bad-status',
    'oversized', 'invalid-utf8', 'duplicate-json', 'deep-json'];
  for (const outcome of outcomes) {
    const h = fixture(t, outcome);
    const first = await h.service.publish(h.argument('repo/http-' + outcome), h.context);
    assert.equal(first.state, 'unknown', outcome);
    assert.equal(first.admission.reason, 'publication_or_delivery_unknown_no_retry', outcome);
    assert.equal(first.delivery.status, 'delivery-unknown', outcome);
    const db = new DatabaseSync(h.ledger);
    try {
      const row = db.prepare('SELECT state, confirmed_at, confirmation_ref FROM deliveries').get()!;
      assert.equal(row.state, 'delivery_unknown', outcome);
      assert.equal(row.confirmed_at, null, outcome); assert.equal(row.confirmation_ref, null, outcome);
    } finally { db.close(); }
    assert.equal(h.telegramTransport.requests.length, 1, outcome);
    h.restart();
    const replay = await h.service.publish(h.argument('repo/http-' + outcome), h.context);
    assert.equal(replay.state, 'unknown', outcome);
    assert.equal(h.telegramTransport.requests.length, 1, `${outcome} must not retry after restart`);
  }
});

test('valid response metadata boundaries confirm once and remain suppressed across restart', async t => {
  for (const outcome of ['max-size', 'valid-utf8', 'max-depth'] as const) {
    const h = fixture(t, outcome);
    assert.equal((await h.service.publish(h.argument(), h.context)).state, 'sent', outcome);
    assert.equal(h.telegramTransport.requests.length, 1);
    h.restart();
    assert.equal((await h.service.publish(h.argument(), h.context)).state, 'duplicate', outcome);
    assert.equal(h.telegramTransport.requests.length, 1);
  }
});

test('abort cancels the bounded exchange and a late fake success cannot confirm or replay', async t => {
  const h = fixture(t, 'late');
  const started = waitForTestTelegramHttpRequest(h.telegramTransport);
  const running = h.service.publish(h.argument('repo/late-http'), h.context);
  await started; h.controller.abort();
  assert.equal((await running).state, 'unknown');
  assert.equal(h.telegramTransport.requests.length, 1);
  completeLateTestTelegramHttp(h.telegramTransport);
  await new Promise(resolve => setTimeout(resolve, 0));
  h.restart();
  assert.equal((await h.service.publish(h.argument('repo/late-http'), { ...h.context, signal: new AbortController().signal })).state, 'unknown');
  assert.equal(h.telegramTransport.requests.length, 1);
});

test('legacy fake transport remains test-only and is adapted through serialized HTTP bytes', async t => {
  const h = fixture(t); const legacy = createTestTelegramTransport();
  const service = createNotificationService({ configPath: h.configPath, telegramTransport: legacy });
  const result = await service.publish(h.argument('repo/legacy-http-adapter'), h.context);
  assert.equal(result.state, 'sent'); assert.equal(result.admission.test_only, true); assert.equal(result.delivery.test_only, true);
  assert.equal(result.delivery.receipt?.identity.profile_id, 'test-only.primary');
  assert.equal(result.delivery.receipt?.identity.destination_id, 'test-only.owner');
  assert.equal(legacy.messages.length, 1);
});

test('independent services share atomic claims and cannot duplicate an overlapping event', async t => {
  const h = fixture(t); const other = h.makeService();
  const results = await Promise.all([h.service.publish(h.argument(), h.context), other.publish(h.argument(), h.context)]);
  assert.equal(results.filter(r => r.state === 'sent').length, 1);
  assert.equal(results.filter(r => r.state === 'unknown').length, 1);
  assert.equal(h.state.sends, 1); assert.equal(h.telegramTransport.messages.length, 1);
});

test('pinned base rejects credentials including empty userinfo, query, fragment and non-HTTPS', t => {
  const h = fixture(t);
  for (const base of ['http://inbox.example.invalid/', 'https://@inbox.example.invalid/',
    'https://user:pass@inbox.example.invalid/', 'https:///inbox.example.invalid/',
    'https://inbox.example.invalid/?query=1', 'https://inbox.example.invalid/#fragment']) {
    h.config.projects[0].inbox_base_url = base; h.save();
    assert.throws(() => h.makeService(), { message: 'configuration_unavailable' });
  }
});

test('NFKC and control-normalized known secrets cannot enter the publication body', async t => {
  const h = fixture(t);
  for (const secret of ['ｓｙｎｔｈｅｔｉｃ-credential', 'synthetic-\u200bcredential']) {
    const service = createNotificationService({ configPath: h.configPath, telegramHttpClient: h.telegramTransport,
      knownSecrets: [secret] });
    const result = await service.publish({ ...h.argument(), text: 'synthetic-credential' }, h.context);
    assert.equal(result.state, 'held');
  }
  assert.equal(h.state.sends, 0); assert.equal(h.telegramTransport.requests.length, 0); assert.equal(deliveryCount(h.ledger), 0);
});

test('changed model key/revision for SAME KNOWN native request holds after confirmed or read-unknown', async t => {
  for (const prior of ['confirmed', 'unknown']) {
    const h = fixture(t);
    if (prior === 'unknown') h.state.hook = name => { if (name === 'read') throw new Error('synthetic read failure'); };
    const first = await h.service.publish(h.argument(), h.context);
    assert.equal(first.state, prior === 'confirmed' ? 'sent' : 'unknown');
    const originalSend = h.native('send'); h.state.hook = undefined;
    const db = new DatabaseSync(h.ledger);
    const original = db.prepare('SELECT * FROM canonical_associations').get() as any;
    assert.equal(original.read_verified, prior === 'confirmed' ? 1 : 0);
    assert.equal(original.inbox_authority, 'https://inbox.example.invalid'); db.close();
    const readCount = h.state.reads;
    h.context.inboxSend = async () => { h.state.sends++; return structuredClone(originalSend); };
    for (const args of [h.argument('owner/repo:changed'), h.argument('owner/repo:decision', 'b'.repeat(64)),
      h.argument('owner/repo:both', 'b'.repeat(40))]) {
      h.restart(); const result = await h.service.publish(args, h.context);
      assert.equal(result.state, 'held'); assert.equal(result.admission.reason, 'canonical_identity_conflict');
      assert.equal(result.admission.identity_binding?.status, 'canonical-conflict');
      assert.equal(result.admission.identity_binding?.asserted.revision, args.revision);
      assert.equal(result.admission.identity_binding?.notification_identity.decision_key, args.decision_key);
      assert.equal(h.state.reads, readCount, 'conflicting canonical identity must stop before another full read');
      const ledger = new DeliveryLedger(h.ledger);
      try { assert.equal(ledger.inspect(h.identity(args.decision_key, args.revision))?.state, 'delivery_unknown'); }
      finally { ledger.close(); }
    }
    const after = new DatabaseSync(h.ledger);
    assert.deepEqual(after.prepare('SELECT * FROM canonical_associations').all(), [original]); after.close();
    assert.equal(h.telegramTransport.messages.length, prior === 'confirmed' ? 1 : 0);
  }
});

test('stable notification guard suppresses changed origin/port/new-message callbacks across restart', async t => {
  for (const outcome of ['echo', 'unknown'] as const) {
    const h = fixture(t, outcome); await h.service.publish(h.argument(), h.context);
    h.config.projects[0].inbox_base_url = 'https://migrated.example.invalid:8443/new-base'; h.save(); h.restart();
    h.context.inboxSend = async () => { throw new Error('must not ask for another native message'); };
    const result = await h.service.publish(h.argument(), h.context);
    assert.equal(result.state, outcome === 'echo' ? 'duplicate' : 'unknown');
    assert.equal(h.state.sends, 1); assert.equal(h.telegramTransport.messages.length, 1);
    assert.equal(result.admission.identity_binding?.status, 'canonical-bound');
    assert.equal(result.admission.identity_binding?.canonical_request?.authority, 'https://inbox.example.invalid');
  }
});

test('canonical association does not namespace by root/session/base path or default-port spelling', async t => {
  const h = fixture(t); await h.service.publish(h.argument(), h.context);
  const old = h.native('send');
  const renamed = path.join(h.directory, 'renamed'); fs.renameSync(h.root, renamed);
  h.host.project_path = renamed; h.host.session_id = 'other-session'; h.context.observed = { ...h.host };
  h.config.projects[0].project_path = renamed;
  h.config.projects[0].inbox_base_url = 'https://inbox.example.invalid:443/different-base'; h.save(); h.restart();
  old.structuredContent.project.root = renamed;
  old.structuredContent.url = h.config.projects[0].inbox_base_url + '#thread=' + old.structuredContent.thread_id;
  h.context.inboxSend = async () => old;
  const result = await h.service.publish(h.argument('owner/repo:changed'), h.context);
  assert.equal(result.admission.reason, 'canonical_identity_conflict'); assert.equal(result.state, 'held');
  assert.equal(h.telegramTransport.messages.length, 1);
});

test('same native message with conflicting thread correlation holds before Telegram', async t => {
  const h = fixture(t); await h.service.publish(h.argument(), h.context);
  const old = h.native('send'); old.structuredContent.thread_id = 'msg_' + 'Z'.repeat(26);
  old.structuredContent.url = h.config.projects[0].inbox_base_url + '#thread=' + old.structuredContent.thread_id;
  h.context.inboxSend = async () => old;
  const result = await h.service.publish(h.argument('owner/repo:changed'), h.context);
  assert.equal(result.state, 'held'); assert.equal(result.admission.reason, 'canonical_identity_conflict');
  assert.equal(h.telegramTransport.messages.length, 1);
});

test('unknown without validated native IDs is terminal notification-only, not semantic sameness proof', async t => {
  const h = fixture(t);
  h.state.hook = name => { if (name === 'send') throw new Error('unknown, no returned IDs'); };
  const first = await h.service.publish(h.argument(), h.context);
  assert.equal(first.state, 'unknown'); assert.equal(first.admission.identity_binding?.status, 'notification-only');
  assert.equal(first.admission.identity_binding?.canonical_request, undefined);
  h.state.hook = undefined; h.restart();
  const replay = await h.service.publish(h.argument(), h.context);
  assert.equal(replay.state, 'unknown'); assert.equal(h.state.sends, 1);
  const db = new DatabaseSync(h.ledger); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM canonical_associations').get()!.n, 0); db.close();
});

test('unmapped v1 scope blocks changed assertions/origin/new-message rather than assuming no history', async t => {
  const h = fixture(t, 'echo', false); const db = new DatabaseSync(h.ledger); fs.chmodSync(h.ledger, 0o600); db.exec(schemaFixture);
  db.prepare("INSERT INTO deliveries VALUES (?,?,?,?,?,'delivery_unknown',?,1,1,NULL,NULL,'live',NULL)")
    .run('test-only.primary', 'test-only.owner', 'owner/repo:old', revision, 'explicit_attention', 'a'.repeat(32)); db.close();
  migrateLedgerV1ToV2(h.ledger, cutover);
  h.config.projects[0].inbox_base_url = 'https://changed.example.invalid:8443/inbox'; h.save(); h.restart();
  for (const args of [h.argument('owner/repo:changed'), h.argument('owner/repo:old', 'b'.repeat(64))]) {
    const receipt = await h.service.publish(args, h.context);
    assert.equal(receipt.state, 'held'); assert.equal(receipt.admission.reason, 'legacy_history_unmapped');
  }
  assert.equal((await h.service.publish(h.argument('owner/repo:old'), h.context)).state, 'unknown');
  assert.equal(h.state.sends, 0); assert.equal(h.telegramTransport.messages.length, 0);
});

test('publisher never creates a missing configured ledger or cutover fence as fallback', async t => {
  const h = fixture(t, 'echo', false);
  const result = await h.service.publish(h.argument(), h.context);
  assert.equal(result.state, 'held'); assert.equal(h.state.sends, 0);
  assert.ok(!fs.existsSync(h.ledger)); assert.ok(!fs.existsSync(h.ledger + '.cutover-v2.json'));
});

test('echo validator binds full text and canonical UTF16 text-link target', async t => {
  const h = fixture(t); assert.equal((await h.service.publish(h.argument(), h.context)).state, 'sent');
  const message = h.telegramTransport.messages[0];
  const echo = { message_id: 1, text: message.text, entities: structuredClone(message.entities) };
  assert.equal(confirmed(message, echo), 1);
  assert.throws(() => confirmed(message, { ...echo, text: message.text + ' changed' }));
  assert.throws(() => confirmed(message, { ...echo, entities: [] }));
  assert.throws(() => confirmed(message, { ...echo, entities: [{ ...echo.entities[0], url: 'https://other.example.invalid/' }] }));
  assert.throws(() => prepareBody('Ready.', 'bad\n', revision, []));
});
