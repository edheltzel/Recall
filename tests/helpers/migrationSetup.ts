import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Extraction-specific DDL (matches what will be added to src/db/schema.ts)
const EXTRACTION_DDL = `
CREATE TABLE IF NOT EXISTS extraction_tracker (
  conversation_path TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  extracted_at TEXT,
  failed_at TEXT,
  retry_after TEXT,
  error TEXT,
  skipped INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS extraction_sessions (
  session_id TEXT PRIMARY KEY,
  project TEXT,
  branch TEXT,
  timestamp TEXT NOT NULL,
  summary TEXT,
  topics TEXT,
  conversation_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_extraction_sessions_ts ON extraction_sessions(timestamp DESC);

CREATE TABLE IF NOT EXISTS extraction_errors (
  error_key TEXT PRIMARY KEY,
  error TEXT NOT NULL,
  fix TEXT,
  context TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS extraction_locks (
  conversation_path TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  started_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

let tempDir: string | null = null;
let db: Database | null = null;

export function setupMigrationDb(): { db: Database; dbPath: string; tempDir: string } {
  tempDir = mkdtempSync(join(tmpdir(), 'recall-migration-test-'));
  const dbPath = join(tempDir, 'test.db');
  db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(EXTRACTION_DDL);
  db.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)').run('version', '4');
  return { db, dbPath, tempDir };
}

export function getMigrationDb(): Database {
  if (!db) throw new Error('Call setupMigrationDb() first');
  return db;
}

export function getDbPath(): string {
  if (!tempDir) throw new Error('Call setupMigrationDb() first');
  return join(tempDir, 'test.db');
}

export function teardownMigrationDb(): void {
  if (db) {
    db.close();
    db = null;
  }
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
}
