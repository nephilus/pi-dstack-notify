import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createNotificationExtension } from '../../index.ts';
import type { ReminderClock } from '../../adapter/reminder-scheduler.ts';
import { deniedAttempts } from '../adapter/deny-runtime.ts';

// Ordinary actual entry + real TypeBox: no core resolver/substitution is installed.
after(() => { assert.deepEqual(deniedAttempts, []); assert.equal(process.env.PATH, '/__notification_no_executables__'); });
for (const config of [undefined, 'relative/config.json']) test('actual session_start stays inert for startup flag ' + config, async () => {
  let observations = 0, timers = 0, messages = 0;
  const clock: ReminderClock = { now: Date.now, elapsed: () => performance.now(), schedule() { timers++; return () => {}; } };
  const events = new Map<string, Function>();
  createNotificationExtension({}, { reminderClock: clock })({
    registerFlag() {}, getFlag: () => config,
    on(name: string, handler: Function) { events.set(name, handler); }, registerTool() {},
    sendMessage() { messages++; },
  } as unknown as ExtensionAPI);
  const ctx = { get cwd() { observations++; throw Error('must remain inert'); },
    sessionManager: { getCwd() { observations++; throw Error('must remain inert'); }, getSessionId() { observations++; throw Error('must remain inert'); } } };
  await events.get('session_start')!({}, ctx);
  await events.get('input')!({}, ctx); await events.get('session_before_tree')!({}, ctx);
  await events.get('session_tree')!({}, ctx); await events.get('session_shutdown')!({}, ctx);
  assert.equal(observations, 0); assert.equal(timers, 0); assert.equal(messages, 0);
});
