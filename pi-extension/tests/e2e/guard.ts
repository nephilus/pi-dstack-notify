// Pre-init test-only host resolution. Uses the actual host-provided TypeBox,
// never substitutes core/service.ts or any notification implementation.
import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const hostTypeboxURL = pathToFileURL(createRequire(import.meta.url).resolve('typebox')).href;
import '../adapter/deny-runtime.ts';

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'typebox') return {
    url: hostTypeboxURL,
    shortCircuit: true,
  };
  return next(specifier, context);
} });
