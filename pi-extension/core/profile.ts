import { privateBytes, utf8 } from './config.ts';
import { digest, held } from './safety.ts';
/** Credentials remain in a WeakMap, not enumerable/repr/JSON fields. */
export interface SharedProfile { readonly profile_id: string; readonly destination_id: string; readonly fingerprint: string }
const credentials = new WeakMap<SharedProfile, readonly [string, string]>();
function uncomment(line: string): string {
  let quote = ''; let escape = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (escape) { escape = false; continue; }
    if (quote === '"' && c === '\\') { escape = true; continue; }
    if (quote) { if (c === quote) quote = ''; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '#') return line.slice(0, i).trim();
  }
  return line.trim();
}
/** Audited TOML subset: only these two tables and scalar string/bool/integer.
 * Unsupported TOML is held explicitly; never fallback or mix credential sources.
 */
export function loadProfile(filename: string): SharedProfile {
  const bytes = privateBytes(filename); const sections: Record<string, Record<string, any>> = Object.create(null);
  let table: Record<string, any> | undefined;
  for (const raw of utf8(bytes).split(/\r?\n/)) {
    const line = uncomment(raw); if (!line) continue;
    const header = /^\[(safety|notification_profile)\]$/.exec(line);
    if (header) {
      if (Object.hasOwn(sections, header[1])) held();
      table = Object.create(null); sections[header[1]] = table!; continue;
    }
    const pair = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(line);
    if (!table || !pair || Object.hasOwn(table, pair[1])) held();
    const value = pair[2]; let parsed: any;
    if (/^"(?:[^"\\\x00-\x1f]|\\["\\bfnrt]|\\u[0-9a-fA-F]{4})*"$/.test(value)) parsed = JSON.parse(value);
    else if (/^'[^'\x00-\x1f]*'$/.test(value)) parsed = value.slice(1, -1);
    else if (value === 'true' || value === 'false') parsed = value === 'true';
    else if (/^[+-]?(?:0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value))) parsed = Number(value);
    else held();
    if (typeof parsed === 'string' && /[\ud800-\udfff]/u.test(parsed.replace(/[\u{10000}-\u{10ffff}]/gu, ''))) held();
    table[pair[1]] = parsed;
  }
  const safety = sections.safety, profile = sections.notification_profile;
  if (!safety || !profile || safety.telegram_enabled !== true) held();
  for (const id of [profile.profile_id, profile.destination_id]) {
    if (typeof id !== 'string' || id.length > 128 || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$(?![\s\S])/.test(id)
        || id.startsWith('test-only.')) held();
  }
  const token = safety.telegram_bot_token;
  const chat = typeof safety.telegram_chat_id === 'number'
    ? (safety.telegram_chat_id ? String(safety.telegram_chat_id) : null) : safety.telegram_chat_id;
  if (typeof token !== 'string' || !token.trim() || typeof chat !== 'string' || !chat.trim()) held();
  const result = Object.freeze({ profile_id: profile.profile_id, destination_id: profile.destination_id,
                                fingerprint: digest(bytes) });
  credentials.set(result, Object.freeze([token, chat]));
  return result;
}
/** Internal seam for gates; no environment/default credential resolution. */
export function profileSecrets(profile: SharedProfile): readonly [string, string] {
  return credentials.get(profile) ?? held();
}
