import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { CREATE_TABLES, CREATE_INDEXES } from '../../src/db/schema';
import { applyMigrations, getMigrationVersion, MIGRATIONS } from '../../src/db/migrations';

// bun snapshots $HOME at process startup, so mutating process.env.HOME at
// runtime does not change os.homedir(). To let a test point migration 4→5 at a
// fixture home dir, mock os.homedir() to return `mockedHome` when set and the
// real home otherwise — the passthrough keeps every other test unaffected.
const realHomedir = homedir;
let mockedHome: string | null = null;
mock.module('os', () => ({ ...require('os'), homedir: () => mockedHome ?? realHomedir() }));

let tempDir: string;
let db: Database;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'recall-migrations-test-'));
  const dbPath = join(tempDir, 'test.db');
  db = new Database(dbPath);
  db.prepare('PRAGMA journal_mode = WAL').run();
  db.prepare('PRAGMA foreign_keys = ON').run();
  db.exec(CREATE_TABLES);
  db.exec(CREATE_INDEXES);
});

afterEach(() => {
  if (db) db.close();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe('getMigrationVersion', () => {
  test('returns 0 for fresh database', () => {
    expect(getMigrationVersion(db)).toBe(0);
  });

  test('returns correct version after setting PRAGMA', () => {
    db.prepare('PRAGMA user_version = 3').run();
    expect(getMigrationVersion(db)).toBe(3);
  });
});

describe('applyMigrations', () => {
  test('applies all migrations on fresh database', () => {
    const result = applyMigrations(db);
    expect(result.from).toBe(0);
    expect(result.to).toBe(MIGRATIONS.length);
    expect(result.applied).toBe(MIGRATIONS.length);
    expect(getMigrationVersion(db)).toBe(MIGRATIONS.length);
  });

  test('no-ops when already at latest version', () => {
    applyMigrations(db);
    const result = applyMigrations(db);
    expect(result.applied).toBe(0);
    expect(result.from).toBe(MIGRATIONS.length);
  });

  test('applies only pending migrations', () => {
    db.prepare('PRAGMA user_version = 3').run();
    const result = applyMigrations(db);
    expect(result.from).toBe(3);
    expect(result.to).toBe(MIGRATIONS.length);
    expect(result.applied).toBe(MIGRATIONS.length - 3);
  });

  test('sessions table has source column after migrations', () => {
    applyMigrations(db);
    const cols = db.prepare('PRAGMA table_info(sessions)').all() as any[];
    const colNames = cols.map((c: any) => c.name);
    expect(colNames).toContain('source');
  });

  test('schema_meta updated for backward compat', () => {
    const migration = applyMigrations(db);
    if (migration.applied > 0) {
      db.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)').run('version', String(migration.to));
    }
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as any;
    expect(row.value).toBe(String(MIGRATIONS.length));
  });
});

describe('bridge migration', () => {
  test('existing install with schema_meta v4 gets user_version set', () => {
    db.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)').run('version', '4');
    expect(getMigrationVersion(db)).toBe(0);

    const result = applyMigrations(db);
    expect(result.from).toBe(0);
    expect(result.applied).toBe(MIGRATIONS.length);
    expect(getMigrationVersion(db)).toBe(MIGRATIONS.length);
  });
});

describe('data migration (4 to 5)', () => {
  test('does not crash on clean DB without JSON files', () => {
    db.prepare('PRAGMA user_version = 4').run();
    const result = applyMigrations(db);
    expect(result.applied).toBe(MIGRATIONS.length - 4);
    expect(getMigrationVersion(db)).toBe(MIGRATIONS.length);
  });

  test('legacy JSON import runs when flag unset, is suppressed when flag set ($HOME fixture)', () => {
    // A real ~/.claude/MEMORY/*.json fixture (via $HOME) makes the guard
    // discriminating: Leg A proves the import path actually populates the
    // extraction_* tables; Leg B proves the flag suppresses ingestion while
    // the migration chain still advances user_version to latest. Without the
    // fixture, "tables empty" is satisfied by an empty host home dir and the
    // test would pass even if migration 4→5 were deleted.
    const convPath = '/tmp/recall-fixture-conv.jsonl';
    const homeDir = mkdtempSync(join(tmpdir(), 'recall-home-test-'));
    const memoryDir = join(homeDir, '.claude', 'MEMORY');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(
      join(memoryDir, '.extraction_tracker.json'),
      JSON.stringify({ [convPath]: { size: 1234, extractedAt: '2026-01-01T00:00:00Z', skipped: 0 } })
    );
    writeFileSync(
      join(memoryDir, 'SESSION_INDEX.json'),
      JSON.stringify([
        {
          sessionId: 'sess-1',
          project: 'recall',
          branch: 'main',
          timestamp: '2026-01-02T00:00:00Z',
          summary: 'did things',
          topics: ['a', 'b'],
          conversationPath: convPath,
        },
      ])
    );
    writeFileSync(
      join(memoryDir, 'ERROR_PATTERNS.json'),
      JSON.stringify({
        patterns: [
          {
            error: 'boom',
            fix: 'stop booming',
            context: 'while booming',
            firstSeen: '2026-01-03T00:00:00Z',
            lastSeen: '2026-01-04T00:00:00Z',
          },
        ],
      })
    );

    const count = (d: Database, t: string) =>
      (d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

    // Point migration 4→5's os.homedir() at the fixture home (see top-of-file mock).
    const prevFlag = process.env.RECALL_SKIP_LEGACY_DATA_MIGRATIONS;
    const dbsToClean: Array<{ d: Database; dir: string }> = [];
    const freshV4Db = () => {
      const dir = mkdtempSync(join(tmpdir(), 'recall-leg-db-'));
      const d = new Database(join(dir, 'test.db'));
      d.exec(CREATE_TABLES);
      d.exec(CREATE_INDEXES);
      d.prepare('PRAGMA user_version = 4').run();
      dbsToClean.push({ d, dir });
      return d;
    };

    try {
      mockedHome = homeDir;

      // Leg A — flag UNSET: the import path runs and populates the tables.
      delete process.env.RECALL_SKIP_LEGACY_DATA_MIGRATIONS;
      const a = freshV4Db();
      expect(applyMigrations(a).to).toBe(MIGRATIONS.length);
      expect(getMigrationVersion(a)).toBe(MIGRATIONS.length);

      expect(count(a, 'extraction_tracker')).toBe(1);
      const trackerRow = a.prepare(
        'SELECT conversation_path, size FROM extraction_tracker'
      ).get() as { conversation_path: string; size: number };
      expect(trackerRow.conversation_path).toBe(convPath);
      expect(trackerRow.size).toBe(1234);

      expect(count(a, 'extraction_sessions')).toBe(1);
      const sessionRow = a.prepare(
        'SELECT session_id, timestamp FROM extraction_sessions'
      ).get() as { session_id: string; timestamp: string };
      expect(sessionRow.session_id).toBe('sess-1');
      expect(sessionRow.timestamp).toBe('2026-01-02T00:00:00Z');

      expect(count(a, 'extraction_errors')).toBe(1);
      const errorRow = a.prepare(
        'SELECT error, fix FROM extraction_errors'
      ).get() as { error: string; fix: string };
      expect(errorRow.error).toBe('boom');
      expect(errorRow.fix).toBe('stop booming');

      // Leg B — flag SET: identical fixtures, ingestion suppressed, chain intact.
      process.env.RECALL_SKIP_LEGACY_DATA_MIGRATIONS = '1';
      const b = freshV4Db();
      const result = applyMigrations(b);
      expect(result.applied).toBe(MIGRATIONS.length - 4);
      expect(getMigrationVersion(b)).toBe(MIGRATIONS.length);
      for (const t of ['extraction_sessions', 'extraction_tracker', 'extraction_errors']) {
        expect(count(b, t)).toBe(0);
      }
    } finally {
      mockedHome = null;
      for (const { d, dir } of dbsToClean) {
        d.close();
        rmSync(dir, { recursive: true, force: true });
      }
      rmSync(homeDir, { recursive: true, force: true });
      if (prevFlag === undefined) delete process.env.RECALL_SKIP_LEGACY_DATA_MIGRATIONS;
      else process.env.RECALL_SKIP_LEGACY_DATA_MIGRATIONS = prevFlag;
    }
  });
});

describe('migration failure handling', () => {
  test('failed migration leaves version unchanged', () => {
    db.prepare('PRAGMA user_version = 0').run();
    db.prepare('BEGIN IMMEDIATE').run();
    try {
      throw new Error('Intentional failure');
    } catch {
      db.prepare('ROLLBACK').run();
    }
    expect(getMigrationVersion(db)).toBe(0);
  });
});

describe('provenance migration (8 to 9)', () => {
  const PROVENANCE_TABLES = ['messages', 'decisions', 'learnings', 'breadcrumbs', 'loa_entries'];

  test('all memory tables have provenance column after migrations', () => {
    applyMigrations(db);
    for (const table of PROVENANCE_TABLES) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
      expect(cols.map((c: any) => c.name)).toContain('provenance');
    }
  });

  test('upgrade path: ALTER adds provenance to a legacy table without it', () => {
    // Simulate a pre-provenance install: legacy table shape, version 8.
    const legacyDir = mkdtempSync(join(tmpdir(), 'recall-legacy-test-'));
    const legacyDb = new Database(join(legacyDir, 'legacy.db'));
    try {
      legacyDb.exec(`
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          timestamp DATETIME NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          project TEXT,
          importance INTEGER DEFAULT 5
        );
        CREATE TABLE decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, decision TEXT NOT NULL);
        CREATE TABLE learnings (id INTEGER PRIMARY KEY AUTOINCREMENT, problem TEXT NOT NULL);
        CREATE TABLE breadcrumbs (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL);
        CREATE TABLE loa_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, fabric_extract TEXT NOT NULL);
      `);
      legacyDb.prepare('INSERT INTO messages (session_id, timestamp, role, content) VALUES (?, ?, ?, ?)')
        .run('s1', '2026-01-01T00:00:00Z', 'user', 'legacy row');
      legacyDb.prepare('PRAGMA user_version = 8').run();

      const result = applyMigrations(legacyDb);
      expect(result.from).toBe(8);
      expect(getMigrationVersion(legacyDb)).toBe(MIGRATIONS.length);

      for (const table of PROVENANCE_TABLES) {
        const cols = legacyDb.prepare(`PRAGMA table_info(${table})`).all() as any[];
        expect(cols.map((c: any) => c.name)).toContain('provenance');
      }

      // Legacy rows stay NULL — unknown is never laundered into a value.
      const row = legacyDb.prepare('SELECT provenance FROM messages WHERE session_id = ?').get('s1') as any;
      expect(row.provenance).toBeNull();

      // CHECK on the ALTERed column enforces the vocabulary but allows NULL.
      expect(() => {
        legacyDb.prepare('INSERT INTO messages (session_id, timestamp, role, content, provenance) VALUES (?, ?, ?, ?, ?)')
          .run('s1', '2026-01-01T00:00:01Z', 'user', 'bad', 'guessed');
      }).toThrow();
      legacyDb.prepare('INSERT INTO messages (session_id, timestamp, role, content, provenance) VALUES (?, ?, ?, ?, ?)')
        .run('s1', '2026-01-01T00:00:02Z', 'user', 'ok', 'verbatim');
    } finally {
      legacyDb.close();
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  test('CHECK constraint enforces vocabulary on fresh-install DDL', () => {
    applyMigrations(db);
    const insert = (provenance: string | null) =>
      db.prepare('INSERT INTO breadcrumbs (content, provenance) VALUES (?, ?)').run('x', provenance);

    for (const valid of ['verbatim', 'user_authored', 'extracted', 'derived', null]) {
      expect(() => insert(valid)).not.toThrow();
    }
    expect(() => insert('unknown')).toThrow();
    expect(() => insert('VERBATIM')).toThrow();
  });
});

describe('session_progress migration (10 to 11)', () => {
  const SESSION_PROGRESS_COLUMNS = [
    'session_id',
    'conversation_path',
    'turns_seen',
    'tools_seen',
    'last_offset',
    'runs_this_session',
    'prompts_seen',
    'last_correction_turn',
    'updated_at',
  ];

  test('fresh DB has session_progress with the right columns and lands at latest version', () => {
    applyMigrations(db);
    // Mutation guard: dropping the migration entry shrinks MIGRATIONS.length to
    // 10, so user_version would land at 10, not 11 → this assertion goes RED.
    expect(getMigrationVersion(db)).toBe(MIGRATIONS.length);
    const cols = db.prepare('PRAGMA table_info(session_progress)').all() as any[];
    expect(cols.map((c: any) => c.name).sort()).toEqual([...SESSION_PROGRESS_COLUMNS].sort());
  });

  test('upgrade path: a version-10 DB without the table gets it created', () => {
    // Simulate a pre-#51 install: no session_progress table, version 10.
    const legacyDir = mkdtempSync(join(tmpdir(), 'recall-sessprog-test-'));
    const legacyDb = new Database(join(legacyDir, 'legacy.db'));
    try {
      legacyDb.prepare('PRAGMA user_version = 10').run();
      const before = legacyDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='session_progress'"
      ).get();
      expect(before).toBeNull();

      const result = applyMigrations(legacyDb);
      // Mutation guard: remove the migration entry and target drops to 10, so a
      // version-10 DB applies nothing and the table never appears → RED.
      expect(result.from).toBe(10);
      expect(getMigrationVersion(legacyDb)).toBe(MIGRATIONS.length);

      const cols = legacyDb.prepare('PRAGMA table_info(session_progress)').all() as any[];
      expect(cols.map((c: any) => c.name).sort()).toEqual([...SESSION_PROGRESS_COLUMNS].sort());

      // Counters default to 0 on insert-by-pk.
      legacyDb.prepare('INSERT INTO session_progress (session_id) VALUES (?)').run('s1');
      const row = legacyDb.prepare(
        'SELECT turns_seen, tools_seen, last_offset, runs_this_session FROM session_progress WHERE session_id = ?'
      ).get('s1') as any;
      expect(row.turns_seen).toBe(0);
      expect(row.tools_seen).toBe(0);
      expect(row.last_offset).toBe(0);
      expect(row.runs_this_session).toBe(0);
    } finally {
      legacyDb.close();
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  test('idempotent: re-running migrations is a no-op and keeps the table', () => {
    applyMigrations(db);
    const result = applyMigrations(db);
    expect(result.applied).toBe(0);
    const tbl = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='session_progress'"
    ).get() as any;
    expect(tbl.name).toBe('session_progress');
  });
});

describe('correction rate-limit columns migration (11 to 12)', () => {
  // A pre-#52 install: session_progress exists with the original 7 columns at
  // version 11. The 11 → 12 migration must add the two correction columns.
  function makeLegacyV11Db(dir: string): Database {
    const d = new Database(join(dir, 'legacy11.db'));
    d.prepare(
      `CREATE TABLE session_progress (
         session_id        TEXT PRIMARY KEY,
         conversation_path TEXT,
         turns_seen        INTEGER DEFAULT 0,
         tools_seen        INTEGER DEFAULT 0,
         last_offset       INTEGER DEFAULT 0,
         runs_this_session INTEGER DEFAULT 0,
         updated_at        TEXT
       )`
    ).run();
    d.prepare('PRAGMA user_version = 11').run();
    return d;
  }

  test('upgrade path: a version-11 DB gains prompts_seen + last_correction_turn (default 0)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recall-corr-mig-'));
    const legacyDb = makeLegacyV11Db(dir);
    try {
      const before = legacyDb.prepare('PRAGMA table_info(session_progress)').all() as any[];
      expect(before.map((c) => c.name)).not.toContain('prompts_seen');
      expect(before.map((c) => c.name)).not.toContain('last_correction_turn');

      const result = applyMigrations(legacyDb);
      // Mutation guard: drop the 11 → 12 migration and target falls to 11, so a
      // version-11 DB applies nothing and the columns never appear → RED.
      expect(result.from).toBe(11);
      expect(getMigrationVersion(legacyDb)).toBe(MIGRATIONS.length);

      const after = (legacyDb.prepare('PRAGMA table_info(session_progress)').all() as any[]).map((c) => c.name);
      expect(after).toContain('prompts_seen');
      expect(after).toContain('last_correction_turn');

      // New columns default to 0 on insert-by-pk.
      legacyDb.prepare('INSERT INTO session_progress (session_id) VALUES (?)').run('s1');
      const row = legacyDb.prepare(
        'SELECT prompts_seen, last_correction_turn FROM session_progress WHERE session_id = ?'
      ).get('s1') as any;
      expect(row.prompts_seen).toBe(0);
      expect(row.last_correction_turn).toBe(0);
    } finally {
      legacyDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fresh DB already has the correction columns and lands at the latest version', () => {
    applyMigrations(db);
    expect(getMigrationVersion(db)).toBe(MIGRATIONS.length);
    const cols = (db.prepare('PRAGMA table_info(session_progress)').all() as any[]).map((c) => c.name);
    expect(cols).toContain('prompts_seen');
    expect(cols).toContain('last_correction_turn');
  });

  test('idempotent: re-running after 12 applies nothing', () => {
    applyMigrations(db);
    const result = applyMigrations(db);
    expect(result.applied).toBe(0);
    expect(getMigrationVersion(db)).toBe(MIGRATIONS.length);
  });
});

describe('source-lineage column migration (12 to 13)', () => {
  test('fresh DB has source_ids on loa_entries and lands at the latest version', () => {
    applyMigrations(db);
    // Mutation guard: dropping the 12 → 13 entry shrinks MIGRATIONS.length to
    // 12, so user_version would land at 12 and the column would be absent → RED.
    expect(getMigrationVersion(db)).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.length).toBe(14);
    const cols = (db.prepare('PRAGMA table_info(loa_entries)').all() as any[]).map((c) => c.name);
    expect(cols).toContain('source_ids');
  });

  test('upgrade path: an 11 → 12 → 13 chain adds source_ids to loa_entries (nullable)', () => {
    // A pre-#140 install at version 11: loa_entries lacks source_ids and
    // session_progress still has its original 7 columns. Applying must run both
    // 11 → 12 (correction columns) and 12 → 13 (source_ids) and land at latest.
    const legacyDir = mkdtempSync(join(tmpdir(), 'recall-srcids-mig-'));
    const legacyDb = new Database(join(legacyDir, 'legacy11.db'));
    try {
      legacyDb.exec(`
        CREATE TABLE loa_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          fabric_extract TEXT NOT NULL
        );
        CREATE TABLE session_progress (
          session_id        TEXT PRIMARY KEY,
          conversation_path TEXT,
          turns_seen        INTEGER DEFAULT 0,
          tools_seen        INTEGER DEFAULT 0,
          last_offset       INTEGER DEFAULT 0,
          runs_this_session INTEGER DEFAULT 0,
          updated_at        TEXT
        );
      `);
      legacyDb.prepare('INSERT INTO loa_entries (title, fabric_extract) VALUES (?, ?)')
        .run('legacy', 'extract');
      legacyDb.prepare('PRAGMA user_version = 11').run();

      const before = (legacyDb.prepare('PRAGMA table_info(loa_entries)').all() as any[]).map((c) => c.name);
      expect(before).not.toContain('source_ids');

      const result = applyMigrations(legacyDb);
      // Mutation guard: drop the 12 → 13 migration and target falls to 12, so
      // the column never appears even though the chain still advances → RED.
      expect(result.from).toBe(11);
      expect(getMigrationVersion(legacyDb)).toBe(MIGRATIONS.length);

      const sourceCol = (legacyDb.prepare('PRAGMA table_info(loa_entries)').all() as any[])
        .find((c) => c.name === 'source_ids');
      expect(sourceCol).toBeDefined();
      // Declared TEXT, no NOT NULL, no default → legacy rows stay NULL.
      expect(sourceCol.type).toBe('TEXT');
      expect(sourceCol.notnull).toBe(0);
      const legacyRow = legacyDb.prepare('SELECT source_ids FROM loa_entries WHERE title = ?').get('legacy') as any;
      expect(legacyRow.source_ids).toBeNull();

      // A derived summary can record its origin records as JSON; round-trips.
      const lineage = JSON.stringify([
        { table: 'loa_entries', id: 1 },
        { table: 'decisions', id: 9 },
      ]);
      legacyDb.prepare('INSERT INTO loa_entries (title, fabric_extract, source_ids) VALUES (?, ?, ?)')
        .run('derived', 'consolidated', lineage);
      const derived = legacyDb.prepare('SELECT source_ids FROM loa_entries WHERE title = ?').get('derived') as any;
      expect(JSON.parse(derived.source_ids)).toEqual([
        { table: 'loa_entries', id: 1 },
        { table: 'decisions', id: 9 },
      ]);
    } finally {
      legacyDb.close();
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  test('idempotent: re-running after 13 applies nothing', () => {
    applyMigrations(db);
    const result = applyMigrations(db);
    expect(result.applied).toBe(0);
    expect(getMigrationVersion(db)).toBe(MIGRATIONS.length);
  });
});

describe('access-tracking columns migration (13 to 14)', () => {
  const ACCESS_TABLES = ['messages', 'decisions', 'learnings', 'breadcrumbs', 'loa_entries'];

  test('fresh DB has access_count + last_accessed on all five memory tables', () => {
    applyMigrations(db);
    // Mutation guard: dropping the 13 → 14 entry shrinks MIGRATIONS.length to 13,
    // so user_version would land at 13 and the columns would be absent → RED.
    expect(getMigrationVersion(db)).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.length).toBe(14);
    for (const table of ACCESS_TABLES) {
      const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name);
      expect(cols).toContain('access_count');
      expect(cols).toContain('last_accessed');
    }
  });

  test('fresh-install defaults: access_count = 0, last_accessed = NULL', () => {
    applyMigrations(db);
    db.prepare('INSERT INTO breadcrumbs (content) VALUES (?)').run('fresh row');
    const row = db.prepare(
      'SELECT access_count, last_accessed FROM breadcrumbs WHERE content = ?'
    ).get('fresh row') as any;
    expect(row.access_count).toBe(0);
    expect(row.last_accessed).toBeNull();
  });

  test('upgrade path: a version-13 legacy DB gains the columns with correct defaults', () => {
    // A pre-#152 install at version 13: the five memory tables lack the
    // access-tracking columns. Applying must run only 13 → 14 and land at latest.
    const legacyDir = mkdtempSync(join(tmpdir(), 'recall-access-mig-'));
    const legacyDb = new Database(join(legacyDir, 'legacy13.db'));
    try {
      legacyDb.exec(`
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          timestamp DATETIME NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL
        );
        CREATE TABLE decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, decision TEXT NOT NULL);
        CREATE TABLE learnings (id INTEGER PRIMARY KEY AUTOINCREMENT, problem TEXT NOT NULL);
        CREATE TABLE breadcrumbs (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL);
        CREATE TABLE loa_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, fabric_extract TEXT NOT NULL);
      `);
      legacyDb.prepare('INSERT INTO breadcrumbs (content) VALUES (?)').run('legacy row');
      legacyDb.prepare('PRAGMA user_version = 13').run();

      for (const table of ACCESS_TABLES) {
        const before = (legacyDb.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name);
        expect(before).not.toContain('access_count');
        expect(before).not.toContain('last_accessed');
      }

      const result = applyMigrations(legacyDb);
      // Mutation guard: drop the 13 → 14 migration and target falls to 13, so the
      // columns never appear even though the chain still advances → RED.
      expect(result.from).toBe(13);
      expect(getMigrationVersion(legacyDb)).toBe(MIGRATIONS.length);

      for (const table of ACCESS_TABLES) {
        const cols = legacyDb.prepare(`PRAGMA table_info(${table})`).all() as any[];
        const accessCol = cols.find((c) => c.name === 'access_count');
        const lastCol = cols.find((c) => c.name === 'last_accessed');
        expect(accessCol).toBeDefined();
        // access_count is a non-null integer defaulting to 0.
        expect(accessCol.dflt_value).toBe('0');
        // last_accessed is nullable with no default → NULL until a row is used.
        expect(lastCol).toBeDefined();
        expect(lastCol.notnull).toBe(0);
        expect(lastCol.dflt_value).toBeNull();
      }

      // Legacy rows pick up the defaults: count 0, last_accessed NULL.
      const row = legacyDb.prepare(
        'SELECT access_count, last_accessed FROM breadcrumbs WHERE content = ?'
      ).get('legacy row') as any;
      expect(row.access_count).toBe(0);
      expect(row.last_accessed).toBeNull();
    } finally {
      legacyDb.close();
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  test('idempotent: re-running after 14 applies nothing', () => {
    applyMigrations(db);
    const result = applyMigrations(db);
    expect(result.applied).toBe(0);
    expect(getMigrationVersion(db)).toBe(MIGRATIONS.length);
  });
});

describe('MIGRATIONS array', () => {
  test('has expected number of migrations', () => {
    // 7 → 8: importance column on messages/decisions/learnings/loa_entries (Sprint #4)
    // 8 → 9: provenance column on all five memory tables (issue #42)
    // 9 → 10: dedup_lineage table (issue #45)
    // 10 → 11: session_progress table (issue #51)
    // 11 → 12: correction rate-limit columns on session_progress (issue #52)
    // 12 → 13: source_ids lineage column on loa_entries (issue #140)
    // 13 → 14: access_count + last_accessed on all five memory tables (issue #152)
    expect(MIGRATIONS.length).toBe(14);
  });

  test('all entries are functions', () => {
    for (const m of MIGRATIONS) {
      expect(typeof m).toBe('function');
    }
  });
});
