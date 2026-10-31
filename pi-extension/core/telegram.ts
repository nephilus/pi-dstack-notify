import * as https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { held, record, protectScalars, strictJson } from './safety.ts';
import { dispatchLegacyTestTelegramTransport, dispatchTestTelegramHttp, confirmed } from './transport.ts';
import type { InternalTelegramHttpRequest, InternalTelegramHttpResponse } from './transport.ts';
import type { TelegramMessage, TestTelegramHttpClient, TestTelegramTransport } from './types.ts';

export interface TelegramCredentials { readonly token: string; readonly chatId: number }
export type TelegramMode =
  | { readonly kind: 'production'; readonly testOnly: false }
  | { readonly kind: 'http-test'; readonly testOnly: true; readonly client: TestTelegramHttpClient }
  | { readonly kind: 'transport-test'; readonly testOnly: true; readonly client: TestTelegramTransport };
const tokenPattern = /^[1-9][0-9]{4,19}:[A-Za-z0-9_-]{20,128}$(?![\s\S])/;
const chatPattern = /^(?:[1-9][0-9]*|-[1-9][0-9]*)$/;
const MAX_BYTES = 65536;
const DEADLINE_MS = 10000;
const ORIGIN = 'https://api.telegram.org';

/** Validate the exact profile-held token/chat pair before any durable/native effect. */
export function validateTelegramCredentials(values: readonly string[]): TelegramCredentials {
  if (values.length !== 2) held();
  const [token, chat] = values;
  if (typeof token !== 'string' || token.length > 150 || !tokenPattern.test(token)
      || typeof chat !== 'string' || chat.length > 17 || !chatPattern.test(chat)) held();
  const chatId = Number(chat);
  if (!Number.isSafeInteger(chatId) || !chatId || Math.abs(chatId) > 2 ** 52 - 1 || String(chatId) !== chat) held();
  return Object.freeze({ token, chatId });
}

function requestBytes(message: TelegramMessage, chatId: number, secrets: readonly string[]): Buffer {
  if (message.disable_notification !== false || message.link_preview_options?.is_disabled !== true
      || typeof message.text !== 'string' || message.text.length > 4096 || !Array.isArray(message.entities)) held();
  confirmed(message, { message_id: 1, text: message.text, entities: message.entities });
  protectScalars(message, secrets);
  const payload = { chat_id: chatId, text: message.text, entities: message.entities,
    disable_notification: false, link_preview_options: { is_disabled: true } };
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  if (bytes.byteLength > MAX_BYTES) held();
  return bytes;
}

function requestSpec(credentials: TelegramCredentials, message: TelegramMessage, secrets: readonly string[]): InternalTelegramHttpRequest {
  const body = requestBytes(message, credentials.chatId, secrets);
  return Object.freeze({ hostname: 'api.telegram.org', port: 443, method: 'POST',
    path: `/bot${credentials.token}/sendMessage`,
    headers: Object.freeze({ 'content-type': 'application/json; charset=utf-8', accept: 'application/json',
      'content-length': String(body.byteLength) }), body, deadlineMs: DEADLINE_MS });
}

function exchangeHttps(request: InternalTelegramHttpRequest, signal: AbortSignal): Promise<InternalTelegramHttpResponse> {
  return new Promise((resolve, reject) => {
    let req: ClientRequest | undefined;
    let finished = false;
    let response: IncomingMessage | undefined;
    const cleanup = () => signal.removeEventListener('abort', abort);
    const fail = () => {
      if (finished) return;
      finished = true; cleanup();
      try { response?.destroy(); req?.destroy(); } catch { /* Fixed failure below. */ }
      reject(new Error('telegram_delivery_unknown'));
    };
    const abort = () => fail();
    try {
      if (signal.aborted) { fail(); return; }
      req = https.request({ hostname: request.hostname, port: request.port, method: request.method,
        path: request.path, headers: request.headers, agent: false, maxHeaderSize: 16 * 1024 }, incoming => {
        response = incoming;
        const chunks: Buffer[] = []; let size = 0;
        incoming.on('data', (chunk: Buffer | string) => {
          if (finished) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.byteLength;
          if (size > MAX_BYTES) { fail(); return; }
          chunks.push(bytes);
        });
        incoming.on('aborted', fail); incoming.on('error', fail);
        incoming.on('end', () => {
          if (finished) return;
          finished = true; cleanup();
          const contentType = incoming.headers['content-type'];
          resolve({ statusCode: incoming.statusCode ?? 0,
            headers: { 'content-type': typeof contentType === 'string' ? contentType : '' },
            body: Buffer.concat(chunks, size) });
        });
      });
      req.on('error', fail);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { fail(); return; }
      req.end(request.body);
    } catch { fail(); }
  });
}

function boundedExchange(request: InternalTelegramHttpRequest, signal: AbortSignal, mode: TelegramMode): Promise<InternalTelegramHttpResponse> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('telegram_delivery_unknown')); return; }
    const controller = new AbortController(); let settled = false;
    const finish = (error?: unknown, value?: InternalTelegramHttpResponse) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (error !== undefined) { controller.abort(); reject(new Error('telegram_delivery_unknown')); }
      else if (!value || value.body.byteLength > MAX_BYTES) { controller.abort(); reject(new Error('telegram_delivery_unknown')); }
      else resolve(value);
    };
    const abort = () => finish(new Error('aborted'));
    const timer = setTimeout(() => finish(new Error('deadline')), DEADLINE_MS);
    signal.addEventListener('abort', abort, { once: true });
    try {
      const exchange = mode.kind === 'http-test'
        ? dispatchTestTelegramHttp(mode.client, request, controller.signal)
        : mode.kind === 'transport-test'
          ? dispatchLegacyTestTelegramTransport(mode.client, request, controller.signal)
          : exchangeHttps(request, controller.signal);
      Promise.resolve(exchange).then(value => finish(undefined, value), () => finish(new Error('exchange')));
    } catch { finish(new Error('exchange')); }
  });
}

function responseContentType(response: InternalTelegramHttpResponse): boolean {
  const value = response.headers['content-type'];
  return typeof value === 'string' && value.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}
function parseTelegramResponse(response: InternalTelegramHttpResponse, expected: TelegramCredentials,
  message: TelegramMessage, secrets: readonly string[]): number {
  if (response.statusCode !== 200 || response.body.byteLength > MAX_BYTES || !responseContentType(response)) held();
  const text = new TextDecoder('utf-8', { fatal: true }).decode(response.body);
  const envelope = strictJson(text);
  protectScalars(envelope, secrets);
  if (!record(envelope) || Object.keys(envelope).length !== 2 || !Object.hasOwn(envelope, 'ok')
      || !Object.hasOwn(envelope, 'result') || envelope.ok !== true || !record(envelope.result)) held();
  const result = envelope.result;
  if (!Number.isSafeInteger(result.message_id) || result.message_id <= 0 || result.message_id > 2 ** 52 - 1
      || !record(result.chat) || result.chat.id !== expected.chatId) held();
  return confirmed(message, { message_id: result.message_id, text: result.text, entities: result.entities });
}

/** One serialized request and bounded response path for production and branded fakes. */
export async function sendTelegram(message: TelegramMessage, credentials: TelegramCredentials,
  secrets: readonly string[], signal: AbortSignal, mode: TelegramMode): Promise<number> {
  try {
    const request = requestSpec(credentials, message, secrets);
    const response = await boundedExchange(request, signal, mode);
    if (signal.aborted) held();
    return parseTelegramResponse(response, credentials, message, secrets);
  } catch {
    // Never expose Telegram's token-bearing request path, response, or raw cause.
    throw new Error('telegram_delivery_unknown');
  }
}

export function productionTelegramMode(): TelegramMode { return Object.freeze({ kind: 'production', testOnly: false }); }
export function httpTestTelegramMode(client: TestTelegramHttpClient): TelegramMode {
  return Object.freeze({ kind: 'http-test', testOnly: true, client });
}
export function legacyTestTelegramMode(client: TestTelegramTransport): TelegramMode {
  return Object.freeze({ kind: 'transport-test', testOnly: true, client });
}
