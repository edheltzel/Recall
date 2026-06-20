// Session-progress CRUD — self-contained, no imports from src/
// (hooks must never import from src/ — root AGENTS.md Key Conventions).
// All functions take dbPath as their first parameter for testability,
// mirroring hooks/lib/extraction-tracker.ts.
//
// Backs the mid-session learning loop (issue #51): hooks fire as stateless
// processes, so the per-session turn/tool counters and the incremental
// transcript cursor must persist in SQLite. The table is defined in
// src/db/schema.ts (fresh installs) and migration 10 → 11 (upgrades).

import { Database } from 'bun:sqlite';

function openDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  return db;
}

export interface SessionProgressRecord {
  session_id: string;
  conversation_path: string | null;
  turns_seen: number;
  tools_seen: number;
  last_offset: number;
  runs_this_session: number;
  updated_at: string | null;
}

/** Read a session's progress row, or null if it does not exist yet. */
export function getSessionProgress(
  dbPath: string,
  sessionId: string
): SessionProgressRecord | null {
  const db = openDb(dbPath);
  try {
    const row = db
      .prepare('SELECT * FROM session_progress WHERE session_id = ?')
      .get(sessionId) as SessionProgressRecord | undefined;
    return row ?? null;
  } finally {
    db.close();
  }
}

/**
 * Ensure a row exists for the session (counters default to 0). Non-destructive:
 * INSERT OR IGNORE leaves an existing row — and its accumulated counters —
 * untouched. Call this before the increment helpers, which assume the row
 * exists. The transcript path is stable across a session, so it is recorded
 * once here.
 */
export function ensureSession(
  dbPath: string,
  sessionId: string,
  conversationPath: string | null
): void {
  const db = openDb(dbPath);
  try {
    db.prepare(
      "INSERT OR IGNORE INTO session_progress (session_id, conversation_path, updated_at) VALUES (?, ?, datetime('now'))"
    ).run(sessionId, conversationPath);
  } finally {
    db.close();
  }
}

/** Atomically increment the per-window user-turn counter (UserPromptSubmit). */
export function incrementTurns(dbPath: string, sessionId: string): void {
  const db = openDb(dbPath);
  try {
    db.prepare(
      "UPDATE session_progress SET turns_seen = turns_seen + 1, updated_at = datetime('now') WHERE session_id = ?"
    ).run(sessionId);
  } finally {
    db.close();
  }
}

/** Atomically increment the per-window tool-call counter (PostToolUse). */
export function incrementTools(dbPath: string, sessionId: string): void {
  const db = openDb(dbPath);
  try {
    db.prepare(
      "UPDATE session_progress SET tools_seen = tools_seen + 1, updated_at = datetime('now') WHERE session_id = ?"
    ).run(sessionId);
  } finally {
    db.close();
  }
}

/** Increment the session-lifetime run counter (budget guard, design §3.4). */
export function incrementRuns(dbPath: string, sessionId: string): void {
  const db = openDb(dbPath);
  try {
    db.prepare(
      "UPDATE session_progress SET runs_this_session = runs_this_session + 1, updated_at = datetime('now') WHERE session_id = ?"
    ).run(sessionId);
  } finally {
    db.close();
  }
}

/**
 * Advance the incremental-extraction cursor to a new transcript offset after a
 * successful run. The prior value is read via getSessionProgress so the caller
 * can slice from it; this only advances (design §3.2).
 */
export function advanceOffset(
  dbPath: string,
  sessionId: string,
  newOffset: number
): void {
  const db = openDb(dbPath);
  try {
    db.prepare(
      "UPDATE session_progress SET last_offset = ?, updated_at = datetime('now') WHERE session_id = ?"
    ).run(newOffset, sessionId);
  } finally {
    db.close();
  }
}

/**
 * Reset the per-window counters (turns + tools) after a cadence run fires.
 * Leaves the session-lifetime budget (runs_this_session) and the cursor
 * (last_offset) intact (design §3.1).
 */
export function resetWindow(dbPath: string, sessionId: string): void {
  const db = openDb(dbPath);
  try {
    db.prepare(
      "UPDATE session_progress SET turns_seen = 0, tools_seen = 0, updated_at = datetime('now') WHERE session_id = ?"
    ).run(sessionId);
  } finally {
    db.close();
  }
}
