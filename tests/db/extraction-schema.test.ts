import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let tempDir: string;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'recall-schema-test-'));
  const dbPath = join(tempDir, 'test.db');
  process.env.RECALL_DB_PATH = dbPath;

  // Reset module-level db singleton so initDb() uses the new path
  const conn = await import('../../src/db/connection.js');
  conn.closeDb();
  conn.initDb();
});

afterAll(() => {
  // Import is cached — just close and clean up
  import('../../src/db/connection.js').then((conn) => conn.closeDb());
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RECALL_DB_PATH;
});

describe('extraction_tracker table', () => {
  test('has all required columns', async () => {
    const { getDb } = await import('../../src/db/connection.js');
    const db = getDb();
    const rows = db.prepare('PRAGMA table_info(extraction_tracker)').all() as Array<{
      name: string;
      type: string;
    }>;
    const colMap = Object.fromEntries(rows.map((r) => [r.name, r.type]));

    expect(colMap['conversation_path']).toBe('TEXT');
    expect(colMap['size']).toBe('INTEGER');
    expect(colMap['extracted_at']).toBe('TEXT');
    expect(colMap['failed_at']).toBe('TEXT');
    expect(colMap['retry_after']).toBe('TEXT');
    expect(colMap['error']).toBe('TEXT');
    expect(colMap['skipped']).toBe('INTEGER');
  });

  test('conversation_path is PRIMARY KEY', async () => {
    const { getDb } = await import('../../src/db/connection.js');
    const db = getDb();
    db.prepare(
      'INSERT INTO extraction_tracker (conversation_path, size) VALUES (?, ?)'
    ).run('/path/to/conv', 100);

    let threw = false;
    try {
      db.prepare(
        'INSERT INTO extraction_tracker (conversation_path, size) VALUES (?, ?)'
      ).run('/path/to/conv', 200);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Cleanup
    db.prepare('DELETE FROM extraction_tracker WHERE conversation_path = ?').run('/path/to/conv');
  });
});

describe('extraction_sessions table', () => {
  test('has all required columns', async () => {
    const { getDb } = await import('../../src/db/connection.js');
    const db = getDb();
    const rows = db.prepare('PRAGMA table_info(extraction_sessions)').all() as Array<{
      name: string;
      type: string;
    }>;
    const colMap = Object.fromEntries(rows.map((r) => [r.name, r.type]));

    expect(colMap['session_id']).toBe('TEXT');
    expect(colMap['project']).toBe('TEXT');
    expect(colMap['branch']).toBe('TEXT');
    expect(colMap['timestamp']).toBe('TEXT');
    expect(colMap['summary']).toBe('TEXT');
    expect(colMap['topics']).toBe('TEXT');
    expect(colMap['conversation_path']).toBe('TEXT');
  });
});

describe('extraction_errors table', () => {
  test('has all required columns', async () => {
    const { getDb } = await import('../../src/db/connection.js');
    const db = getDb();
    const rows = db.prepare('PRAGMA table_info(extraction_errors)').all() as Array<{
      name: string;
      type: string;
    }>;
    const colMap = Object.fromEntries(rows.map((r) => [r.name, r.type]));

    expect(colMap['error_key']).toBe('TEXT');
    expect(colMap['error']).toBe('TEXT');
    expect(colMap['fix']).toBe('TEXT');
    expect(colMap['context']).toBe('TEXT');
    expect(colMap['first_seen']).toBe('TEXT');
    expect(colMap['last_seen']).toBe('TEXT');
  });
});

describe('extraction_locks table', () => {
  test('has all required columns', async () => {
    const { getDb } = await import('../../src/db/connection.js');
    const db = getDb();
    const rows = db.prepare('PRAGMA table_info(extraction_locks)').all() as Array<{
      name: string;
      type: string;
    }>;
    const colMap = Object.fromEntries(rows.map((r) => [r.name, r.type]));

    expect(colMap['conversation_path']).toBe('TEXT');
    expect(colMap['pid']).toBe('INTEGER');
    expect(colMap['started_at']).toBe('TEXT');
  });

  test('conversation_path is PRIMARY KEY', async () => {
    const { getDb } = await import('../../src/db/connection.js');
    const db = getDb();
    db.prepare(
      'INSERT INTO extraction_locks (conversation_path, pid, started_at) VALUES (?, ?, ?)'
    ).run('/path/to/lock', 1234, new Date().toISOString());

    let threw = false;
    try {
      db.prepare(
        'INSERT INTO extraction_locks (conversation_path, pid, started_at) VALUES (?, ?, ?)'
      ).run('/path/to/lock', 5678, new Date().toISOString());
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Cleanup
    db.prepare('DELETE FROM extraction_locks WHERE conversation_path = ?').run('/path/to/lock');
  });
});

describe('schema version', () => {
  test('PRAGMA user_version matches migration count', async () => {
    const { getDb } = await import('../../src/db/connection.js');
    const { MIGRATIONS } = await import('../../src/db/migrations.js');
    const db = getDb();
    const row = db.prepare('PRAGMA user_version').get() as any;
    expect(row.user_version).toBe(MIGRATIONS.length);
  });
});

describe('WAL checkpoint', () => {
  test('all 4 extraction tables survive WAL checkpoint', async () => {
    const { getDb } = await import('../../src/db/connection.js');
    const db = getDb();

    db.exec('PRAGMA wal_checkpoint');

    // Verify all 4 tables are still queryable
    const tables = [
      'extraction_tracker',
      'extraction_sessions',
      'extraction_errors',
      'extraction_locks',
    ];
    for (const table of tables) {
      const rows = db.prepare('SELECT * FROM ' + table).all();
      expect(Array.isArray(rows)).toBe(true);
    }
  });
});
