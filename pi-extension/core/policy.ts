import { fyipLeadingStatus } from './fyip.ts';
import type { ClassificationStatus } from './fyip.ts';
import { normalize, protect, safeBody, safeText, validateReviewLink, held } from './safety.ts';
import type { CanonicalTarget, NotificationReceipt, ReviewLink, TelegramMessage } from './types.ts';
/** Exact accepted explicit-attention policy: no claim that Choice ran. */
export function attentionBypass(): NotificationReceipt['classification'] {
  return { status: 'bypassed', choice: null, bypass_reason: 'explicit_attention' };
}
const STATUS = 'Attention · explicit request · unclassified (classifier bypassed)';
const OWNER_STATUS='Attention · owner request · unclassified (classifier bypassed)';
const REMINDER_STATUS='Attention · unanswered owner reminder · unclassified (classifier bypassed)';
const MAX_TELEGRAM_UNITS = 4096;
const MAX_SUMMARY_UNITS = 1400;
const MAX_SUMMARY_WORDS = 100;
const MAX_NATIVE_ID = 'msg_' + '0'.repeat(26);
function marker(target: CanonicalTarget): string {
  return `Pi notification; session ${target.session_id}; revision ${target.revision}`;
}
function linkBlock(link: ReviewLink): string { return `\n\nReview: ${link.label}\n${link.url}`; }
function scalarPrefix(value: string, units: number): string {
  if (value.length <= units) return value;
  let result = ''; let used = 0;
  for (const scalar of value) {
    const width = scalar.length;
    if (used + width > units) break;
    result += scalar; used += width;
  }
  return result;
}
function summaryText(value: string, maxUnits: number): string {
  const words = [...value.matchAll(/\S+/gu)];
  let source = value; let truncated = false;
  if (words.length > MAX_SUMMARY_WORDS) {
    const last = words[MAX_SUMMARY_WORDS - 1];
    source = value.slice(0, last.index! + last[0].length); truncated = true;
  }
  const cap = Math.min(MAX_SUMMARY_UNITS, maxUnits);
  if (source.length > cap) truncated = true;
  if (!truncated) return source;
  const prefix = scalarPrefix(source, Math.max(0, cap - 1)).trimEnd();
  return prefix + '…';
}
/** Preclaim bound using the exact configured Inbox base and fixed native message-ID grammar. */
export function preflightAttentionBounds(base: string, session: string, revision: string, reviewValue?: ReviewLink, fyipStatus?: ClassificationStatus, ownerRequest=false, reminder=false): void {
  const link = reviewValue === undefined ? undefined : validateReviewLink(reviewValue);
  const url = base + '#thread=' + MAX_NATIVE_ID;
  const lead = (reminder ? REMINDER_STATUS : fyipStatus ? fyipLeadingStatus(fyipStatus) : ownerRequest ? OWNER_STATUS : STATUS) + '\nSource: Pi session ' + session + '\nInbox: ';
  const prefix = lead + url + '\n\n';
  const fixed = prefix.length + (link ? linkBlock(link).length : 0)
    + `\n\nPi notification; session ${session}; revision ${revision}`.length;
  if (fixed >= MAX_TELEGRAM_UNITS) held();
}
/** Render only a fully verified native target; all entities address literal visible URLs. */
export function renderAttention(body: string, target: CanonicalTarget, secrets: readonly string[], reviewValue?: ReviewLink, fyipStatus?: ClassificationStatus, ownerRequest=false, reminder=false): TelegramMessage {
  const link = reviewValue === undefined ? undefined : validateReviewLink(reviewValue);
  protect(link ? [body, target.url, target.session_id, link.label, link.url] : [body, target.url, target.session_id], secrets);
  safeBody(body, secrets, link);
  const markerText = marker(target);
  const markerSuffix = '\n\n' + markerText;
  if (!body.endsWith(markerSuffix)) held();
  let main = body.slice(0, -markerSuffix.length);
  if (link) {
    const suffix = linkBlock(link);
    if (!main.endsWith(suffix)) held();
    main = main.slice(0, -suffix.length);
  }
  let summary = normalize(main)
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\b(password|passwd|api[_ -]?key|(?:access[_ -]?|refresh[_ -]?|bot[_ -]?)?token|secret|authorization)\b(\s*=\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '$1$2[redacted]')
    .replace(/[ \t]+/g, ' ').trim();
  safeText(summary || ' ', 16000, true);
  const lead = (reminder ? REMINDER_STATUS : fyipStatus ? fyipLeadingStatus(fyipStatus) : ownerRequest ? OWNER_STATUS : STATUS) + '\nSource: Pi session ' + target.session_id + '\nInbox: ';
  const prefix = lead + target.url + '\n\n';
  const fixedSuffix = (link ? linkBlock(link) : '') + markerSuffix;
  const available = MAX_TELEGRAM_UNITS - prefix.length - fixedSuffix.length;
  if (available < 1) held();
  summary = summaryText(summary, available);
  let text = prefix + summary;
  const entities: TelegramMessage['entities'] = [{ type: 'text_link', offset: lead.length,
    length: target.url.length, url: target.url }];
  if (link) {
    text += linkBlock(link);
    const urlOffset = text.length - link.url.length;
    entities.push({ type: 'text_link', offset: urlOffset, length: link.url.length, url: link.url });
  }
  text += markerSuffix;
  if (text.length > MAX_TELEGRAM_UNITS) held();
  // Validate visible slices and scalar-safe entity boundaries before transport construction.
  for (const entity of entities) {
    if (entity.type !== 'text_link' || text.slice(entity.offset, entity.offset + entity.length) !== entity.url) held();
  }
  protect(link ? [text, link.label, link.url] : [text], secrets);
  return { text, entities, disable_notification: false, link_preview_options: { is_disabled: true } };
}
