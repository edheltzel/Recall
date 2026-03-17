import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { statSync, readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import { migrateAll } from '../../hooks/lib/extraction-migration';
import {
  markAsExtracted,
  markAsFailed,
  wasAlreadyExtracted,
  getExtractionRecord,
} from '../../hooks/lib/extraction-tracker';
import {
  acquireSemaphore,
  releaseSemaphore,
  getActiveLockCount,
} from '../../hooks/lib/extraction-semaphore';
import { childAcquireLock, childReleaseLock } from '../../hooks/lib/extraction-lock';
import { evaluateQuality, shouldSkipExtraction } from '../../hooks/lib/extraction-quality';
import {
  setupMigrationDb,
  teardownMigrationDb,
  getDbPath,
} from '../helpers/migrationSetup';

const FIXTURES = join(import.meta.dir, '../fixtures/extraction');

describe('E2E: extraction SQLite migration', () => {
  beforeEach(() => {
    setupMigrationDb();
  });

  afterEach(() => {
    teardownMigrationDb();
  });

  // ---------------------------------------------------------------------------
  // Test 1: Full migration — fixture JSON files imported into a clean DB
  // ---------------------------------------------------------------------------
  test('full migration: fixture JSON files imported into clean DB', () => {
    const dbPath = getDbPath();

    // Read fixture content before migration to verify it is unchanged after
    const trackerPath = join(FIXTURES, 'tracker/nominal.json');
    const sessionIndexPath = join(FIXTURES, 'session-index/nominal.json');
    const errorPatternsPath = join(FIXTURES, 'error-patterns/nominal.json');

    const trackerBefore = readFileSync(trackerPath, 'utf-8');
    const sessionsBefore = readFileSync(sessionIndexPath, 'utf-8');
    const errorsBefore = readFileSync(errorPatternsPath, 'utf-8');

    // Run migration
    const result = migrateAll(dbPath, {
      trackerPath,
      sessionIndexPath,
      errorPatternsPath,
    });

    // Verify returned counts match fixture data
    expect(result.tracker).toBe(5);
    expect(result.sessions).toBe(4);
    expect(result.errors).toBe(3);

    // Verify rows landed in the DB
    const db = new Database(dbPath);
    try {
      const trackerRows = (db.prepare('SELECT COUNT(*) as cnt FROM extraction_tracker').get() as { cnt: number }).cnt;
      const sessionRows = (db.prepare('SELECT COUNT(*) as cnt FROM extraction_sessions').get() as { cnt: number }).cnt;
      const errorRows = (db.prepare('SELECT COUNT(*) as cnt FROM extraction_errors').get() as { cnt: number }).cnt;

      expect(trackerRows).toBe(5);
      expect(sessionRows).toBe(4);
      expect(errorRows).toBe(3);
    } finally {
      db.close();
    }

    // Fixture files must be byte-for-byte identical — migration must not mutate sources
    expect(readFileSync(trackerPath, 'utf-8')).toBe(trackerBefore);
    expect(readFileSync(sessionIndexPath, 'utf-8')).toBe(sessionsBefore);
    expect(readFileSync(errorPatternsPath, 'utf-8')).toBe(errorsBefore);
  });

  // ---------------------------------------------------------------------------
  // Test 2: Full extraction flow through SQLite
  // ---------------------------------------------------------------------------
  test('extraction flow: new session tracked through SQLite', () => {
    const dbPath = getDbPath();
    const convPath = '/tmp/test-session/conv-e2e-flow.jsonl';
    const size = 5000;

    // Step 1: Session is new — should not appear as already extracted
    expect(wasAlreadyExtracted(dbPath, convPath, size)).toBe(false);

    // Step 2: Acquire the per-conversation lock (simulates child process acquiring)
    const acquired = childAcquireLock(dbPath, convPath, process.pid);
    expect(acquired).toBe(true);

    // Step 3: Mark as successfully extracted
    markAsExtracted(dbPath, convPath, size);

    // Step 4: Release the lock
    childReleaseLock(dbPath, convPath, process.pid);

    // Step 5: Same path at same size → already extracted
    expect(wasAlreadyExtracted(dbPath, convPath, size)).toBe(true);

    // Step 6: Record must have extracted_at populated
    const record = getExtractionRecord(dbPath, convPath);
    expect(record).not.toBeNull();
    expect(record!.extracted_at).not.toBeNull();
    expect(record!.conversation_path).toBe(convPath);
    expect(record!.size).toBe(size);
  });

  // ---------------------------------------------------------------------------
  // Test 3: Concurrency — 4 semaphore acquires, 3 succeed, 1 blocked
  // ---------------------------------------------------------------------------
  test('concurrency: 4 semaphore acquires, 3 succeed, 1 blocked', () => {
    const dbPath = getDbPath();
    const pid = process.pid;
    const path1 = '/tmp/conv-sem-1.jsonl';
    const path2 = '/tmp/conv-sem-2.jsonl';
    const path3 = '/tmp/conv-sem-3.jsonl';
    const path4 = '/tmp/conv-sem-4.jsonl';

    // Initial state: 0 active locks
    expect(getActiveLockCount(dbPath)).toBe(0);

    // Acquire 3 slots — all should succeed
    expect(acquireSemaphore(dbPath, path1, pid)).toBe(true);
    expect(getActiveLockCount(dbPath)).toBe(1);

    expect(acquireSemaphore(dbPath, path2, pid)).toBe(true);
    expect(getActiveLockCount(dbPath)).toBe(2);

    expect(acquireSemaphore(dbPath, path3, pid)).toBe(true);
    expect(getActiveLockCount(dbPath)).toBe(3);

    // 4th acquire must be blocked — semaphore at capacity
    expect(acquireSemaphore(dbPath, path4, pid)).toBe(false);
    expect(getActiveLockCount(dbPath)).toBe(3); // unchanged

    // Release one slot
    releaseSemaphore(dbPath, path1);
    expect(getActiveLockCount(dbPath)).toBe(2);

    // Now the 4th should succeed
    expect(acquireSemaphore(dbPath, path4, pid)).toBe(true);
    expect(getActiveLockCount(dbPath)).toBe(3);

    // Cleanup
    releaseSemaphore(dbPath, path2);
    releaseSemaphore(dbPath, path3);
    releaseSemaphore(dbPath, path4);
    expect(getActiveLockCount(dbPath)).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Test 4: Quality gate — thin conversation skipped cleanly
  // ---------------------------------------------------------------------------
  test('quality gate: thin conversation skipped cleanly', () => {
    const dbPath = getDbPath();
    const convPath = '/tmp/conv-thin.jsonl';

    // Read the tiny fixture and compute total message content chars
    const tinyFixture = join(FIXTURES, 'conversation-tiny.jsonl');
    const lines = readFileSync(tinyFixture, 'utf-8').trim().split('\n').filter(l => l.trim());
    let totalChars = 0;
    for (const line of lines) {
      const msg = JSON.parse(line) as { content?: string };
      if (msg.content) totalChars += msg.content.length;
    }

    // shouldSkipExtraction must return true for this thin conversation
    expect(shouldSkipExtraction(totalChars)).toBe(true);

    // Thin output text — evaluateQuality should also fail
    const thinOutput = 'too short';
    const qualResult = evaluateQuality(thinOutput);
    expect(qualResult.pass).toBe(false);

    // Simulate recording a skipped extraction directly in the DB
    const db = new Database(dbPath);
    try {
      db.prepare(`
        INSERT OR REPLACE INTO extraction_tracker
          (conversation_path, size, skipped)
        VALUES (?, ?, 1)
      `).run(convPath, totalChars);
    } finally {
      db.close();
    }

    // Verify the skipped flag is persisted correctly
    const record = getExtractionRecord(dbPath, convPath);
    expect(record).not.toBeNull();
    expect(record!.skipped).toBe(1);
    expect(record!.extracted_at).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Test 5: Failed extraction — retry logic reads from SQLite
  // ---------------------------------------------------------------------------
  test('failed extraction: retry logic reads from SQLite', () => {
    const dbPath = getDbPath();
    const convPath = '/tmp/conv-retry-e2e.jsonl';
    const size = 5000;
    const errorMsg = 'quality_gate';

    // Record a failure — retry_after defaults to +24h from now
    markAsFailed(dbPath, convPath, size, errorMsg);

    // Within the cooldown period: wasAlreadyExtracted returns true (skip retry)
    expect(wasAlreadyExtracted(dbPath, convPath, size)).toBe(true);

    // Verify the error and retry_after are stored correctly
    const record = getExtractionRecord(dbPath, convPath);
    expect(record).not.toBeNull();
    expect(record!.error).toBe(errorMsg);
    expect(record!.retry_after).not.toBeNull();

    // Confirm retry_after is in the future
    const retryAfter = new Date(record!.retry_after! + 'Z');
    expect(retryAfter.getTime()).toBeGreaterThan(Date.now());

    // Manually wind the retry_after back to the past to simulate cooldown expiry
    const db = new Database(dbPath);
    try {
      db.prepare(
        "UPDATE extraction_tracker SET retry_after = datetime('now', '-1 hour') WHERE conversation_path = ?"
      ).run(convPath);
    } finally {
      db.close();
    }

    // After the retry window elapses: wasAlreadyExtracted should return false
    expect(wasAlreadyExtracted(dbPath, convPath, size)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Test 6: No real files touched — mtime of ~/.claude/memory.db is unchanged
  // ---------------------------------------------------------------------------
  test('no real files touched: mtime of ~/.claude/memory.db unchanged', () => {
    const realDbPath = join(homedir(), '.claude', 'memory.db');

    if (!existsSync(realDbPath)) {
      // Real DB does not exist in this environment — test is vacuously satisfied
      return;
    }

    const mtimeBefore = statSync(realDbPath).mtimeMs;

    // Run a representative set of operations against our temp DB only
    const dbPath = getDbPath();
    const convPath = '/tmp/conv-isolation-check.jsonl';

    migrateAll(dbPath, {
      trackerPath: join(FIXTURES, 'tracker/nominal.json'),
      sessionIndexPath: join(FIXTURES, 'session-index/nominal.json'),
      errorPatternsPath: join(FIXTURES, 'error-patterns/nominal.json'),
    });
    markAsExtracted(dbPath, convPath, 1234);
    markAsFailed(dbPath, '/tmp/conv-fail.jsonl', 999, 'test_error');
    wasAlreadyExtracted(dbPath, convPath, 1234);
    getExtractionRecord(dbPath, convPath);
    acquireSemaphore(dbPath, '/tmp/sem-iso.jsonl', process.pid);
    releaseSemaphore(dbPath, '/tmp/sem-iso.jsonl');
    childAcquireLock(dbPath, '/tmp/lock-iso.jsonl', process.pid);
    childReleaseLock(dbPath, '/tmp/lock-iso.jsonl', process.pid);
    getActiveLockCount(dbPath);
    shouldSkipExtraction(100);
    evaluateQuality('short text');

    const mtimeAfter = statSync(realDbPath).mtimeMs;

    // The real database must not have been touched
    expect(mtimeAfter).toBe(mtimeBefore);
  });
});
