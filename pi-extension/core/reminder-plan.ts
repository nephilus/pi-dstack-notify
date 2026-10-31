import { isTestClefHttpClient } from './clef.ts';
import { canonicalDirectoryPath, loadConfiguration, selectProject } from './config.ts';
import { loadProfile, profileSecrets } from './profile.ts';
import { validateTelegramCredentials } from './telegram.ts';
import { isTestTelegramHttpClient, isTestTransport } from './transport.ts';
import { isTestOwnerEvidenceProvider, testOwnerOutcome } from './owner-evidence.ts';
import type { TestOwnerEvidenceProvider } from './owner-evidence.ts';
import { canonicalUTCSlot, reminderDeliveryIdentity } from './reminder-time.ts';
import { existingDatabase } from './storage.ts';
import { validateSchema } from './schema.ts';
import { validateDispatchFence } from './migration.ts';
import { exact, held, protectScalars, sessionPattern } from './safety.ts';
import type { DeliveryIdentity, HostObservation, NotificationServiceOptions } from './types.ts';

export interface ReminderPlan {
  readonly status: 'inactive' | 'held' | 'ready';
  readonly reason: 'no_due_work' | 'disabled' | 'owner_evidence_unavailable' | 'planning_held' | 'due_work';
  readonly utc_slot: string | null;
  readonly due_count: number;
}
export interface ReminderPlanner {
  /** Trusted host-only port. Ready is PROVISIONAL; this grants no native effect. */
  planReminders(input: { observed: Readonly<HostObservation> }): ReminderPlan;
}
export interface ReminderPlannerOptions extends NotificationServiceOptions {
  readonly ownerEvidenceProvider?: TestOwnerEvidenceProvider;
}
/** Nonpublic effect-free source port for the separately owned hourly controller.
 * No capabilities are accepted/stored. No timers, native/model/Telegram calls,
 * claims, cleanup or writer-mode DB initialization occur. */
export function createReminderPlanner(options: ReminderPlannerOptions): ReminderPlanner {
  const configPath = options.configPath, provider = options.ownerEvidenceProvider;
  const http = options.telegramHttpClient, legacy = options.telegramTransport;
  if ((provider !== undefined && !isTestOwnerEvidenceProvider(provider))
      || (http !== undefined && !isTestTelegramHttpClient(http))
      || (legacy !== undefined && !isTestTransport(legacy)) || (http && legacy)
      || (provider !== undefined && !http && !legacy)
      || (options.clefHttpClient !== undefined && (!isTestClefHttpClient(options.clefHttpClient) || (!http && !legacy)))
      || ((http || legacy) && options.clefConfigPath != null)) held();
  // Closed mode and all construction dependencies are captured before lookup.
  const testOnly = !!(http || legacy), ownerSupported = provider !== undefined && testOwnerOutcome(provider).outcome !== 'unknown';
  const hostSecrets = Object.freeze([...(options.knownSecrets ?? [])]);
  if (hostSecrets.length > 128 || hostSecrets.some(s => typeof s !== 'string' || !s || s.length > 8192)
      || (options.clock !== undefined && typeof options.clock !== 'function')) held();
  const clock = options.clock ?? (() => Date.now()/1000);
  return Object.freeze({ planReminders(input: { observed: Readonly<HostObservation> }): ReminderPlan {
    let utc_slot: string | null = null, secrets: readonly string[] = hostSecrets;
    const finish = (status: ReminderPlan['status'], reason: ReminderPlan['reason'], due_count = 0): ReminderPlan => {
      const result = Object.freeze({ status, reason, utc_slot, due_count });
      protectScalars(result,secrets); return result;
    };
    try {
      exact(input,['observed']); exact(input.observed,['session_id','project_path']);
      const observed = input.observed;
      if (!sessionPattern.test(observed.session_id)) held(); canonicalDirectoryPath(observed.project_path);
      utc_slot = canonicalUTCSlot(clock());
      const config = loadConfiguration(configPath);
      const project = config.projects.find(p => p.project_path === observed.project_path && p.enabled);
      if (!config.enabled || !project || project.policy !== 'notification_product') return finish('inactive','disabled');
      selectProject(config,observed.project_path);
      // Unsupported actual decoder MUST NOT produce pointless hourly AI turns.
      if (!ownerSupported) return finish('held','owner_evidence_unavailable');
      const profile = loadProfile(project.profile_path), credentials = profileSecrets(profile);
      validateTelegramCredentials(credentials); secrets = [...hostSecrets,...credentials];
      protectScalars([observed,profile.profile_id,profile.destination_id,project.inbox_base_url],secrets);
      const prefix = testOnly ? 'test-only.' : '';
      const profileId = prefix + profile.profile_id, destinationId = prefix + profile.destination_id;
      if (profileId.length > 128 || destinationId.length > 128) held();
      const db = existingDatabase(project.ledger_path,true);
      try {
        db.exec('BEGIN'); // Read snapshot, not BEGIN IMMEDIATE.
        validateSchema(db,3); validateDispatchFence(db,project.ledger_path);
        if (db.prepare('SELECT 1 FROM canonical_associations WHERE profile_id=? AND destination_id=? AND legacy_unmapped=1 LIMIT 1')
          .get(profileId,destinationId)) held();
        const rows = db.prepare(`SELECT * FROM pending_owner_requests WHERE profile_id=? AND destination_id=?
          AND project_root=? AND state='active'
          ORDER BY processing_sequence,created_at,decision_key,event_revision,purpose`).all(profileId,destinationId,observed.project_path);
        if (rows.length > 32) held();
        // Read first, then sample eligibility time. A plan never wakes for a
        // stale slot merely because private reads straddled the UTC boundary.
        const dueAt = clock(); utc_slot = canonicalUTCSlot(dueAt);
        let due = 0;
        for (const row of rows) {
          protectScalars({ ...row },secrets);
          if (row.snoozed_until !== null && Number(row.snoozed_until) > dueAt) continue;
          const key = reminderDeliveryIdentity(row as unknown as DeliveryIdentity,utc_slot);
          const existing = db.prepare(`SELECT 1 FROM deliveries WHERE profile_id=? AND destination_id=?
            AND decision_key=? AND event_revision=? AND purpose='reminder'`).get(profileId,destinationId,key.decision_key,key.event_revision);
          if (!existing) due++;
        }
        if (canonicalUTCSlot(clock()) !== utc_slot) held();
        db.exec('COMMIT');
        return due ? finish('ready','due_work',due) : finish('inactive','no_due_work');
      } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
    } catch {
      try { return finish('held','planning_held'); }
      catch {
        const fallback: ReminderPlan = Object.freeze({ status:'inactive',reason:'disabled',utc_slot:null,due_count:0 });
        try { protectScalars(fallback,secrets); return fallback; } catch { throw new Error('notification_held'); }
      }
    }
  } });
}
