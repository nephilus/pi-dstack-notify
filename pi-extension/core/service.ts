import { runReminderTick } from './reminder-workflow.ts';
import { createReminderPlanner } from './reminder-plan.ts';
import { isTestOwnerEvidenceProvider } from './owner-evidence.ts';
import { decodeOwnerObservation, ownerSourceRequest } from './owner-control.ts';
import { OwnerCapacityHeld } from './ledger.ts';
import type { OwnerRequestReceipt } from './types.ts';
import { isTestClefHttpClient, loadClefConfiguration, prepareClefPayload, classifyClef, curatedDisplay, CLEF_QUESTION_SHA256 } from './clef.ts';
import { admitFYIPCandidate, classifyFYIPAdmission, fyipLeadingStatus } from './fyip.ts';
import { digest } from './safety.ts';
import type { ClassificationResult } from './fyip.ts';
import type { PublishFYIPArguments, FYIPReceipt } from './types.ts';
import { loadConfiguration, selectProject, canonicalDirectoryPath } from './config.ts';
import { loadProfile, profileSecrets } from './profile.ts';
import { attentionBypass, renderAttention, preflightAttentionBounds } from './policy.ts';
import { held, exact, record, keyPattern, revisionPattern, sessionPattern, prepareBody, protect, protectScalars, validateReviewLink } from './safety.ts';
import { sendEvidence, verifyReadback } from './inbox.ts';
import { DeliveryLedger, CanonicalConflict, LegacyMappingRequired } from './ledger.ts';
import { isTestTransport, isTestTelegramHttpClient } from './transport.ts';
import { httpTestTelegramMode, legacyTestTelegramMode, productionTelegramMode, sendTelegram, validateTelegramCredentials } from './telegram.ts';
import type { Claim } from './ledger.ts';
import type { NotificationService, NotificationServiceOptions, NotificationReceipt, HostObservation, DeliveryIdentity, PublicationContext, PublishArguments, IdentityBinding } from './types.ts';
export type * from './types.ts';
function hold(reason: string, unknown = false): NotificationReceipt {
  return { state: unknown ? 'unknown' : 'held', admission: { status: 'held', reason },
    classification: attentionBypass(), delivery: { status: unknown ? 'delivery-unknown' : 'not_attempted' } };
}
function observation(value: unknown): HostObservation {
  exact(value, ['session_id', 'project_path']);
  if (typeof value.session_id !== 'string' || !sessionPattern.test(value.session_id)) held();
  canonicalDirectoryPath(value.project_path);
  return { session_id: value.session_id, project_path: value.project_path };
}
function argumentsOf(value: unknown): PublishArguments {
  if (!record(value)) held();
  const hasLink = Object.hasOwn(value, 'review_link');
  exact(value, hasLink ? ['text', 'decision_key', 'revision', 'review_link'] : ['text', 'decision_key', 'revision']);
  if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 16000
      || typeof value.decision_key !== 'string' || !keyPattern.test(value.decision_key)
      || typeof value.revision !== 'string' || !revisionPattern.test(value.revision)) held();
  const link = hasLink ? validateReviewLink(value.review_link) : undefined;
  return { text: value.text, decision_key: value.decision_key, revision: value.revision, ...(link ? { review_link: link } : {}) };
}
function testReceipt<T extends FYIPReceipt>(receipt: T, enabled: boolean): T {
  if (enabled) { receipt.admission.test_only = true; receipt.delivery.test_only = true; }
  return receipt;
}
function safeReceipt(value: unknown, secrets: readonly string[], includeKeys = false): void {
  protectScalars(value, secrets);
  if (!includeKeys) return;
  const visit = (item: unknown): void => {
    if (!item || typeof item !== 'object') return;
    if (Array.isArray(item)) { for (const child of item) visit(child); return; }
    for (const [key,child] of Object.entries(item)) { protect([key],secrets); visit(child); }
  };
  visit(value);
}
/** Never reflect a rejected assembled receipt or disturb its durable terminal row. */
function protectedReceipt<T extends FYIPReceipt>(receipt: T, secrets: readonly string[], testOnly: boolean,
  attempted: boolean, includeKeys = false): T | NotificationReceipt {
  const result = testReceipt(receipt, testOnly);
  try { safeReceipt(result, secrets, includeKeys); return result; } catch { /* Redact the whole receipt. */ }
  const redacted = testReceipt(hold('receipt_protected', attempted), testOnly);
  // Redaction must not invent attention bypass for a FYIP operation. Preserve
  // request-specific provenance only if the complete replacement is safe;
  // otherwise the opaque fallback below makes no classification claim.
  redacted.classification = { ...receipt.classification };
  try { safeReceipt(redacted, secrets, includeKeys); return redacted; } catch { /* Fixed fallback also protected. */ }
  // Empty status strings cannot contain a nonempty protected value. Preserve an
  // honest held/unknown outcome, with no identity/body/metadata from the failure.
  for (const state of (attempted ? ['unknown'] : ['held', 'unknown']) as Array<'held' | 'unknown'>) {
    const fallback: NotificationReceipt = testReceipt({ state, admission: { status: '' },
      classification: { status: '' }, delivery: { status: '' } }, testOnly);
    try { safeReceipt(fallback, secrets, includeKeys); return fallback; } catch { /* Try a safe non-success state. */ }
  }
  // No non-success receipt can satisfy this pathological protected-state set.
  // A fixed controlled rejection is safer than returning a protected value.
  throw new Error('notification_held');
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('notification_held'));
    if (signal.aborted) { promise.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(v => { signal.removeEventListener('abort', abort); resolve(v); },
      () => { signal.removeEventListener('abort', abort); reject(new Error('notification_held')); });
  });
}
/** Lazy fixed Telegram sender; no Python, subprocess, fallback profile or public raw sender. */
export function createNotificationService(options: NotificationServiceOptions): NotificationService {
  const configPath = options.configPath;
  const httpClient = options.telegramHttpClient;
  const transport = options.telegramTransport;
  if ((httpClient !== undefined && !isTestTelegramHttpClient(httpClient))
      || (transport !== undefined && !isTestTransport(transport)) || (httpClient !== undefined && transport !== undefined)) held();
  // Mode is frozen at construction and cannot be switched by a publication or tool argument.
  const mode = httpClient ? httpTestTelegramMode(httpClient)
    : transport ? legacyTestTelegramMode(transport) : productionTelegramMode();
  const clefClient = options.clefHttpClient;
  const clefConfigPath = options.clefConfigPath;
  const ownerProvider = options.ownerEvidenceProvider;
  if ((clefClient !== undefined && !isTestClefHttpClient(clefClient))
      || (ownerProvider !== undefined && !isTestOwnerEvidenceProvider(ownerProvider))
      || ((clefClient !== undefined || ownerProvider !== undefined) && !mode.testOnly)
      || (mode.testOnly && clefConfigPath != null)
      || (clefClient !== undefined && clefConfigPath != null)) held();
  // A fake Telegram operation cannot ever dispatch a production classifier.
  const planner = createReminderPlanner(options);
  const secretsFromHost = Object.freeze([...(options.knownSecrets ?? [])]);
  const clock = options.clock;
  const tickMonotonicClock=options.tickMonotonicClock;
  if(tickMonotonicClock!==undefined&&(!mode.testOnly||typeof tickMonotonicClock!=='function'))held();
  if (secretsFromHost.length > 128 || secretsFromHost.some(s => typeof s !== 'string' || !s || s.length > 8192)
      || (clock !== undefined && typeof clock !== 'function')) held();
  // Validate startup config, but reread it for every request and effect gate.
  // Missing config disables; invalid explicit config throws only a controlled code.
  try { loadConfiguration(configPath); } catch { throw new Error('configuration_unavailable'); }
  const tickOptions=Object.freeze({configPath,knownSecrets:secretsFromHost,clock,tickMonotonicClock,ownerEvidenceProvider:ownerProvider});
  let active = false;
  async function run(input: PublishArguments | PublishFYIPArguments, context: PublicationContext, fyip: boolean, owner = false): Promise<FYIPReceipt> {
      if (active) {
        const busy = hold('busy'); if (fyip) busy.classification = {status:'not_run'};
        if(owner)busy.classification={status:'bypassed',choice:null,bypass_reason:'owner_request'};
        return protectedReceipt(busy, secretsFromHost, mode.testOnly, false, fyip || owner);
      }
      active = true;
      let ledger: DeliveryLedger | undefined, identity: DeliveryIdentity | undefined, claim: Claim | undefined;
      let binding: IdentityBinding | undefined;
      let classification: ClassificationResult | undefined;
      let decisionClaim: string | undefined;
      let decisionFinished = false;
      let receiptSecrets: readonly string[] = secretsFromHost;
      const finish = (receipt: FYIPReceipt): FYIPReceipt => {
        if (binding) receipt.admission.identity_binding = structuredClone(binding);
        if(owner){
          receipt.classification={status:'bypassed',choice:null,bypass_reason:'owner_request'};
          (receipt as OwnerRequestReceipt).tracking={status:ledger&&identity?ledger.ownerTracking(identity):'not_enrolled'};
        }
        if (fyip && receipt.state !== 'suppressed') receipt.classification = classification
          ? { status: classification.status, choice: classification.choice }
          : { status:'not_run' };
        return protectedReceipt(receipt, receiptSecrets, mode.testOnly, claim !== undefined, fyip || owner);
      };
      try {
        let args: PublishArguments;
        if (fyip) {
          const value = input as PublishFYIPArguments;
          exact(value,Object.hasOwn(value,'review_link') ? ['candidate','decision_key','revision','review_link'] : ['candidate','decision_key','revision']);
          // Validate the original identity and review shape without imposing a prose alphabet on admission.
          args = argumentsOf({ text:'FYIP',decision_key:value.decision_key,revision:value.revision,
            ...(Object.hasOwn(value,'review_link') ? { review_link:value.review_link } : {}) });
          if (!admitFYIPCandidate(value.candidate).admitted) return finish(hold('candidate_not_admitted'));
        } else args = argumentsOf(input);
        if (!context || typeof context.operationId !== 'string' || !/^[A-Za-z0-9._-]{1,80}$(?![\s\S])/.test(context.operationId)
            || !(context.signal instanceof AbortSignal) || context.signal.aborted
            || [context.hostCheck, context.inboxSend, context.inboxRead].some(f => typeof f !== 'function')) held();
        const observed = observation(context.observed);
        const signal = context.signal;
        const hostCallback = context.hostCheck.bind(context);
        const sendCallback = context.inboxSend.bind(context);
        const readCallback = context.inboxRead.bind(context);
        const config = loadConfiguration(configPath), project = selectProject(config, observed.project_path);
        const profile = loadProfile(project.profile_path);
        const profileCredentials = profileSecrets(profile);
        // A validation failure can collide with a credential-shaped reason.
        // Protect already-read private values BEFORE any subsequent throw.
        receiptSecrets = [...secretsFromHost, ...profileCredentials];
        const telegramCredentials = validateTelegramCredentials(profileCredentials);
        if ((fyip || owner) && project.policy !== 'notification_product') held();
        // Private Clef reads happen only after deterministic admission and enabled scope.
        // Missing/invalid private config becomes unavailable, never a public selector.
        let clefConfig: ReturnType<typeof loadClefConfiguration> = null;
        if (fyip && !mode.testOnly) { try { clefConfig = loadClefConfiguration(clefConfigPath); } catch { /* admitted unavailable */ } }
        const secrets = [...secretsFromHost, ...profileCredentials, ...(clefConfig ? [clefConfig.key] : [])];
        receiptSecrets = secrets;
        // Unsupported actual OWNER decoding cannot publish a supposedly tracked
        // original. This is before any ledger lookup/reservation/native effect.
        if(owner&&!ownerProvider)return finish(hold('owner_evidence_unavailable'));
        if (fyip || owner) protect(['state','admission','classification','delivery','status','reason','scope','inbox_target','reachability',
          'test_only','identity_binding','asserted','decision_key','revision','revision_semantics','notification_identity',
          'canonical_request','authority','message_id','thread_id','profile_id','destination_id','event_revision','purpose',
          'project_id','project_root','session_id','url','choice','receipt','identity','created_at','updated_at','confirmed_at',
          'claim_id','confirmation_ref','source','migration_id','bypass_reason',...(owner ? ['tracking'] : [])],secrets);
        if(owner)protectScalars(['owner_request','not_enrolled','reserved_unknown','active','paused_answer',
          'bypassed','explicit_attention','live','in_flight','delivery_unknown','busy',
          'owner_evidence_unavailable','owner_capacity_held','receipt_protected','publication_or_delivery_unknown_no_retry',
          'configured_admission_held','legacy_history_unmapped','canonical_identity_conflict','prior_attempt_terminal'],secrets);
        // Predictable binding/classification/provenance metadata must not first
        // discover a protected fixed-string collision after a durable effect.
        protectScalars(['notification-only', 'canonical-bound', 'canonical-conflict',
          'git-sha1', 'content-sha256', 'sent', 'duplicate', 'held', 'unknown',
          'admitted', 'configured-project', 'not_verified', 'delivery-confirmed',
          'delivery-unknown', 'not_attempted', attentionBypass()], secrets);
        protect([args.decision_key, args.revision, profile.profile_id, profile.destination_id,
          observed.session_id, observed.project_path, project.inbox_base_url,
          ...(args.review_link ? [args.review_link.label, args.review_link.url] : [])], secrets);
        // FYIP decision metadata and complete possible receipts preflight before decision claim/model HTTP.
        if (fyip) {
          const admission = admitFYIPCandidate((input as PublishFYIPArguments).candidate,
            secrets.filter(s => [...s].length <= 4096).slice(0,32));
          if (!admission.admitted) return finish(hold('candidate_not_admitted'));
          protectScalars(['fyip','suppressed','not_run','classified_yes','classified_no','fallback_unavailable',
            'fallback_uncertain','fallback_invalid','fallback_error','yes','no','not_attempted',
            'candidate_not_admitted','candidate_evidence_changed','classification_interrupted','prior_attempt_terminal',
            'receipt_protected','publication_or_delivery_unknown_no_retry','configured_admission_held',
            'canonical_identity_conflict','legacy_history_unmapped','live','in_flight','delivery_unknown'],secrets);
          protectScalars(['classified_yes','fallback_unavailable','fallback_uncertain','fallback_invalid','fallback_error']
            .map(status => fyipLeadingStatus(status as ClassificationResult['status'])),secrets);
          const prefix = mode.testOnly ? 'test-only.' : '';
          if (profile.profile_id.length + prefix.length > 128 || profile.destination_id.length + prefix.length > 128) held();
          identity = { profile_id:prefix + profile.profile_id,destination_id:prefix + profile.destination_id,
            decision_key:args.decision_key,event_revision:args.revision,purpose:'fyip' };
          protect(Object.values(identity),secrets);
          // Preflight all predictable FYIP fixed sections with safe placeholder
          // prose, without imposing publication grammar on the admitted context.
          const fixedBody = prepareBody('FYIP',observed.session_id,args.revision,secrets,args.review_link);
          const maxNativeId = 'msg_' + '0'.repeat(26);
          for (const status of ['classified_yes','fallback_unavailable','fallback_uncertain','fallback_invalid','fallback_error'] as const) {
            preflightAttentionBounds(project.inbox_base_url,observed.session_id,args.revision,args.review_link,status);
            renderAttention(fixedBody,{project_id:'',project_root:observed.project_path,session_id:observed.session_id,
              message_id:maxNativeId,thread_id:maxNativeId,revision:args.revision,
              revision_semantics:args.revision.length === 40 ? 'git-sha1' : 'content-sha256',
              url:project.inbox_base_url + '#thread=' + maxNativeId},secrets,args.review_link,status);
          }
          const payload = prepareClefPayload(admission.context,clefConfig,secrets);
          const initialConfigFingerprint = clefConfig?.fingerprint;
          const classificationGuard = async (): Promise<void> => {
            const check = (): void => {
              if (signal.aborted) held();
              ledger?.checkFence();
              const current = loadConfiguration(configPath), selected = selectProject(current,observed.project_path);
              if (current.fingerprint !== config.fingerprint || loadProfile(selected.profile_path).fingerprint !== profile.fingerprint) held();
              if (initialConfigFingerprint && loadClefConfiguration(clefConfigPath)?.fingerprint !== initialConfigFingerprint) held();
            };
            check();
            const host = observation(await abortable(Promise.resolve(hostCallback()),signal));
            check();
            if (host.session_id !== observed.session_id || host.project_path !== observed.project_path) held();
          };
          await classificationGuard();
          ledger = new DeliveryLedger(project.ledger_path,clock,3);
          const decision = ledger.claimFYIP(identity,{ candidate_sha256:digest(JSON.stringify(admission.context)),
            question_sha256:CLEF_QUESTION_SHA256, config_sha256:clefConfig?.fingerprint ?? digest(mode.testOnly ? 'closed-test-clef' : 'unavailable') });
          if (decision.action === 'held') return finish(hold('classification_interrupted'));
          if (decision.action === 'claimed') {
            decisionClaim = decision.claim_id;
            await classificationGuard();
            const result = await classifyClef(clefConfig,clefClient,payload,signal,secrets);
            await classificationGuard();
            classification = classifyFYIPAdmission(admission,result);
            ledger.decideFYIP(identity,decision.claim_id,classification.status,classification.choice);
            decisionFinished = true;
          } else {
            classification = classifyFYIPAdmission(admission, decision.choice
              ? {kind:'response',value:decision.choice} : {kind:'unavailable'});
            classification = { ...classification,status:decision.status as ClassificationResult['status'] };
          }
          if (!classification.eligible) return finish({ state:'suppressed',admission:{status:'admitted'},
            classification:{status:'classified_no',choice:'no'},delivery:{status:'not_attempted'} });
          // Fingerprints never reset identity or permit a second model decision.
          // A changed candidate cannot borrow a frozen YES to start a NEW effect;
          // existing delivery history still takes the ordinary terminal path.
          if (decision.candidate_sha256 !== digest(JSON.stringify(admission.context)) && !ledger.inspect(identity))
            return finish(hold('candidate_evidence_changed'));
          args.text = curatedDisplay(admission.context);
        }
        const body = prepareBody(args.text, observed.session_id, args.revision, secrets, args.review_link);
        preflightAttentionBounds(project.inbox_base_url, observed.session_id, args.revision, args.review_link, classification?.status, owner);
        // Check generated provenance, fixed sections and truncation boundaries before claim too.
        // Native identifiers are fixed-width; actual readback is independently rechecked below.
        const maxId = 'msg_' + '0'.repeat(26);
        renderAttention(body, { project_id: '', project_root: observed.project_path, session_id: observed.session_id,
          message_id: maxId, thread_id: maxId, revision: args.revision,
          revision_semantics: args.revision.length === 40 ? 'git-sha1' : 'content-sha256',
          url: project.inbox_base_url + '#thread=' + maxId }, secrets, args.review_link, classification?.status, owner);
        // Only fake modes use the non-production namespace; production uses the exact profile IDs.
        const prefix = mode.testOnly ? 'test-only.' : '';
        if (profile.profile_id.length + prefix.length > 128 || profile.destination_id.length + prefix.length > 128) held();
        identity = { profile_id: prefix + profile.profile_id, destination_id: prefix + profile.destination_id,
          decision_key: args.decision_key, event_revision: args.revision, purpose: fyip ? 'fyip' : owner ? 'owner_request' : 'explicit_attention' };
        protect(Object.values(identity), secrets);
        binding = { status: 'notification-only', notification_identity: { ...identity },
          asserted: { decision_key: args.decision_key, revision: args.revision,
            revision_semantics: args.revision.length === 40 ? 'git-sha1' : 'content-sha256' } };
        const guard = (): void => {
          if (signal.aborted) held();
          ledger?.checkFence();
          const current = loadConfiguration(configPath), selected = selectProject(current, observed.project_path);
          const currentProfile = loadProfile(selected.profile_path);
          if (current.fingerprint !== config.fingerprint || currentProfile.fingerprint !== profile.fingerprint) held();
          if (clefConfig && loadClefConfiguration(clefConfigPath)?.fingerprint !== clefConfig.fingerprint) held();
          if (signal.aborted) held();
        };
        const hostCheck = async (): Promise<void> => {
          guard(); const host = observation(await abortable(Promise.resolve(hostCallback()), signal)); guard();
          if (host.session_id !== observed.session_id || host.project_path !== observed.project_path) held();
        };
        guard(); ledger ??= new DeliveryLedger(project.ledger_path, clock, project.policy === 'notification_product' ? 3 : undefined);
        claim = owner ? ledger.reserveOwnerRequest(identity,{body,project_root:observed.project_path,
          session_id:observed.session_id,...(args.review_link?{review_link:args.review_link}:{})}) : ledger.claim(identity);
        safeReceipt(claim.receipt, secrets);
        const knownCanonical = ledger.canonicalFor(identity);
        if (knownCanonical) {
          safeReceipt(knownCanonical, secrets);
          binding.canonical_request = knownCanonical; binding.status = 'canonical-bound';
        }
        if (claim.action === 'suppressed') return finish({ state: 'duplicate', admission: { status: 'duplicate' },
          classification: attentionBypass(), delivery: { status: 'delivery-confirmed', receipt: claim.receipt } });
        if (claim.action !== 'claimed') return finish(hold('prior_attempt_terminal', true));
        await hostCheck(); guard();
        const sent = await abortable(Promise.resolve(sendCallback({ body, idempotency_key: claim.receipt.claim_id! })), signal);
        // Persist validated known native IDs BEFORE full read/config recheck.
        // Cancellation or failed read must not erase already observed correlation.
        const evidence = sendEvidence(sent, observed, project.inbox_base_url, secrets);
        binding.canonical_request = { authority: evidence.authority, message_id: evidence.message_id, thread_id: evidence.thread_id };
        ledger.associate(identity, claim.receipt.claim_id!, evidence);
        binding.status = 'canonical-bound';
        guard(); await hostCheck(); guard();
        const read = await abortable(Promise.resolve(readCallback({ message_id: evidence.message_id, thread_id: evidence.thread_id })), signal);
        guard();
        const target = verifyReadback(sent, read, { observed, body, revision: args.revision,
          base: project.inbox_base_url, review_link: args.review_link }, secrets);
        if(owner){
          const original={identity:{...identity},target,body,...(args.review_link?{review_link:args.review_link}:{})};
          const sourceRequest=ownerSourceRequest(ownerProvider!,original);
          let source=null;
          if(sourceRequest){await hostCheck();guard();source=await abortable(Promise.resolve(readCallback(sourceRequest,{signal})),signal);guard();}
          const observation=decodeOwnerObservation(ownerProvider!,original,read,source,secrets);
          guard();ledger.activateOwnerRequest(identity,claim.receipt.claim_id!,target,observation);
        }else ledger.associate(identity, claim.receipt.claim_id!, evidence, true);
        const message = renderAttention(body, target, secrets, args.review_link, classification?.status, owner);
        await hostCheck(); guard();
        const messageId = await abortable(sendTelegram(message, telegramCredentials, secrets, signal, mode), signal);
        guard();
        const receipt = ledger.confirmed(identity, claim.receipt.claim_id!, messageId);
        safeReceipt(receipt, secrets);
        return finish({ state: 'sent', admission: { status: 'admitted', scope: 'configured-project', inbox_target: target,
          reachability: 'not_verified' }, classification: attentionBypass(),
          delivery: { status: 'delivery-confirmed', receipt } });
      } catch (error) {
        if (ledger && identity && decisionClaim && !decisionFinished) {
          try { ledger.interruptFYIP(identity,decisionClaim); } catch { /* classifying is equally terminal-held. */ }
        }
        if (ledger && identity && claim?.action === 'claimed') {
          try { ledger.unknown(identity, claim.receipt.claim_id!); } catch { /* In-flight remains terminal. */ }
          if (error instanceof CanonicalConflict) {
            if (binding) binding.status = 'canonical-conflict';
            const result = hold('canonical_identity_conflict', true); result.state = 'held';
            return finish(result);
          }
          return finish(hold('publication_or_delivery_unknown_no_retry', true));
        }
        return finish(hold(error instanceof LegacyMappingRequired ? 'legacy_history_unmapped'
          : error instanceof OwnerCapacityHeld ? 'owner_capacity_held' : 'configured_admission_held'));
      } finally { try { ledger?.close(); } catch { /* Never expose filesystem/SQLite details. */ } active = false; }
  }
  return Object.freeze({
    tickReminders: async (input:Record<string,never>,context:PublicationContext) => {
      if(active)return runReminderTick(input,context,tickOptions,mode,safeReceipt,true);
      active=true;
      try{return await runReminderTick(input,context,tickOptions,mode,safeReceipt);}
      finally{active=false;}
    },
    publish: (input: PublishArguments,context: PublicationContext) => run(input,context,false) as Promise<NotificationReceipt>,
    publishOwnerRequest: (input:PublishArguments,context:PublicationContext)=>run(input,context,false,true) as Promise<OwnerRequestReceipt>,
    publishFYIP: (input: PublishFYIPArguments,context: PublicationContext) => run(input,context,true),
    planReminders: planner.planReminders,
  });
}
