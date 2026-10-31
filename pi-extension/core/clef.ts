import * as https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { privateBytes, utf8 } from './config.ts';
import { digest, exact, held, protectScalars, strictJson, protectOutboundScalars } from './safety.ts';
import { CLEF_QUESTION } from './clef-question.ts';
import { validateClefChoice } from './clef-choice.ts';
import type { ClassificationContext, ClassifierObservation } from './fyip.ts';

export interface TestClefHttpClient { readonly mode: 'test-clef-http-only'; readonly requests: readonly unknown[] }
export type TestClefOutcome = 'yes'|'no'|'low-confidence-no'|'invalid'|'error'|'redirect'|'duplicate-json'|'nonfinite'|'invalid-utf8'|'valid-utf8'|'oversized'|'max-size'|'deep-json'|'late';
type FakeState = { outcome: TestClefOutcome; requests: unknown[]; responses: Uint8Array[]; pending?: () => void; waiters: (() => void)[] };
const fakes = new WeakMap<object, FakeState>();
export function createTestClefHttpClient(options: { outcome?: TestClefOutcome } = {}): TestClefHttpClient {
  exact(options, Object.hasOwn(options,'outcome') ? ['outcome'] : []);
  const outcome = options.outcome ?? 'yes';
  if (!['yes','no','low-confidence-no','invalid','error','redirect','duplicate-json','nonfinite','invalid-utf8','valid-utf8','oversized','max-size','deep-json','late'].includes(outcome)) held();
  const state: FakeState = { outcome, requests: [], responses: [], waiters: [] };
  const client = Object.freeze({ mode: 'test-clef-http-only' as const, get requests() { return structuredClone(state.requests); } });
  fakes.set(client,state); return client;
}
export function isTestClefHttpClient(value: unknown): value is TestClefHttpClient {
  return typeof value === 'object' && value !== null && fakes.has(value);
}
/** Copies of closed canned response bytes, for isolated boundary counterfactuals.
 * No response/payload/host callback or arbitrary bytes can be injected. */
export function testClefResponseBytes(client: TestClefHttpClient): readonly Uint8Array[] {
  const state = fakes.get(client) ?? held(); return state.responses.map(bytes => Uint8Array.from(bytes));
}
export function waitForTestClefRequest(client: TestClefHttpClient): Promise<void> {
  const state = fakes.get(client) ?? held();
  return state.requests.length ? Promise.resolve() : new Promise(resolve => state.waiters.push(resolve));
}
export function completeLateTestClef(client: TestClefHttpClient): void {
  const state = fakes.get(client) ?? held(); const pending = state.pending; state.pending = undefined; pending?.();
}
export interface ClefConfiguration {
  readonly origin: string; readonly model: string; readonly expected_model: string;
  readonly timeout_ms: number; readonly fingerprint: string; readonly key: string;
}
/** Explicit PRIVATE operator configuration, independent of public project policy. */
export function loadClefConfiguration(filename?: string | null): ClefConfiguration | null {
  if (filename == null) return null;
  const bytes = privateBytes(filename), doc = strictJson(utf8(bytes));
  exact(doc,['version','base_url','key_file','model','expected_model','timeout_seconds']);
  if (doc.version !== 1 || typeof doc.base_url !== 'string' || doc.base_url.length > 2048
      || !/^https:\/\/[A-Za-z0-9.:[\]-]+(?::[0-9]+)?$(?![\s\S])/.test(doc.base_url)) held();
  const base = new URL(doc.base_url);
  if (base.protocol !== 'https:' || !base.hostname || base.username || base.password || base.pathname !== '/' || base.search || base.hash) held();
  for (const field of ['model','expected_model']) if (typeof doc[field] !== 'string' || !/^[A-Za-z0-9_./:-]{1,200}$(?![\s\S])/.test(doc[field])) held();
  if (typeof doc.timeout_seconds !== 'number' || !Number.isFinite(doc.timeout_seconds) || doc.timeout_seconds <= 0 || doc.timeout_seconds > 5) held();
  const keyBytes = privateBytes(doc.key_file);
  if (!keyBytes.length || keyBytes.length > 4096) held();
  const key = utf8(keyBytes).trim();
  if (key.length < 12 || key.length > 4096 || /[^\x21-\x7e]/.test(key)) held();
  return Object.freeze({ origin: base.origin, model: doc.model, expected_model: doc.expected_model,
    timeout_ms: doc.timeout_seconds * 1000, key, fingerprint: digest(Buffer.concat([bytes,Buffer.from([0]),keyBytes])) });
}
export function curatedDisplay(context: ClassificationContext): string {
  return [context.title, context.current_state, context.materiality, ...context.evidence.map(e => e.detail)].join('\n\n');
}
export function clefPayload(context: ClassificationContext, model: string) {
  const display = curatedDisplay(context);
  return { model, state: { task_context: context.title + '\n' + context.materiality,
    candidate_text: display, current_public_final: display, previous_public_final: context.previous_state,
    last_published_update: null, attention_state: 'unknown' }, questions: { publish: CLEF_QUESTION } };
}
export const CLEF_QUESTION_SHA256 = digest(JSON.stringify(CLEF_QUESTION));
type Response = { status: number; contentType: string; body: Uint8Array };
function fakeExchange(client: TestClefHttpClient, body: Buffer, model: string): Promise<Response> {
  const state = fakes.get(client) ?? held(); state.requests.push(strictJson(utf8(body)));
  for (const wake of state.waiters.splice(0)) wake();
  const response = (): Response => {
    if (state.outcome === 'error') throw new Error('clef_unavailable');
    const no = state.outcome === 'no' || state.outcome === 'low-confidence-no';
    const value: any = { model, usage: { input_tokens: 100, output_tokens: 0 }, answers: { publish: {
      type: 'choice', choice: no ? 'no' : 'yes', probabilities: { yes: no ? .1 : .9, no: no ? .9 : .1 }, confidence: state.outcome === 'low-confidence-no' ? 0 : .9 } } };
    if (state.outcome === 'invalid') value.answers.publish.choice = 'noul';
    if (state.outcome === 'deep-json') { let child: any = 0; for (let i=0;i<34;i++) child = [child]; value.metadata = child; }
    if (state.outcome === 'oversized' || state.outcome === 'max-size') {
      value.metadata = '';
      const baseline = Buffer.byteLength(JSON.stringify(value));
      value.metadata = 'x'.repeat((state.outcome === 'max-size' ? 262144 : 262145) - baseline);
    }
    if (state.outcome === 'valid-utf8') value.metadata = 'Café 日本語';
    if (state.outcome === 'invalid-utf8') value.metadata = 'X';
    let text = JSON.stringify(value);
    if (state.outcome === 'duplicate-json') text = '{"model":"duplicate",' + text.slice(1);
    if (state.outcome === 'nonfinite') text = text.slice(0,-1) + ',"metadata":1e999}';
    let bytes = Buffer.from(text);
    if (state.outcome === 'invalid-utf8') {
      const marker = Buffer.from('"metadata":"');
      const index = bytes.indexOf(marker); if (index < 0) held();
      bytes[index + marker.length] = 255;
    }
    state.responses.push(Uint8Array.from(bytes));
    return { status: state.outcome === 'redirect' ? 302 : 200, contentType: 'application/json', body: bytes };
  };
  if (state.outcome === 'late') return new Promise(resolve => { state.pending = () => resolve(response()); });
  return Promise.resolve().then(response);
}
function realExchange(config: ClefConfiguration, body: Buffer, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve,reject) => {
    let req: ClientRequest | undefined, response: IncomingMessage | undefined, finished = false;
    const cleanup = () => signal.removeEventListener('abort',abort);
    const fail = () => { if (finished) return; finished = true; cleanup(); response?.destroy(); req?.destroy(); reject(new Error('clef_unavailable')); };
    const abort = () => fail();
    try {
      if (signal.aborted) { fail(); return; }
      const base = new URL(config.origin);
      req = https.request({ hostname: base.hostname, port: base.port || 443, method:'POST',path:'/v1/systemone',agent:false,maxHeaderSize:16384,
        headers:{ authorization:'Bearer ' + config.key,'content-type':'application/json; charset=utf-8',accept:'application/json','content-length':String(body.length) } }, incoming => {
        response = incoming; const chunks: Buffer[] = []; let size = 0;
        incoming.on('data',(chunk: Buffer) => { if (finished) return; size += chunk.length; if (size > 262144) { fail(); return; } chunks.push(chunk); });
        incoming.on('error',fail); incoming.on('aborted',fail);
        incoming.on('end',() => { if (finished) return; finished = true; cleanup(); resolve({ status:incoming.statusCode ?? 0,
          contentType:typeof incoming.headers['content-type'] === 'string' ? incoming.headers['content-type'] : '', body:Buffer.concat(chunks,size) }); });
      });
      req.on('error',fail); signal.addEventListener('abort',abort,{once:true});
      if (signal.aborted) { fail(); return; } req.end(body);
    } catch { fail(); }
  });
}
/** Preflight is separate so unsafe payloads cannot become an admitted fallback. */
export function prepareClefPayload(context: ClassificationContext, config: ClefConfiguration | null, secrets: readonly string[]): Buffer {
  const payload = clefPayload(context,config?.model ?? 'test-clef');
  protectOutboundScalars(payload,secrets);
  const body = Buffer.from(JSON.stringify(payload)); if (body.length > 32768) held(); return body;
}
export async function classifyClef(config: ClefConfiguration | null, client: TestClefHttpClient | undefined,
  body: Buffer, signal: AbortSignal, secrets: readonly string[]): Promise<ClassifierObservation> {
  if (signal.aborted) held();
  if (!config && !client) return { kind:'unavailable' };
  const model = config?.expected_model ?? 'test-clef';
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  try {
    const response = await new Promise<Response>((resolve,reject) => {
      let settled = false;
      const finish = (value?: Response) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort',abort);
        if (value) resolve(value); else { controller.abort(); reject(new Error('clef_unavailable')); } };
      abort = () => finish(); timer = setTimeout(() => finish(),config?.timeout_ms ?? 5000);
      signal.addEventListener('abort',abort,{once:true});
      if (signal.aborted) { finish(); return; }
      (client ? fakeExchange(client,body,model) : realExchange(config!,body,controller.signal)).then(v => finish(v),() => finish());
    });
    if (signal.aborted) held();
    if (response.status !== 200 || response.body.byteLength > 262144 || response.contentType.split(';')[0].trim().toLowerCase() !== 'application/json') return {kind:'uncertain'};
    try {
      const value = strictJson(utf8(response.body)); protectScalars(value,secrets);
      const choice = validateClefChoice(value,model); return {kind:'response',value:choice.choice};
    } catch { return {kind:'response',value:'invalid'}; }
  } catch { if (signal.aborted) held(); return {kind:'error'}; }
  finally { clearTimeout(timer); signal.removeEventListener('abort',abort); }
}
