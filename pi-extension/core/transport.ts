import { held, record, exact, strictJson } from './safety.ts';
import type { TelegramEntity, TelegramMessage, TestTelegramHttpClient, TestTelegramRequestRecord, TestTelegramTransport } from './types.ts';
export type TestTelegramOutcome = 'echo' | 'unknown' | 'malformed' | 'wrong-chat' | 'wrong-text'
  | 'extra-entity' | 'duplicate-entity' | 'bad-entity-boundary' | 'bad-message-id' | 'missing-entities'
  | 'redirect' | 'bad-status' | 'oversized' | 'invalid-utf8' | 'duplicate-json' | 'deep-json' | 'late'
  | 'max-size' | 'valid-utf8' | 'max-depth';
export interface InternalTelegramHttpRequest {
  hostname: 'api.telegram.org'; port: 443; method: 'POST'; path: string;
  headers: Readonly<Record<string, string>>; body: Uint8Array; deadlineMs: 10000;
}
export interface InternalTelegramHttpResponse {
  statusCode: number; headers: Readonly<Record<string, string>>; body: Uint8Array;
}
type TransportState = { messages: TelegramMessage[]; outcome: 'echo' | 'unknown' | 'malformed' };
type HttpState = { messages: TelegramMessage[]; requests: TestTelegramRequestRecord[]; outcome: TestTelegramOutcome;
  pending?: () => void; waiters: Array<() => void> };
const transports = new WeakMap<object, TransportState>();
const httpClients = new WeakMap<object, HttpState>();
const tokenPath = /^\/bot[1-9][0-9]{4,19}:[A-Za-z0-9_-]{20,128}\/sendMessage$/;
const jsonHeaders = Object.freeze({ 'content-type': 'application/json; charset=utf-8' });
function requestPayload(request: InternalTelegramHttpRequest): { chat_id: number; message: TelegramMessage } {
  if (request.hostname !== 'api.telegram.org' || request.port !== 443 || request.method !== 'POST'
      || !tokenPath.test(request.path) || request.deadlineMs !== 10000
      || request.headers['content-type'] !== 'application/json; charset=utf-8') held();
  const payload = strictJson(new TextDecoder('utf-8', { fatal: true }).decode(request.body));
  exact(payload, ['chat_id', 'text', 'entities', 'disable_notification', 'link_preview_options']);
  exact(payload.link_preview_options, ['is_disabled']);
  if (!Number.isSafeInteger(payload.chat_id) || !payload.chat_id || Math.abs(payload.chat_id) > 2 ** 52 - 1
      || typeof payload.text !== 'string' || !Array.isArray(payload.entities)
      || payload.disable_notification !== false || payload.link_preview_options.is_disabled !== true) held();
  return { chat_id: payload.chat_id, message: { text: payload.text, entities: payload.entities as TelegramEntity[],
    disable_notification: false, link_preview_options: { is_disabled: true } } };
}
function encodedResponse(value: unknown): InternalTelegramHttpResponse {
  return { statusCode: 200, headers: jsonHeaders, body: Buffer.from(JSON.stringify(value), 'utf8') };
}
function responseFor(state: HttpState, request: InternalTelegramHttpRequest, parsed: { chat_id: number; message: TelegramMessage }): InternalTelegramHttpResponse {
  const id = state.messages.length;
  const result: any = { message_id: id, chat: { id: parsed.chat_id }, text: parsed.message.text,
    entities: structuredClone(parsed.message.entities) };
  if (state.outcome === 'unknown') return { statusCode: 503, headers: jsonHeaders, body: Buffer.from('{"ok":false}', 'utf8') };
  if (state.outcome === 'wrong-chat') result.chat.id += 1;
  if (state.outcome === 'wrong-text') result.text += ' changed';
  if (state.outcome === 'extra-entity') result.entities.push({ type: 'url', offset: 0, length: 1, url: 'https://other.example.invalid/' });
  if (state.outcome === 'duplicate-entity' && result.entities.length) result.entities.push(structuredClone(result.entities[0]));
  if (state.outcome === 'bad-entity-boundary') result.entities.push({ type: 'text_link', offset: 0, length: parsed.message.text.length + 1, url: parsed.message.text });
  if (state.outcome === 'bad-message-id') result.message_id = 0;
  if (state.outcome === 'missing-entities') delete result.entities;
  if (state.outcome === 'deep-json' || state.outcome === 'max-depth') {
    // Envelope depth 0, result 1, metadata 2; leaf reaches exactly 32 or 33.
    let metadata: unknown = 0;
    for (let i = 0; i < (state.outcome === 'max-depth' ? 30 : 31); i++) metadata = [metadata];
    result.metadata = metadata;
  }
  if (state.outcome === 'redirect') return { statusCode: 302, headers: { location: 'https://redirect.example.invalid/' }, body: Buffer.alloc(0) };
  if (state.outcome === 'bad-status') return { statusCode: 400, headers: jsonHeaders, body: Buffer.from('{"ok":false}', 'utf8') };
  if (state.outcome === 'oversized' || state.outcome === 'max-size') {
    result.metadata = '';
    const baseline = encodedResponse({ ok: true, result }).body.byteLength;
    const size = state.outcome === 'max-size' ? 65536 : 65537;
    if (baseline > size) held();
    result.metadata = 'x'.repeat(size - baseline);
  }
  if (state.outcome === 'valid-utf8') result.metadata = 'Café 日本語';
  if (state.outcome === 'invalid-utf8') {
    // Nonfatal replacement decoding still yields an otherwise valid confirmation.
    result.metadata = 'X';
    const response = encodedResponse({ ok: true, result });
    const body = Buffer.from(response.body);
    const marker = Buffer.from('"metadata":"');
    const index = body.indexOf(marker);
    if (index < 0) held();
    body[index + marker.length] = 0xff;
    return { ...response, body };
  }
  if (state.outcome === 'duplicate-json') {
    const valid = JSON.stringify({ ok: true, result });
    return { statusCode: 200, headers: jsonHeaders,
      body: Buffer.from('{"ok":true,' + valid.slice(1), 'utf8') };
  }
  if (state.outcome === 'malformed') return { statusCode: 200, headers: jsonHeaders, body: Buffer.from('{"ok":true,"result":', 'utf8') };
  return encodedResponse({ ok: true, result });
}
function recordRequest(state: HttpState, request: InternalTelegramHttpRequest, parsed: { chat_id: number; message: TelegramMessage }): void {
  state.messages.push(structuredClone(parsed.message));
  state.requests.push(Object.freeze({ origin: 'https://api.telegram.org', method: 'POST',
    endpoint: '/bot[redacted]/sendMessage', body_bytes: request.body.byteLength,
    chat_id: parsed.chat_id, message: structuredClone(parsed.message), deadline_ms: request.deadlineMs }));
  for (const wake of state.waiters.splice(0)) wake();
}
/** A branded, closed HTTP fake. It accepts no callback, host, token or URL option. */
export function createTestTelegramHttpClient(options: { outcome?: TestTelegramOutcome } = {}): TestTelegramHttpClient {
  const outcome = options.outcome ?? 'echo';
  const outcomes: TestTelegramOutcome[] = ['echo', 'unknown', 'malformed', 'wrong-chat', 'wrong-text',
    'extra-entity', 'duplicate-entity', 'bad-entity-boundary', 'bad-message-id', 'missing-entities',
    'redirect', 'bad-status', 'oversized', 'invalid-utf8', 'duplicate-json', 'deep-json', 'late',
    'max-size', 'valid-utf8', 'max-depth'];
  if (!outcomes.includes(outcome)) held();
  const state: HttpState = { messages: [], requests: [], outcome, waiters: [] };
  const client = Object.freeze({ mode: 'test-http-only' as const,
    get messages() { return structuredClone(state.messages); },
    get requests() { return structuredClone(state.requests); } });
  httpClients.set(client, state); return client;
}
export function isTestTelegramHttpClient(value: unknown): value is TestTelegramHttpClient {
  return typeof value === 'object' && value !== null && httpClients.has(value);
}
/** Internal dispatch keeps fake calls on the same serialized HTTP path as production. */
export function dispatchTestTelegramHttp(client: TestTelegramHttpClient, request: InternalTelegramHttpRequest,
  signal: AbortSignal): Promise<InternalTelegramHttpResponse> {
  const state = httpClients.get(client) ?? held();
  if (signal.aborted) return Promise.reject(new Error('fake_request_aborted'));
  const parsed = requestPayload(request); recordRequest(state, request, parsed);
  if (state.outcome === 'late') return new Promise(resolve => { state.pending = () => resolve(responseFor(state, request, parsed)); });
  return Promise.resolve(responseFor(state, request, parsed));
}
/** Test-only late completion hook; exercising it after abort must never confirm. */
export function waitForTestTelegramHttpRequest(client: TestTelegramHttpClient): Promise<void> {
  const state = httpClients.get(client) ?? held();
  if (state.requests.length) return Promise.resolve();
  return new Promise(resolve => state.waiters.push(resolve));
}
export function completeLateTestTelegramHttp(client: TestTelegramHttpClient): void {
  const state = httpClients.get(client) ?? held();
  const pending = state.pending; state.pending = undefined; pending?.();
}
/** Offline-only legacy fake retained for adapters; no arbitrary callback, socket, URL or credentials. */
export function createTestTelegramTransport(options: { outcome?: 'echo' | 'unknown' | 'malformed' } = {}): TestTelegramTransport {
  const outcome = options.outcome ?? 'echo';
  if (!['echo', 'unknown', 'malformed'].includes(outcome)) held();
  const state = { messages: [] as TelegramMessage[], outcome };
  const transport = Object.freeze({ mode: 'test-only' as const,
    get messages() { return structuredClone(state.messages); } });
  transports.set(transport, state); return transport;
}
export function isTestTransport(value: unknown): value is TestTelegramTransport {
  return typeof value === 'object' && value !== null && transports.has(value);
}
/** Module-internal fake adapter; output is reserialized and parsed by production confirmation. */
export function dispatchLegacyTestTelegramTransport(transport: TestTelegramTransport,
  request: InternalTelegramHttpRequest, signal: AbortSignal): Promise<InternalTelegramHttpResponse> {
  const state = transports.get(transport) ?? held();
  if (signal.aborted) return Promise.reject(new Error('fake_request_aborted'));
  const parsed = requestPayload(request); state.messages.push(structuredClone(parsed.message));
  if (state.outcome === 'unknown') return Promise.reject(new Error('synthetic_transport_unknown'));
  const legacyResult: any = state.outcome === 'malformed'
    ? { message_id: 1, text: 'unconfirmed synthetic echo' }
    : { message_id: state.messages.length, text: parsed.message.text, entities: structuredClone(parsed.message.entities) };
  return Promise.resolve(encodedResponse({ ok: true, result: { ...legacyResult, chat: { id: parsed.chat_id } } }));
}
/** Strict one-to-one echo validation used by both real HTTPS and HTTP-fake responses. */
export function confirmed(message: TelegramMessage, response: unknown): number {
  if (!record(response) || !Number.isSafeInteger(response.message_id) || response.message_id <= 0
      || response.message_id > 2 ** 52 - 1 || response.text !== message.text || !Array.isArray(response.entities)) held();
  const keys = (entities: unknown[]): string[] => {
    if (entities.length > 32) held();
    const result: string[] = [];
    const ranges: Array<[number, number]> = [];
    for (const entity of entities) {
      if (!record(entity) || (entity.type !== 'bold' && entity.type !== 'text_link')) held();
      exact(entity, entity.type === 'text_link' ? ['type', 'offset', 'length', 'url'] : ['type', 'offset', 'length']);
      if (!Number.isInteger(entity.offset) || entity.offset < 0 || !Number.isInteger(entity.length)
          || entity.length <= 0 || entity.offset + entity.length > message.text.length
          || splitSurrogate(message.text, entity.offset) || splitSurrogate(message.text, entity.offset + entity.length)) held();
      if (entity.type === 'text_link') {
        if (typeof entity.url !== 'string' || !entity.url
            || message.text.slice(entity.offset, entity.offset + entity.length) !== entity.url) held();
      }
      ranges.push([entity.offset, entity.offset + entity.length]);
      result.push(JSON.stringify([entity.type, entity.offset, entity.length, entity.type === 'text_link' ? entity.url : null]));
    }
    ranges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) held();
    result.sort();
    if (new Set(result).size !== result.length) held();
    return result;
  };
  const expected = keys(message.entities), actual = keys(response.entities);
  if (!expected.length || JSON.stringify(actual) !== JSON.stringify(expected)) held();
  return response.message_id;
}
function splitSurrogate(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const before = text.charCodeAt(index - 1), after = text.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}
