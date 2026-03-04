import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { getDbPath, getDb, initDb, closeDb, getDbStats } from '../../src/db/connection';

describe('connection', () => {
  let testDbPath: string;

  beforeAll(() => {
    testDbPath = setupTestDb();
  });

  afterAll(() => {
    teardownTestDb();
  });

  describe('getDbPath', () => {
    test('returns MEM_DB_PATH when env var is set', () => {
      // MEM_DB_PATH is already set by setupTestDb to the temp test DB path
      expect(getDbPath()).toBe(testDbPath);
    });

    test('returns default path when MEM_DB_PATH is not set', () => {
      const original = process.env.MEM_DB_PATH;
      delete process.env.MEM_DB_PATH;

      try {
        const expected = join(homedir(), '.claude', 'memory.db');
        expect(getDbPath()).toBe(expected);
      } finally {
        process.env.MEM_DB_PATH = original;
      }
    });
  });

  describe('initDb', () => {
    test('creates database file and returns { created: true }', () => {
      // Temporarily point MEM_DB_PATH at a brand-new location so we can
      // exercise the "first-time creation" code path without touching the
      // shared test DB managed by the setup helper.
      closeDb();

      const freshDir = mkdtempSync(join(tmpdir(), 'recall-test-init-'));
      const freshPath = join(freshDir, 'fresh.db');
      const originalPath = process.env.MEM_DB_PATH;

      try {
        process.env.MEM_DB_PATH = freshPath;
        const result = initDb();
        expect(result.created).toBe(true);
        expect(result.path).toBe(freshPath);
      } finally {
        closeDb();
        process.env.MEM_DB_PATH = originalPath;
        rmSync(freshDir, { recursive: true, force: true });
        // Restore the shared test DB connection for subsequent tests
        initDb();
      }
    });

    test('returns { created: false } when DB already exists', () => {
      // The DB was already created by setupTestDb; calling initDb again on the
      // same path should report that no new file was created.
      const result = initDb();
      expect(result.created).toBe(false);
      expect(result.path).toBe(testDbPath);
    });
  });

  describe('getDb', () => {
    test('returns a valid Database instance after init', () => {
      const database = getDb();
      expect(database).toBeInstanceOf(Database);
    });
  });

  describe('getDbStats', () => {
    test('returns size > 0 and correct path after init', () => {
      const stats = getDbStats();
      expect(stats.size_bytes).toBeGreaterThan(0);
      expect(stats.path).toBe(testDbPath);
    });
  });

  describe('closeDb', () => {
    test('closes connection without throwing', () => {
      expect(() => closeDb()).not.toThrow();
    });
  });
});
