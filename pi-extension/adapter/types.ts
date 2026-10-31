import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import type { NotificationService } from '../core/types.ts';

// Reuse the completed single core's canonical direct-interface types.
export type { HostObservation, PublishArguments, NativeMcpResult, NotificationReceipt,
  PublicationContext, PublishFYIPArguments, FYIPReceipt, OwnerRequestReceipt, ReminderTickReceipt } from '../core/types.ts';
export type NotificationServicePort = NotificationService;
export type ServiceFactory = (options: { configPath: string }) => NotificationService;
export type HostContext = Pick<ExtensionToolContext, 'cwd' | 'sessionManager' | 'tools' | 'executeTool'>;
