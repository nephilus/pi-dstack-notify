import { randomUUID } from 'node:crypto';
import type { HostObservation } from '../core/types.ts';

export const REMINDER_REQUEST_TYPE = 'notification-reminder-request';
const HOUR = 3_600_000;
const RECHECK = 5_000;
const CONTENT = 'Notification reminder reconciliation request, not owner input or approval. '
  + 'Yield to real input. Call notification_reminder_tick({}) once for the current configured workflow.';

/** Session-lifetime inspection/message port, NEVER an ExtensionToolContext.
 * Pi 1.4: session_start owns resources; sendMessage idle custom starts a run,
 * while streaming followUp has no per-message before_agent_start hook.
 */
export interface ReminderHost {
  observe(): HostObservation;
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  sendMessage(message: { customType: string; content: string; display: boolean; details: unknown },
    options: { triggerTurn: true; deliverAs: 'followUp' }): void;
}
export interface ReminderClock {
  /** UTC wall milliseconds: slot identity only, never host deferral duration. */
  now(): number;
  /** Monotonic elapsed milliseconds, independent of UTC clock adjustments. */
  elapsed(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}
export interface ReminderSchedulerOptions {
  /** EFFECT-FREE core-owned due/config plan only. No native callbacks or dispatch. */
  duePlan(observed: Readonly<HostObservation>): Promise<boolean>;
  clock?: ReminderClock;
}
export interface ReminderAdmission {
  readonly signal: AbortSignal;
  /** Call with fresh observations before/after awaits. No native capability stored. */
  check(observed: HostObservation): boolean;
  close(): void;
}
interface Epoch {
  generation: number; input: number; slot: number; scope: string;
}
interface Arm extends Epoch { token: string }
interface Permit extends Epoch { run: number }
const sameScope = (o: HostObservation): string => JSON.stringify([o.session_id, o.project_path]);
const systemClock: ReminderClock = {
  now: Date.now,
  elapsed: () => performance.now(),
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs); timer.unref();
    return () => clearTimeout(timer);
  },
};

/** Host-controller only: no tools registered, no policy, native I/O or delivery claims.
 * Wire beforeAgentStart before tool execution; turnEnd expires first-turn authority.
 * Never infer a permit from an existing arm at execute time.
 */
export function createReminderScheduler(options: ReminderSchedulerOptions) {
  const clock = options.clock ?? systemClock;
  let host: ReminderHost | undefined, cancelTimer: (() => void) | undefined;
  let generation = 0, input = 0, run = 0, scope = '', highSlot = -Infinity;
  let deferredUntil = 0, promptDepth = 0, planning = false;
  let arm: Arm | undefined, permit: Permit | undefined;
  let active: { controller: AbortController; epoch: Permit } | undefined;

  const slot = () => Math.floor(clock.now() / HOUR);
  function invalidate(): void {
    generation++; arm = undefined; permit = undefined;
    active?.controller.abort(); active = undefined;
  }
  function observation(): HostObservation | undefined {
    if (!host) return;
    try {
      const observed = host.observe();
      if (!observed || typeof observed.session_id !== 'string' || !observed.session_id
          || typeof observed.project_path !== 'string' || !observed.project_path) {
        invalidate(); return;
      }
      const next = sameScope(observed);
      if (next !== scope) {
        invalidate(); scope = next; highSlot = -Infinity;
      }
      if ((arm && arm.slot !== slot()) || (permit && permit.slot !== slot())
          || (active && active.epoch.slot !== slot())) invalidate();
      return { ...observed };
    } catch { invalidate(); return; }
  }
  function matches(epoch: Epoch, observed: HostObservation): boolean {
    return !!host && epoch.generation === generation && epoch.input === input
      && epoch.slot === slot() && epoch.scope === scope && sameScope(observed) === scope;
  }
  function ready(): boolean {
    try { return !!host && host.isIdle() && !host.hasPendingMessages()
      && promptDepth === 0 && clock.elapsed() >= deferredUntil && !active; }
    catch { invalidate(); return false; }
  }
  function schedule(): void {
    cancelTimer?.(); cancelTimer = undefined;
    if (!host) return;
    const boundary = (slot() + 1) * HOUR - clock.now();
    cancelTimer = clock.schedule(heartbeat, Math.max(1, Math.min(RECHECK, boundary)));
  }
  function heartbeat(): void {
    cancelTimer = undefined;
    const observed = observation();
    if (observed && ready() && !planning && slot() > highSlot) {
      const epoch: Epoch = { generation, input, slot: slot(), scope };
      planning = true;
      // Catch sync and async failures; no native effects may occur in this port.
      void Promise.resolve().then(() => {
        const fresh = observation();
        if (!fresh || !matches(epoch, fresh) || !ready()) return false;
        return options.duePlan(Object.freeze({ ...observed }));
      })
        .then(due => {
          const fresh = observation();
          if (due !== true || !fresh || !matches(epoch, fresh) || !ready() || epoch.slot <= highSlot) return;
          arm = { ...epoch, token: randomUUID() };
          highSlot = epoch.slot; // At most one submitted request/slot, including send failures.
          // No await between final guards, arm creation and supported message dispatch.
          host!.sendMessage({ customType: REMINDER_REQUEST_TYPE, content: CONTENT, display: false,
            details: { notification_reminder_token: arm.token } }, { triggerTurn: true, deliverAs: 'followUp' });
        }).catch(() => { arm = undefined; })
        .finally(() => { planning = false; });
    }
    schedule();
  }
  return {
    /** Read-only arbitration snapshot: never claims, invalidates or advances a slot. */
    opportunity(): { state: 'pending' | 'unspent' | 'spent' | 'inactive' | 'unknown'; currentSlot: number } {
      try {
        const currentSlot = slot();
        if (!Number.isFinite(currentSlot)) return { state: 'unknown', currentSlot };
        if (!host) return { state: 'inactive', currentSlot };
        if (sameScope(host.observe()) !== scope) return { state: 'unknown', currentSlot };
        if (planning || arm || permit || active) return { state: 'pending', currentSlot };
        if (currentSlot <= highSlot) return { state: 'spent', currentSlot };
        if (!host.isIdle() || host.hasPendingMessages() || promptDepth || clock.elapsed() < deferredUntil)
          return { state: 'unknown', currentSlot };
        return { state: 'unspent', currentSlot };
      } catch { return { state: 'unknown', currentSlot: NaN }; }
    },
    start(nextHost: ReminderHost): void {
      cancelTimer?.(); invalidate(); host = nextHost; scope = ''; highSlot = -Infinity;
      deferredUntil = 0; promptDepth = 0;
      observation(); schedule(); // No immediate effects or due-plan call at construction/start.
    },
    stop(): void {
      cancelTimer?.(); cancelTimer = undefined; invalidate(); host = undefined;
    },
    /** Observed input only. Lease expires even if handled/rejected/failed without a run. */
    observedInput(): void {
      input++; invalidate(); deferredUntil = clock.elapsed() + RECHECK;
    },
    /** Invalidate effects, NOT resources: cancelled navigation may emit no start event. */
    beforeNavigation(): void {
      invalidate(); deferredUntil = clock.elapsed() + RECHECK;
    },
    /** session_tree (or explicit recovery observation), not session_start. */
    rebase(): void { invalidate(); observation(); },
    uiPrompt(open: boolean): void {
      promptDepth = open ? promptDepth + 1 : Math.max(0, promptDepth - 1);
      if (open) invalidate();
    },
    beforeAgentStart(event: { messageType: string; message?: { customType?: string; details?: unknown } }): void {
      // A new actual run always revokes prior run authority. A stale prompt must
      // never steal/consume a newer arm, even if its public tick looks identical.
      active?.controller.abort(); active = undefined; permit = undefined; run++;
      const observed = observation();
      const details = event.message?.details;
      if (!observed || event.messageType !== 'custom' || event.message?.customType !== REMINDER_REQUEST_TYPE
          || typeof details !== 'object' || details === null || Array.isArray(details)
          || !arm || Object.keys(details).length !== 1
          || (details as Record<string, unknown>).notification_reminder_token !== arm.token
          || !matches(arm, observed) || clock.elapsed() < deferredUntil || promptDepth) return;
      permit = { generation: arm.generation, input: arm.input, slot: arm.slot, scope: arm.scope, run };
      arm = undefined; // Recognized idle custom-start is the ONLY arm -> permit transition.
    },
    /** End of first model response + its tool calls, before queued follow-up turns. */
    turnEnd(): void {
      permit = undefined; active?.controller.abort(); active = undefined;
    },
    settled(): void {
      invalidate(); // Completion/abort/no-tool response cannot keep an admission alive.
      // The normal timer rechecks outside settlement; no continuation loop.
    },
    /** Called ONLY from later registered tick execute with its fresh observation.
     * Caller retains its own originating context/signal/finally fences.
     */
    take(observed: HostObservation): ReminderAdmission | undefined {
      const current = observation();
      const selected = permit;
      permit = undefined; // Every execution attempt consumes an existing permit, never an arm.
      if (!current || !selected || selected.run !== run || !matches(selected, current)
          || !matches(selected, observed) || active || promptDepth || clock.elapsed() < deferredUntil) return;
      const controller = new AbortController();
      const record = { controller, epoch: selected }; active = record;
      const close = () => { controller.abort(); if (active === record) active = undefined; };
      return Object.freeze({ signal: controller.signal,
        check(fresh: HostObservation) {
          const current = observation();
          return !!current && active === record && !controller.signal.aborted && selected.run === run
            && matches(selected, current) && matches(selected, fresh)
            && promptDepth === 0 && clock.elapsed() >= deferredUntil;
        }, close });
    },
  };
}
