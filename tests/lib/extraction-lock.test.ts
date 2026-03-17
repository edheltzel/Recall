import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { setupMigrationDb, teardownMigrationDb, getDbPath } from '../helpers/migrationSetup';
import {
  childAcquireLock,
  childReleaseLock,
  parentIsLockHeld,
} from '../../hooks/lib/extraction-lock';

let dbPath: string;

beforeEach(() => {
  const setup = setupMigrationDb();
  dbPath = setup.dbPath;
});

afterEach(() => {
  teardownMigrationDb();
});

describe('childAcquireLock', () => {
  test('inserts row into extraction_locks with correct PID', () => {
    const acquired = childAcquireLock(dbPath, '/test/conv-1.jsonl', process.pid);
    expect(acquired).toBe(true);

    const db = new Database(dbPath);
    const row = db
      .prepare('SELECT pid FROM extraction_locks WHERE conversation_path = ?')
      .get('/test/conv-1.jsonl') as { pid: number } | undefined;
    db.close();

    expect(row).toBeDefined();
    expect(row!.pid).toBe(process.pid);
  });

  test('returns false if row exists for same path (different PID)', () => {
    childAcquireLock(dbPath, '/test/conv-1.jsonl', process.pid);
    const second = childAcquireLock(dbPath, '/test/conv-1.jsonl', 99998);
    expect(second).toBe(false);
  });

  test('returns true if existing row is expired (replaces it)', () => {
    const db = new Database(dbPath);
    db.prepare(
      "INSERT INTO extraction_locks (conversation_path, pid, started_at) VALUES (?, ?, datetime('now', '-20 minutes'))"
    ).run('/test/conv-expired.jsonl', 99999999);
    db.close();

    const acquired = childAcquireLock(dbPath, '/test/conv-expired.jsonl', process.pid, 600);
    expect(acquired).toBe(true);

    const db2 = new Database(dbPath);
    const row = db2
      .prepare('SELECT pid FROM extraction_locks WHERE conversation_path = ?')
      .get('/test/conv-expired.jsonl') as { pid: number } | undefined;
    db2.close();

    expect(row).toBeDefined();
    expect(row!.pid).toBe(process.pid);
  });
});

describe('parentIsLockHeld', () => {
  test('returns true when active lock exists', () => {
    childAcquireLock(dbPath, '/test/conv-active.jsonl', process.pid);
    const held = parentIsLockHeld(dbPath, '/test/conv-active.jsonl');
    expect(held).toBe(true);
  });

  test('returns false when no row exists', () => {
    const held = parentIsLockHeld(dbPath, '/test/conv-nonexistent.jsonl');
    expect(held).toBe(false);
  });

  test('returns false when row is expired', () => {
    const db = new Database(dbPath);
    db.prepare(
      "INSERT INTO extraction_locks (conversation_path, pid, started_at) VALUES (?, ?, datetime('now', '-20 minutes'))"
    ).run('/test/conv-expired.jsonl', 99999999);
    db.close();

    const held = parentIsLockHeld(dbPath, '/test/conv-expired.jsonl', 600);
    expect(held).toBe(false);
  });
});

describe('childReleaseLock', () => {
  test('removes own row after acquire', () => {
    childAcquireLock(dbPath, '/test/conv-release.jsonl', process.pid);
    childReleaseLock(dbPath, '/test/conv-release.jsonl', process.pid);

    const db = new Database(dbPath);
    const row = db
      .prepare('SELECT pid FROM extraction_locks WHERE conversation_path = ?')
      .get('/test/conv-release.jsonl');
    db.close();

    // bun:sqlite returns null (not undefined) for no-row results
    expect(row).toBeFalsy();
  });

  test('does not remove another process lock (PID mismatch)', () => {
    const db = new Database(dbPath);
    db.prepare(
      "INSERT INTO extraction_locks (conversation_path, pid, started_at) VALUES (?, ?, datetime('now'))"
    ).run('/test/conv-other.jsonl', 99999);
    db.close();

    childReleaseLock(dbPath, '/test/conv-other.jsonl', process.pid);

    const db2 = new Database(dbPath);
    const row = db2
      .prepare('SELECT pid FROM extraction_locks WHERE conversation_path = ?')
      .get('/test/conv-other.jsonl') as { pid: number } | undefined;
    db2.close();

    expect(row).toBeDefined();
    expect(row!.pid).toBe(99999);
  });
});

describe('cross-process', () => {
  test('child acquires lock, parent sees lock held', async () => {
    const convPath = '/test/cross-process.jsonl';

    const child = Bun.spawn(
      ['bun', '-e', "const { Database } = require('bun:sqlite'); const db = new Database(process.env.DB_PATH); db.exec('PRAGMA journal_mode = WAL'); db.prepare(\"INSERT OR REPLACE INTO extraction_locks (conversation_path, pid, started_at) VALUES (?, ?, datetime('now'))\").run(process.env.CONV_PATH, process.pid); db.close(); await Bun.sleep(5000);"],
      {
        env: {
          ...process.env,
          DB_PATH: dbPath,
          CONV_PATH: convPath,
        },
        stdout: 'ignore',
        stderr: 'ignore',
      }
    );

    await Bun.sleep(300);

    try {
      const held = parentIsLockHeld(dbPath, convPath);
      expect(held).toBe(true);
    } finally {
      child.kill(9);
      await child.exited;
    }
  }, 8000);

  test('parent skips spawning when lock held', () => {
    childAcquireLock(dbPath, '/test/conv-skip.jsonl', process.pid);

    const held = parentIsLockHeld(dbPath, '/test/conv-skip.jsonl');
    expect(held).toBe(true);

    childReleaseLock(dbPath, '/test/conv-skip.jsonl', process.pid);

    const heldAfter = parentIsLockHeld(dbPath, '/test/conv-skip.jsonl');
    expect(heldAfter).toBe(false);
  });
});
