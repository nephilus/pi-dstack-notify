import './offline-guard.mjs';
import { attempts } from './offline-guard.mjs';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { defaultCaseFold } from '../../core/casefold.ts';
import { CASEFOLD_DATA, CASEFOLD_SOURCE_SHA256, CASEFOLD_UNICODE_VERSION } from '../../core/casefold-data.ts';
after(() => { assert.deepEqual(attempts, []); assert.equal(process.env.PATH, '/nonexistent-notification-test-path'); });

test('generated mappings exactly reproduce COMPLETE pinned Unicode 15.1 C+F source bytes', () => {
  const bytes = readFileSync(new URL('../../fixtures/CaseFolding-15.1.0.txt', import.meta.url));
  assert.equal(bytes.length, 84870);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '4e55acfdc32825a22e87670e9056a3bf94ad7c5400065778e9e10f8314372bcf');
  assert.equal(CASEFOLD_SOURCE_SHA256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(CASEFOLD_UNICODE_VERSION, '15.1.0');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  assert.ok(source.startsWith('# CaseFolding-15.1.0.txt\n# Date: 2023-05-12, 21:53:10 GMT\n'));
  const expected = new Map<number, string>(), seen = new Set<string>();
  const counts: Record<string, number> = { C: 0, F: 0, S: 0, T: 0 };
  const scalar = (cp: number) => cp >= 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
  for (const line of source.split('\n')) {
    const row = line.split('#')[0].trim(); if (!row) continue;
    const match = /^([0-9A-F]{4,6}); ([CFST]); ([0-9A-F ]+);$/.exec(row)!;
    assert.ok(match); const cp = parseInt(match[1], 16), status = match[2];
    assert.ok(scalar(cp)); const key = cp + ':' + status;
    assert.ok(!seen.has(key)); seen.add(key); counts[status]++;
    const mapping = match[3].trim().split(/ +/).map(value => parseInt(value, 16));
    assert.ok(mapping.length > 0 && mapping.every(scalar));
    if (status === 'C' || status === 'F') {
      assert.ok(!expected.has(cp)); expected.set(cp, String.fromCodePoint(...mapping));
    }
  }
  assert.deepEqual(counts, { C: 1426, F: 104, S: 31, T: 2 });
  assert.equal(CASEFOLD_DATA.length, 1530); assert.equal(new Map(CASEFOLD_DATA).size, 1530);
  assert.deepEqual(new Map(CASEFOLD_DATA), expected);
  // Full scalar-domain identity coverage, not just selected script endpoints.
  for (let cp = 0; cp <= 0x10ffff; cp++) if (scalar(cp)) {
    const input = String.fromCodePoint(cp);
    assert.equal(defaultCaseFold(input), expected.get(cp) ?? input);
  }
});

test('full mappings, default-not-Turkic choice and comparison outputs beyond publication grammar', () => {
  for (const [input, output] of [ ['Straße', 'strasse'], ['STRASSE', 'strasse'], ['ẞß', 'ssss'],
    ['ſ', 's'], ['ŉ', '\u02bcn'], ['ǰ', 'j\u030c'], ['ẖ', 'h\u0331'], ['ẗ', 't\u0308'],
    ['ẘ', 'w\u030a'], ['ẙ', 'y\u030a'], ['ẚ', 'a\u02be'], ['ẛ', '\u1e61'],
    ['I', 'i'], ['İ', 'i\u0307'], ['ı', 'ı'], ['Ɓ', '\u0253'], ['Ⱥ', '\u2c65'],
    ['Σςσ', 'σσσ'], ['ДЕЛО', 'дело'], ['𐐀', '𐐨'], ['日本語 한글 𠀀', '日本語 한글 𠀀'] ])
    assert.equal(defaultCaseFold(input), output, input);
});

test('casefold never silently normalizes and retains the source wrapper order', () => {
  assert.equal(defaultCaseFold('\u01f0'), 'j\u030c');
  assert.notEqual(defaultCaseFold('\u01f0'), defaultCaseFold('\u01f0').normalize('NFC'));
  assert.equal(defaultCaseFold('\u00c5'), '\u00e5');
  assert.equal(defaultCaseFold('A\u030a'), 'a\u030a');
  assert.notEqual(defaultCaseFold('\u00c5'), defaultCaseFold('A\u030a'));
  assert.equal(defaultCaseFold(''), '');
  assert.equal(defaultCaseFold('\ud800'), '\ud800'); // Python primitive preserves; FYIP cleaning replaces.
  assert.throws(() => defaultCaseFold(null as never), { message: 'casefold_invalid' });
});
