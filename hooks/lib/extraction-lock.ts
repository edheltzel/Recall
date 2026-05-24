// Extraction per-conversation lock — self-contained, no imports from src/
// Distinct from the semaphore (global capacity cap):
//   Semaphore = "are we under the max concurrent limit?" (global)
//   Lock       = "is THIS specific conversation already being extracted?" (per-conv mutex)
//
// All functions take dbPath as first parameter for testability.

import { Database } from 'bun:sqlite';
import { isPidAlive } from './pid-utils';

const DEFAULT_TTL_SECONDS = 600; // 10 minutes

function openDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  return db;
}

/**
 * Attempt to acquire a per-conversation extraction lock.
 *
 * Algorithm:
 *   1. Delete any expired row for this path (time-based TTL)
 *   2. INSERT OR IGNORE — atomic, only succeeds if no row exists
 *   3. Return whether we got the lock (changes > 0)
 *
 * @param dbPath      Path to SQLite database
 * @param convPath    Conversation file path (PK for the lock)
 * @param pid         PID of the acquiring process
 * @param ttlSeconds  Expiry threshold for stale lock cleanup (default 600)
 * @returns true if lock acquired, false if already held
 */
export function childAcquireLock(
  dbPath: string,
  convPath: string,
  pid: number,
  ttlSeconds?: number
): boolean {
  const ttl = ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const db = openDb(dbPath);
  try {
    // Remove expired lock for this specific path so it doesn't block us
    const cutoffSeconds = `-${ttl} seconds`;
    db.prepare(
      "DELETE FROM extraction_locks WHERE conversation_path = ? AND started_at < datetime('now', ?)"
    ).run(convPath, cutoffSeconds);

    // Atomic insert — OR IGNORE means we don't overwrite an active lock
    const result = db
      .prepare(
        "INSERT OR IGNORE INTO extraction_locks (conversation_path, pid, started_at) VALUES (?, ?, datetime('now'))"
      )
      .run(convPath, pid);

    return result.changes > 0;
  } finally {
    db.close();
  }
}

/**
 * Release the per-conversation lock.
 * Only removes the row if the PID matches — protects against releasing
 * a lock owned by a different process.
 *
 * @param dbPath   Path to SQLite database
 * @param convPath Conversation file path
 * @param pid      PID of the releasing process (must match stored PID)
 */
export function childReleaseLock(dbPath: string, convPath: string, pid: number): void {
  const db = openDb(dbPath);
  try {
    db.prepare(
      'DELETE FROM extraction_locks WHERE conversation_path = ? AND pid = ?'
    ).run(convPath, pid);
  } finally {
    db.close();
  }
}

/**
 * Check whether an active lock is held for a conversation path.
 * Used by the parent (RecallExtract) before deciding to spawn a child.
 *
 * A lock is considered held if:
 *   - A row exists for the path, AND
 *   - The row is not expired (within TTL), AND
 *   - The owning PID is still alive
 *
 * @param dbPath      Path to SQLite database
 * @param convPath    Conversation file path
 * @param ttlSeconds  Maximum lock age before considered expired (default 600)
 * @returns true if lock is actively held, false otherwise
 */
export function parentIsLockHeld(
  dbPath: string,
  convPath: string,
  ttlSeconds?: number
): boolean {
  const ttl = ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const db = openDb(dbPath);
  try {
    const row = db
      .prepare('SELECT pid, started_at FROM extraction_locks WHERE conversation_path = ?')
      .get(convPath) as { pid: number; started_at: string } | undefined;

    if (!row) return false;

    // Time-based expiry check
    const startedAt = new Date(row.started_at + 'Z'); // SQLite datetime is UTC, ensure parsed as UTC
    const ageSeconds = (Date.now() - startedAt.getTime()) / 1000;
    if (ageSeconds > ttl) return false;

    // PID liveness check
    return isPidAlive(row.pid);
  } finally {
    db.close();
  }
}
