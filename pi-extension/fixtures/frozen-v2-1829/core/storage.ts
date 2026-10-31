import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalPath } from './config.ts';
import { held } from './safety.ts';
export function privateFile(filename: string): void {
  const st = fs.lstatSync(filename);
  if (!st.isFile() || st.uid !== process.getuid?.() || st.nlink !== 1
      || (st.mode & 0o077) || (st.mode & 0o600) !== 0o600) held();
}
export function privateParent(filename: string): void {
  canonicalPath(filename, false);
  const st = fs.lstatSync(path.dirname(filename));
  if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o077)
      || (st.mode & 0o700) !== 0o700) held();
}
export function syncParent(filename: string): void {
  const fd = fs.openSync(path.dirname(filename), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export function existingDatabase(filename: string): DatabaseSync {
  privateParent(filename); privateFile(filename);
  for (const suffix of ['-wal', '-shm']) {
    try { privateFile(filename + suffix); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
  const db = new DatabaseSync(filename);
  try { db.exec('PRAGMA busy_timeout=10000; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON'); }
  catch (error) { db.close(); throw error; }
  return db;
}
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}
