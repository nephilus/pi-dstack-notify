import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const hostRequire = createRequire(import.meta.url);
export const HOST_TYPEBOX_URL = pathToFileURL(hostRequire.resolve('typebox')).href;
export const UNIT_ENTRY_URL = new URL('../../index.ts?adapter-unit', import.meta.url).href;

/** Test-only hooks: both substitutions require the exact queried unit parent.
 * The explicit host resolver keeps the adapter-only command self-contained.
 * No ordinary entry's core-service edge is replaced.
 */
export function installUnitEntryHook(onActualTypebox?: (parent: string | undefined, url: string) => void): () => void {
  const host = registerHooks({ resolve(specifier, context, next) {
    if (specifier === 'typebox') return { url: HOST_TYPEBOX_URL, shortCircuit: true };
    return next(specifier, context);
  } });
  const unit = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL === UNIT_ENTRY_URL) {
      if (specifier === 'typebox') return {
        url: 'data:text/javascript,export const Type={Unsafe:s=>s,Object:(properties,options)=>({type:"object",properties,...options})}', shortCircuit: true,
      };
      if (specifier === './core/service.ts') return {
        url: 'data:text/javascript,export function createNotificationService(){throw Error("must remain lazy")}',
        shortCircuit: true,
      };
    }
    const resolved = next(specifier, context);
    if (specifier === 'typebox') onActualTypebox?.(context.parentURL, resolved.url);
    return resolved;
  } });
  return () => { unit.deregister(); host.deregister(); };
}
