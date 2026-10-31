import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { createNotificationService } from './core/service.ts';
import type { NotificationServiceOptions, PublishArguments, PublishFYIPArguments } from './core/types.ts';
import { registerNotificationExtension } from './adapter/register.ts';
import type { ReminderClock } from './adapter/reminder-scheduler.ts';
import { INPUT_SCHEMA, FYIP_INPUT_SCHEMA } from './adapter/schema.ts';
import type { PokeClock } from './adapter/poke-controller.ts';
import { POKE_HINT_SCHEMA } from './adapter/poke-hints.ts';

/** Construction-time core dependencies only; never tool/flag-selected transports.
 * The actual core enforces its branded closed fake transport boundary.
 */
type CoreDependencies = Omit<NotificationServiceOptions, 'configPath'>;
type HostDependencies = { reminderClock?: ReminderClock; pokeClock?: PokeClock };
function createExtension(
  coreDependencies: CoreDependencies,
  hostDependencies: HostDependencies,
  minimal: boolean,
): (pi: ExtensionAPI) => void {
  const dependencies = Object.freeze({ ...coreDependencies });
  const reminderClock = hostDependencies.reminderClock;
  return (pi: ExtensionAPI): void => {
    registerNotificationExtension(pi, {
      minimal,
      parameters: Type.Unsafe<PublishArguments>(INPUT_SCHEMA),
      tickParameters: Type.Object({}, { additionalProperties: false }),
      reminderClock, pokeClock: hostDependencies.pokeClock,
      pokeParameters: Type.Unsafe(POKE_HINT_SCHEMA),
      fyipParameters: Type.Unsafe<PublishFYIPArguments>(FYIP_INPUT_SCHEMA),
      serviceFactory: options => createNotificationService({ ...dependencies, configPath: options.configPath }),
    });
  };
}

/** Full roadmap entry retained; package selection is not a model permission. */
export function createNotificationExtension(coreDependencies: CoreDependencies = {}, hostDependencies: HostDependencies = {}) {
  return createExtension(coreDependencies, hostDependencies, false);
}
/** Minimal package entry shares the SAME publishers, core and native lifetime fences. */
export function createMinimalNotificationExtension(coreDependencies: CoreDependencies = {}, hostDependencies: HostDependencies = {}) {
  return createExtension(coreDependencies, hostDependencies, true);
}

// Default full entry is inert without configuration; valid enabled configuration uses
// the core's lazy fixed-origin production sender (never initialized at registration).
export default function notificationExtension(pi: ExtensionAPI): void {
  createNotificationExtension()(pi);
}
