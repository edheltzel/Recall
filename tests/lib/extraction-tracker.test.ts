import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupMigrationDb, teardownMigrationDb, getDbPath } from '../helpers/migrationSetup';
import {
  getExtractionRecord,
  markAsExtracted,
  markAsFailed,
  wasAlreadyExtracted,
  getAllTrackerRecords,
} from '../../hooks/lib/extraction-tracker';

let dbPath: string;

beforeEach(() => {
  const setup = setupMigrationDb();
  dbPath = setup.dbPath;
});

afterEach(() => {
  teardownMigrationDb();
});

describe('getExtractionRecord', () => {
  test('returns null for unknown path', () => {
    const result = getExtractionRecord(dbPath, '/no/such/path');
    expect(result).toBeNull();
  });

  test('returns record after markAsExtracted', () => {
    markAsExtracted(dbPath, '/some/conv', 1000);
    const result = getExtractionRecord(dbPath, '/some/conv');
    expect(result).not.toBeNull();
    expect(result!.conversation_path).toBe('/some/conv');
    expect(result!.size).toBe(1000);
    expect(result!.extracted_at).not.toBeNull();
  });

  test('returns record after markAsFailed with retry_after ~24h from now', () => {
    markAsFailed(dbPath, '/some/conv', 500, 'extraction failed');
    const result = getExtractionRecord(dbPath, '/some/conv');
    expect(result).not.toBeNull();
    expect(result!.failed_at).not.toBeNull();
    expect(result!.retry_after).not.toBeNull();
    expect(result!.error).toBe('extraction failed');

    // retry_after should be roughly 24h from now
    const retryAfter = new Date(result!.retry_after!);
    const now = new Date();
    const diffHours = (retryAfter.getTime() - now.getTime()) / (1000 * 60 * 60);
    expect(diffHours).toBeGreaterThan(23);
    expect(diffHours).toBeLessThan(25);
  });
});

describe('wasAlreadyExtracted', () => {
  test('returns false for unknown path', () => {
    expect(wasAlreadyExtracted(dbPath, '/unknown/path', 1000)).toBe(false);
  });

  test('returns true for extracted with same size', () => {
    markAsExtracted(dbPath, '/some/conv', 1000);
    expect(wasAlreadyExtracted(dbPath, '/some/conv', 1000)).toBe(true);
  });

  test('returns false when file grew over 50%', () => {
    markAsExtracted(dbPath, '/some/conv', 1000);
    // 2000 is 100% growth — exceeds 50% threshold
    expect(wasAlreadyExtracted(dbPath, '/some/conv', 2000)).toBe(false);
  });

  test('returns false when retry window has elapsed', () => {
    // Insert a failed record with retry_after in the past
    const { getMigrationDb } = require('../helpers/migrationSetup');
    const db = getMigrationDb();
    db.prepare(
      `INSERT INTO extraction_tracker (conversation_path, size, failed_at, retry_after, error)
       VALUES (?, ?, datetime('now', '-2 hours'), datetime('now', '-1 hour'), ?)`
    ).run('/some/conv', 500, 'some error');

    expect(wasAlreadyExtracted(dbPath, '/some/conv', 500)).toBe(false);
  });

  test('returns true when within retry cooldown', () => {
    markAsFailed(dbPath, '/some/conv', 500, 'some error');
    // retry_after is +24h from now — still in cooldown
    expect(wasAlreadyExtracted(dbPath, '/some/conv', 500)).toBe(true);
  });
});

describe('markAsExtracted', () => {
  test('upserts on second call — count still 1', () => {
    markAsExtracted(dbPath, '/some/conv', 1000);
    markAsExtracted(dbPath, '/some/conv', 1050);

    const all = getAllTrackerRecords(dbPath);
    const matches = all.filter((r) => r.conversation_path === '/some/conv');
    expect(matches.length).toBe(1);
    expect(matches[0].size).toBe(1050);
  });
});

describe('markAsFailed', () => {
  test('upserts on second call — count still 1', () => {
    markAsFailed(dbPath, '/some/conv', 500, 'first error');
    markAsFailed(dbPath, '/some/conv', 500, 'second error');

    const all = getAllTrackerRecords(dbPath);
    const matches = all.filter((r) => r.conversation_path === '/some/conv');
    expect(matches.length).toBe(1);
    expect(matches[0].error).toBe('second error');
  });
});

describe('getAllTrackerRecords', () => {
  test('returns all rows — insert 3, get 3', () => {
    markAsExtracted(dbPath, '/conv/a', 100);
    markAsExtracted(dbPath, '/conv/b', 200);
    markAsFailed(dbPath, '/conv/c', 300, 'error');

    const all = getAllTrackerRecords(dbPath);
    expect(all.length).toBe(3);

    const paths = all.map((r) => r.conversation_path);
    expect(paths).toContain('/conv/a');
    expect(paths).toContain('/conv/b');
    expect(paths).toContain('/conv/c');
  });
});
