// SQLite writers for the Stop hook (RecallExtract.ts).
// Self-contained — no imports from src/. Mirrors the relevant subset of
// src/lib/memory.ts so the hook can dual-write into the same tables without
// pulling in the full memory module (hooks must run even if src/ is broken).
//
// All functions take dbPath as the first parameter for testability.
// Every write is wrapped at the call site in try/catch — failures must not
// block the legacy file path or cause the extraction to be marked failed.

import { Database } from 'bun:sqlite';
import { existsSync } from 'fs';
import { resolveDbPath } from './db-path';

// Re-export under the historical name so existing consumers (RecallExtract,
// RecallBatchExtract, RecallClearExtract) don't need to change their imports.
export const getDbPath = resolveDbPath;

function openDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  // Concurrent Claude/OpenCode extraction writers must wait for a peer's
  // short transaction instead of turning a transient lock into record loss.
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

function clampImportance(value: number | undefined, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(10, Math.max(1, n));
}

function tableExists(db: Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name);
  return !!row;
}

function columnExists(db: Database, table: string, column: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return rows.some((r) => r.name === column);
  } catch {
    return false;
  }
}

// ADR-0001: every writer in this file is an extraction path, so records are
// stamped provenance = 'extracted'. The value is a SQL literal (not a bind
// param) so the legacy-DB column guard stays a simple string switch — older
// databases without the provenance column keep working unchanged.
function provenanceFragment(db: Database, table: string): { col: string; val: string } {
  return columnExists(db, table, 'provenance')
    ? { col: ', provenance', val: ", 'extracted'" }
    : { col: '', val: '' };
}

// ---------------------------------------------------------------------------
// extraction_sessions
// ---------------------------------------------------------------------------

export interface ExtractionSessionInput {
  sessionId: string;
  project: string | null;
  branch?: string | null;
  timestamp: string; // ISO date
  summary: string | null;
  topics: string[];
  conversationPath: string | null;
}

export function writeExtractionSession(dbPath: string, entry: ExtractionSessionInput): void {
  const db = openDb(dbPath);
  try {
    if (!tableExists(db, 'extraction_sessions')) return;
    db.prepare(
      `INSERT OR REPLACE INTO extraction_sessions
         (session_id, project, branch, timestamp, summary, topics, conversation_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entry.sessionId,
      entry.project,
      entry.branch ?? null,
      entry.timestamp,
      entry.summary,
      JSON.stringify(entry.topics ?? []),
      entry.conversationPath
    );

    // Cap at 500 rows (matches legacy SESSION_INDEX.json behavior)
    db.prepare(
      `DELETE FROM extraction_sessions
       WHERE session_id NOT IN (
         SELECT session_id FROM extraction_sessions ORDER BY timestamp DESC LIMIT 500
       )`
    ).run();
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// decisions
// ---------------------------------------------------------------------------

export interface DecisionInput {
  decision: string;
  confidence?: 'high' | 'medium' | 'low';
  sessionId?: string | null;
  project?: string | null;
  category?: string | null;
  importance?: number;
}

export function writeDecisionsBatch(dbPath: string, items: DecisionInput[]): number {
  if (items.length === 0) return 0;
  const db = openDb(dbPath);
  try {
    if (!tableExists(db, 'decisions')) return 0;
    const hasConfidence = columnExists(db, 'decisions', 'confidence');
    const provenance = provenanceFragment(db, 'decisions');
    const sql = hasConfidence
      ? `INSERT INTO decisions (session_id, category, project, decision, status, confidence, importance${provenance.col})
         VALUES (?, ?, ?, ?, 'active', ?, ?${provenance.val})`
      : `INSERT INTO decisions (session_id, category, project, decision, status, importance${provenance.col})
         VALUES (?, ?, ?, ?, 'active', ?${provenance.val})`;
    const stmt = db.prepare(sql);
    const insertMany = db.transaction((batch: DecisionInput[]) => {
      let n = 0;
      for (const it of batch) {
        const importance = clampImportance(it.importance, 5);
        if (hasConfidence) {
          stmt.run(
            it.sessionId ?? null,
            it.category ?? 'auto-extracted',
            it.project ?? null,
            it.decision,
            it.confidence ?? 'medium',
            importance
          );
        } else {
          stmt.run(
            it.sessionId ?? null,
            it.category ?? 'auto-extracted',
            it.project ?? null,
            it.decision,
            importance
          );
        }
        n++;
      }
      return n;
    });
    return insertMany(items);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// learnings
// ---------------------------------------------------------------------------

export interface LearningInput {
  problem: string;
  solution?: string | null;
  prevention?: string | null;
  tags?: string | null;
  sessionId?: string | null;
  project?: string | null;
  category?: string | null;
  importance?: number;
  confidence?: 'high' | 'medium' | 'low';
}

export function writeLearningsBatch(dbPath: string, items: LearningInput[]): number {
  if (items.length === 0) return 0;
  const db = openDb(dbPath);
  try {
    if (!tableExists(db, 'learnings')) return 0;
    const hasConfidence = columnExists(db, 'learnings', 'confidence');
    const provenance = provenanceFragment(db, 'learnings');
    const sql = hasConfidence
      ? `INSERT INTO learnings (session_id, category, project, problem, solution, prevention, tags, confidence, importance${provenance.col})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?${provenance.val})`
      : `INSERT INTO learnings (session_id, category, project, problem, solution, prevention, tags, importance${provenance.col})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?${provenance.val})`;
    const stmt = db.prepare(sql);
    const insertMany = db.transaction((batch: LearningInput[]) => {
      let n = 0;
      for (const it of batch) {
        const importance = clampImportance(it.importance, 5);
        if (hasConfidence) {
          stmt.run(
            it.sessionId ?? null,
            it.category ?? 'auto-extracted',
            it.project ?? null,
            it.problem,
            it.solution ?? null,
            it.prevention ?? null,
            it.tags ?? null,
            it.confidence ?? 'medium',
            importance
          );
        } else {
          stmt.run(
            it.sessionId ?? null,
            it.category ?? 'auto-extracted',
            it.project ?? null,
            it.problem,
            it.solution ?? null,
            it.prevention ?? null,
            it.tags ?? null,
            importance
          );
        }
        n++;
      }
      return n;
    });
    return insertMany(items);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// breadcrumbs
// ---------------------------------------------------------------------------

export interface BreadcrumbInput {
  content: string;
  category?: string | null;
  sessionId?: string | null;
  project?: string | null;
  importance?: number;
  expiresAt?: string | null;
}

export function writeBreadcrumbsBatch(dbPath: string, items: BreadcrumbInput[]): number {
  if (items.length === 0) return 0;
  const db = openDb(dbPath);
  try {
    if (!tableExists(db, 'breadcrumbs')) return 0;
    const provenance = provenanceFragment(db, 'breadcrumbs');
    const stmt = db.prepare(
      `INSERT INTO breadcrumbs (session_id, content, category, project, importance, expires_at${provenance.col})
       VALUES (?, ?, ?, ?, ?, ?${provenance.val})`
    );
    const insertMany = db.transaction((batch: BreadcrumbInput[]) => {
      let n = 0;
      for (const it of batch) {
        stmt.run(
          it.sessionId ?? null,
          it.content,
          it.category ?? 'extracted-idea',
          it.project ?? null,
          clampImportance(it.importance, 5),
          it.expiresAt ?? null
        );
        n++;
      }
      return n;
    });
    return insertMany(items);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// loa_entries
// ---------------------------------------------------------------------------

export interface LoaInput {
  title: string;
  fabricExtract: string;
  description?: string | null;
  sessionId?: string | null;
  project?: string | null;
  tags?: string | null;
  messageCount?: number | null;
  importance?: number;
}

export function writeLoaEntryFromExtraction(dbPath: string, entry: LoaInput): number {
  const db = openDb(dbPath);
  try {
    if (!tableExists(db, 'loa_entries')) return 0;
    // LoA importance is floored at 5 (curated tier guardrail).
    const importance = Math.max(5, clampImportance(entry.importance, 8));
    const provenance = provenanceFragment(db, 'loa_entries');
    const result = db
      .prepare(
        `INSERT INTO loa_entries
           (title, description, fabric_extract, session_id, project, tags, message_count, importance${provenance.col})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?${provenance.val})`
      )
      .run(
        entry.title,
        entry.description ?? null,
        entry.fabricExtract,
        entry.sessionId ?? null,
        entry.project ?? null,
        entry.tags ?? null,
        entry.messageCount ?? null,
        importance
      );
    return Number(result.lastInsertRowid);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// extraction_errors
// ---------------------------------------------------------------------------

export interface ExtractionErrorInput {
  errorKey: string;
  error: string;
  fix?: string | null;
  context?: string | null;
  firstSeen?: string;
  lastSeen?: string;
}

export function writeExtractionErrors(dbPath: string, items: ExtractionErrorInput[]): number {
  if (items.length === 0) return 0;
  const db = openDb(dbPath);
  try {
    if (!tableExists(db, 'extraction_errors')) return 0;
    const now = new Date().toISOString();
    const stmt = db.prepare(
      `INSERT INTO extraction_errors (error_key, error, fix, context, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(error_key) DO UPDATE SET
         fix = COALESCE(excluded.fix, fix),
         context = COALESCE(excluded.context, context),
         last_seen = excluded.last_seen`
    );
    const insertMany = db.transaction((batch: ExtractionErrorInput[]) => {
      let n = 0;
      for (const it of batch) {
        stmt.run(
          it.errorKey,
          it.error,
          it.fix ?? null,
          it.context ?? null,
          it.firstSeen ?? now,
          it.lastSeen ?? now
        );
        n++;
      }
      return n;
    });
    return insertMany(items);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// ensureDbWritable — best-effort probe; returns false if db missing/locked
// ---------------------------------------------------------------------------

export function ensureDbWritable(dbPath: string): boolean {
  try {
    if (!existsSync(dbPath)) return false;
    const db = openDb(dbPath);
    try {
      db.prepare('SELECT 1').get();
      return true;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}
