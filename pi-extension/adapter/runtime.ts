import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { HostContext, HostObservation, NativeMcpResult, NotificationReceipt,
  NotificationServicePort, PublicationContext, ServiceFactory, PublishArguments, PublishFYIPArguments, FYIPReceipt, OwnerRequestReceipt, ReminderTickReceipt } from './types.ts';
import type { ReminderAdmission } from './reminder-scheduler.ts';
import { SEND, READ, exact, isObject, validArguments, validFYIPArguments } from './schema.ts';

export type AdapterCode = 'invalid_request' | 'configuration_unavailable' | 'busy' |
  'cancelled' | 'callback_failed' | 'internal_error';
const ADAPTER_CODES: ReadonlySet<string> = new Set(['invalid_request', 'configuration_unavailable',
  'busy', 'cancelled', 'callback_failed', 'internal_error']);
export class AdapterError extends Error {
  constructor(code: AdapterCode) { super(ADAPTER_CODES.has(code) ? code : 'internal_error'); }
}
export function controlledCode(error: unknown): string {
  return error instanceof AdapterError && ADAPTER_CODES.has(error.message) ? error.message : 'internal_error';
}
interface Operation {
  id: string;
  observed: Readonly<HostObservation>;
  ctx: HostContext;
  controller: AbortController;
  epoch: number;
  live: boolean;
  callbackRunning: boolean;
  childAbortCleanups: Map<AbortSignal, () => void>;
  admission?: ReminderAdmission;
}
export interface AdapterOptions {
  configPath?: unknown;
  /** Host-only lazy startup lookup: SDK binds flags AFTER extension factories. */
  resolveConfigPath?: () => unknown;
  serviceFactory: ServiceFactory;
  canonicalize?: (path: string) => string;
}
function same(a: HostObservation, b: HostObservation): boolean {
  return a.session_id === b.session_id && a.project_path === b.project_path;
}

// Shared only within this JavaScript realm. Runtime/module replacement must not
// mistake an old uncooperative dispatch for settled work. No authority is stored.
const PENDING_KEY = Symbol.for('pi-configured-notification.native-pending.v1');
interface PendingCell { readonly version: 1; pending: symbol | undefined }
function pendingCell(): PendingCell | undefined {
  try {
    if (!(PENDING_KEY in globalThis)) {
      const cell = Object.create(null) as PendingCell;
      Object.defineProperties(cell, {
        version: { value: 1, enumerable: true },
        pending: { value: undefined, writable: true, enumerable: true },
      });
      Object.seal(cell);
      Object.defineProperty(globalThis, PENDING_KEY, { value: cell });
    }
    const globalSlot = Object.getOwnPropertyDescriptor(globalThis, PENDING_KEY);
    if (!globalSlot || !('value' in globalSlot) || globalSlot.writable !== false
        || globalSlot.configurable !== false) return;
    const cell: unknown = globalSlot.value;
    if (typeof cell !== 'object' || cell === null || Object.getPrototypeOf(cell) !== null
        || !Object.isSealed(cell) || Reflect.ownKeys(cell).length !== 2) return;
    const version = Object.getOwnPropertyDescriptor(cell, 'version');
    const pending = Object.getOwnPropertyDescriptor(cell, 'pending');
    if (!version || !('value' in version) || version.value !== 1 || version.writable !== false
        || !pending || !('value' in pending) || pending.writable !== true
        || (pending.value !== undefined && typeof pending.value !== 'symbol')) return;
    return cell as PendingCell;
  } catch { return; } // Unknown/mismatched shared state is blocked, never replaced.
}

/** Host adapter only: no config/profile/credential reads, policy or ledger. */
export class NotificationAdapter {
  private readonly options: AdapterOptions;
  private readonly canonicalize: (path: string) => string;
  private active?: Operation;
  // Readonly availability. Invalid shared state is conservatively unavailable.
  get hasPendingNativeDispatch(): boolean {
    const cell = pendingCell(); return !cell || cell.pending !== undefined;
  }
  get isActive(): boolean { return this.active !== undefined; }
  private configResolved = false;
  private resolvedConfigPath: unknown;
  private get configPath(): unknown {
    if (!this.configResolved) {
      this.configResolved = true; // Once per adapter lifetime, including invalid/missing/error.
      try { this.resolvedConfigPath = this.options.resolveConfigPath
        ? this.options.resolveConfigPath() : this.options.configPath; }
      catch { this.resolvedConfigPath = undefined; }
    }
    return this.resolvedConfigPath;
  }
  get configured(): boolean { const path = this.configPath; return typeof path === 'string' && isAbsolute(path); }
  currentObservation(ctx: Pick<HostContext, 'cwd' | 'sessionManager'>): HostObservation { return this.observe(ctx); }
  /** Same effect-free core plan, exposed internally without another config parser. */
  planForPoke(observed: Readonly<HostObservation>) {
    if (!this.configured || this.active || this.hasPendingNativeDispatch) return undefined;
    this.service ??= this.options.serviceFactory({ configPath: this.configPath as string });
    return this.service.planReminders({ observed });
  }
  planDue(observed: Readonly<HostObservation>): boolean {
    if (!this.configured || this.active || this.hasPendingNativeDispatch) return false;
    this.service ??= this.options.serviceFactory({ configPath: this.configPath as string });
    const plan = this.service.planReminders({ observed });
    return plan.status === 'ready' && plan.due_count > 0 && !this.hasPendingNativeDispatch;
  }
  private service?: NotificationServicePort;
  private epoch = 0;
  constructor(options: AdapterOptions) {
    this.options = options;
    this.canonicalize = options.canonicalize ?? realpathSync;
  }
  private observe(ctx: Pick<HostContext, 'cwd' | 'sessionManager'>): HostObservation {
    try {
      const cwd = ctx.cwd;
      const managerCwd = ctx.sessionManager.getCwd();
      const session = ctx.sessionManager.getSessionId();
      if (!isAbsolute(cwd) || !isAbsolute(managerCwd) || typeof session !== 'string' ||
          /^[A-Za-z0-9._-]{1,128}$/.exec(session)?.[0] !== session) throw new Error();
      const project = this.canonicalize(cwd);
      if (!isAbsolute(project) || project !== this.canonicalize(managerCwd)) throw new Error();
      return { session_id: session, project_path: project };
    } catch { throw new AdapterError('cancelled'); }
  }
  private fence(op: Operation): HostObservation {
    if (this.active !== op || !op.live || op.controller.signal.aborted || op.epoch !== this.epoch)
      throw new AdapterError('cancelled');
    let current: HostObservation;
    try { current = this.observe(op.ctx); }
    catch { this.invalidate(); throw new AdapterError('cancelled'); }
    if (!same(op.observed, current) || (op.admission && !op.admission.check(current))) {
      this.invalidate();
      throw new AdapterError('cancelled');
    }
    return current;
  }
  invalidate(): void {
    this.epoch++;
    const op = this.active;
    if (op) { op.live = false; op.controller.abort(); }
    // Persistent configured authorization remains in the core/config. The next
    // normal session constructs a fresh service, not an operator rebind.
    this.service = undefined;
  }
  private async nativeCall(op: Operation, name: typeof SEND | typeof READ,
    args: Record<string, unknown>, childSignal?: AbortSignal): Promise<NativeMcpResult> {
    this.fence(op);
    if (childSignal?.aborted) { this.invalidate(); throw new AdapterError('cancelled'); }
    const cell = pendingCell();
    if (op.callbackRunning || !cell || cell.pending !== undefined) throw new AdapterError('callback_failed');
    if (!op.ctx.tools.some(tool => tool.name === name)) throw new AdapterError('callback_failed');
    op.callbackRunning = true;
    const token = Symbol('pending-native');
    cell.pending = token;
    const childAbort = () => {
      // Child cancellation poisons this entire operation, not a settled-request
      // failure core can isolate. An old listener cannot revoke a newer operation.
      if (this.active === op && op.live) this.invalidate();
    };
    if (childSignal && !op.childAbortCleanups.has(childSignal)) {
      childSignal.addEventListener('abort', childAbort, { once: true });
      op.childAbortCleanups.set(childSignal, () => childSignal.removeEventListener('abort', childAbort));
    }
    const signal = childSignal ? AbortSignal.any([op.controller.signal, childSignal]) : op.controller.signal;
    try {
      if (childSignal?.aborted) childAbort();
      this.fence(op);
      const outcome = await op.ctx.executeTool(name, args, { signal });
      this.fence(op);
      if (!isObject(outcome) || outcome.isError !== false || !isObject(outcome.result))
        throw new AdapterError('callback_failed');
      // Core validates native content, structuredContent, isError and canonical
      // persistence; preserve the entire native result, never parse its prose.
      return outcome.result as NativeMcpResult;
    } catch (error) {
      this.fence(op);
      throw error instanceof AdapterError ? error : new AdapterError('callback_failed');
    } finally {
      // This finally follows actual executeTool settlement, NOT the run() race,
      // abort, lifecycle event, next slot or tool return. Never force-clear it.
      const currentCell = pendingCell();
      if (currentCell?.pending === token) currentCell.pending = undefined;
      // Child cancellation remains operation-poisoning after a settled read;
      // listeners are revoked in the originating operation's finally, not here.
      op.callbackRunning = false;
    }
  }
  private context(op: Operation): PublicationContext {
    return {
      operationId: op.id,
      observed: op.observed,
      signal: op.controller.signal,
      hostCheck: async () => this.fence(op),
      inboxSend: async args => {
        this.fence(op);
        if (!exact(args, ['body', 'idempotency_key']) || typeof args.body !== 'string' ||
            !args.body.trim() || Array.from(args.body).length > 16000 ||
            typeof args.idempotency_key !== 'string' || !args.idempotency_key ||
            args.idempotency_key.length > 512) throw new AdapterError('invalid_request');
        return this.nativeCall(op, SEND, { ...args,
          project_path: op.observed.project_path, agent_session: op.observed.session_id,
          agent_host: 'pi', agent_name: 'Pi notification publisher' });
      },
      inboxRead: async (args, options?: { signal?: AbortSignal }) => {
        this.fence(op);
        if (!exact(args, ['message_id', 'thread_id']) ||
            [args.message_id, args.thread_id].some(value => typeof value !== 'string' ||
              /^msg_[0-9A-HJKMNP-TV-Z]{26}$/i.exec(value)?.[0] !== value))
          throw new AdapterError('invalid_request');
        if (options !== undefined && (!isObject(options) || Object.keys(options).some(key => key !== 'signal')
            || (options.signal !== undefined && !(options.signal instanceof AbortSignal))))
          throw new AdapterError('invalid_request');
        return this.nativeCall(op, READ, { ...args,
          project_path: op.observed.project_path, agent_session: op.observed.session_id, format: 'full' }, options?.signal);
      },
    };
  }
  private validateReceipt(value: unknown, fyip: boolean): FYIPReceipt {
    if (!isObject(value) || !(fyip ? ['sent', 'duplicate', 'held', 'unknown', 'suppressed']
      : ['sent', 'duplicate', 'held', 'unknown']).includes(String(value.state)) ||
        ['admission', 'classification', 'delivery'].some(key => !isObject(value[key]) ||
          typeof value[key].status !== 'string' || value[key].status.length > 256))
      throw new AdapterError('internal_error');
    // Receipt semantics/secret safety belong to the single core, not this adapter.
    return value as unknown as FYIPReceipt;
  }
  async publish(args: unknown, ctx: HostContext, signal: AbortSignal | undefined): Promise<NotificationReceipt> {
    if (!validArguments(args)) throw new AdapterError('invalid_request');
    return this.run(args, ctx, signal, 'attention') as Promise<NotificationReceipt>;
  }
  async publishFYIP(args: unknown, ctx: HostContext, signal: AbortSignal | undefined): Promise<FYIPReceipt> {
    if (!validFYIPArguments(args)) throw new AdapterError('invalid_request');
    return this.run(args, ctx, signal, 'fyip') as Promise<FYIPReceipt>;
  }
  async publishOwnerRequest(args: unknown, ctx: HostContext, signal: AbortSignal | undefined): Promise<OwnerRequestReceipt> {
    if (!validArguments(args)) throw new AdapterError('invalid_request');
    return this.run(args, ctx, signal, 'owner') as Promise<OwnerRequestReceipt>;
  }
  async tickReminders(args: unknown, ctx: HostContext, signal: AbortSignal | undefined,
    take: (observed: HostObservation) => ReminderAdmission | undefined): Promise<ReminderTickReceipt> {
    if (!exact(args, [])) throw new AdapterError('invalid_request');
    return this.run(args as Record<string, never>, ctx, signal, 'tick', take) as Promise<ReminderTickReceipt>;
  }
  private async run(args: PublishArguments | PublishFYIPArguments | Record<string, never>, ctx: HostContext,
    signal: AbortSignal | undefined, mode: 'attention' | 'fyip' | 'owner' | 'tick',
    take?: (observed: HostObservation) => ReminderAdmission | undefined): Promise<FYIPReceipt | ReminderTickReceipt> {
    const snapshot = Object.freeze(structuredClone(args));
    if (this.active || this.hasPendingNativeDispatch) throw new AdapterError('busy');
    const configPath = this.configPath;
    if (typeof configPath !== 'string' || !isAbsolute(configPath))
      throw new AdapterError('configuration_unavailable');
    if (!signal || signal.aborted) throw new AdapterError('cancelled');
    const op: Operation = { id: randomUUID(), observed: Object.freeze(this.observe(ctx)), ctx,
      controller: new AbortController(), epoch: this.epoch, live: true, callbackRunning: false,
      childAbortCleanups: new Map() };
    this.active = op;
    const abort = () => this.invalidate();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let rejectAbort: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(new AdapterError('cancelled'));
      op.controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    // A synchronous constructor failure can precede Promise.race attachment.
    void cancelled.catch(() => {});
    try {
      if (mode === 'tick') {
        op.admission = take?.(this.observe(ctx));
        if (!op.admission) throw new AdapterError('cancelled');
        op.admission.signal.addEventListener('abort', abort, { once: true });
        if (op.admission.signal.aborted) abort();
      }
      this.fence(op);
      this.service ??= this.options.serviceFactory({ configPath });
      this.fence(op);
      const service = this.service;
      // Race revocation even if an uncooperative dependency ignores its signal.
      // All capabilities are fenced; a late core result is never returned.
      const work = Promise.resolve().then<FYIPReceipt | ReminderTickReceipt>(() => {
        this.fence(op);
        return mode === 'tick' ? service.tickReminders(snapshot as Record<string, never>, this.context(op))
          : mode === 'fyip' ? service.publishFYIP(snapshot as PublishFYIPArguments, this.context(op))
          : mode === 'owner' ? service.publishOwnerRequest(snapshot as PublishArguments, this.context(op))
          : service.publish(snapshot as PublishArguments, this.context(op));
      });
      const result = await Promise.race([work, cancelled]);
      this.fence(op);
      if (op.callbackRunning) throw new AdapterError('internal_error');
      if (mode === 'tick') {
        // Aggregate semantics/accounting and protected fields belong to core only.
        if (!isObject(result) || !['completed', 'incomplete', 'inactive', 'held'].includes(String(result.state)))
          throw new AdapterError('internal_error');
        return result as unknown as ReminderTickReceipt;
      }
      return this.validateReceipt(result, mode === 'fyip');
    } catch (error) {
      this.invalidate();
      throw error instanceof AdapterError ? error : new AdapterError('internal_error');
    } finally {
      op.live = false;
      op.admission?.signal.removeEventListener('abort', abort);
      op.admission?.close();
      for (const cleanup of op.childAbortCleanups.values()) cleanup();
      op.childAbortCleanups.clear();
      op.controller.signal.removeEventListener('abort', rejectAbort);
      op.controller.abort();
      signal.removeEventListener('abort', abort);
      if (this.active === op) this.active = undefined;
    }
  }
}
