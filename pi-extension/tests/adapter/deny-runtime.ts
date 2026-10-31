// Preloaded before adapter/tests/core-spies initialize. No executable is on PATH.
// These guards prohibit process/network effects rather than faking a core engine.
import childProcess from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';

export const deniedAttempts: string[] = [];
function deny(kind: string): never {
  deniedAttempts.push(kind);
  throw new Error('offline_effect_forbidden');
}
process.env.PATH = '/__notification_no_executables__';
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
  Object.defineProperty(childProcess, name, { value: () => deny('child_process'), configurable: true, writable: true });
}
for (const [module, names] of [[net, ['connect', 'createConnection']],
  [http, ['request', 'get']], [https, ['request', 'get']], [tls, ['connect']]] as const) {
  for (const name of names) Object.defineProperty(module, name, {
    value: () => deny('network'), configurable: true, writable: true,
  });
}
Object.defineProperty(net.Socket.prototype, 'connect', { value: () => deny('socket'), configurable: true, writable: true });
globalThis.fetch = (() => deny('fetch')) as typeof fetch;
syncBuiltinESMExports();
