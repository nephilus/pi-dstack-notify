/** Stable direct adapter boundary. Host observations are scope, not authority. */
export interface HostObservation { session_id: string; project_path: string }
/** Structured, presentation-only external review link; never a delivery identity. */
export interface ReviewLink { label: string; url: string }
/** Model-supplied assertions. Syntax is NOT proof of semantic event sameness. */
export interface PublishArguments { text: string; decision_key: string; revision: string; review_link?: ReviewLink }
export interface NativeMcpResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: unknown;
  [key: string]: unknown;
}
export interface PublicationContext {
  operationId: string;
  observed: Readonly<HostObservation>;
  signal: AbortSignal;
  hostCheck(): Promise<HostObservation>;
  inboxSend(args: { body: string; idempotency_key: string }): Promise<NativeMcpResult>;
  inboxRead(args: { message_id: string; thread_id: string }): Promise<NativeMcpResult>;
}
export interface DeliveryIdentity {
  profile_id: string; destination_id: string; decision_key: string;
  event_revision: string; purpose: string;
}
export interface DeliveryReceipt {
  identity: DeliveryIdentity;
  state: string; created_at: number; updated_at: number; confirmed_at: number | null;
  claim_id: string | null; confirmation_ref: string | null;
  source: string; migration_id: string | null;
}
/** Identity is pinned HTTPS origin + native request/message ID. Thread must match.
 * Project path/session are evidence, never a replay namespace. */
export interface CanonicalRequestCorrelation {
  authority: string; message_id: string; thread_id: string;
}
export interface CanonicalSendEvidence extends CanonicalRequestCorrelation {
  native_project_id: string; project_root: string; session_id: string;
}
export interface IdentityBinding {
  status: 'notification-only' | 'canonical-bound' | 'canonical-conflict';
  asserted: { decision_key: string; revision: string; revision_semantics: 'git-sha1' | 'content-sha256' };
  /** Immutable current ledger identity, distinct from canonical native identity. */
  notification_identity: DeliveryIdentity;
  canonical_request?: CanonicalRequestCorrelation;
}
export interface CanonicalTarget {
  project_id: string; project_root: string; session_id: string;
  message_id: string; thread_id: string;
  /** Exact model assertion verified as a persisted body marker, not a native
   * semantic hash independently computed from the event. */
  revision: string;
  revision_semantics: 'git-sha1' | 'content-sha256'; url: string;
}
export interface NotificationReceipt {
  state: 'sent' | 'duplicate' | 'held' | 'unknown';
  admission: {
    status: string; reason?: string; scope?: 'configured-project';
    inbox_target?: CanonicalTarget; reachability?: 'not_verified'; test_only?: true;
    identity_binding?: IdentityBinding;
  };
  classification: { status: string; choice?: string | null; bypass_reason?: string | null };
  delivery: { status: string; receipt?: DeliveryReceipt; test_only?: true };
}
export interface NotificationService {
  publish(args: PublishArguments, context: PublicationContext): Promise<NotificationReceipt>;
}
export type TelegramEntity =
  | { type: 'text_link'; offset: number; length: number; url: string }
  | { type: 'bold'; offset: number; length: number };
export interface TelegramMessage {
  text: string; entities: TelegramEntity[]; disable_notification: false;
  link_preview_options: { is_disabled: true };
}
/** Closed fake: no arbitrary network/delivery callback can be supplied. */
export interface TestTelegramTransport {
  readonly mode: 'test-only';
  readonly messages: readonly TelegramMessage[];
}
/** Branded construction-time HTTP fake. Its implementation is held privately. */
export interface TestTelegramHttpClient {
  readonly mode: 'test-http-only';
  readonly messages: readonly TelegramMessage[];
  readonly requests: readonly TestTelegramRequestRecord[];
}
export interface TestTelegramRequestRecord {
  readonly origin: 'https://api.telegram.org';
  readonly method: 'POST';
  readonly endpoint: '/bot[redacted]/sendMessage';
  readonly body_bytes: number;
  readonly chat_id: number;
  readonly message: TelegramMessage;
  readonly deadline_ms: 10000;
}
export interface NotificationServiceOptions {
  configPath?: string | null;
  /** Test-only, closed fake HTTP boundary; selected only at factory construction. */
  telegramHttpClient?: TestTelegramHttpClient;
  /** Backward-compatible closed fake; internally adapted through fake HTTP bytes. */
  telegramTransport?: TestTelegramTransport;
  knownSecrets?: readonly string[];
  /** Seconds since epoch, matching the accepted ledger schema. */
  clock?: () => number;
}
