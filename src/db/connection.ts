// Database connection management for RECALL	

import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, statSync, chmodSync } from 'fs';
import { CREATE_TABLES, CREATE_INDEXES, CREATE_FTS, CREATE_FTS_TRIGGERS, CREATE_VECTOR_TABLES } from './schema.js';
import { applyMigrations } from './migrations.js';

const DEFAULT_DB_PATH = join(homedir(), '.agents', 'Recall', 'recall.db');

let db: Database | null = null;
let dbInitializing = false; // Lock to prevent race condition

// Precedence:
//   1. RECALL_DB_PATH (primary)
//   2. MEM_DB_PATH    (legacy fallback)
//   3. DEFAULT_DB_PATH
export function getDbPath(): string {
  return (
    process.env.RECALL_DB_PATH ||
    process.env.MEM_DB_PATH ||
    DEFAULT_DB_PATH
  );
}

export function getDb(): Database {
  // Fast path: already initialized
  if (db) {
    return db;
  }

  // Prevent race condition: if another call is initializing, wait
  if (dbInitializing) {
    // Spin-wait (safe in Node.js single-threaded context)
    while (dbInitializing && !db) {
      // In practice this should never spin because bun:sqlite is synchronous
    }
    if (db) return db;
  }

  // Acquire lock
  dbInitializing = true;

  try {
    // Double-check after acquiring lock
    if (db) {
      return db;
    }

    const dbPath = getDbPath();

    if (!existsSync(dbPath)) {
      throw new Error(`Database not found at ${dbPath}. Run 'recall init' first.`);
    }

    db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    // Concurrent CLI/MCP/hook invocations share this file. Without a busy
    // timeout, a writer that finds the lock held fails immediately with
    // 'database is locked'; wait up to 5s for the lock to clear instead. (#72)
    db.exec('PRAGMA busy_timeout = 5000');

    return db;
  } finally {
    dbInitializing = false;
  }
}

export function initDb(): { created: boolean; path: string } {
  const dbPath = getDbPath();
  const dbDir = join(dbPath, '..');

  // Ensure directory exists
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  const alreadyExists = existsSync(dbPath);

  db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  // One-time init can legitimately race a concurrent hook DB open (extraction
  // hooks fire on their own schedule). Wait up to 5s for a held lock to clear
  // rather than failing the whole init on transient contention — chosen over
  // fail-fast so a background hook write can't abort `recall init`. (#72/#96)
  db.exec('PRAGMA busy_timeout = 5000');

  // Schema setup — ordering matters. See CHANGELOG 0.7.11.
  // 1) CREATE_TABLES: idempotent — creates tables that don't exist yet.
  // 2) applyMigrations: mutates existing tables (ADD COLUMN etc.) based on
  //    PRAGMA user_version. Must run BEFORE any step that references
  //    post-migration columns.
  // 3) CREATE_INDEXES / FTS / vector tables: may reference columns added
  //    by migrations (e.g. idx_messages_importance from migration 7->8).
  //    Running these before applyMigrations breaks every upgrade path.
  db.exec(CREATE_TABLES);
  const migration = applyMigrations(db);
  db.exec(CREATE_INDEXES);
  db.exec(CREATE_FTS);
  db.exec(CREATE_FTS_TRIGGERS);
  db.exec(CREATE_VECTOR_TABLES);

  if (migration.applied > 0) {
    // Keep schema_meta in sync for backward compatibility with older code.
    db.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)').run('version', String(migration.to));
  }

  // SECURITY: Set restrictive permissions (owner read/write only)
  // Prevents other users on system from reading conversation history
  try {
    chmodSync(dbPath, 0o600);
    // Also secure WAL and SHM files if they exist
    const walPath = dbPath + '-wal';
    const shmPath = dbPath + '-shm';
    if (existsSync(walPath)) chmodSync(walPath, 0o600);
    if (existsSync(shmPath)) chmodSync(shmPath, 0o600);
  } catch {
    // chmod may fail on some filesystems - non-fatal
  }

  return { created: !alreadyExists, path: dbPath };
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function getDbStats(): { size_bytes: number; path: string } {
  const dbPath = getDbPath();
  const stats = statSync(dbPath);
  return {
    size_bytes: stats.size,
    path: dbPath
  };
}
