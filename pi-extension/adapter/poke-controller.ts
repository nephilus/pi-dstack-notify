import { createHash, randomUUID } from 'node:crypto';
import type { HostObservation } from '../core/types.ts';
import type { ReminderPlan } from '../core/reminder-plan.ts';
import { REMINDER_REQUEST_TYPE } from './reminder-scheduler.ts';
import { fingerprint, normalizeHint, progresses } from './poke-hints.ts';
import type { Projection } from './poke-hints.ts';
export const POKE_REQUEST_TYPE = 'notification-advisory-poke';
const CONTENT = 'Advisory continuation hint, not new user instructions or permission. '
  + 'Reconcile current task state, ownership, existing permissions and dependencies. '
  + 'Continue only already-authorized independently runnable work you still own. '
  + 'If waiting, blocked, done, delegated or unsure, stop; do not poll dependencies, '
  + 'retry uncertain effects or take over delegated work.';
export interface PokeClock {
  elapsed(): number;
  immediate(callback: () => void): () => void;
}
export interface PokeHost {
  observe(): HostObservation;
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  sendMessage(message: { customType: string; content: string; display: boolean; details: unknown },
    control: { triggerTurn: true; deliverAs: 'followUp' }): void;
}
interface Chain {
  scope: string; generation: number; deadline: number; lastTime: number; attempts: number;
  consumed: Set<string>; previous?: Projection; lastSelected: number; veto: boolean;
}
interface Run {
  kind: 'normal' | 'poke' | 'custom'; generation: number; scope: string; chain?: Chain;
  baseline?: Projection; final?: Projection; veto: boolean; contaminated: boolean;
  started: boolean; turn: boolean; ended: boolean; failed: boolean; settled: boolean;
  initialToken?: string; initialSeen: boolean; firstTurn: boolean;
}
interface Arm { token: string; chain: Chain; generation: number }
const scopeOf = (o: HostObservation) => JSON.stringify([o.session_id, o.project_path]);
const digest = (text: unknown, images: unknown) => createHash('sha256').update(JSON.stringify([text, images ?? null])).digest('hex');
const systemClock: PokeClock = { elapsed: () => performance.now(), immediate(callback) {
  const handle = setImmediate(callback); return () => clearImmediate(handle);
} };
/** Event-only advisory controller. No native capability, tool context, replay or timer. */
export function createPokeController(options: {
  clock?: PokeClock;
  plan(observed: HostObservation): Promise<ReminderPlan | undefined>;
  opportunity(): { state: 'pending' | 'unspent' | 'spent' | 'inactive' | 'unknown'; currentSlot: number };
}) {
  const clock = options.clock ?? systemClock;
  let host: PokeHost | undefined, generation = 0, ui = 0;
  let ticket: { generation: number; scope: string; digest: string } | undefined;
  let run: Run | undefined, chain: Chain | undefined, arm: Arm | undefined;
  let latest: Projection | undefined, cancel: (() => void) | undefined;
  function drop() { cancel?.(); cancel = undefined; chain = undefined; arm = undefined; }
  function revoke() { generation++; ticket = undefined; if (run) run.contaminated = true; drop(); }
  function observedScope(): string | undefined {
    try { return host ? scopeOf(host.observe()) : undefined; } catch { return; }
  }
  function checkpoint(c: Chain): boolean {
    const now = clock.elapsed();
    if (!Number.isFinite(now) || now < 0 || now < c.lastTime || now >= c.deadline) {
      if (chain === c) drop(); return false;
    }
    c.lastTime = now; return true;
  }
  function guards(c: Chain, r: Run): boolean {
    try { return chain === c && run === r && r.settled && !r.failed && !r.contaminated
      && c.generation === generation && c.scope === observedScope() && !c.veto && !ui
      && !!host && host.isIdle() && !host.hasPendingMessages() && checkpoint(c); }
    catch { return false; }
  }
  function matchingToken(message: { customType?: string; details?: unknown } | undefined, token: string): boolean {
    const d = message?.details;
    return message?.customType === POKE_REQUEST_TYPE && typeof d === 'object' && d !== null && !Array.isArray(d)
      && Object.keys(d).length === 1 && (d as Record<string, unknown>).poke_request_token === token;
  }
  function offer(c: Chain, r: Run) {
    if (!r.final || r.final.state !== 'candidate' || !r.final.steps.some(s => s.state === 'pending')
        || c.attempts >= 3 || c.veto || !checkpoint(c)) return;
    const projection = structuredClone(r.final), fp = fingerprint(projection);
    if (c.consumed.has(fp) || (c.previous && !progresses(c.previous, projection))) { drop(); return; }
    cancel?.();
    cancel = clock.immediate(() => {
      cancel = undefined;
      void (async () => {
        if (!guards(c, r)) { if (chain === c) drop(); return; }
        const view = options.opportunity();
        if (view.state === 'pending' || view.state === 'unknown' || view.state === 'inactive') { drop(); return; }
        const plan = await options.plan(host!.observe());
        if (!guards(c, r)) { if (chain === c) drop(); return; }
        const fresh = options.opportunity();
        const valid = plan && Number.isInteger(plan.due_count) && plan.due_count >= 0
          && ((plan.status === 'inactive' && plan.reason === 'no_due_work' && plan.due_count === 0)
            || (plan.status === 'held' && plan.reason === 'owner_evidence_unavailable' && plan.due_count === 0)
            || (plan.status === 'ready' && plan.reason === 'due_work' && plan.due_count > 0));
        if (!valid || fresh.state === 'pending' || fresh.state === 'unknown' || fresh.state === 'inactive'
            || (fresh.state === 'unspent' && plan.status === 'ready') || !guards(c, r)) {
          if (chain === c) drop(); return;
        }
        // No await from fresh gates through consumption and fixed submission.
        c.attempts++; c.consumed.add(fp); c.previous = projection;
        const pending = projection.state === 'candidate' ? projection.steps : [];
        for (let n = 1; n <= pending.length; n++) {
          const i = (c.lastSelected + n) % pending.length;
          if (pending[i].state === 'pending') { c.lastSelected = i; break; }
        }
        const submitted: Arm = { token: randomUUID(), chain: c, generation }; arm = submitted;
        try { host!.sendMessage({ customType: POKE_REQUEST_TYPE, display: false, content: CONTENT,
          details: { poke_request_token: submitted.token } }, { triggerTurn: true, deliverAs: 'followUp' }); }
        catch { if (arm === submitted) { c.veto = true; drop(); } }
      })().catch(() => { if (chain === c) drop(); });
    });
  }
  return {
    start(next: PokeHost) { revoke(); host = next; run = undefined; latest = undefined; ui = 0; },
    stop() { revoke(); host = undefined; run = undefined; latest = undefined; },
    invalidate() { revoke(); },
    uiPrompt(open: boolean) { ui = open ? ui + 1 : Math.max(0, ui - 1); if (open) revoke(); },
    input(event: { source: string; text: string; images?: unknown; streamingBehavior?: string }) {
      revoke();
      try {
        const scope = observedScope();
        if (scope && host?.isIdle() && !ui && ['interactive', 'rpc'].includes(event.source) && event.streamingBehavior === undefined)
          ticket = { generation, scope, digest: digest(event.text, event.images) };
      } catch { ticket = undefined; }
    },
    beforeAgentStart(event: { messageType: string; prompt?: string; images?: unknown;
      message?: { customType?: string; details?: unknown } }) {
      const scope = observedScope();
      const t = ticket; ticket = undefined;
      const a = arm;
      const normal = event.messageType === 'user' && t && t.generation === generation && t.scope === scope
        && t.digest === digest(event.prompt, event.images);
      const matched = event.messageType === 'custom' && a && a.generation === generation
        && chain === a.chain && scope === a.chain.scope && matchingToken(event.message, a.token) && checkpoint(a.chain);
      // All customs, including reminder and stale poke types, are non-normal.
      const custom = event.messageType === 'custom' || event.message?.customType === REMINDER_REQUEST_TYPE;
      if (normal) { drop(); run = { kind: 'normal', generation, scope: scope!, baseline: structuredClone(latest),
        veto: false, contaminated: false, started: false, turn: false, ended: false, failed: false,
        settled: false, initialSeen: false, firstTurn: false }; }
      else if (matched) { arm = undefined; run = { kind: 'poke', chain: a.chain, generation, scope: scope!,
        initialToken: a.token, initialSeen: false, veto: false, contaminated: false, started: false,
        turn: false, ended: false, failed: false, settled: false, firstTurn: false }; }
      else { run = { kind: 'custom', generation, scope: scope ?? '', veto: true, contaminated: custom,
        started: false, turn: false, ended: false, failed: false, settled: false, initialSeen: false, firstTurn: false };
        // A stale/custom receiving run cannot consume an unrelated current arm.
        if (!arm) drop(); }
    },
    agentStart() { if (run && !run.settled) run.started = true; },
    turnStart() { if (run?.started && !run.settled) { if (!run.turn) run.firstTurn = true; run.turn = true; } },
    messageStart(event: { message: { role?: string; customType?: string; details?: unknown } }) {
      const r = run; if (!r || event.message.role !== 'custom') return;
      if (r.kind === 'poke' && r.started && r.firstTurn && !r.initialSeen && !r.ended
          && r.generation === generation && matchingToken(event.message, r.initialToken!)) {
        r.initialSeen = true; return;
      }
      r.contaminated = true;
      if (r.chain && chain === r.chain) drop();
    },
    turnEnd(event: { outcome: string }) {
      if (!run || run.settled) return;
      run.ended = true; run.firstTurn = false;
      if (event.outcome !== 'completed') { run.failed = true; if (run.chain === chain) drop(); }
    },
    record(value: unknown, signal: AbortSignal | undefined): boolean {
      // Capture identity BEFORE bounded synchronous normalization; never retain ToolContext.
      const captured = run, capturedChain = captured?.chain, capturedGeneration = generation;
      const scope = observedScope();
      const projection = normalizeHint(value);
      if (!captured || captured !== run || capturedChain !== captured.chain
          || capturedGeneration !== generation || captured.generation !== generation || !host
          || captured.scope !== scope || captured.scope !== observedScope() || !signal || signal.aborted
          || captured.contaminated || captured.failed || captured.settled || !captured.started || !captured.turn
          || (captured.kind !== 'normal' && !(captured.kind === 'poke' && captured.initialSeen))) return false;
      if (!projection) { captured.veto = true; if (capturedChain) capturedChain.veto = true; return false; }
      if (capturedChain && projection.state === 'candidate') {
        const previous = captured.final ?? capturedChain.previous;
        if (previous?.state === 'candidate' && (previous.steps.length !== projection.steps.length
            || previous.steps.some((s, i) => s.summary !== projection.steps[i].summary
              || (s.state === 'done' && projection.steps[i].state !== 'done')))) {
          captured.veto = true; capturedChain.veto = true;
          return false; // Invalid chain reports cannot rewrite the latest accepted observation.
        }
      }
      captured.final = structuredClone(projection); latest = structuredClone(projection);
      if (projection.state !== 'candidate') { captured.veto = true; if (capturedChain) capturedChain.veto = true; }
      return true;
    },
    settled(event: { aborted: boolean }) {
      const r = run; if (!r || r.settled) return;
      r.settled = true;
      if (event.aborted || r.failed || r.contaminated || r.veto || r.generation !== generation || !r.started
          || !r.turn || !r.ended || !r.final || r.scope !== observedScope()) { if (r.chain === chain) drop(); return; }
      if (r.kind === 'normal') {
        const now = clock.elapsed();
        if (!Number.isFinite(now) || now < 0 || fingerprint(r.baseline) === fingerprint(r.final)) return;
        const c: Chain = { scope: r.scope, generation, deadline: now + 30_000, lastTime: now,
          attempts: 0, consumed: new Set(), lastSelected: -1, veto: false };
        chain = c; r.chain = c; offer(c, r);
      } else if (r.kind === 'poke' && r.initialSeen && r.chain === chain && chain) offer(chain, r);
    },
  };
}
