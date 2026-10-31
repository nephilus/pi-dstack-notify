/** Source-shaped reproduction of accepted v1 version gate, not Python execution.
 * Used only against disposable fixture DBs to prove v2 is rejected before WAL.
 */
import type { DatabaseSync } from 'node:sqlite';
export function acceptedV1ReaderGate(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = (db.prepare('PRAGMA user_version').get() as any).user_version;
    if (version !== 0 && version !== 1) throw new Error('Unsupported delivery ledger schema version.');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
