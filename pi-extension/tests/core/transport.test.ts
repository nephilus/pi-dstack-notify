import './offline-guard.mjs';
import { attempts } from './offline-guard.mjs';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmed, createTestTelegramHttpClient, completeLateTestTelegramHttp, dispatchTestTelegramHttp } from '../../core/transport.ts';
import type { InternalTelegramHttpRequest, TestTelegramOutcome } from '../../core/transport.ts';
import { sendTelegram, httpTestTelegramMode, validateTelegramCredentials } from '../../core/telegram.ts';
import { prepareBody, protectScalars, strictJson } from '../../core/safety.ts';
import { renderAttention } from '../../core/policy.ts';
import type { TelegramMessage } from '../../core/types.ts';
after(() => { assert.deepEqual(attempts, []); assert.equal(process.env.PATH, '/nonexistent-notification-test-path'); });
const token = '987654321:NOT_A_REAL_TOKEN_fixture_abcdefghijk';
const url = 'https://review.example.invalid/';
const text = '𠀀 ' + url;
const message: TelegramMessage = { text, entities: [{ type: 'text_link', offset: 3, length: url.length, url }],
  disable_notification: false, link_preview_options: { is_disabled: true } };

test('closed malformed HTTP fixtures isolate byte, UTF-8, duplicate-key and depth guards', async () => {
  const body = Buffer.from(JSON.stringify({ chat_id: -1, ...message }), 'utf8');
  const request: InternalTelegramHttpRequest = { hostname: 'api.telegram.org', port: 443,
    method: 'POST', path: `/bot${token}/sendMessage`, deadlineMs: 10000, body,
    headers: { 'content-type': 'application/json; charset=utf-8', accept: 'application/json',
      'content-length': String(body.byteLength) } };
  const depth = (item: unknown): number => item && typeof item === 'object'
    ? Math.max(0, ...Object.values(item).map(child => 1 + depth(child))) : 0;
  const outcomes: TestTelegramOutcome[] = ['oversized', 'max-size', 'invalid-utf8', 'valid-utf8',
    'duplicate-json', 'deep-json', 'max-depth'];
  for (const outcome of outcomes) {
    const client = createTestTelegramHttpClient({ outcome });
    const response = await dispatchTestTelegramHttp(client, request, new AbortController().signal);
    assert.equal(response.statusCode, 200); assert.match(response.headers['content-type'], /^application\/json/);
    // Counterfactual: relaxing just the targeted wire/parser protection leaves
    // a valid envelope, destination, message and bijective entity confirmation.
    const permissiveText = new TextDecoder('utf-8').decode(response.body);
    const envelope = JSON.parse(permissiveText);
    assert.deepEqual(Object.keys(envelope).sort(), ['ok', 'result']);
    assert.equal(envelope.ok, true); assert.equal(envelope.result.chat.id, -1);
    assert.equal(confirmed(message, envelope.result), 1, outcome);
    if (outcome === 'oversized' || outcome === 'max-size') {
      assert.equal(response.body.byteLength, outcome === 'max-size' ? 65536 : 65537);
      assert.deepEqual(strictJson(permissiveText), envelope);
      protectScalars(envelope, [token]);
    } else assert.ok(response.body.byteLength < 65536);
    if (outcome === 'invalid-utf8') {
      assert.equal(envelope.result.metadata, '\ufffd');
      assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(response.body));
      assert.deepEqual(strictJson(permissiveText), envelope);
      protectScalars(envelope, [token]);
    } else {
      assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(response.body), permissiveText);
    }
    if (outcome === 'duplicate-json') {
      assert.throws(() => strictJson(permissiveText), { message: 'notification_held' });
      protectScalars(envelope, [token]);
    }
    if (outcome === 'deep-json' || outcome === 'max-depth') {
      assert.equal(depth(envelope), outcome === 'max-depth' ? 32 : 33);
      if (outcome === 'deep-json') {
        // Both bounded traversals deliberately enforce the same depth contract.
        assert.throws(() => strictJson(permissiveText), { message: 'notification_held' });
        assert.throws(() => protectScalars(envelope, [token]), { message: 'notification_held' });
      } else {
        assert.deepEqual(strictJson(permissiveText), envelope); protectScalars(envelope, [token]);
      }
    }
    if (outcome === 'valid-utf8') {
      assert.equal(envelope.result.metadata, 'Café 日本語');
      assert.deepEqual(strictJson(permissiveText), envelope); protectScalars(envelope, [token]);
    }
  }
});

test('confirmation is bijective, exact and UTF-16 scalar bounded', () => {
  const echo = () => ({ message_id: 1, text, entities: structuredClone(message.entities) });
  assert.equal(confirmed(message, echo()), 1);
  for (const patch of [ { offset: 1, length: 1 }, { offset: -1 }, { offset: 3.1 }, { length: 0 },
    { length: url.length + 1 }, { url: 'https://other.example.invalid/' }, { extra: true }, { type: 'url' } ]) {
    const response = echo(); Object.assign(response.entities[0], patch);
    assert.throws(() => confirmed(message, response));
  }
  const duplicate = echo(); duplicate.entities.push(structuredClone(duplicate.entities[0]));
  assert.throws(() => confirmed(message, duplicate));
  assert.throws(() => confirmed(message, { ...echo(), entities: [] }));
});

test('numeric destinations and token routes are canonical and bounded, including line endings', () => {
  for (const chat of ['1', '-1', '4503599627370495', '-4503599627370495'])
    assert.equal(validateTelegramCredentials([token, chat]).chatId, Number(chat));
  for (const chat of ['0', '-0', '+1', '01', '-01', '1\n', '@name', '4503599627370496'])
    assert.throws(() => validateTelegramCredentials([token, chat]));
  for (const value of [token + '\n', token + '\r', token + '/other', '1234:short'])
    assert.throws(() => validateTelegramCredentials([value, '1']));
});

test('actual ten-second total deadline returns unknown and discards late completion', async () => {
  const fake = createTestTelegramHttpClient({ outcome: 'late' });
  const start = performance.now();
  await assert.rejects(sendTelegram(message, validateTelegramCredentials([token, '-1']), [token],
    new AbortController().signal, httpTestTelegramMode(fake)), { message: 'telegram_delivery_unknown' });
  assert.ok(performance.now() - start >= 9900);
  assert.equal(fake.requests.length, 1);
  completeLateTestTelegramHttp(fake);
  await Promise.resolve();
  assert.equal(fake.requests.length, 1);
});

test('scalar-safe summaries reserve fixed literal links even with repeated URL spans', () => {
  const review = { label: '日本語', url };
  const target = { project_id: 'p', project_root: '/synthetic', session_id: 'session',
    message_id: 'msg_' + '0'.repeat(26), thread_id: 'msg_' + '0'.repeat(26), revision: 'a'.repeat(64),
    revision_semantics: 'content-sha256' as const, url: 'https://inbox.example.invalid/#thread=msg_' + '0'.repeat(26) };
  const body = prepareBody('𠀀'.repeat(2000), 'session', target.revision, [], review);
  const rendered = renderAttention(body, target, [], review);
  assert.ok(rendered.text.startsWith('Attention · explicit request'));
  assert.ok(rendered.text.length <= 4096);
  assert.ok([...rendered.text].every(scalar => {
    const cp = scalar.codePointAt(0)!; return cp < 0xd800 || cp > 0xdfff;
  }));
  assert.equal(confirmed(rendered, { message_id: 1, text: rendered.text, entities: rendered.entities }), 1);
  for (const entity of rendered.entities) {
    assert.equal(entity.type, 'text_link');
    if (entity.type === 'text_link') assert.equal(rendered.text.slice(entity.offset, entity.offset + entity.length), entity.url);
  }
});
