import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { getDbPath, getDb, initDb, closeDb, getDbStats } from '../../src/db/connection';
import { MIGRATIONS, applyMigrations } from '../../src/db/migrations';

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

  describe('getDb migration self-heal (#202)', () => {
    // Build a current-schema DB on a fresh path, run `degrade` against the raw
    // file to simulate a live install that drifted behind source, then assert
    // that opening it through getDb() (NOT initDb) brings it current. Mirrors
    // the existing v7 initDb regression, but proves the runtime open path.
    function withDriftedDb(degrade: (raw: Database) => void, assert: () => void): void {
      closeDb();
      const freshDir = mkdtempSync(join(tmpdir(), 'recall-test-getdb-migrate-'));
      const freshPath = join(freshDir, 'drifted.db');
      const originalPath = process.env.RECALL_DB_PATH;
      try {
        process.env.RECALL_DB_PATH = freshPath;
        initDb();   // build a full current-schema DB at user_version = MIGRATIONS.length
        closeDb();

        const raw = new Database(freshPath);
        degrade(raw);
        raw.close();

        assert();
      } finally {
        closeDb();
        process.env.RECALL_DB_PATH = originalPath;
        rmSync(freshDir, { recursive: true, force: true });
        initDb(); // restore the shared test DB connection for subsequent tests
      }
    }

    test('migrates a DB pinned at user_version N-1 to current on open', () => {
      withDriftedDb(
        (raw) => {
          // Pin one migration behind, exactly as a live DB sits when init last
          // ran before the newest migration landed (the #202 failure mode).
          raw.prepare(`PRAGMA user_version = ${MIGRATIONS.length - 1}`).run();
        },
        () => {
          const uv = getDb().query('PRAGMA user_version').get() as { user_version: number };
          expect(uv.user_version).toBe(MIGRATIONS.length);
        }
      );
    });

    test('self-heals a base table a pending migration depends on (live v15 code_* gap)', () => {
      // The observed live bug: a DB at user_version 15 had NO code_* base tables
      // because they live in CREATE_TABLES (run only by initDb), and migration
      // 15->16 tolerates their absence and just bumps the version. getDb calling
      // applyMigrations *alone* would advance to 16 while leaving code_* missing.
      // Reproduce that drift and assert getDb recreates the base tables — proof
      // that the open path runs initDb's full CREATE_TABLES->migrate->indexes
      // ordering, not migrations in isolation.
      withDriftedDb(
        (raw) => {
          raw.prepare('PRAGMA foreign_keys = OFF').run();
          for (const obj of ['code_edges', 'code_nodes', 'code_files']) {
            raw.prepare(`DROP TABLE IF EXISTS ${obj}`).run();
          }
          raw.prepare(`PRAGMA user_version = ${MIGRATIONS.length - 1}`).run();
        },
        () => {
          const db = getDb();
          const uv = db.query('PRAGMA user_version').get() as { user_version: number };
          expect(uv.user_version).toBe(MIGRATIONS.length);
          for (const table of ['code_files', 'code_nodes', 'code_edges']) {
            const row = db
              .query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
              .get(table) as { name: string } | null;
            expect(row?.name).toBe(table);
          }
        }
      );
    });

    test('concurrent migrators converge without double-applying (#202)', () => {
      // applyMigrations reads user_version once before its loop, so two processes
      // can both observe version N-1 and race. Open two handles to one file at
      // N-1: the winner advances to current; the loser must no-op (applied 0),
      // not double-apply or throw. (BEGIN IMMEDIATE + the under-lock re-read are
      // what make the truly-interleaved case safe; this asserts convergence.)
      closeDb();
      const freshDir = mkdtempSync(join(tmpdir(), 'recall-test-getdb-concurrent-'));
      const freshPath = join(freshDir, 'concurrent.db');
      const originalPath = process.env.RECALL_DB_PATH;
      try {
        process.env.RECALL_DB_PATH = freshPath;
        initDb();
        closeDb();

        const seed = new Database(freshPath);
        seed.prepare(`PRAGMA user_version = ${MIGRATIONS.length - 1}`).run();
        seed.close();

        const a = new Database(freshPath);
        const b = new Database(freshPath);
        try {
          const ra = applyMigrations(a);
          const rb = applyMigrations(b);
          expect(ra.applied).toBe(1);
          expect(ra.to).toBe(MIGRATIONS.length);
          expect(rb.applied).toBe(0); // loser sees the new version and no-ops
          const uv = b.query('PRAGMA user_version').get() as { user_version: number };
          expect(uv.user_version).toBe(MIGRATIONS.length);
        } finally {
          a.close();
          b.close();
        }
      } finally {
        closeDb();
        process.env.RECALL_DB_PATH = originalPath;
        rmSync(freshDir, { recursive: true, force: true });
        initDb();
      }
    });
  });

  describe('busy_timeout pragma (#96)', () => {
    test('getDb() connection sets busy_timeout = 5000', () => {
      const row = getDb().query('PRAGMA busy_timeout').get() as { timeout: number };
      expect(row.timeout).toBe(5000);
    });

    test('a fresh initDb() connection sets busy_timeout = 5000', () => {
      // initDb opens its own connection during one-time schema setup; it must
      // also wait up to 5s on a held lock rather than failing fast (#96).
      closeDb();
      const freshDir = mkdtempSync(join(tmpdir(), 'recall-test-busy-'));
      const freshPath = join(freshDir, 'busy.db');
      const originalPath = process.env.RECALL_DB_PATH;

      try {
        process.env.RECALL_DB_PATH = freshPath;
        initDb();
        const row = getDb().query('PRAGMA busy_timeout').get() as { timeout: number };
        expect(row.timeout).toBe(5000);
      } finally {
        closeDb();
        process.env.RECALL_DB_PATH = originalPath;
        rmSync(freshDir, { recursive: true, force: true });
        // Restore the shared test DB connection for subsequent tests
        initDb();
      }
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
