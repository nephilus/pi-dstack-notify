import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { deniedAttempts } from '../adapter/deny-runtime.ts';
import { argument, fixture, receiptOf } from './fixture.ts';

after(() => assert.deepEqual(deniedAttempts, []));

for (const hostError of [undefined, false]) test(`built-in nested native payload succeeds with host isError=${hostError}`, async t => {
  const h = fixture(t, 'echo', { minimal: true });
  h.state.hostOutcome = (_stage, outcome) => {
    assert.ok(outcome.result.structuredContent.content);
    assert.ok(outcome.result.structuredContent.structuredContent);
    if (hostError === undefined) delete outcome.result.isError;
    else outcome.result.isError = hostError;
    // Wrong/secret model-facing presentation must never be the native payload.
    outcome.result.content = [{ type: 'text', text: 'synthetic-credential' }];
    return outcome;
  };
  const result = receiptOf(await h.invoke());
  assert.equal(result.state, 'sent');
  assert.equal(JSON.stringify(result).includes('synthetic-credential'), false);
  assert.equal(h.rows('canonical_associations')[0].read_verified, 1);
});

type Mutation = { name: string; stage?: 'send' | 'read'; host?: (o: any) => any; native?: (r: any) => void };
const cases: Mutation[] = [
  ...[undefined, true, null, 'false', 0].map(value => ({ name: `outer error ${String(value)}`, host: (o: any) => ({ ...o, isError: value }) })),
  ...[true, null, 'true', 'false', 0].map(value => ({ name: `host error ${String(value)}`, host: (o: any) => { o.result.isError = value; return o; } })),
  ...[undefined, null, [], 'native'].map(value => ({ name: `nested payload ${JSON.stringify(value)}`, host: (o: any) => { o.result.structuredContent = value; return o; } })),
  { name: 'host result missing', host: o => { delete o.result; return o; } },
  { name: 'host result array', host: o => ({ ...o, result: [] }) },
  { name: 'direct native wrong layer', host: o => ({ ...o, result: o.result.structuredContent }) },
  { name: 'inner fields wrong layer', host: o => { o.result.structuredContent = o.result.structuredContent.structuredContent; return o; } },
  { name: 'after hook dropped payload', host: o => { delete o.result.structuredContent; return o; } },
  ...[true, null, 'false'].map(value => ({ name: `native error ${String(value)}`, native: (r: any) => { r.isError = value; } })),
  { name: 'content omitted', native: r => { delete r.content; } },
  { name: 'content null', native: r => { r.content = null; } },
  { name: 'content empty', native: r => { r.content = []; } },
  { name: 'content image', native: r => { r.content.push({ type: 'image', data: 'fixture' }); } },
  { name: 'content text not string', native: r => { r.content[0].text = null; } },
  { name: 'native structured omitted', native: r => { delete r.structuredContent; } },
  { name: 'native structured array', native: r => { r.structuredContent = []; } },
  { name: 'native structured null', native: r => { r.structuredContent = null; } },
  { name: 'send message id missing', native: r => { delete r.structuredContent.message_id; } },
  { name: 'send thread id bad', native: r => { r.structuredContent.thread_id = 'msg_invalid'; } },
  { name: 'send id newline', native: r => { r.structuredContent.message_id += '\n'; } },
  { name: 'send root mismatch', native: r => { r.structuredContent.project.root = '/other'; } },
  { name: 'send project id null', native: r => { r.structuredContent.project.id = null; } },
  { name: 'send url mismatch', native: r => { r.structuredContent.url += '/'; } },
  { name: 'send attachments omitted', native: r => { delete r.structuredContent.attachments; } },
  { name: 'send attachments null', native: r => { r.structuredContent.attachments = null; } },
  { name: 'send attachments nonempty', native: r => { r.structuredContent.attachments = [{}]; } },
  { name: 'native secret ignored field', native: r => { r.structuredContent.ignored = 'synthetic-credential'; } },
  { name: 'native secret prose', native: r => { r.content[0].text = 'synthetic-credential'; } },
  { name: 'read content missing', stage: 'read', native: r => { delete r.content; } },
  { name: 'read host error', stage: 'read', host: o => { o.result.isError = true; return o; } },
  { name: 'read thread omitted', stage: 'read', native: r => { delete r.structuredContent.thread; } },
  { name: 'read thread id mismatch', stage: 'read', native: r => { r.structuredContent.thread.thread_id = 'msg_' + 'Z'.repeat(26); } },
  { name: 'read project id mismatch', stage: 'read', native: r => { r.structuredContent.thread.project.id = 'prj_other'; } },
  { name: 'read root mismatch', stage: 'read', native: r => { r.structuredContent.thread.project.root = '/other'; } },
  { name: 'read messages nonarray', stage: 'read', native: r => { r.structuredContent.thread.messages = {}; } },
  { name: 'read unrelated malformed message', stage: 'read', native: r => { r.structuredContent.thread.messages.push(null); } },
  { name: 'read duplicate target', stage: 'read', native: r => { r.structuredContent.thread.messages.push(structuredClone(r.structuredContent.thread.messages[0])); } },
  { name: 'read absent target', stage: 'read', native: r => { r.structuredContent.thread.messages = []; } },
  ...['project_id', 'thread_id', 'body'].map(field => ({ name: `read message ${field} mismatch`, stage: 'read' as const, native: (r: any) => { r.structuredContent.thread.messages[0][field] += 'wrong'; } })),
  ...['kind', 'host', 'session'].map(field => ({ name: `read author ${field} mismatch`, stage: 'read' as const, native: (r: any) => { r.structuredContent.thread.messages[0].author[field] = 'wrong'; } })),
  ...['attachments', 'inline_images'].flatMap(field => [null, [{}], {}].map(value => ({ name: `read ${field} ${JSON.stringify(value)}`, stage: 'read' as const, native: (r: any) => { r.structuredContent.thread.messages[0][field] = value; } }))),
  { name: 'read revision marker altered', stage: 'read', native: r => { r.structuredContent.thread.messages[0].body = r.structuredContent.thread.messages[0].body.replace(/a{64}$/, 'b'.repeat(64)); } },
  { name: 'read url mismatch', stage: 'read', native: r => { r.structuredContent.url += '/'; } },
];
for (const [index, c] of cases.entries()) test(`nested native rejection: ${c.name}; terminal, no retry`, async t => {
  const h = fixture(t, 'echo', { minimal: true });
  const stage = c.stage ?? 'send';
  h.state.mutate = (s, r) => { if (s === stage) c.native?.(r); };
  h.state.hostOutcome = (s, o) => {
    // A host after-hook can report host success despite an inner native error;
    // Core must independently reject that native envelope, not lose its error.
    if (s === stage && c.name.startsWith('native error')) o.result.isError = false;
    return s === stage && c.host ? c.host(o) : o;
  };
  const args = argument('native-wrapper/' + index);
  const result = receiptOf(await h.invoke(args));
  assert.equal(result.state, 'unknown');
  assert.equal(h.telegramHttpClient.messages.length, 0);
  assert.equal(JSON.stringify(result).includes('synthetic-credential'), false);
  assert.equal(h.rows('deliveries')[0].state, 'delivery_unknown');
  const association = h.rows('canonical_associations');
  if (stage === 'read') {
    assert.equal(association.length, 1, 'validated SEND correlation is retained');
    assert.equal(association[0].read_verified, 0);
    assert.equal(result.admission.identity_binding?.status, 'canonical-bound');
  } else assert.equal(association.length, 0, 'unvalidated SEND is not invented correlation');
  const count = h.dispatches.length;
  h.state.mutate = undefined; h.state.hostOutcome = undefined;
  await h.restart();
  assert.equal(receiptOf(await h.invoke(args)).state, 'unknown');
  assert.equal(h.dispatches.length, count, 'no automatic or explicit same-identity replay');
});
