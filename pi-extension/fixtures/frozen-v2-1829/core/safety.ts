import { createHash } from 'node:crypto';
import type { ReviewLink } from './types.ts';
export function held(): never { throw new Error('notification_held'); }
export function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
export function exact(value: unknown, keys: string[]): asserts value is Record<string, any> {
  if (!record(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) held();
}
export function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
/** Port of accepted formatter normalization; never applied to authoritative IDs. */
export function normalize(value: string): string {
  return value.replace(/[\x00-\x08\x0b-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, '')
    .replace(/```.*?(?:```|$)|~~~.*?(?:~~~|$)/gs, '')
    .replaceAll('**', '').replaceAll('`', '').replaceAll('__', '');
}
function forms(value: string): string[] {
  return [value, normalize(value), value.normalize('NFKC'), normalize(value.normalize('NFKC')), normalize(value).normalize('NFKC')];
}
// Frozen Unicode 15.1 allowlist; ranges are explicit, never runtime category based.
// Assignment proof: fixtures/unicode-15.1-approved-age.txt (official 15.1 UCD,
// independent result:unicode-data#1). All 82,319 members assigned by 14.0;
// no assignment holes. NFC/NFKC checks below further exclude compatibility forms.
const unicodeRanges: readonly (readonly [number, number])[] = [
  [0x00c0, 0x00d6], [0x00d8, 0x00f6], [0x00f8, 0x024f], [0x1e00, 0x1eff],
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0x20000, 0x2a6df], [0xac00, 0xd7a3],
  [0x3041, 0x3096], [0x30a1, 0x30fa], [0x30fc, 0x30fe],
];
const unicodePunctuation = new Set([0x00b7, 0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2026, 0x3001, 0x3002]);
function safeScalar(cp: number, allowLineFeed: boolean): boolean {
  if (cp === 0x0a) return allowLineFeed;
  if (cp < 0x80) return /^[A-Za-z0-9 .,;?'()=_+\-]$/.test(String.fromCharCode(cp));
  return unicodePunctuation.has(cp) || unicodeRanges.some(([start, end]) => cp >= start && cp <= end);
}
/** NFC-only explicit text subset. Unknown, hidden, private, unassigned and noncharacter scalars fail closed. */
export function safeText(value: unknown, maxScalars: number, allowLineFeed = true): string {
  if (typeof value !== 'string' || !value || value.length > 16000
      || value.normalize('NFC') !== value || value.normalize('NFKC') !== value) held();
  let scalars = 0;
  for (const char of value) {
    scalars++;
    if (!safeScalar(char.codePointAt(0)!, allowLineFeed)) held();
  }
  if (scalars > maxScalars) held();
  return value;
}
// Keep these credential-shaped families aligned with Telegram's defense-in-depth redaction.
const credentialPatterns = [
  /\b(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{8,}\b/,
  /\b(password|passwd|api[_ -]?key|(?:access[_ -]?|refresh[_ -]?|bot[_ -]?)?token|secret|authorization)\b(\s*=\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/i,
];
export function protect(values: unknown[], secrets: readonly string[]): void {
  if (secrets.some(s => typeof s !== 'string' || !s)) held();
  const protectedValues = secrets.flatMap(forms).filter(Boolean);
  for (const value of values) {
    if (typeof value !== 'string' || forms(value).some(v => protectedValues.some(s => v.includes(s))
        || credentialPatterns.some(pattern => pattern.test(v)))) held();
  }
}
const dnsLabel = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const reviewUrlPattern = new RegExp('^https://(' + dnsLabel + '(?:\\.' + dnsLabel + ')+)(?::([1-9][0-9]{0,4}))?(/[A-Za-z0-9._~/-]*)?(?:\\?([A-Za-z0-9._~=&+-]+))?(?:#([A-Za-z0-9._~=&+-]+))?$');
export function safeReviewUrl(value: unknown): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 2048
      || /[\x00-\x20\x7f-\uffff\\%]/.test(value)) held();
  protect([value], []);
  const match = reviewUrlPattern.exec(value);
  if (!match || match[1].length > 253 || match[1].split('.').some(label => label.startsWith('xn--'))
      || match[1].split('.').some(label => label === 'localhost' || label === 'local')
      || /^\d+(?:\.\d+){3}$/.test(match[1])
      || (match[2] !== undefined && (Number(match[2]) > 65535 || Number(match[2]) === 443))) held();
  try {
    const parsed = new URL(value);
    if (parsed.href !== value || parsed.protocol !== 'https:' || parsed.username || parsed.password
        || parsed.hostname !== match[1]) held();
  } catch { held(); }
  return value;
}
export function validateReviewLink(value: unknown): ReviewLink {
  exact(value, ['label', 'url']);
  const label = safeText(value.label, 200, false);
  const url = safeReviewUrl(value.url);
  return { label, url };
}
/** Native identity safety, NOT the caller's prose/script grammar. Preserve exact
 * spelling but reject malformed scalars, controls, noncharacters and the frozen
 * Unicode 15.1 default-ignorable/format-control ranges (including bidi controls).
 * Ordinary arbitrary native prose must not be passed through this gate. */
export function safeNativeIdentity(value: unknown, maxUnits = 256): string {
  if (typeof value !== 'string' || !value || value.length > maxUnits) held();
  const hidden = [[0x00ad, 0x00ad], [0x034f, 0x034f], [0x0600, 0x0605], [0x061c, 0x061c],
    [0x06dd, 0x06dd], [0x070f, 0x070f], [0x0890, 0x0891], [0x08e2, 0x08e2], [0x115f, 0x1160],
    [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f], [0x2028, 0x202e],
    [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff],
    [0xffa0, 0xffa0], [0xfff0, 0xfffb], [0x110bd, 0x110bd], [0x110cd, 0x110cd],
    [0x13430, 0x1343f], [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a],
    [0xe0000, 0xe0fff]];
  for (const scalar of value) {
    const cp = scalar.codePointAt(0)!;
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0xd800 && cp <= 0xdfff)
        || (cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xffff) >= 0xfffe
        || hidden.some(([start, end]) => cp >= start && cp <= end)) held();
  }
  return value;
}
export function protectScalars(value: unknown, secrets: readonly string[]): void {
  const seen = new WeakSet<object>(); let count = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++count > 50000 || depth > 32) held();
    if (typeof item === 'string') { protect([item], secrets); return; }
    if (item === null || item === undefined || typeof item === 'boolean') return;
    if (typeof item === 'number') { if (!Number.isFinite(item)) held(); return; }
    if (typeof item !== 'object' || seen.has(item)) held();
    seen.add(item);
    if (Array.isArray(item)) { for (const child of item) visit(child, depth + 1); return; }
    if (!record(item)) held();
    for (const child of Object.values(item)) visit(child, depth + 1);
  };
  visit(value, 0);
}
const markdownImage = /!\[[^\]]*\]\([^)]+\)/s;
const htmlImage = /<\s*img\b/i;
const htmlEntity = /&(?:#[0-9]{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]+);/i;
const embeddedScheme = /\b(?:file|data|blob):/i;
const localPath = /(?:^|[\s\n])(?:\\\\|\/{1,2}|[a-z]:[\\/]|~[\\/]|\.\.?\/)/i;
function rejectNativeCapture(value: string): void {
  for (const form of forms(value)) {
    if (markdownImage.test(form) || htmlImage.test(form) || htmlEntity.test(form)
        || embeddedScheme.test(form) || localPath.test(form)) held();
  }
}
export const keyPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,199}$(?![\s\S])/;
export const revisionPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$(?![\s\S])/;
export const sessionPattern = /^[A-Za-z0-9._-]{1,128}$(?![\s\S])/;
export const messagePattern = /^msg_[0-9A-HJKMNP-TV-Z]{26}$(?![\s\S])/i;
const provenanceSuffix = /\n\nPi notification; session ([A-Za-z0-9._-]{1,128}); revision ((?:[0-9a-f]{40}|[0-9a-f]{64}))$/;
export function safeBody(body: unknown, secrets: readonly string[], reviewLink?: ReviewLink): string {
  if (typeof body !== 'string' || !body.trim() || body.length > 16000) held();
  const link = reviewLink === undefined ? undefined : validateReviewLink(reviewLink);
  protect(link ? [body, link.label, link.url] : [body], secrets);
  rejectNativeCapture(body);
  let content = body;
  const marker = provenanceSuffix.exec(content);
  if (marker) {
    const markerStart = content.length - marker[0].length;
    content = content.slice(0, markerStart);
    if (content.includes('Pi notification; session ')) held();
  } else if (link) held();
  if (link) {
    const block = `\n\nReview: ${link.label}\n${link.url}`;
    if (!content.endsWith(block)) held();
    content = content.slice(0, -block.length);
  }
  safeText(content, 16000, true);
  if (!content.trim()) held();
  return body;
}
export function prepareBody(text: unknown, session: string, revision: string, secrets: readonly string[], reviewLink?: ReviewLink): string {
  const source = safeText(text, 16000, true);
  if (!source.trim() || !sessionPattern.test(session) || !revisionPattern.test(revision)
      || source.includes('Pi notification; session ')) held();
  const link = reviewLink === undefined ? undefined : validateReviewLink(reviewLink);
  protect(link ? [source, session, revision, link.label, link.url] : [source, session, revision], secrets);
  rejectNativeCapture(source);
  const block = link ? `\n\nReview: ${link.label}\n${link.url}` : '';
  return safeBody(`${source}${block}\n\nPi notification; session ${session}; revision ${revision}`, secrets, link);
}
/** Bounded strict JSON scanner: catches duplicate object keys before JSON.parse. */
export function strictJson(text: string): any {
  let at = 0;
  const ws = () => { while (/\s/.test(text[at] ?? '') && at < text.length) at++; };
  const string = (): string => {
    if (text[at++] !== '"') held();
    const start = at - 1;
    while (at < text.length) {
      const c = text[at++];
      if (c === '"') return JSON.parse(text.slice(start, at));
      if (c === '\\') at++;
      else if (c.charCodeAt(0) < 32) held();
    }
    return held();
  };
  const value = (depth: number): void => {
    if (depth > 32) held();
    ws();
    if (text[at] === '"') { string(); return; }
    if (text[at] === '{') {
      at++; ws(); const keys = new Set<string>();
      if (text[at] === '}') { at++; return; }
      for (;;) {
        ws(); const key = string(); if (keys.has(key)) held(); keys.add(key);
        ws(); if (text[at++] !== ':') held(); value(depth + 1); ws();
        const end = text[at++]; if (end === '}') return; if (end !== ',') held();
      }
    }
    if (text[at] === '[') {
      at++; ws(); if (text[at] === ']') { at++; return; }
      for (;;) { value(depth + 1); ws(); const end = text[at++]; if (end === ']') return; if (end !== ',') held(); }
    }
    const primitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));
    if (!primitive) held(); at += primitive[0].length;
  };
  value(0); ws(); if (at !== text.length) held();
  const result = JSON.parse(text);
  const finite = (v: any): void => {
    if (typeof v === 'number' && !Number.isFinite(v)) held();
    if (v && typeof v === 'object') Object.values(v).forEach(finite);
  };
  finite(result); return result;
}
