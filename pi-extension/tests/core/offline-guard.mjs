// Preload before tests. No process, Python, shell, model or network fallback.
import child from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
export const attempts = [];
const deny = name => () => { attempts.push(name); throw new Error('offline test boundary'); };
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) child[name] = deny(name);
for (const target of [net, tls]) for (const name of ['connect', 'createConnection']) if (name in target) target[name] = deny(name);
net.Socket.prototype.connect = deny('Socket.connect');
for (const target of [http, https]) for (const name of ['request', 'get']) target[name] = deny(name);
globalThis.fetch = deny('fetch');
process.env.PATH = '/nonexistent-notification-test-path';
delete process.env.PYTHON;
delete process.env.PYTHONPATH;
syncBuiltinESMExports();
