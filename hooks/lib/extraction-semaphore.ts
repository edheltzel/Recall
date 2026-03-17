// Extraction counting semaphore — self-contained, no imports from src/
// All functions take dbPath as first parameter for testability.

import { Database } from 'bun:sqlite';
import { isPidAlive } from './pid-utils';

const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_TTL_SECONDS = 600; // 10 minutes

function openDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  return db;
}

/**
 * Sweep expired locks from extraction_locks.
 * Two strategies combined:
 *   1. Time-based: remove rows where started_at older than TTL seconds
 *   2. PID liveness: remove rows where the owning PID is dead
 *
 * @param dbPath      Path to SQLite database
 * @param ttlSeconds  Lock TTL in seconds (default 600)
 * @returns Number of locks removed
 */
export function sweepExpiredLocks(dbPath: string, ttlSeconds?: number): number {
  const ttl =
    ttlSeconds ??
    parseInt(process.env.EXTRACTION_LOCK_TTL_SECONDS || String(DEFAULT_TTL_SECONDS), 10);

  const db = openDb(dbPath);
  try {
    // Strategy 1: time-based TTL sweep using bound parameter
    const cutoffSeconds = `-${ttl} seconds`;
    const timeResult = db
      .prepare("DELETE FROM extraction_locks WHERE started_at < datetime('now', ?)")
      .run(cutoffSeconds);
    let removed = timeResult.changes;

    // Strategy 2: PID liveness sweep — check all remaining locks
    interface LockRow {
      conversation_path: string;
      pid: number;
    }
    const remaining = db
      .prepare('SELECT conversation_path, pid FROM extraction_locks')
      .all() as LockRow[];

    for (const row of remaining) {
      if (!isPidAlive(row.pid)) {
        const pidResult = db
          .prepare('DELETE FROM extraction_locks WHERE conversation_path = ? AND pid = ?')
          .run(row.conversation_path, row.pid);
        removed += pidResult.changes;
      }
    }

    return removed;
  } finally {
    db.close();
  }
}

/**
 * Get the current count of active locks.
 */
export function getActiveLockCount(dbPath: string): number {
  const db = openDb(dbPath);
  try {
    const row = db
      .prepare('SELECT COUNT(*) as cnt FROM extraction_locks')
      .get() as { cnt: number };
    return row.cnt;
  } finally {
    db.close();
  }
}

/**
 * Try to acquire a semaphore slot for the given conversation path.
 *
 * Algorithm:
 *   1. Sweep expired locks (time-based + PID liveness)
 *   2. Count active locks
 *   3. If >= maxConcurrent, return false
 *   4. INSERT OR IGNORE — if changes > 0, we got the slot
 *   5. Return whether acquired
 *
 * @param dbPath         Path to SQLite database
 * @param convPath       Conversation path (PK for the lock)
 * @param pid            PID of the acquiring process
 * @param maxConcurrent  Maximum concurrent slots (default 3)
 * @param ttlSeconds     Lock TTL for sweep (default 600)
 * @returns true if acquired, false if rejected
 */
export function acquireSemaphore(
  dbPath: string,
  convPath: string,
  pid: number,
  maxConcurrent: number = DEFAULT_MAX_CONCURRENT,
  ttlSeconds?: number
): boolean {
  const ttl =
    ttlSeconds ??
    parseInt(process.env.EXTRACTION_LOCK_TTL_SECONDS || String(DEFAULT_TTL_SECONDS), 10);

  const db = openDb(dbPath);
  try {
    // Single transaction: sweep + count + insert to prevent TOCTOU
    db.exec('BEGIN IMMEDIATE');
    try {
      // Sweep expired locks (time-based)
      const cutoffSeconds = `-${ttl} seconds`;
      db.prepare("DELETE FROM extraction_locks WHERE started_at < datetime('now', ?)").run(cutoffSeconds);

      // PID liveness sweep on remaining locks
      interface LockRow { conversation_path: string; pid: number; }
      const remaining = db.prepare('SELECT conversation_path, pid FROM extraction_locks').all() as LockRow[];
      const deadPaths = remaining.filter(r => !isPidAlive(r.pid)).map(r => r.conversation_path);
      for (const path of deadPaths) {
        db.prepare('DELETE FROM extraction_locks WHERE conversation_path = ?').run(path);
      }

      // Check capacity
      const activeCount = (db.prepare('SELECT COUNT(*) as cnt FROM extraction_locks').get() as { cnt: number }).cnt;
      if (activeCount >= maxConcurrent) {
        db.exec('COMMIT');
        return false;
      }

      // Atomic insert
      const result = db.prepare(
        "INSERT OR IGNORE INTO extraction_locks (conversation_path, pid, started_at) VALUES (?, ?, datetime('now'))"
      ).run(convPath, pid);

      db.exec('COMMIT');
      return result.changes > 0;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } finally {
    db.close();
  }
}

/**
 * Release the semaphore lock for the given conversation path.
 * Safe to call even if the lock doesn't exist.
 */
export function releaseSemaphore(dbPath: string, convPath: string): void {
  const db = openDb(dbPath);
  try {
    db.prepare('DELETE FROM extraction_locks WHERE conversation_path = ?').run(convPath);
  } finally {
    db.close();
  }
}
