// Ordered migration system using PRAGMA user_version.
//
// Each migration is a function that receives an open Database handle.
// The runner applies migrations[current..target] sequentially, each in its
// own transaction. PRAGMA user_version is bumped after each successful migration.
//
// To add a new migration: append a function to the MIGRATIONS array.
// The index IS the version number. Migration at index N brings the DB from N → N+1.

import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export type Migration = (db: Database) => void;

// ---------------------------------------------------------------------------
// Migration definitions
// ---------------------------------------------------------------------------

export const MIGRATIONS: Migration[] = [
  // Migration 0 → 1: Bridge from schema_meta to PRAGMA user_version.
  // Existing installs have schema_meta.version = "4" but user_version = 0.
  // Fresh installs have neither. CREATE TABLE IF NOT EXISTS handles DDL.
  // This migration is a no-op — it exists so the runner advances user_version to 1.
  (_db) => {},

  // Migration 1 → 2: No-op (historical — initial tables created by CREATE TABLE IF NOT EXISTS)
  (_db) => {},

  // Migration 2 → 3: Add source column for multi-platform support
  (db) => {
    try {
      db.prepare("ALTER TABLE sessions ADD COLUMN source TEXT DEFAULT 'claude-code'").run();
    } catch {
      // Column already exists on fresh installs — safe to ignore
    }
  },

  // Migration 3 → 4: Extraction tables (created by CREATE TABLE IF NOT EXISTS in schema DDL)
  // No-op — tables are brand new, handled by the DDL that runs before migrations.
  (_db) => {},

  // Migration 4 → 5: JSON → SQLite data migration for extraction state.
  // Migrates .extraction_tracker.json, SESSION_INDEX.json, ERROR_PATTERNS.json
  // into extraction_tracker, extraction_sessions, extraction_errors tables.
  (db) => {
    const memoryDir = join(homedir(), '.claude', 'MEMORY');

    const trackerPath = join(memoryDir, '.extraction_tracker.json');
    const sessionPath = join(memoryDir, 'SESSION_INDEX.json');
    const errorPath = join(memoryDir, 'ERROR_PATTERNS.json');

    // Migrate tracker
    if (existsSync(trackerPath)) {
      try {
        const data = JSON.parse(readFileSync(trackerPath, 'utf-8')) as Record<string, any>;
        const stmt = db.prepare(`
          INSERT OR IGNORE INTO extraction_tracker
            (conversation_path, size, extracted_at, failed_at, retry_after, error, skipped)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const [path, entry] of Object.entries(data)) {
          stmt.run(
            path,
            entry.size ?? 0,
            entry.extractedAt ?? null,
            entry.failedAt ?? null,
            entry.retryAfter ?? null,
            entry.error ?? null,
            entry.skipped ?? 0
          );
        }
      } catch { /* corrupted file — skip, don't block migration */ }
    }

    // Migrate session index
    if (existsSync(sessionPath)) {
      try {
        const data = JSON.parse(readFileSync(sessionPath, 'utf-8')) as any[];
        const stmt = db.prepare(`
          INSERT OR IGNORE INTO extraction_sessions
            (session_id, project, branch, timestamp, summary, topics, conversation_path)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const entry of data) {
          if (!entry.timestamp) continue;
          stmt.run(
            entry.sessionId,
            entry.project ?? null,
            entry.branch ?? null,
            entry.timestamp,
            entry.summary ?? null,
            JSON.stringify(entry.topics ?? []),
            entry.conversationPath ?? null
          );
        }
      } catch { /* corrupted — skip */ }
    }

    // Migrate error patterns
    if (existsSync(errorPath)) {
      try {
        const data = JSON.parse(readFileSync(errorPath, 'utf-8'));
        const patterns = data.patterns ?? [];
        const stmt = db.prepare(`
          INSERT OR IGNORE INTO extraction_errors
            (error_key, error, fix, context, first_seen, last_seen)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const p of patterns) {
          const firstSeen = p.firstSeen ?? p.date ?? new Date().toISOString();
          const lastSeen = p.lastSeen ?? p.date ?? new Date().toISOString();
          const context = p.context ?? p.cause ?? null;
          stmt.run(p.error, p.error, p.fix ?? null, context, firstSeen, lastSeen);
        }
      } catch { /* corrupted — skip */ }
    }
  },

  // Migration 5 → 6: Add confidence column to decisions and learnings
  (db) => {
    try {
      db.prepare(`ALTER TABLE decisions ADD COLUMN confidence TEXT DEFAULT 'medium' CHECK (confidence IN ('high', 'medium', 'low'))`).run();
    } catch {
      // Column already exists — safe to ignore
    }
    try {
      db.prepare(`ALTER TABLE learnings ADD COLUMN confidence TEXT DEFAULT 'medium' CHECK (confidence IN ('high', 'medium', 'low'))`).run();
    } catch {
      // Column already exists — safe to ignore
    }
  },
];

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

export interface MigrationResult {
  from: number;
  to: number;
  applied: number;
}

/**
 * Apply pending migrations to the database.
 *
 * Reads PRAGMA user_version to determine current state, then applies
 * each migration in order within its own transaction. On failure,
 * the failing migration is rolled back and an error is thrown.
 */
export function applyMigrations(db: Database): MigrationResult {
  const current = (db.prepare('PRAGMA user_version').get() as any).user_version as number;
  const target = MIGRATIONS.length;

  if (current >= target) {
    return { from: current, to: target, applied: 0 };
  }

  let applied = 0;
  for (let i = current; i < target; i++) {
    db.prepare('BEGIN IMMEDIATE').run();
    try {
      MIGRATIONS[i](db);
      db.prepare(`PRAGMA user_version = ${i + 1}`).run();
      db.prepare('COMMIT').run();
      applied++;
    } catch (e) {
      try { db.prepare('ROLLBACK').run(); } catch { /* already rolled back */ }
      throw new Error(`Migration ${i} → ${i + 1} failed: ${e}`);
    }
  }

  return { from: current, to: target, applied };
}

/**
 * Get the current migration version from the database.
 */
export function getMigrationVersion(db: Database): number {
  return (db.prepare('PRAGMA user_version').get() as any).user_version as number;
}
