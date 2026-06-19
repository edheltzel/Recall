// Resilience tests for the SQLite-native extraction path — covers the
// load-bearing regressions surfaced by the Forge cross-vendor audit:
//   - Pre-migration DB (no extraction_locks table) must not block the hook
//   - Malformed legacy tracker JSON must be quarantined, not retried
//   - Early-return paths must release the lock

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { migrateTrackerJson } from '../../hooks/lib/extraction-migration';
import { acquireSemaphore, getActiveLockCount, releaseSemaphore } from '../../hooks/lib/extraction-semaphore';

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'recall-resilience-'));
  dbPath = join(tmp, 'memory.db');
});

afterEach(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

describe('Pre-migration DB resilience (Forge Finding 1)', () => {
  test('acquireSemaphore on a DB without extraction_locks throws — caller must catch', () => {
    // Simulate a pre-migration DB: open + journal mode but no extraction_locks table.
    const db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('CREATE TABLE foo (id INTEGER)');
    db.close();

    expect(() => acquireSemaphore(dbPath, '/some/conv', 12345, 3)).toThrow();
  });

  test('the RecallExtract hook wraps acquireSemaphore in try/catch — verified by grep', async () => {
    const f = await Bun.file(join(import.meta.dir, '..', '..', 'hooks', 'RecallExtract.ts')).text();
    // The acquire site must be inside a try block
    const hasTry = /try\s*{[\s\S]{0,200}acquireSemaphore\(/.test(f);
    expect(hasTry).toBe(true);
    // And on catch we log SEMAPHORE_UNAVAILABLE
    expect(f).toContain('SEMAPHORE_UNAVAILABLE');
  });
});

describe('Corrupt tracker JSON quarantine (Forge Finding 6)', () => {
  test('migrateTrackerJson throws on malformed JSON — caller must rename to .corrupt-*', () => {
    const badJson = join(tmp, 'tracker.json');
    writeFileSync(badJson, '{this is: not valid json');
    // Also need a valid DB so the function gets past existsSync(dbPath)
    const db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`CREATE TABLE extraction_tracker (
      conversation_path TEXT PRIMARY KEY, size INTEGER NOT NULL,
      extracted_at TEXT, failed_at TEXT, retry_after TEXT, error TEXT, skipped INTEGER DEFAULT 0
    )`);
    db.close();
    expect(() => migrateTrackerJson(badJson, dbPath)).toThrow();
  });

  test('the RecallExtract hook quarantines on parse failure — verified by grep', async () => {
    const f = await Bun.file(join(import.meta.dir, '..', '..', 'hooks', 'RecallExtract.ts')).text();
    expect(f).toContain('.corrupt-');
    expect(f).toContain('TRACKER_MIGRATE: corrupt JSON quarantined');
  });
});

describe('Early-return lock release (Forge Finding 2)', () => {
  test('RecallExtract calls releaseChildLockSafe on every early skip return — verified by grep', async () => {
    const f = await Bun.file(join(import.meta.dir, '..', '..', 'hooks', 'RecallExtract.ts')).text();
    // Each early "skip" return must be preceded by releaseChildLockSafe within ~3 lines.
    const skipPatterns = [
      /Already extracted this conversation, skipping[\s\S]{0,150}releaseChildLockSafe/,
      /Conversation too short, skipping extraction[\s\S]{0,150}releaseChildLockSafe/,
      /REEXTRACT-MD: File not found[\s\S]{0,150}releaseChildLockSafe/,
      /Already extracted this markdown, skipping[\s\S]{0,150}releaseChildLockSafe/,
      /Markdown too short, skipping extraction[\s\S]{0,150}releaseChildLockSafe/,
    ];
    for (const re of skipPatterns) {
      expect(re.test(f)).toBe(true);
    }
  });

  test('releaseSemaphore is idempotent — calling on a non-existent row is a no-op', () => {
    // Set up DB with extraction_locks
    const db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`CREATE TABLE extraction_locks (
      conversation_path TEXT PRIMARY KEY, pid INTEGER NOT NULL, started_at TEXT NOT NULL
    )`);
    db.close();
    expect(() => releaseSemaphore(dbPath, '/nope')).not.toThrow();
    expect(getActiveLockCount(dbPath)).toBe(0);
  });
});

describe('Parent semaphore + idempotent release (Forge Finding 4)', () => {
  test('release after acquire leaves zero rows', () => {
    const db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`CREATE TABLE extraction_locks (
      conversation_path TEXT PRIMARY KEY, pid INTEGER NOT NULL, started_at TEXT NOT NULL
    )`);
    db.close();
    const got = acquireSemaphore(dbPath, '/conv', process.pid, 3);
    expect(got).toBe(true);
    expect(getActiveLockCount(dbPath)).toBe(1);
    releaseSemaphore(dbPath, '/conv');
    expect(getActiveLockCount(dbPath)).toBe(0);
  });

  test('RecallExtract releases on spawn failure — verified by grep', async () => {
    const f = await Bun.file(join(import.meta.dir, '..', '..', 'hooks', 'RecallExtract.ts')).text();
    expect(f).toContain('SPAWN_FAILED');
    // The release call and the SPAWN_FAILED log must be in the same catch block
    // (within ~200 chars of each other in either order).
    const proximal =
      /releaseChildLockSafe[\s\S]{0,200}SPAWN_FAILED/.test(f) ||
      /SPAWN_FAILED[\s\S]{0,200}releaseChildLockSafe/.test(f);
    expect(proximal).toBe(true);
  });
});

describe('busy_timeout on hook DB opens (#96)', () => {
  test('RecallExtract clearTrackerRow open sets busy_timeout = 5000 — verified by grep', async () => {
    const f = await Bun.file(join(import.meta.dir, '..', '..', 'hooks', 'RecallExtract.ts')).text();
    // clearTrackerRow opens + closes its own connection inside the function, so
    // the pragma isn't observable at runtime — assert it at the source seam:
    // the Database open must be followed by busy_timeout, mirroring getDb()
    // (hooks must not import from src/, so the value is duplicated inline). (#72/#96)
    expect(/const db = new Database\(dbPath\);[\s\S]{0,400}PRAGMA busy_timeout = 5000/.test(f)).toBe(true);
  });
});
