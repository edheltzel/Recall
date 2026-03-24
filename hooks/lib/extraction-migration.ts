// JSON-to-SQLite migration for extraction state files.
// Self-contained — no imports from src/.

import { Database } from 'bun:sqlite';
import { readFileSync } from 'fs';

function openDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  return db;
}

// ---------------------------------------------------------------------------
// Tracker JSON types
// ---------------------------------------------------------------------------

interface TrackerEntry {
  size?: number;
  extractedAt?: string;
  failedAt?: string;
  retryAfter?: string;
  error?: string;
  skipped?: number;
}

type TrackerJson = Record<string, TrackerEntry>;

// ---------------------------------------------------------------------------
// Session Index JSON types
// ---------------------------------------------------------------------------

interface SessionIndexEntry {
  sessionId: string;
  project?: string;
  branch?: string;
  timestamp: string;
  summary?: string;
  topics?: string[];
  conversationPath?: string;
}

// ---------------------------------------------------------------------------
// Error Patterns JSON types
// ---------------------------------------------------------------------------

interface ErrorPatternEntry {
  error: string;
  fix?: string;
  context?: string;
  cause?: string;
  file?: string;
  date?: string;
  firstSeen?: string;
  lastSeen?: string;
}

interface ErrorPatternsJson {
  patterns: ErrorPatternEntry[];
}

// ---------------------------------------------------------------------------
// migrateTrackerJson
// ---------------------------------------------------------------------------

export function migrateTrackerJson(
  jsonPath: string,
  dbPath: string
): { imported: number } {
  const raw = readFileSync(jsonPath, 'utf-8');
  const data: TrackerJson = JSON.parse(raw); // throws on invalid JSON

  const db = openDb(dbPath);
  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO extraction_tracker
        (conversation_path, size, extracted_at, failed_at, retry_after, error, skipped)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    let imported = 0;
    for (const [conversationPath, entry] of Object.entries(data)) {
      stmt.run(
        conversationPath,
        entry.size ?? 0,
        entry.extractedAt ?? null,
        entry.failedAt ?? null,
        entry.retryAfter ?? null,
        entry.error ?? null,
        entry.skipped ?? 0
      );
      imported++;
    }

    return { imported };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// migrateSessionIndex
// ---------------------------------------------------------------------------

export function migrateSessionIndex(
  jsonPath: string,
  dbPath: string
): { imported: number } {
  const raw = readFileSync(jsonPath, 'utf-8');
  const data: SessionIndexEntry[] = JSON.parse(raw);

  const db = openDb(dbPath);
  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO extraction_sessions
        (session_id, project, branch, timestamp, summary, topics, conversation_path)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    let imported = 0;
    for (const entry of data) {
      if (!entry.timestamp) continue; // timestamp is required

      stmt.run(
        entry.sessionId,
        entry.project ?? null,
        entry.branch ?? null,
        entry.timestamp,
        entry.summary ?? null,
        JSON.stringify(entry.topics ?? []),
        entry.conversationPath ?? null
      );
      imported++;
    }

    // Cap at 500 rows (matches legacy SESSION_INDEX.json behavior)
    db.prepare(`
      DELETE FROM extraction_sessions
      WHERE session_id NOT IN (
        SELECT session_id FROM extraction_sessions ORDER BY timestamp DESC LIMIT 500
      )
    `).run();

    return { imported };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// migrateErrorPatterns
// ---------------------------------------------------------------------------

export function migrateErrorPatterns(
  jsonPath: string,
  dbPath: string
): { imported: number } {
  const raw = readFileSync(jsonPath, 'utf-8');
  const data: ErrorPatternsJson = JSON.parse(raw);
  const patterns = data.patterns ?? [];

  const db = openDb(dbPath);
  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO extraction_errors
        (error_key, error, fix, context, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    let imported = 0;
    for (const pattern of patterns) {
      // Real data uses 'date' and 'cause'; fixtures use 'firstSeen'/'lastSeen'/'context'
      const firstSeen = pattern.firstSeen ?? pattern.date ?? new Date().toISOString();
      const lastSeen = pattern.lastSeen ?? pattern.date ?? new Date().toISOString();
      const context = pattern.context ?? pattern.cause ?? null;
      stmt.run(
        pattern.error,
        pattern.error,
        pattern.fix ?? null,
        context,
        firstSeen,
        lastSeen
      );
      imported++;
    }

    return { imported };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// migrateAll
// ---------------------------------------------------------------------------

export interface MigrateAllOptions {
  trackerPath?: string;
  sessionIndexPath?: string;
  errorPatternsPath?: string;
}

export function migrateAll(
  dbPath: string,
  options: MigrateAllOptions
): { tracker: number; sessions: number; errors: number } {
  // Each sub-function opens its own connection and uses INSERT OR REPLACE,
  // making the migration idempotent. Re-running after partial failure is safe.
  let tracker = 0;
  let sessions = 0;
  let errors = 0;

  if (options.trackerPath) {
    tracker = migrateTrackerJson(options.trackerPath, dbPath).imported;
  }

  if (options.sessionIndexPath) {
    sessions = migrateSessionIndex(options.sessionIndexPath, dbPath).imported;
  }

  if (options.errorPatternsPath) {
    errors = migrateErrorPatterns(options.errorPatternsPath, dbPath).imported;
  }

  return { tracker, sessions, errors };
}
