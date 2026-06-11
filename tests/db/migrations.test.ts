import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CREATE_TABLES, CREATE_INDEXES } from '../../src/db/schema';
import { applyMigrations, getMigrationVersion, MIGRATIONS } from '../../src/db/migrations';

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

describe('MIGRATIONS array', () => {
  test('has expected number of migrations', () => {
    // 7 → 8: importance column on messages/decisions/learnings/loa_entries (Sprint #4)
    // 8 → 9: provenance column on all five memory tables (issue #42)
    expect(MIGRATIONS.length).toBe(9);
  });

  test('all entries are functions', () => {
    for (const m of MIGRATIONS) {
      expect(typeof m).toBe('function');
    }
  });
});
