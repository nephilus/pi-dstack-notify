import { held, record, messagePattern, protect, protectScalars, safeBody, safeNativeIdentity } from './safety.ts';
import type { NativeMcpResult, HostObservation, CanonicalTarget, CanonicalSendEvidence, ReviewLink } from './types.ts';
export function structured(result: NativeMcpResult): Record<string, any> {
  if (!record(result) || (result.isError !== undefined && result.isError !== false)
      || !Array.isArray(result.content) || !result.content.length
      || result.content.some(b => !record(b) || b.type !== 'text' || typeof b.text !== 'string')
      || !record(result.structuredContent)) held();
  return result.structuredContent;
}
export function sentIds(result: NativeMcpResult, secrets: readonly string[]): { message_id: string; thread_id: string } {
  const sent = structured(result);
  const mid = sent.message_id, tid = sent.thread_id;
  if (typeof mid !== 'string' || !messagePattern.test(mid) || typeof tid !== 'string' || !messagePattern.test(tid)) held();
  protect([mid, tid], secrets);
  return { message_id: mid, thread_id: tid };
}
/** Validated native send correlation is durable even if full read later fails.
 * Native messages carry no independent event key/revision; those remain assertions.
 */
export function sendEvidence(result: NativeMcpResult, observed: HostObservation, base: string,
  secrets: readonly string[]): CanonicalSendEvidence {
  protectScalars(result, secrets);
  const sent = structured(result), ids = sentIds(result, secrets);
  if (!record(sent.project) || typeof sent.project.id !== 'string' || !sent.project.id
      || sent.project.id.length > 256 || sent.project.root !== observed.project_path
      || sent.url !== base + '#thread=' + ids.thread_id
      || !Array.isArray(sent.attachments) || sent.attachments.length) held();
  safeNativeIdentity(sent.project.id); safeNativeIdentity(sent.project.root, 16000);
  const authority = new URL(base).origin;
  protect([authority, sent.project.id, sent.project.root, observed.session_id, ids.message_id, ids.thread_id], secrets);
  return { authority, ...ids, native_project_id: sent.project.id,
    project_root: sent.project.root, session_id: observed.session_id };
}
/** Independently validate a stored ORIGINAL, using its original author/session,
 * not the current invocation. No fabricated send result or native owner auth. */
export function verifyStoredOriginalRead(readResult:NativeMcpResult,target:CanonicalTarget,body:string,
  secrets:readonly string[],reviewLink?:ReviewLink):CanonicalTarget {
  protectScalars(readResult,secrets);protectScalars(target,secrets);safeBody(body,secrets,reviewLink);
  const read=structured(readResult),thread=read.thread;
  if(!body.endsWith(`\n\nPi notification; session ${target.session_id}; revision ${target.revision}`)
      ||body.split('Pi notification; session ').length!==2
      ||target.revision_semantics!==(target.revision.length===40?'git-sha1':'content-sha256')
      ||!record(thread)||!record(thread.project)||thread.project.id!==target.project_id
      ||thread.project.root!==target.project_root||thread.thread_id!==target.thread_id
      ||read.url!==target.url||!target.url.endsWith('#thread='+target.thread_id)
      ||!Array.isArray(thread.messages)||thread.messages.some(m=>!record(m)))held();
  safeNativeIdentity(target.project_id);safeNativeIdentity(target.project_root,16000);
  if(!messagePattern.test(target.message_id)||!messagePattern.test(target.thread_id))held();
  const matches=thread.messages.filter(m=>m.id===target.message_id);if(matches.length!==1)held();
  const m=matches[0];
  if(m.project_id!==target.project_id||m.thread_id!==target.thread_id||m.body!==body
      ||!record(m.author)||m.author.kind!=='agent'||m.author.host!=='pi'||m.author.session!==target.session_id
      ||!Array.isArray(m.attachments??[])||(m.attachments??[]).length||m.attachments===null
      ||!Array.isArray(m.inline_images??[])||(m.inline_images??[]).length||m.inline_images===null)held();
  return {...target};
}
export function verifyReadback(sentResult: NativeMcpResult, readResult: NativeMcpResult,
  expected: { observed: HostObservation; body: string; revision: string; base: string; review_link?: ReviewLink },
  secrets: readonly string[]): CanonicalTarget {
  protectScalars(sentResult, secrets); protectScalars(readResult, secrets);
  safeBody(expected.body, secrets, expected.review_link);
  const marker = `Pi notification; session ${expected.observed.session_id}; revision ${expected.revision}`;
  if (!expected.body.endsWith('\n\n' + marker) || expected.body.split('Pi notification; session ').length !== 2) held();
  const sent = structured(sentResult), read = structured(readResult);
  const ids = sentIds(sentResult, secrets);
  const project = sent.project, thread = read.thread;
  if (!record(project) || typeof project.id !== 'string' || !project.id || project.id.length > 256
      || project.root !== expected.observed.project_path || !record(thread) || !record(thread.project)
      || thread.project.root !== expected.observed.project_path || thread.project.id !== project.id
      || thread.thread_id !== ids.thread_id || !Array.isArray(thread.messages)
      || thread.messages.some(m => !record(m))) held();
  safeNativeIdentity(project.id); safeNativeIdentity(project.root, 16000);
  safeNativeIdentity(thread.project.id); safeNativeIdentity(thread.project.root, 16000);
  const matches = thread.messages.filter(m => m.id === ids.message_id);
  if (matches.length !== 1) held();
  const m = matches[0];
  if (m.project_id !== project.id || m.thread_id !== ids.thread_id || !record(m.author)
      || m.author.kind !== 'agent' || m.author.host !== 'pi' || m.author.session !== expected.observed.session_id
      || m.body !== expected.body || !Array.isArray(m.attachments ?? []) || (m.attachments ?? []).length
      || !Array.isArray(m.inline_images ?? []) || (m.inline_images ?? []).length
      || !Array.isArray(sent.attachments) || sent.attachments.length) held();
  // Null attachments are not the native absence shape; reject, not coalesce.
  if (m.attachments === null || m.inline_images === null) held();
  safeNativeIdentity(m.project_id);
  const expectedUrl = expected.base + '#thread=' + ids.thread_id;
  if (sent.url !== expectedUrl || read.url !== sent.url) held();
  protect([project.id, project.root, expected.observed.session_id, ids.message_id, ids.thread_id, read.url, expected.revision], secrets);
  const target:CanonicalTarget={ project_id: project.id, project_root: project.root, session_id: expected.observed.session_id,
    ...ids, revision: expected.revision, revision_semantics: expected.revision.length === 40 ? 'git-sha1' : 'content-sha256',
    url: read.url };
  return verifyStoredOriginalRead(readResult,target,expected.body,secrets,expected.review_link);
}
