/** Bounded operator-only continuation evidence. No discovery, environment fallback,
 * legacy execution, inferred causal tuples, replay, or general event feed. */
import * as fs from 'node:fs';
import { canonicalDirectoryPath, canonicalPath, pinnedBase, privateBytes, utf8 } from './config.ts';
import { digest, exact, held, keyPattern, revisionPattern, sessionPattern, strictJson, prepareBody, protect, validateReviewLink } from './safety.ts';
import { loadProfile, profileSecrets } from './profile.ts';
import { validateTelegramCredentials } from './telegram.ts';
import { privateFile, privateParent, syncParent } from './storage.ts';
import type { DeliveryIdentity } from './types.ts';
export class AdoptionHeld extends Error {
  constructor(reason: 'legacy_exact_key' | 'one_item_mismatch') { super('continuation_' + reason); }
}
export interface AdoptionContext { text: string; project_root: string; session_id: string; inbox_base_url: string; profile_sha256: string; review_link?: unknown }
interface Binding { path: string; sha256: string }
export interface AdoptionEvidence {
  format: 'opaque-json-v1-one-current-intent';
  source: Binding; archive: Binding; material: Binding; profile: Binding; operator_spec: Binding;
  opaque_receipt_count: number; destination_sha256: string; pair_sha256: string; intent_sha256: string;
  legacy_unknown_attempts: 'unavailable'; legacy_volatile_cache: 'unavailable';
}
export function exclusivePrivateWrite(filename: string, bytes: Uint8Array): void {
  canonicalPath(filename, false); privateParent(filename);
  const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncParent(filename);
}
/** Exact hash-bound configured launcher's literal format, including Python's
 * universal-newline translation. Comments/export/quotes/expansion are NOT dotenv syntax here. */
export function parseLegacyEnv(bytes: Uint8Array): readonly [string, string] {
  // The shared decoder consumes a leading UTF-8 BOM; the literal launcher does not.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) held();
  const pairs = new Map<string,string>();
  const lines = utf8(bytes).replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    const eq = line.indexOf('='), key = line.slice(0,eq), value = line.slice(eq+1);
    if (eq < 0 || !['TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID'].includes(key) || pairs.has(key)) held();
    pairs.set(key,value);
  }
  const token = pairs.get('TELEGRAM_BOT_TOKEN'), chat = pairs.get('TELEGRAM_CHAT_ID');
  if (pairs.size !== 2 || !token || !chat || !/^[0-9]+:[A-Za-z0-9_-]+$(?![\s\S])/.test(token)
      || !/^[1-9][0-9]*$(?![\s\S])/.test(chat)) held();
  return [token,chat];
}
export const legacyPairCommitment = (token: string, chat: string): string => digest('pi-dstack-existing-env-pair-v1\0' + token + '\0' + chat);
export const legacyDestination = (token: string, chat: string): string => digest(token + '\0' + chat);
export function opaqueReceipts(bytes: Uint8Array): Record<string, {at:number;message_id:number}> {
  const doc = strictJson(utf8(bytes)); exact(doc,['version','requests']);
  if (doc.version !== 1 || !doc.requests || typeof doc.requests !== 'object' || Array.isArray(doc.requests)) held();
  for (const [key,row] of Object.entries(doc.requests) as [string,any][]) {
    if (!/^[0-9a-f]{64}$(?![\s\S])/.test(key)) held();
    exact(row,['at','message_id']);
    if (!Number.isSafeInteger(row.at) || row.at < 0 || !Number.isSafeInteger(row.message_id) || row.message_id <= 0) held();
  }
  return doc.requests;
}
function intentDigest(id: DeliveryIdentity, context: AdoptionContext): string {
  return digest(JSON.stringify([id.profile_id,id.destination_id,id.decision_key,id.event_revision,id.purpose,
    context.text,context.project_root,context.session_id,context.inbox_base_url,context.profile_sha256,context.review_link ?? null]));
}
function bound(filename: string, expected: string): Buffer {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$(?![\s\S])/.test(expected)) held();
  privateParent(filename);
  const bytes = privateBytes(filename); if (digest(bytes) !== expected) held(); return bytes;
}
/** Called only INSIDE the same exclusive administration lock, before SQLite.
 * Original inputs stay untouched; every produced file is exclusive/no-overwrite. */
export function prepareAdoption(filename: string, specPath: string): AdoptionEvidence {
  privateParent(specPath);
  const specBytes = privateBytes(specPath), s = strictJson(utf8(specBytes));
  exact(s,['version','origin','current_request','selected_source_commit','env_path','env_sha256','pair_sha256','legacy_path','legacy_sha256','profile_path','profile_id','destination_id','intent']);
  if (s.version !== 1 || s.origin !== 'owner-current-one-new-setup-acceptance'
      || typeof s.selected_source_commit !== 'string' || !/^[a-f0-9]{40}$(?![\s\S])/.test(s.selected_source_commit)
      || typeof s.current_request !== 'string' || !s.current_request.trim() || s.current_request.length > 1024) held();
  privateFile(s.env_path);
  const material = bound(s.env_path,s.env_sha256), archive = bound(s.legacy_path,s.legacy_sha256);
  const receipts = opaqueReceipts(archive), [token,chat] = parseLegacyEnv(material);
  validateTelegramCredentials([token,chat]);
  if (legacyPairCommitment(token,chat) !== s.pair_sha256) held();
  for (const output of [s.profile_path,filename + '.opaque-json-v1.archive']) {
    canonicalPath(output,false); privateParent(output);
    try { fs.lstatSync(output); held(); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
  const destination = legacyDestination(token,chat), i = s.intent;
  exact(i,Object.hasOwn(i,'review_link') ? ['text','decision_key','revision','project_root','session_id','inbox_base_url','review_link']
    : ['text','decision_key','revision','project_root','session_id','inbox_base_url']);
  if (typeof i.text !== 'string' || !i.text.trim() || i.text.length > 16000 || typeof i.decision_key !== 'string'
      || !keyPattern.test(i.decision_key) || typeof i.revision !== 'string' || !revisionPattern.test(i.revision)
      || typeof i.session_id !== 'string' || !sessionPattern.test(i.session_id)) held();
  canonicalDirectoryPath(i.project_root); pinnedBase(i.inbox_base_url);
  const review_link = Object.hasOwn(i,'review_link') ? validateReviewLink(i.review_link) : undefined;
  const context = { text:i.text,project_root:i.project_root,session_id:i.session_id,inbox_base_url:i.inbox_base_url,...(review_link?{review_link}:{}) };
  prepareBody(i.text,i.session_id,i.revision,[token,chat],review_link);
  protect([s.profile_id,s.destination_id,s.current_request,i.decision_key,i.revision,i.project_root,i.session_id,i.inbox_base_url],[token,chat]);
  if (Object.hasOwn(receipts,digest(destination + '\0' + i.decision_key))) throw new AdoptionHeld('legacy_exact_key');
  // Validate IDs with the SAME profile loader; artifacts remain on ANY failure.
  const profileText = `[safety]\ntelegram_enabled = true\ntelegram_bot_token = ${JSON.stringify(token)}\ntelegram_chat_id = ${JSON.stringify(chat)}\n[notification_profile]\nprofile_id = ${JSON.stringify(s.profile_id)}\ndestination_id = ${JSON.stringify(s.destination_id)}\n`;
  exclusivePrivateWrite(s.profile_path,Buffer.from(profileText));
  const profile = loadProfile(s.profile_path);
  const archivePath = filename + '.opaque-json-v1.archive';
  exclusivePrivateWrite(archivePath,archive);
  const evidence: AdoptionEvidence = { format:'opaque-json-v1-one-current-intent',
    source:{path:s.legacy_path,sha256:s.legacy_sha256},archive:{path:archivePath,sha256:digest(archive)},
    material:{path:s.env_path,sha256:s.env_sha256},profile:{path:s.profile_path,sha256:profile.fingerprint},
    operator_spec:{path:specPath,sha256:digest(specBytes)},opaque_receipt_count:Object.keys(receipts).length,
    destination_sha256:destination,pair_sha256:s.pair_sha256,intent_sha256:intentDigest({profile_id:profile.profile_id,destination_id:profile.destination_id,
      decision_key:i.decision_key,event_revision:i.revision,purpose:'explicit_attention'},{...context,profile_sha256:profile.fingerprint}),
    legacy_unknown_attempts:'unavailable',legacy_volatile_cache:'unavailable' };
  validateAdoption(evidence); return evidence;
}
export function validateAdoption(e: AdoptionEvidence): void {
  exact(e,['format','source','archive','material','profile','operator_spec','opaque_receipt_count','destination_sha256','pair_sha256','intent_sha256','legacy_unknown_attempts','legacy_volatile_cache']);
  if (e.format !== 'opaque-json-v1-one-current-intent' || e.legacy_unknown_attempts !== 'unavailable'
      || e.legacy_volatile_cache !== 'unavailable' || !Number.isSafeInteger(e.opaque_receipt_count) || e.opaque_receipt_count < 0
      || !/^[a-f0-9]{64}$(?![\s\S])/.test(e.destination_sha256) || !/^[a-f0-9]{64}$(?![\s\S])/.test(e.intent_sha256)) held();
  for (const b of [e.source,e.archive,e.material,e.profile,e.operator_spec]) { exact(b,['path','sha256']); bound(b.path,b.sha256); }
  if (e.source.sha256 !== e.archive.sha256 || Object.keys(opaqueReceipts(bound(e.archive.path,e.archive.sha256))).length !== e.opaque_receipt_count) held();
  const [token,chat] = parseLegacyEnv(bound(e.material.path,e.material.sha256));
  const profile = loadProfile(e.profile.path), pair = profileSecrets(profile);
  privateFile(e.material.path);
  if (pair[0] !== token || pair[1] !== chat || legacyDestination(token,chat) !== e.destination_sha256
      || legacyPairCommitment(token,chat) !== e.pair_sha256) held();
}
/** SAME claim boundary, including direct callers. Absence of context cannot
 * authorize a send; FYIP/owner/reminder/future work have no positive origin here. */
export function admitAdoption(e: AdoptionEvidence, id: DeliveryIdentity, context?: AdoptionContext): void {
  validateAdoption(e);
  const receipts = opaqueReceipts(bound(e.archive.path,e.archive.sha256));
  if (Object.hasOwn(receipts,digest(e.destination_sha256 + '\0' + id.decision_key))) throw new AdoptionHeld('legacy_exact_key');
  if (!context || id.purpose !== 'explicit_attention' || intentDigest(id,context) !== e.intent_sha256) throw new AdoptionHeld('one_item_mismatch');
}
