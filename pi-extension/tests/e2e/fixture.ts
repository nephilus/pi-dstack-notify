import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import notificationExtension, { createNotificationExtension } from '../../index.ts';
import minimalNotificationExtension, { createMinimalNotificationExtension } from '../../minimal.ts';
import { createTestTelegramHttpClient } from '../../core/transport.ts';
import type { TestTelegramOutcome } from '../../core/transport.ts';
import { createTestClefHttpClient } from '../../core/clef.ts';
import type { TestClefOutcome } from '../../core/clef.ts';
import { createTestOwnerEvidenceProvider } from '../../core/owner-evidence.ts';
import type { ReminderClock } from '../../adapter/reminder-scheduler.ts';
import type { PokeClock } from '../../adapter/poke-controller.ts';
import type { TestOwnerOutcome } from '../../core/owner-evidence.ts';
import { testOwnerNativeFixtures } from '../../core/owner-control.ts';
import { initializeLedgerV2, initializeLedgerV3, migrateLedgerV1ToV2 } from '../../core/migration.ts';
import type { NativeMcpResult, NotificationReceipt, PublishArguments, TestTelegramHttpClient } from '../../core/types.ts';
import type { HostContext } from '../../adapter/types.ts';
import { READ, SEND } from '../../adapter/schema.ts';

const nativeFixture = JSON.parse(fs.readFileSync(new URL('../../fixtures/inbox-native.json', import.meta.url), 'utf8'));
const profileFixture = fs.readFileSync(new URL('../../fixtures/shared-profile.toml', import.meta.url), 'utf8');
export const revision = 'a'.repeat(64);
export const argument = (key = 'owner/repo:first', rev = revision): PublishArguments => ({
  text: 'A deliberate update needs attention.', decision_key: key, revision: rev,
});
export interface ToolResult { content: unknown; details: unknown; isError?: boolean }
interface RegisteredTool {
  name: string;
  parameters: unknown;
  execute(id: string, args: unknown, signal: AbortSignal, update: undefined, ctx: HostContext): Promise<ToolResult>;
}
export function receiptOf(result: ToolResult): NotificationReceipt {
  assert.notEqual(result.isError, true, JSON.stringify(result.details));
  const value = result.details as NotificationReceipt;
  assert.ok(['sent', 'duplicate', 'held', 'unknown'].includes(value.state));
  return value;
}
export function writePrivate(filename: string, text: string): void {
  fs.writeFileSync(filename, text, { mode: 0o600 }); fs.chmodSync(filename, 0o600);
}
export function fixture(t: TestContext, outcome: TestTelegramOutcome = 'echo',
  options: { minimal?: boolean; legacyUnmapped?: boolean; fyip?: TestClefOutcome; owner?: TestOwnerOutcome | 'actual'; reminderClock?: ReminderClock; pokeClock?: PokeClock; clock?: () => number } = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notification-entry-e2e-')));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const project = path.join(directory, 'project'); fs.mkdirSync(project, { mode: 0o700 });
  const profile = path.join(directory, 'profile.toml'); writePrivate(profile, profileFixture);
  const ledger = path.join(directory, 'delivery.sqlite');
  const cutover = { dispatchDisabled: true, allOldWritersQuiesced: true,
    walConsistentBackupVerified: true } as const;
  if (options.legacyUnmapped) {
    // Separate disposable migration fixture, not a workaround for unmapped holds.
    const db = new DatabaseSync(ledger); fs.chmodSync(ledger, 0o600);
    try {
      db.exec(fs.readFileSync(new URL('../../fixtures/delivery-v1.sql', import.meta.url), 'utf8'));
      db.prepare("INSERT INTO deliveries VALUES (?,?,?,?,?,'delivery_unknown',?,1,1,NULL,NULL,'live',NULL)")
        .run('test-only.primary', 'test-only.owner', 'owner/repo:legacy', revision, 'explicit_attention', 'a'.repeat(32));
    } finally { db.close(); }
    migrateLedgerV1ToV2(ledger, cutover);
  } else {
    // Explicit NEW DISPOSABLE state only. Never initialize through publication.
    (options.fyip || options.owner ? initializeLedgerV3 : initializeLedgerV2)(ledger, { ...cutover, noPriorHistory: true });
  }
  const configPath = path.join(directory, 'config.json');
  const config = { version: 1, enabled: true, projects: [{ project_path: project, enabled: true,
    profile_path: profile, ledger_path: ledger, inbox_base_url: 'https://inbox.example.invalid/', policy: options.fyip || options.owner ? 'notification_product' : 'explicit_attention' }] };
  const save = () => writePrivate(configPath, JSON.stringify(config)); save();
  // The real core's branded closed fake is constructed BEFORE entry initialization.
  const telegramHttpClient = createTestTelegramHttpClient({ outcome });
  const clefHttpClient = options.fyip ? createTestClefHttpClient({ outcome: options.fyip }) : undefined;
  let ownerEvidenceProvider = options.owner && options.owner !== 'actual'
    ? createTestOwnerEvidenceProvider(options.owner === 'snooze'
      ? { outcome: options.owner, snoozedUntil: 4000.5 } : { outcome: options.owner }) : undefined;
  const host = { cwd: project, managerCwd: project, session: 'synthetic-session', idle: true, pending: false };
  const modelRequests: Array<{ message: any; control: any }> = [];
  const dispatches: Array<{ name: string; args: Record<string, unknown>; signal: AbortSignal }> = [];
  const records = new Map<string, { send: any; read: any }>();
  let nativeSequence = 0, invocations = 0;
  const state: {
    sends: number; reads: number; observations: number; reuseMessage?: string;
    mutate?: (stage: 'send' | 'read', native: any) => void;
    onNative?: (stage: 'send' | 'read', native: any) => void | Promise<void>;
  } = { sends: 0, reads: 0, observations: 0 };
  const ctx = {
    get cwd() { state.observations++; return host.cwd; },
    sessionManager: { getCwd: () => host.managerCwd, getSessionId: () => host.session },
    isIdle: () => host.idle, hasPendingMessages: () => host.pending,
    tools: [{ name: SEND }, { name: READ }],
    async executeTool(name: string, args: Record<string, unknown>, { signal }: { signal: AbortSignal }) {
      assert.equal(signal.aborted, false);
      assert.equal(args.project_path, host.cwd);
      assert.equal(args.agent_session, host.session);
      dispatches.push({ name, args: structuredClone(args), signal });
      let result: any;
      if (name === SEND) {
        assert.deepEqual(Object.keys(args).sort(), ['body', 'idempotency_key', 'project_path',
          'agent_session', 'agent_host', 'agent_name'].sort());
        assert.equal(args.agent_host, 'pi'); assert.equal(args.agent_name, 'Pi notification publisher');
        state.sends++;
        if (state.reuseMessage) {
          result = structuredClone(records.get(state.reuseMessage)!.send);
        } else {
          const mid = 'msg_' + String(++nativeSequence).padStart(26, '0');
          const send = structuredClone(nativeFixture.send), read = structuredClone(nativeFixture.read);
          const url = config.projects[0].inbox_base_url + '#thread=' + mid;
          Object.assign(send.structuredContent, { message_id: mid, thread_id: mid, url });
          send.structuredContent.project.root = host.cwd;
          read.structuredContent.url = url;
          read.structuredContent.thread.thread_id = mid;
          read.structuredContent.thread.project.root = host.cwd;
          const message = read.structuredContent.thread.messages[0];
          Object.assign(message, { id: mid, thread_id: mid, body: args.body, idempotency_key: args.idempotency_key });
          Object.assign(message.author, { session: host.session, host: 'pi', name: args.agent_name });
          records.set(mid, { send: structuredClone(send), read }); result = send;
        }
      } else {
        assert.equal(name, READ);
        assert.deepEqual(Object.keys(args).sort(), ['message_id', 'thread_id', 'project_path', 'agent_session', 'format'].sort());
        assert.equal(args.format, 'full'); assert.equal(args.message_id, args.thread_id);
        state.reads++;
        result = structuredClone(records.get(args.message_id as string)!.read);
        if (ownerEvidenceProvider) {
          const data = result.structuredContent, message = data.thread.messages[0];
          data.thread.messages.push(...testOwnerNativeFixtures(ownerEvidenceProvider, {
            identity: { profile_id: 'test-only.primary', destination_id: 'test-only.owner',
              decision_key: 'synthetic/request', event_revision: revision, purpose: 'owner_request' },
            target: { project_id: data.thread.project.id, project_root: host.cwd,
              session_id: message.author.session, message_id: message.id, thread_id: message.thread_id,
              revision, revision_semantics: 'content-sha256', url: data.url }, body: message.body,
          }).messages);
        }
      }
      const stage = name === SEND ? 'send' : 'read';
      state.mutate?.(stage, result);
      await state.onNative?.(stage, result);
      return { isError: false, result: result as NativeMcpResult };
    },
  };
  let tool!: RegisteredTool;
  const tools = new Map<string, RegisteredTool>();
  const events = new Map<string, (event?: any) => Promise<any>>();
  t.after(async () => { await events.get('session_shutdown')?.(); });
  const flags: string[] = [];
  const flag = { value: configPath as unknown, reads: 0, error: false };
  const makePi = () => ({
    registerFlag(name: string) { flags.push(name); }, getFlag: () => {
      flag.reads++; if (flag.error) throw new Error('synthetic flag getter failure'); return flag.value;
    },
    on(name: string, handler: (event: any, ctx: any) => Promise<any>) {
      events.set(name, event => handler(event ?? {}, ctx));
    },
    sendMessage(message: any, control: any) { modelRequests.push({ message, control }); host.idle = false; },
    registerTool(value: RegisteredTool) { tools.set(value.name, value); if (value.name === 'notification_publish') tool = value; },
  } as unknown as ExtensionAPI);
  function start(startOptions: { minimal?: boolean; noConfig?: boolean; deferFlag?: boolean; defaultEntry?: boolean; knownSecrets?: readonly string[]; owner?: TestOwnerOutcome; telegramHttpClient?: TestTelegramHttpClient } = {}) {
    events.clear(); tools.clear(); flags.length = 0; flag.reads = 0; flag.error = false;
    flag.value = startOptions.noConfig || startOptions.deferFlag ? undefined : configPath;
    if (startOptions.owner) ownerEvidenceProvider = createTestOwnerEvidenceProvider(startOptions.owner === 'snooze'
      ? { outcome: startOptions.owner, snoozedUntil: (options.clock?.() ?? Date.now() / 1000) + 7200.5 }
      : { outcome: startOptions.owner });
    const pi = makePi();
    const minimal = startOptions.minimal ?? options.minimal;
    if (startOptions.defaultEntry) (minimal ? minimalNotificationExtension : notificationExtension)(pi);
    else (minimal ? createMinimalNotificationExtension : createNotificationExtension)({ telegramHttpClient: startOptions.telegramHttpClient ?? telegramHttpClient,
      clefHttpClient, ownerEvidenceProvider, clock: options.clock,
      knownSecrets: ['synthetic-credential', ...(startOptions.knownSecrets ?? [])] }, { reminderClock: options.reminderClock, pokeClock: options.pokeClock })(pi);
    assert.deepEqual(flags, ['notification-config']);
  }
  // Normal tested entry factory; only native Pi host/Inbox is fake, core is real.
  start();
  async function restart(options: { knownSecrets?: readonly string[]; owner?: TestOwnerOutcome; telegramHttpClient?: TestTelegramHttpClient } = {}) {
    await events.get('session_shutdown')?.();
    start(options); await events.get('session_start')?.();
  }
  const invoke = (args: unknown = argument(), controller = new AbortController()) =>
    tool.execute('e2e-' + (++invocations), args, controller.signal, undefined, ctx as unknown as HostContext);
  const invokeFYIP = (args: unknown, controller = new AbortController()) =>
    tools.get('notification_publish_fyip')!.execute('e2e-fyip-' + (++invocations), args,
      controller.signal, undefined, ctx as unknown as HostContext);
  const invokeOwner = (args: unknown = argument(), controller = new AbortController()) =>
    tools.get('notification_owner_request')!.execute('e2e-owner-' + (++invocations), args,
      controller.signal, undefined, ctx as unknown as HostContext);
  const invokeTick = (args: unknown = {}, controller = new AbortController()) =>
    tools.get('notification_reminder_tick')!.execute('e2e-tick-' + (++invocations), args,
      controller.signal, undefined, Object.create(ctx) as HostContext);
  function rows(table: 'deliveries' | 'canonical_associations' | 'fyip_decisions' | 'pending_owner_requests' | 'reminder_occurrences'): any[] {
    const db = new DatabaseSync(ledger, { readOnly: true });
    try { return db.prepare('SELECT * FROM ' + table + (table === 'reminder_occurrences' ? '' : ' ORDER BY decision_key,event_revision')).all(); }
    finally { db.close(); }
  }
  return { directory, project, profile, ledger, configPath, config, save, host, ctx,
    telegramHttpClient, clefHttpClient, ownerEvidenceProvider, dispatches, records, state, events, flags, flag, start, restart, invoke, invokeFYIP, invokeOwner, invokeTick, modelRequests, rows, tools,
    get tool() { return tool; } };
}
