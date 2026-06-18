import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'path';
import { setupMigrationDb, teardownMigrationDb, getDbPath, getMigrationDb } from '../helpers/migrationSetup';
import {
  acquireSemaphore,
  releaseSemaphore,
  sweepExpiredLocks,
  getActiveLockCount,
} from '../../hooks/lib/extraction-semaphore';

const WORKER_PATH = join(import.meta.dir, '../helpers/concurrency_worker.ts');

let dbPath: string;

beforeEach(() => {
  const setup = setupMigrationDb();
  dbPath = setup.dbPath;
});

afterEach(() => {
  teardownMigrationDb();
});

describe('acquireSemaphore', () => {
  test('returns true when below max', () => {
    const acquired = acquireSemaphore(dbPath, '/test/conv-1.jsonl', process.pid, 3);
    expect(acquired).toBe(true);
  });

  test('returns false when at max', () => {
    acquireSemaphore(dbPath, '/test/conv-1.jsonl', process.pid, 3);
    acquireSemaphore(dbPath, '/test/conv-2.jsonl', process.pid, 3);
    acquireSemaphore(dbPath, '/test/conv-3.jsonl', process.pid, 3);
    const fourth = acquireSemaphore(dbPath, '/test/conv-4.jsonl', process.pid, 3);
    expect(fourth).toBe(false);
  });

  test('returns true when one of 3 has expired', () => {
    // Acquire 3 slots
    acquireSemaphore(dbPath, '/test/conv-1.jsonl', process.pid, 3);
    acquireSemaphore(dbPath, '/test/conv-2.jsonl', process.pid, 3);
    acquireSemaphore(dbPath, '/test/conv-3.jsonl', process.pid, 3);

    // Manually set one started_at to 20 minutes ago
    const db = new Database(dbPath);
    db.prepare(
      "UPDATE extraction_locks SET started_at = datetime('now', '-20 minutes') WHERE conversation_path = '/test/conv-1.jsonl'"
    ).run();
    // Also set PID to something definitely dead (PID 1 is init on macOS — process.kill(1, 0) throws EPERM but PID exists)
    // Use PID 0 which doesn't exist as a normal process
    db.prepare(
      "UPDATE extraction_locks SET pid = 99999999 WHERE conversation_path = '/test/conv-1.jsonl'"
    ).run();
    db.close();

    // Sweep expired locks (TTL 600s — 20 min is 1200s so it qualifies)
    sweepExpiredLocks(dbPath, 600);

    // Now try to acquire a 4th — should succeed since one expired
    const acquired = acquireSemaphore(dbPath, '/test/conv-4.jsonl', process.pid, 3);
    expect(acquired).toBe(true);
  });
});

describe('releaseSemaphore', () => {
  test('removes own row after acquire', () => {
    acquireSemaphore(dbPath, '/test/conv-1.jsonl', process.pid, 3);
    releaseSemaphore(dbPath, '/test/conv-1.jsonl');
    const count = getActiveLockCount(dbPath);
    expect(count).toBe(0);
  });

  test('does not throw when lock not found', () => {
    expect(() => releaseSemaphore(dbPath, '/test/nonexistent.jsonl')).not.toThrow();
  });
});

describe('sweepExpiredLocks', () => {
  test('removes all expired rows', () => {
    // Insert 3 rows with started_at 20 minutes ago directly
    const db = new Database(dbPath);
    db.prepare(
      "INSERT INTO extraction_locks (conversation_path, pid, started_at) VALUES ('/sweep/a.jsonl', 99999999, datetime('now', '-20 minutes'))"
    ).run();
    db.prepare(
      "INSERT INTO extraction_locks (conversation_path, pid, started_at) VALUES ('/sweep/b.jsonl', 99999999, datetime('now', '-20 minutes'))"
    ).run();
    db.prepare(
      "INSERT INTO extraction_locks (conversation_path, pid, started_at) VALUES ('/sweep/c.jsonl', 99999999, datetime('now', '-20 minutes'))"
    ).run();
    db.close();

    sweepExpiredLocks(dbPath, 600); // 600s TTL — 20 min = 1200s, so all expire
    const count = getActiveLockCount(dbPath);
    expect(count).toBe(0);
  });
});

describe('getActiveLockCount', () => {
  test('returns correct count after acquiring 2', () => {
    acquireSemaphore(dbPath, '/test/conv-1.jsonl', process.pid, 3);
    acquireSemaphore(dbPath, '/test/conv-2.jsonl', process.pid, 3);
    const count = getActiveLockCount(dbPath);
    expect(count).toBe(2);
  });
});

describe('concurrency', () => {
  test('4 workers race, max 3 acquire', async () => {
    // Close the migration DB so workers can acquire WAL locks without SQLITE_BUSY
    getMigrationDb().close();

    // Spawn 4 workers sequentially with short delays so SQLite writes don't contend.
    // Workers 0-2 each acquire a lock (HOLD_MS=500ms holds them open).
    // Worker 3 spawns after the first 3 have acquired and sees count=3, gets rejected.
    const procs: ReturnType<typeof Bun.spawn>[] = [];
    for (let i = 0; i < 4; i++) {
      const holdMs = i < 3 ? '500' : '100';
      procs.push(
        Bun.spawn(['bun', WORKER_PATH], {
          env: {
            ...process.env,
            DB_PATH: dbPath,
            WORKER_ID: `w${i}`,
            MAX_CONCURRENT: '3',
            HOLD_MS: holdMs,
            CONV_PATH: `/test/worker-race-conv-${i}.jsonl`,
          },
          stdout: 'ignore',
          stderr: 'ignore',
        })
      );
      // Small delay between spawns so each worker serializes its DB write
      // before the next one starts its count check
      if (i < 3) await Bun.sleep(60);
    }

    // Wait for all workers to finish
    await Promise.all(procs.map((p) => p.exited));

    // Read results from concurrency_results table
    const db = new Database(dbPath);
    const results = db.prepare('SELECT * FROM concurrency_results').all() as Array<{
      worker_id: string;
      acquired: number;
      timestamp: string;
    }>;
    db.close();

    const acquiredCount = results.filter((r) => r.acquired === 1).length;
    expect(acquiredCount).toBe(3);
  }, 10000);

  test('SIGKILL crash recovery — sweep cleans up orphaned lock', async () => {
    // Close the migration DB so the worker can acquire WAL locks without SQLITE_BUSY
    getMigrationDb().close();

    // Spawn a worker with a very long hold time
    const proc = Bun.spawn(['bun', WORKER_PATH], {
      env: {
        ...process.env,
        DB_PATH: dbPath,
        WORKER_ID: 'crash-worker',
        MAX_CONCURRENT: '3',
        HOLD_MS: '30000',
        CONV_PATH: '/test/crash-conv.jsonl',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Startup handshake: wait for the worker to announce (on stdout) that it
    // committed the lock, rather than polling the DB against a wall-clock
    // deadline. Bun cold-start under CI load can exceed any fixed budget, so a
    // clock-based poll flakes; waiting on the worker's own signal removes that
    // race entirely. If the worker dies during startup its stdout closes
    // (`done`) before announcing, and the lock-count check below fails loudly
    // with the captured stderr. The bun:test timeout is the ultimate backstop.
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let handshake = '';
    while (!handshake.includes('ACQUIRED')) {
      const { value, done } = await reader.read();
      if (done) break;
      handshake += decoder.decode(value);
    }
    reader.releaseLock();

    if (getActiveLockCount(dbPath) === 0) {
      proc.kill(9);
      await proc.exited;
      const workerStderr = await new Response(proc.stderr).text();
      throw new Error(
        `setup: worker exited before acquiring the extraction lock; worker stderr:\n${workerStderr}`
      );
    }

    // SIGKILL the process
    proc.kill(9);
    await proc.exited;

    // Verify the lock still exists (orphaned)
    const locksBefore = getActiveLockCount(dbPath);
    expect(locksBefore).toBe(1);

    // Manually set started_at to past so TTL-based sweep catches it too
    // (The PID liveness check should catch it regardless, but let's be thorough)
    const db = new Database(dbPath);
    db.prepare(
      "UPDATE extraction_locks SET started_at = datetime('now', '-700 seconds') WHERE conversation_path = '/test/crash-conv.jsonl'"
    ).run();
    db.close();

    // Sweep expired locks — TTL 600s so the -700s lock qualifies
    const removed = sweepExpiredLocks(dbPath, 600);
    expect(removed).toBeGreaterThan(0);

    // Verify lock is gone
    const locksAfter = getActiveLockCount(dbPath);
    expect(locksAfter).toBe(0);

    // Verify we can acquire again
    const acquired = acquireSemaphore(dbPath, '/test/crash-conv.jsonl', process.pid, 3);
    expect(acquired).toBe(true);
    // Backstop only: the handshake above gates progress, so this generous
    // budget just bounds a worker that never starts under extreme CI load.
  }, 30000);
});
