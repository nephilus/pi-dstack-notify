import './offline-guard.mjs';
import { attempts } from './offline-guard.mjs';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareBody, protect, safeReviewUrl, safeText, validateReviewLink, safeNativeIdentity } from '../../core/safety.ts';
after(() => { assert.deepEqual(attempts, []); assert.equal(process.env.PATH, '/nonexistent-notification-test-path'); });

test('frozen Unicode 15.1 range endpoints and supplementary scalars are accepted', () => {
  const endpoints = [0x00c0, 0x00d6, 0x00d8, 0x00f6, 0x00f8, 0x024f, 0x1e00, 0x1eff,
    0x3400, 0x4dbf, 0x4e00, 0x9fff, 0x20000, 0x2a6df, 0xac00, 0xd7a3,
    0x3041, 0x3096, 0x30a1, 0x30fa, 0x30fc, 0x30fe, 0x00b7, 0x2013, 0x2014,
    0x2018, 0x2019, 0x201c, 0x201d, 0x2026, 0x3001, 0x3002];
  for (const cp of endpoints) {
    const scalar = String.fromCodePoint(cp);
    // Explicit range membership never overrides NFC/compatibility exclusions.
    if (scalar.normalize('NFC') !== scalar || scalar.normalize('NFKC') !== scalar)
      assert.throws(() => safeText(scalar, 1, false), { message: 'notification_held' });
    else assert.equal(safeText(scalar, 1, false), scalar);
  }
  const mixed = 'Café – 日本語 한글 ' + String.fromCodePoint(0x20000);
  assert.equal(safeText(mixed, [...mixed].length), mixed);
  assert.equal(safeText('A_Z=9 (review), yes?', 64), 'A_Z=9 (review), yes?');
  assert.equal(safeText('line one\nline two', 32), 'line one\nline two');
});

test('static Unicode 15.1 Age fixture covers exactly all 82319 approved code points', () => {
  const approved = new Set<number>();
  const ranges = [[0xc0, 0xd6], [0xd8, 0xf6], [0xf8, 0x24f], [0x1e00, 0x1eff],
    [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0x20000, 0x2a6df], [0xac00, 0xd7a3],
    [0x3041, 0x3096], [0x30a1, 0x30fa], [0x30fc, 0x30fe], [0xb7, 0xb7],
    [0x2013, 0x2014], [0x2018, 0x2019], [0x201c, 0x201d], [0x2026, 0x2026], [0x3001, 0x3002]];
  for (const [start, end] of ranges) for (let cp = start; cp <= end; cp++) approved.add(cp);
  const covered = new Set<number>();
  const fixture = readFileSync(new URL('../../fixtures/unicode-15.1-approved-age.txt', import.meta.url), 'utf8');
  for (const line of fixture.split('\n').filter(line => line && !line.startsWith('#'))) {
    const match = /^([0-9A-F]+)(?:\.\.([0-9A-F]+))?;([0-9]+\.[0-9]+)$/.exec(line)!;
    assert.ok(match); assert.ok(Number(match[3]) <= 15.1);
    for (let cp = parseInt(match[1], 16); cp <= parseInt(match[2] ?? match[1], 16); cp++) {
      assert.ok(approved.has(cp)); assert.ok(!covered.has(cp)); covered.add(cp);
      const scalar = String.fromCodePoint(cp);
      if (scalar.normalize('NFC') === scalar && scalar.normalize('NFKC') === scalar)
        assert.equal(safeText(scalar, 1, false), scalar);
      else assert.throws(() => safeText(scalar, 1, false));
    }
  }
  assert.equal(covered.size, 82319); assert.deepEqual(covered, approved);
  for (const cp of [0xd7, 0xf7, 0x250, 0x1f00, 0x33ff, 0x4dc0, 0xa000, 0x1ffff, 0x2a6e0,
    0xabff, 0xd7a4, 0x3040, 0x3097, 0x30a0, 0x30fb, 0x30ff]) assert.throws(() => safeText(String.fromCodePoint(cp), 1));
});

test('unknown, non-NFC, compatibility, hidden, bidi, control and malformed scalars fail closed', () => {
  for (const value of ['!', '<img>', '\u0378', '\ue000', '\ufdd0', '\uffff', '\u0085', '\u202e', '\u200b',
    '\ufeff', '\u00a0', '\r', '\t', '\ud800', '\udc00', '\uff21', '\u0132', 'A\u030a']) {
    assert.throws(() => safeText(value, 256), { message: 'notification_held' }, JSON.stringify(value));
  }
  assert.throws(() => safeText('a'.repeat(201), 200, false), { message: 'notification_held' });
  assert.throws(() => safeText('label\ncontinued', 200, false), { message: 'notification_held' });
});

test('native identities use a scalar hazard denylist, not the caller script alphabet', () => {
  for (const cp of [0, 0x1f, 0x7f, 0x9f, 0xad, 0x34f, 0x61c, 0x115f, 0x1160, 0x17b4, 0x17b5,
    0x600, 0x605, 0x6dd, 0x70f, 0x890, 0x891, 0x8e2,
    0x180b, 0x180f, 0x200b, 0x200f, 0x2028, 0x202e, 0x2060, 0x206f, 0x3164, 0xfe00, 0xfe0f,
    0xfeff, 0xffa0, 0xfff0, 0xfffb, 0x110bd, 0x110cd, 0x13430, 0x1343f,
    0x1bca0, 0x1bca3, 0x1d173, 0x1d17a, 0xe0000, 0xe0fff,
    0xd800, 0xdfff, 0xfdd0, 0xfdef, 0xfffe, 0xffff, 0x10fffe, 0x10ffff])
    assert.throws(() => safeNativeIdentity('prj_' + String.fromCodePoint(cp)), { message: 'notification_held' });
  for (const value of ['prj_Ελληνικά', 'prj_Кириллица', 'prj_日本語_𠀀', 'prj_123:/@. -'])
    assert.equal(safeNativeIdentity(value), value);
});

test('review URLs require exact canonical ASCII HTTPS DNS syntax and bounded ports', () => {
  for (const url of ['https://review.example.invalid/pull/123',
    'https://review.example.invalid:8443/review/one?view=files#diff',
    'https://review.example.invalid/pull/1?view=']) assert.equal(safeReviewUrl(url), url);
  for (const url of ['http://review.example.invalid/pull/1', 'https://user@review.example.invalid/pull/1',
    'https://review.example.invalid@evil.example/pull/1', 'https://review.example.invalid:443/pull/1',
    'https://review.example.invalid:01/pull/1', 'https://review.example.invalid:65536/pull/1',
    'https://review.example.invalid./pull/1', 'https://localhost.example/pull/1',
    'https://review.local/pull/1', 'https://127.0.0.1/pull/1', 'https://xn--e1afmkfd.example/pull/1',
    'https://review.example.invalid/%2fsecret', 'https://review.example.invalid/a\\b',
    'https://review.example.invalid/![x](local.png)', 'https://review.example.invalid/?access_token=unlistedvalue',
    'https://review.example.invalid/\u202e',
    'https://review.example.invalid/pull/1#']) {
    assert.throws(() => safeReviewUrl(url), { message: 'notification_held' }, url);
  }
  assert.throws(() => validateReviewLink({ label: 'safe', url: 'https://review.example.invalid/', extra: true }),
    { message: 'notification_held' });
  assert.throws(() => validateReviewLink({ label: 'line\nbreak', url: 'https://review.example.invalid/' }),
    { message: 'notification_held' });
});

test('original and complete generated bodies reject native image/path syntax and credential families', () => {
  const session = 'synthetic-session', revision = 'a'.repeat(64), secrets = ['known-secret'];
  const link = { label: 'Review 日本語', url: 'https://review.example.invalid/pull/123' };
  const body = prepareBody('A safe Café summary.', session, revision, secrets, link);
  assert.ok(body.includes('Review: Review 日本語\n' + link.url));
  assert.ok(body.endsWith(`\n\nPi notification; session ${session}; revision ${revision}`));
  for (const text of ['![x](file:///tmp/x)', '```\n![x](../secret)\n```', '<img src="&#47;tmp/x">',
    '&lt;img src=x&gt;', '/etc/passwd', 'C:\\secret', '\\\\server\\share', '~/private', '../private',
    'file:///tmp/x', 'data:image/png,x', 'password=unlistedvalue', 'sk-example123', 'ghp_example123']) {
    assert.throws(() => prepareBody(text, session, revision, secrets), { message: 'notification_held' }, text);
  }
  for (const value of ['known-secret', 'known-**secret**', 'sk-example123', 'accesstoken=unlistedvalue']) {
    assert.throws(() => protect([value], secrets), { message: 'notification_held' }, value);
  }
  assert.throws(() => prepareBody('safe.', 'sk-session-example123', revision, secrets),
    { message: 'notification_held' });
});
