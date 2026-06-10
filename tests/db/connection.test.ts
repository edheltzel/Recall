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
    test('returns RECALL_DB_PATH when set (set by setupTestDb)', () => {
      // setupTestDb sets RECALL_DB_PATH to the temp test DB path.
      expect(getDbPath()).toBe(testDbPath);
    });

    test('returns default path when neither env var is set', () => {
      const originalRecall = process.env.RECALL_DB_PATH;
      const originalMem = process.env.MEM_DB_PATH;
      delete process.env.RECALL_DB_PATH;
      delete process.env.MEM_DB_PATH;

      try {
        const expected = join(homedir(), '.agents', 'Recall', 'recall.db');
        expect(getDbPath()).toBe(expected);
      } finally {
        if (originalRecall !== undefined) process.env.RECALL_DB_PATH = originalRecall;
        if (originalMem !== undefined) process.env.MEM_DB_PATH = originalMem;
      }
    });

    test('falls back to MEM_DB_PATH when RECALL_DB_PATH is not set (back-compat)', () => {
      const originalRecall = process.env.RECALL_DB_PATH;
      const originalMem = process.env.MEM_DB_PATH;
      delete process.env.RECALL_DB_PATH;
      process.env.MEM_DB_PATH = '/tmp/legacy-recall-db-path.db';

      try {
        expect(getDbPath()).toBe('/tmp/legacy-recall-db-path.db');
      } finally {
        if (originalRecall !== undefined) process.env.RECALL_DB_PATH = originalRecall;
        if (originalMem !== undefined) {
          process.env.MEM_DB_PATH = originalMem;
        } else {
          delete process.env.MEM_DB_PATH;
        }
      }
    });

    test('RECALL_DB_PATH takes precedence over MEM_DB_PATH', () => {
      const originalRecall = process.env.RECALL_DB_PATH;
      const originalMem = process.env.MEM_DB_PATH;
      process.env.RECALL_DB_PATH = '/tmp/recall-primary.db';
      process.env.MEM_DB_PATH = '/tmp/legacy-recall-db.db';

      try {
        expect(getDbPath()).toBe('/tmp/recall-primary.db');
      } finally {
        if (originalRecall !== undefined) {
          process.env.RECALL_DB_PATH = originalRecall;
        } else {
          delete process.env.RECALL_DB_PATH;
        }
        if (originalMem !== undefined) {
          process.env.MEM_DB_PATH = originalMem;
        } else {
          delete process.env.MEM_DB_PATH;
        }
      }
    });
  });

  describe('initDb', () => {
    test('creates database file and returns { created: true }', () => {
      // Temporarily point RECALL_DB_PATH at a brand-new location so we can
      // exercise the "first-time creation" code path without touching the
      // shared test DB managed by the setup helper.
      closeDb();

      const freshDir = mkdtempSync(join(tmpdir(), 'recall-test-init-'));
      const freshPath = join(freshDir, 'fresh.db');
      const originalPath = process.env.RECALL_DB_PATH;

      try {
        process.env.RECALL_DB_PATH = freshPath;
        const result = initDb();
        expect(result.created).toBe(true);
        expect(result.path).toBe(freshPath);
      } finally {
        closeDb();
        process.env.RECALL_DB_PATH = originalPath;
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

    test('succeeds on a pre-migration DB (regresses the v0.7.0 -> v0.7.11 upgrade bug)', () => {
      // Regression for the pre-0.7.11 ordering bug in initDb: CREATE_INDEXES
      // ran before applyMigrations, so any DB still at schema v7 blew up on
      // idx_messages_importance during upgrade install. This test seeds a
      // fixture DB at schema v7 (messages table WITHOUT the importance column)
      // and asserts that initDb migrates cleanly.
      closeDb();

      const freshDir = mkdtempSync(join(tmpdir(), 'recall-test-upgrade-'));
      const freshPath = join(freshDir, 'upgrade.db');
      const originalPath = process.env.RECALL_DB_PATH;

      try {
        // Seed a v7 DB fixture with just the messages table WITHOUT the
        // importance column added in migration 7->8. CREATE_TABLES from
        // initDb will create the other tables (with importance), then
        // applyMigrations' ADD COLUMN on messages adds importance there too,
        // then CREATE_INDEXES can safely reference idx_messages_importance.
        //
        // Pre-0.7.11, CREATE_INDEXES ran before applyMigrations, so this
        // exact shape blew up on "no such column: importance" and never
        // made it to the migration step.
        const seed = new Database(freshPath);
        const seedStmts = [
          'PRAGMA journal_mode = WAL',
          `CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            timestamp DATETIME NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            project TEXT
          )`,
          'PRAGMA user_version = 7',
        ];
        for (const stmt of seedStmts) seed.prepare(stmt).run();
        seed.close();

        process.env.RECALL_DB_PATH = freshPath;

        // Pre-0.7.11 this threw "SQLiteError: no such column: importance"
        // from CREATE_INDEXES before applyMigrations ran. Post-fix it migrates.
        expect(() => initDb()).not.toThrow();

        // After initDb, user_version should be bumped and importance columns + indexes present.
        const verifier = new Database(freshPath, { readonly: true });
        try {
          const uv = verifier.prepare('PRAGMA user_version').get() as { user_version: number };
          expect(uv.user_version).toBeGreaterThanOrEqual(8);

          // Every table touched by migration 7->8 should now carry importance.
          for (const table of ['messages', 'decisions', 'learnings', 'loa_entries']) {
            const cols = verifier.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
            const names = cols.map((c) => c.name);
            expect(names).toContain('importance');
          }

          // Indexes created by CREATE_INDEXES (now post-migration) must exist.
          const idxs = verifier.prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%_importance'"
          ).all() as Array<{ name: string }>;
          const idxNames = idxs.map((i) => i.name);
          expect(idxNames).toContain('idx_messages_importance');
          expect(idxNames).toContain('idx_decisions_importance');
          expect(idxNames).toContain('idx_learnings_importance');
          expect(idxNames).toContain('idx_loa_importance');
        } finally {
          verifier.close();
        }
      } finally {
        closeDb();
        process.env.RECALL_DB_PATH = originalPath;
        rmSync(freshDir, { recursive: true, force: true });
        // Restore the shared test DB connection for subsequent tests
        initDb();
      }
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
