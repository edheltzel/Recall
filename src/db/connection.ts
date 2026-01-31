// Database connection management for Memory Larry 3.0

import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, statSync, chmodSync } from 'fs';
import { CREATE_TABLES, CREATE_INDEXES, CREATE_FTS, CREATE_FTS_TRIGGERS, CREATE_VECTOR_TABLES, SCHEMA_VERSION } from './schema.js';

const DEFAULT_DB_PATH = join(homedir(), '.claude', 'memory.db');

let db: Database.Database | null = null;
let dbInitializing = false; // Lock to prevent race condition

export function getDbPath(): string {
  return process.env.MEM_DB_PATH || DEFAULT_DB_PATH;
}

export function getDb(): Database.Database {
  // Fast path: already initialized
  if (db) {
    return db;
  }

  // Prevent race condition: if another call is initializing, wait
  if (dbInitializing) {
    // Spin-wait (safe in Node.js single-threaded context)
    while (dbInitializing && !db) {
      // In practice this should never spin because better-sqlite3 is synchronous
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
      throw new Error(`Database not found at ${dbPath}. Run 'mem init' first.`);
    }

    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

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
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Run schema creation (exec handles multiple statements)
  db.exec(CREATE_TABLES);
  db.exec(CREATE_INDEXES);
  db.exec(CREATE_FTS);
  db.exec(CREATE_FTS_TRIGGERS);
  db.exec(CREATE_VECTOR_TABLES);

  // Set schema version
  db.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)').run('version', String(SCHEMA_VERSION));

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
