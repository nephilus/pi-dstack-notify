import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerNotificationExtension } from '../../adapter/register.ts';
import { INPUT_SCHEMA, FYIP_INPUT_SCHEMA } from '../../adapter/schema.ts';

for (const minimal of [true, false]) for (const kind of ['missing', 'relative', 'invalid', 'getter_error', 'minimal_enabled'] as const) {
  if (!minimal && kind === 'minimal_enabled') continue;
  test('shared lazy flag resolution before observation/service: ' + (minimal ? 'minimal ' : 'full ') + kind, async () => {
    let flag: unknown, reads = 0, observations = 0, services = 0, timers = 0, messages = 0;
    const handlers = new Map<string, (event?: any) => Promise<any>>();
    const tools: string[] = [];
    const pi = { registerFlag() {}, getFlag() { reads++; if (kind === 'getter_error') throw Error('synthetic'); return flag; },
      on(name: string, handler: any) { handlers.set(name, event => handler(event ?? {}, {
        get cwd() { observations++; throw Error('must not observe'); },
        sessionManager: { getCwd() { observations++; throw Error('must not observe'); }, getSessionId() { observations++; throw Error('must not observe'); } },
      })); }, registerTool(tool: any) { tools.push(tool.name); }, sendMessage() { messages++; },
    } as unknown as ExtensionAPI;
    const clock = { now: () => 0, elapsed: () => 0, schedule() { timers++; return () => {}; }, immediate() { timers++; return () => {}; } };
    registerNotificationExtension(pi, { minimal, parameters: INPUT_SCHEMA, fyipParameters: FYIP_INPUT_SCHEMA,
      tickParameters: {}, pokeParameters: {}, reminderClock: clock, pokeClock: clock,
      serviceFactory() { services++; throw Error('must not construct'); } });
    assert.equal(reads, 0, 'no factory-time read');
    flag = kind === 'relative' ? 'relative.json' : kind === 'invalid' ? 42 : kind === 'minimal_enabled' ? '/synthetic/config' : undefined;
    await handlers.get('session_start')!(); assert.equal(reads, 1);
    for (const event of ['input', 'session_before_switch', 'session_before_fork', 'session_before_tree', 'session_tree', 'session_shutdown'])
      await handlers.get(event)?.({ source: 'interactive', text: 'ordinary' });
    assert.equal(services, 0); assert.equal(observations, 0); assert.equal(timers, 0); assert.equal(messages, 0);
    if (minimal) assert.deepEqual(tools.sort(), ['notification_publish', 'notification_publish_fyip']);
  });
}
