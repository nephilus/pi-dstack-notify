import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';
import type { ServiceFactory } from './types.ts';
import { NotificationAdapter, controlledCode } from './runtime.ts';
import { createReminderScheduler } from './reminder-scheduler.ts';
import type { ReminderClock } from './reminder-scheduler.ts';
import { SEND, READ } from './schema.ts';
import { createPokeController } from './poke-controller.ts';
import type { PokeClock } from './poke-controller.ts';

export interface RegistrationOptions {
  /** Package entry construction only, NEVER a flag/tool/model permission selector. */
  minimal?: boolean;
  parameters: TSchema;
  fyipParameters: TSchema;
  tickParameters: TSchema;
  pokeParameters: TSchema;
  pokeClock?: PokeClock;
  reminderClock?: ReminderClock;
  serviceFactory: ServiceFactory;
  canonicalize?: (path: string) => string;
}
export function registerNotificationExtension(pi: ExtensionAPI, options: RegistrationOptions): NotificationAdapter {
  pi.registerFlag('notification-config', {
    description: 'Explicit absolute configured-notification path; absent disables publishing',
    type: 'string',
  });
  // Registration is inert. The core is constructed lazily only for an active
  // tool invocation with an explicit absolute config path.
  const adapter = new NotificationAdapter({ resolveConfigPath: () => pi.getFlag('notification-config'),
    serviceFactory: options.serviceFactory, canonicalize: options.canonicalize });
  if (options.minimal !== true) {
  const scheduler = createReminderScheduler({ clock: options.reminderClock,
    duePlan: async observed => adapter.planDue(observed) });
  const poke = createPokeController({ clock: options.pokeClock,
    plan: async observed => adapter.planForPoke(observed), opportunity: () => scheduler.opportunity() });
  pi.on('session_start', async (_event, ctx) => {
    poke.stop(); scheduler.stop(); adapter.invalidate();
    // Absent/relative startup flag stays inert before observation or resources.
    if (!adapter.configured) return;
    poke.start({ observe: () => adapter.currentObservation(ctx),
      isIdle: () => ctx.isIdle() && !adapter.isActive,
      hasPendingMessages: () => ctx.hasPendingMessages() || adapter.hasPendingNativeDispatch,
      sendMessage: (message, control) => pi.sendMessage(message, control) });
    scheduler.start({
      observe: () => adapter.currentObservation(ctx),
      isIdle: () => ctx.isIdle() && !adapter.isActive,
      hasPendingMessages: () => ctx.hasPendingMessages() || adapter.hasPendingNativeDispatch,
      sendMessage: (message, control) => pi.sendMessage(message, control),
    });
  });
  pi.on('session_shutdown', async () => { poke.stop(); scheduler.stop(); adapter.invalidate(); });
  const navigate = async () => { poke.invalidate(); scheduler.beforeNavigation(); adapter.invalidate(); };
  pi.on('session_before_switch', navigate);
  pi.on('session_before_fork', navigate);
  pi.on('session_before_tree', navigate);
  pi.on('session_tree', async () => { poke.invalidate(); scheduler.rebase(); adapter.invalidate(); });
  pi.on('input', async event => { poke.input(event); scheduler.observedInput(); });
  pi.on('ui_prompt_start', async () => { poke.uiPrompt(true); scheduler.uiPrompt(true); });
  pi.on('ui_prompt_end', async () => { poke.uiPrompt(false); scheduler.uiPrompt(false); });
  pi.on('before_agent_start', async event => { poke.beforeAgentStart(event); scheduler.beforeAgentStart(event); });
  pi.on('agent_start', async () => { poke.agentStart(); });
  pi.on('turn_start', async () => { poke.turnStart(); });
  pi.on('message_start', async event => { poke.messageStart(event); });
  pi.on('turn_end', async event => { poke.turnEnd(event); scheduler.turnEnd(); });
  pi.on('agent_settled', async event => { poke.settled(event); scheduler.settled(); });
  pi.registerTool({
    name: 'notification_poke_hint', label: 'Record advisory continuation state',
    description: 'Optionally record current task-state advice, not authority or a continuation request. '
      + 'Report waits, delegation, completion or uncertainty truthfully. Candidates cannot override a wait. '
      + 'This grants no tool, ownership, permission, retry or takeover; later genuine settlement may offer bounded advice.',
    parameters: options.pokeParameters, exposure: 'model-only', executionMode: 'sequential',
    async execute(_id, args, signal) {
      const recorded = adapter.configured && poke.record(args, signal);
      const details = recorded ? { recorded: true, advisory: true } : { code: 'invalid_or_stale_hint' };
      return { ...(recorded ? {} : { isError: true }),
        content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
    },
  });
  pi.registerTool({
    name: 'notification_reminder_tick', label: 'Reconcile configured owner reminders',
    description: 'Reconcile the current configured reminder snapshot only for a recognized scheduled request. '
      + 'Call once with {} in that request\'s first response; real input takes priority. '
      + 'Core alone checks original answers, snooze, current hour and durable once-only delivery. '
      + 'No target/hour/owner proof or retry selector. An answer is not approval.',
    parameters: options.tickParameters,
    exposure: 'model-only', executionMode: 'sequential', reachesTools: () => [SEND, READ],
    async execute(_id, args, signal, _onUpdate, ctx) {
      try {
        const receipt = await adapter.tickReminders(args, ctx, signal, observed => scheduler.take(observed));
        return { content: [{ type: 'text' as const, text: JSON.stringify(receipt) }], details: receipt };
      } catch (error) {
        const code = controlledCode(error);
        return { isError: true, content: [{ type: 'text' as const, text: code }], details: { code } };
      }
    },
  });
  pi.registerTool({
    name: 'notification_owner_request', label: 'Publish owner request',
    description: 'Publish a deliberate request for a recorded OWNER answer through the configured core. '
      + 'Text, decision_key and revision are caller assertions, not owner proof or approval. '
      + 'The core alone reserves tracking and verifies original readback and supported answer evidence. '
      + 'Unsupported owner evidence holds before publication. Duplicate requests do not refresh tracking. '
      + 'A recorded answer pauses reminders; it does not approve a decision. No owner or destination override.',
    parameters: options.parameters,
    exposure: 'model-only', executionMode: 'sequential', reachesTools: () => [SEND, READ],
    async execute(_id, args, signal, _onUpdate, ctx) {
      try {
        const receipt = await adapter.publishOwnerRequest(args, ctx, signal);
        return { content: [{ type: 'text' as const, text: JSON.stringify(receipt) }], details: receipt };
      } catch (error) {
        const code = controlledCode(error);
        return { isError: true, content: [{ type: 'text' as const, text: code }], details: { code } };
      }
    },
  });
  } else {
    // Minimal entry creates NO reminder/poke controller, plan, timer or model route.
    // Resolve once after SDK flag binding, before observing any session context.
    pi.on('session_start', async () => { adapter.invalidate(); void adapter.configured; });
    const invalidate = async () => { adapter.invalidate(); };
    pi.on('session_shutdown', invalidate);
    pi.on('session_before_switch', invalidate);
    pi.on('session_before_fork', invalidate);
    pi.on('session_before_tree', invalidate);
    pi.on('session_tree', invalidate);
    pi.on('input', invalidate);
  }
  pi.registerTool({
    name: 'notification_publish_fyip', label: 'Publish curated FYIP update',
    description: 'Submit an explicitly curated milestone/outcome/material-risk/plan-change candidate. '
      + 'The core alone admits evidence and runs configured classification. No raw final, tool result or child exit '
      + 'alone is publication authority. NO is quiet suppression; admitted classifier failure may use labeled fallback. '
      + 'Identity/revision remain caller assertions; delivery is not approval, tracking or a wake request.',
    parameters: options.fyipParameters,
    exposure: 'model-only', executionMode: 'sequential', reachesTools: () => [SEND, READ],
    async execute(_id, args, signal, _onUpdate, ctx) {
      try {
        const receipt = await adapter.publishFYIP(args, ctx, signal);
        return { content: [{ type: 'text' as const, text: JSON.stringify(receipt) }], details: receipt };
      } catch (error) {
        const code = controlledCode(error);
        return { isError: true, content: [{ type: 'text' as const, text: code }], details: { code } };
      }
    },
  });
  pi.registerTool({
    name: 'notification_publish', label: 'Publish notification',
    description: 'Publish deliberate plain-text attention through configured Inbox and notification policy. '
      + 'Text, decision_key and revision are caller assertions, not verified facts or authorization. '
      + 'decision_key supplies bounded identity deduplication, not semantic duplicate prevention across changed keys. '
      + 'revision accepts lowercase Git SHA-1 or content SHA-256 syntax; no revision verification is implied. '
      + 'Delivery is not approval or a wake request.',
    parameters: options.parameters,
    exposure: 'model-only', executionMode: 'sequential',
    reachesTools: () => [SEND, READ],
    async execute(_id, args, signal, _onUpdate, ctx) {
      try {
        const receipt = await adapter.publish(args, ctx, signal);
        return { content: [{ type: 'text' as const, text: JSON.stringify(receipt) }], details: receipt };
      } catch (error) {
        const code = controlledCode(error);
        return { isError: true, content: [{ type: 'text' as const, text: code }], details: { code } };
      }
    },
  });
  return adapter;
}
