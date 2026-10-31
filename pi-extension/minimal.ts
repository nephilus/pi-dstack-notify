import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createMinimalNotificationExtension } from './index.ts';

export { createMinimalNotificationExtension } from './index.ts';

/** Minimal default route: attention and curated FYIP ONLY; no automatic requests. */
export default function minimalNotificationExtension(pi: ExtensionAPI): void {
  createMinimalNotificationExtension()(pi);
}
