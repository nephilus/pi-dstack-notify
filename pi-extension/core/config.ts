import * as fs from 'node:fs';
import * as path from 'node:path';
import { digest, exact, held, strictJson } from './safety.ts';
export interface ProjectConfig {
  project_path: string; enabled: boolean; profile_path: string; ledger_path: string;
  policy: 'explicit_attention' | 'notification_product'; inbox_base_url: string;
}
export interface Configuration { enabled: boolean; projects: ProjectConfig[]; fingerprint: string }
export function canonicalPath(value: unknown, exists = true): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.startsWith('//')
      || value.length > 4096 || /[\x00-\x1f\x7f\\]/.test(value) || path.normalize(value) !== value) held();
  const parent = exists ? value : path.dirname(value);
  if (fs.realpathSync(parent) !== parent) held();
  return value;
}
export function canonicalDirectoryPath(value: unknown): string {
  const directory = canonicalPath(value);
  if (!fs.statSync(directory).isDirectory()) held();
  return directory;
}
export function privateBytes(filename: string): Buffer {
  canonicalPath(filename);
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1
        || (stat.mode & 0o077) || !(stat.mode & 0o400) || stat.size > 65536) held();
    const bytes = Buffer.alloc(65537); let count = 0;
    while (count < bytes.length) {
      const n = fs.readSync(fd, bytes, count, bytes.length - count, null);
      if (!n) break; count += n;
    }
    if (count > 65536) held();
    return bytes.subarray(0, count);
  } finally { fs.closeSync(fd); }
}
export function utf8(bytes: Uint8Array): string { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
export function pinnedBase(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('https://') || /[\x00-\x20\x7f-\uffff\\%?#]/.test(value)) held();
  const authority = value.slice('https://'.length).split('/')[0];
  const url = new URL(value);
  if (!authority || authority.includes('@') || url.protocol !== 'https:' || !url.hostname || url.username || url.password) held();
  return value;
}
export function loadConfiguration(filename?: string | null): Configuration {
  if (filename == null) return { enabled: false, projects: [], fingerprint: '' };
  const bytes = privateBytes(filename); const doc = strictJson(utf8(bytes));
  exact(doc, ['version', 'enabled', 'projects']);
  if (doc.version !== 1 || typeof doc.enabled !== 'boolean' || !Array.isArray(doc.projects) || doc.projects.length > 128) held();
  const roots = new Set<string>();
  for (const p of doc.projects) {
    exact(p, ['project_path', 'enabled', 'profile_path', 'ledger_path', 'policy', 'inbox_base_url']);
    canonicalDirectoryPath(p.project_path);
    // Disabled entries still require exact canonical absolute path spellings;
    // no profile is opened until a publication selects an enabled entry.
    canonicalPath(p.profile_path, false); canonicalPath(p.ledger_path, false);
    if (typeof p.enabled !== 'boolean' || !['explicit_attention','notification_product'].includes(p.policy) || roots.has(p.project_path)) held();
    pinnedBase(p.inbox_base_url); roots.add(p.project_path);
  }
  return { enabled: doc.enabled, projects: doc.projects, fingerprint: digest(bytes) };
}
export function selectProject(config: Configuration, root: string): ProjectConfig {
  const project = config.projects.find(p => p.project_path === root && p.enabled);
  if (!config.enabled || !project) held();
  return project;
}
