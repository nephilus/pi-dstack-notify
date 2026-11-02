import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';

/** Package-owned location, not a Pi setting or an environment credential selector. */
export function defaultConfigurationPath(): string {
  return join(homedir(), '.pi-dstack-notify', 'config.json');
}
function lexicalPath(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value) && !value.startsWith('//')
    && value.length <= 4096 && !/[\x00-\x1f\x7f\\]/.test(value) && normalize(value) === value;
}
/** Call only after host flag binding. Filesystem/private checks stay operation-time. */
export function selectConfigurationPath(readFlag: () => unknown, packageDefault = true): string | undefined {
  try {
    const flag = readFlag();
    const selected = flag === undefined && packageDefault ? defaultConfigurationPath() : flag;
    return lexicalPath(selected) ? selected : undefined;
  } catch { return undefined; }
}
