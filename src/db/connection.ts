// Database connection management for RECALL	

import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, statSync, chmodSync } from 'fs';
import { CREATE_TABLES, CREATE_INDEXES, CREATE_FTS, CREATE_FTS_TRIGGERS, CREATE_VECTOR_TABLES } from './schema.js';
import { applyMigrations } from './migrations.js';
// Importing vec sets up bun:sqlite's custom (extension-capable) SQLite on macOS
// at module load — BEFORE any Database is opened below, as setCustomSQLite
// requires (it is process-global). See src/db/vec.ts.
import { loadVecExtension, isVecAvailable, createVecTable } from './vec.js';

const DEFAULT_DB_PATH = join(homedir(), '.agents', 'Recall', 'recall.db');

let db: Database | null = null;
let dbInitializing = false; // Lock to prevent race condition

/**
 * Apply the connection-level PRAGMAs every open shares (issue #151).
 *
 * Durability is preserved: WAL stays on and `synchronous` is left at its
 * default — NO `synchronous=OFF` (these are read-path tuning only).
 *
 * Read tuning (kept only because Suite F showed a win):
 * - cache_size  = -65536 → 64 MB page cache per connection (negative = KiB),
 *   up from the 2 MB default, so warm reads stay in memory.
 * - mmap_size   = 256 MB → memory-map the DB file so large scans (the vector
 *   BLOB reads) avoid per-page read() syscalls.
 * - temp_store  = MEMORY → keep transient sort/temp B-trees in RAM.
 */
function applyConnectionPragmas(database: Database): void {
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA foreign_keys = ON');
  // Concurrent CLI/MCP/hook invocations share this file. Without a busy
  // timeout, a writer that finds the lock held fails immediately with
  // 'database is locked'; wait up to 5s for the lock to clear instead.
  // (#72/#96 — do not regress.)
  database.exec('PRAGMA busy_timeout = 5000');
  // Read-path tuning (#151) — see doc comment above. No durability change.
  database.exec('PRAGMA cache_size = -65536');
  database.exec('PRAGMA mmap_size = 268435456');
  database.exec('PRAGMA temp_store = MEMORY');
}

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
    applyConnectionPragmas(db);
    // Best-effort load of sqlite-vec (#148). Never throws; on failure the
    // vector path falls back to the brute-force cosine scan.
    loadVecExtension(db);

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
  applyConnectionPragmas(db);
  // Best-effort load of sqlite-vec (#148) before schema setup, so the vec0
  // index table can be created below when the extension is available.
  loadVecExtension(db);

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
  // sqlite-vec index table (#148) — created ONLY when the extension loaded.
  // Deliberately NOT a migration: a vec0 CREATE throws where the extension is
  // absent, which would break initDb and violate the OPTIONAL invariant. This
  // idempotent, availability-guarded create is the correct home.
  if (isVecAvailable()) {
    createVecTable(db);
  }

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
