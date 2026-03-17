import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  setupMigrationDb,
  teardownMigrationDb,
  getDbPath,
  getMigrationDb,
} from '../helpers/migrationSetup';
import {
  migrateTrackerJson,
  migrateSessionIndex,
  migrateErrorPatterns,
  migrateAll,
} from '../../hooks/lib/extraction-migration';
import { join } from 'path';
import { createHash } from 'crypto';
import { readFileSync, statSync } from 'fs';

const FIXTURES_DIR = join(__dirname, '../fixtures/extraction');
const TRACKER_DIR = join(FIXTURES_DIR, 'tracker');
const SESSION_DIR = join(FIXTURES_DIR, 'session-index');
const ERROR_DIR = join(FIXTURES_DIR, 'error-patterns');

describe('migrateTrackerJson', () => {
  beforeEach(() => {
    setupMigrationDb();
  });

  afterEach(() => {
    teardownMigrationDb();
  });

  test('imports all records from nominal fixture (5 rows)', () => {
    const dbPath = getDbPath();
    const result = migrateTrackerJson(join(TRACKER_DIR, 'nominal.json'), dbPath);

    expect(result.imported).toBe(5);

    const db = getMigrationDb();
    const row = db.prepare('SELECT COUNT(*) as count FROM extraction_tracker').get() as { count: number };
    expect(row.count).toBe(5);
  });

  test('preserves extractedAt values', () => {
    const dbPath = getDbPath();
    migrateTrackerJson(join(TRACKER_DIR, 'nominal.json'), dbPath);

    const db = getMigrationDb();
    const row = db
      .prepare('SELECT extracted_at FROM extraction_tracker WHERE conversation_path = ?')
      .get('/Users/ed/.claude/projects/project-a/conv1.jsonl') as { extracted_at: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.extracted_at).toBe('2026-03-10T14:30:00.000Z');
  });

  test('preserves failedAt and retryAfter values', () => {
    const dbPath = getDbPath();
    migrateTrackerJson(join(TRACKER_DIR, 'nominal.json'), dbPath);

    const db = getMigrationDb();
    const row = db
      .prepare('SELECT failed_at, retry_after FROM extraction_tracker WHERE conversation_path = ?')
      .get('/Users/ed/.claude/projects/project-a/conv2.jsonl') as {
        failed_at: string;
        retry_after: string;
      } | undefined;

    expect(row).toBeDefined();
    expect(row!.failed_at).toBe('2026-03-11T10:00:00.000Z');
    expect(row!.retry_after).toBe('2026-03-10T10:00:00.000Z');
  });

  test('is idempotent', () => {
    const dbPath = getDbPath();
    migrateTrackerJson(join(TRACKER_DIR, 'nominal.json'), dbPath);
    migrateTrackerJson(join(TRACKER_DIR, 'nominal.json'), dbPath);

    const db = getMigrationDb();
    const row = db.prepare('SELECT COUNT(*) as count FROM extraction_tracker').get() as { count: number };
    expect(row.count).toBe(5);
  });

  test('handles empty.json gracefully', () => {
    const dbPath = getDbPath();
    const result = migrateTrackerJson(join(TRACKER_DIR, 'empty.json'), dbPath);

    expect(result.imported).toBe(0);

    const db = getMigrationDb();
    const row = db.prepare('SELECT COUNT(*) as count FROM extraction_tracker').get() as { count: number };
    expect(row.count).toBe(0);
  });

  test('handles corrupted.json with error', () => {
    const dbPath = getDbPath();

    expect(() => {
      migrateTrackerJson(join(TRACKER_DIR, 'corrupted.json'), dbPath);
    }).toThrow();

    const db = getMigrationDb();
    const row = db.prepare('SELECT COUNT(*) as count FROM extraction_tracker').get() as { count: number };
    expect(row.count).toBe(0);
  });

  test('handles missing_fields.json — entries with no size get size=0 default', () => {
    const dbPath = getDbPath();
    const result = migrateTrackerJson(join(TRACKER_DIR, 'missing_fields.json'), dbPath);

    expect(result.imported).toBeGreaterThan(0);

    const db = getMigrationDb();
    const row = db
      .prepare('SELECT size FROM extraction_tracker WHERE conversation_path = ?')
      .get('/path/no-size.jsonl') as { size: number } | undefined;

    expect(row).toBeDefined();
    expect(row!.size).toBe(0);
  });
});

describe('migrateSessionIndex', () => {
  beforeEach(() => {
    setupMigrationDb();
  });

  afterEach(() => {
    teardownMigrationDb();
  });

  test('imports all records (4 rows)', () => {
    const dbPath = getDbPath();
    const result = migrateSessionIndex(join(SESSION_DIR, 'nominal.json'), dbPath);

    expect(result.imported).toBe(4);

    const db = getMigrationDb();
    const row = db.prepare('SELECT COUNT(*) as count FROM extraction_sessions').get() as { count: number };
    expect(row.count).toBe(4);
  });

  test('is idempotent', () => {
    const dbPath = getDbPath();
    migrateSessionIndex(join(SESSION_DIR, 'nominal.json'), dbPath);
    migrateSessionIndex(join(SESSION_DIR, 'nominal.json'), dbPath);

    const db = getMigrationDb();
    const row = db.prepare('SELECT COUNT(*) as count FROM extraction_sessions').get() as { count: number };
    expect(row.count).toBe(4);
  });
});

describe('migrateErrorPatterns', () => {
  beforeEach(() => {
    setupMigrationDb();
  });

  afterEach(() => {
    teardownMigrationDb();
  });

  test('imports all records (3 rows)', () => {
    const dbPath = getDbPath();
    const result = migrateErrorPatterns(join(ERROR_DIR, 'nominal.json'), dbPath);

    expect(result.imported).toBe(3);

    const db = getMigrationDb();
    const row = db.prepare('SELECT COUNT(*) as count FROM extraction_errors').get() as { count: number };
    expect(row.count).toBe(3);
  });

  test('is idempotent', () => {
    const dbPath = getDbPath();
    migrateErrorPatterns(join(ERROR_DIR, 'nominal.json'), dbPath);
    migrateErrorPatterns(join(ERROR_DIR, 'nominal.json'), dbPath);

    const db = getMigrationDb();
    const row = db.prepare('SELECT COUNT(*) as count FROM extraction_errors').get() as { count: number };
    expect(row.count).toBe(3);
  });
});

describe('migrateAll', () => {
  beforeEach(() => {
    setupMigrationDb();
  });

  afterEach(() => {
    teardownMigrationDb();
  });

  test('runs all three in sequence', () => {
    const dbPath = getDbPath();
    const result = migrateAll(dbPath, {
      trackerPath: join(TRACKER_DIR, 'nominal.json'),
      sessionIndexPath: join(SESSION_DIR, 'nominal.json'),
      errorPatternsPath: join(ERROR_DIR, 'nominal.json'),
    });

    expect(result.tracker).toBe(5);
    expect(result.sessions).toBe(4);
    expect(result.errors).toBe(3);

    const db = getMigrationDb();
    const trackerCount = (db.prepare('SELECT COUNT(*) as count FROM extraction_tracker').get() as { count: number }).count;
    const sessionsCount = (db.prepare('SELECT COUNT(*) as count FROM extraction_sessions').get() as { count: number }).count;
    const errorsCount = (db.prepare('SELECT COUNT(*) as count FROM extraction_errors').get() as { count: number }).count;

    expect(trackerCount).toBe(5);
    expect(sessionsCount).toBe(4);
    expect(errorsCount).toBe(3);
  });

  test('does not touch source files — fixture hashes unchanged after migration', () => {
    const dbPath = getDbPath();

    const filesToCheck = [
      join(TRACKER_DIR, 'nominal.json'),
      join(SESSION_DIR, 'nominal.json'),
      join(ERROR_DIR, 'nominal.json'),
    ];

    const hashBefore = (filePath: string) =>
      createHash('sha256').update(readFileSync(filePath)).digest('hex');

    const beforeHashes = filesToCheck.map(hashBefore);

    migrateAll(dbPath, {
      trackerPath: filesToCheck[0],
      sessionIndexPath: filesToCheck[1],
      errorPatternsPath: filesToCheck[2],
    });

    const afterHashes = filesToCheck.map(hashBefore);

    expect(afterHashes).toEqual(beforeHashes);
  });

  test('writes to temp DB not real memory.db — ~/.claude/memory.db mtime unchanged', () => {
    const dbPath = getDbPath();
    const realDbPath = join(process.env.HOME!, '.claude', 'memory.db');

    let statBefore: ReturnType<typeof statSync> | null = null;
    try {
      statBefore = statSync(realDbPath);
    } catch {
      // memory.db may not exist in CI; skip mtime check
      statBefore = null;
    }

    migrateAll(dbPath, {
      trackerPath: join(TRACKER_DIR, 'nominal.json'),
      sessionIndexPath: join(SESSION_DIR, 'nominal.json'),
      errorPatternsPath: join(ERROR_DIR, 'nominal.json'),
    });

    if (statBefore !== null) {
      const statAfter = statSync(realDbPath);
      expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    }

    // Primary assertion: the temp DB was written to
    const db = getMigrationDb();
    const count = (db.prepare('SELECT COUNT(*) as count FROM extraction_tracker').get() as { count: number }).count;
    expect(count).toBe(5);
  });
});
