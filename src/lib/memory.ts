// Core memory operations for RECALL

import { getDb, getDbPath } from '../db/connection.js';
import { existsSync, statSync } from 'fs';
import { notMarkedDuplicateSql } from './dedup.js';
import type { Session, Message, Decision, Learning, Breadcrumb, LoaEntry, Stats, SearchResult, Provenance } from '../types/index.js';

// ============ Sessions ============

export function createSession(session: Omit<Session, 'id'>): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO sessions (session_id, started_at, ended_at, summary, project, cwd, git_branch, model, source)
    VALUES ($session_id, $started_at, $ended_at, $summary, $project, $cwd, $git_branch, $model, $source)
  `);
  const result = stmt.run({
    $session_id: session.session_id,
    $started_at: session.started_at,
    $ended_at: session.ended_at || null,
    $summary: session.summary || null,
    $project: session.project || null,
    $cwd: session.cwd || null,
    $git_branch: session.git_branch || null,
    $model: session.model || null,
    $source: session.source || 'claude-code'
  });
  return result.lastInsertRowid as number;
}

export function getSession(sessionId: string): Session | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as Session | undefined;
}

export function sessionExists(sessionId: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT 1 FROM sessions WHERE session_id = ?').get(sessionId);
  return !!row;
}

export function endSession(sessionId: string, summary?: string): void {
  const db = getDb();
  db.prepare('UPDATE sessions SET ended_at = CURRENT_TIMESTAMP, summary = COALESCE(?, summary) WHERE session_id = ?')
    .run(summary || null, sessionId);
}

// ============ Messages ============

export function addMessage(message: Omit<Message, 'id'>): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO messages (session_id, timestamp, role, content, project, importance, provenance)
    VALUES ($session_id, $timestamp, $role, $content, $project, $importance, $provenance)
  `);
  const result = stmt.run({
    $session_id: message.session_id,
    $timestamp: message.timestamp,
    $role: message.role,
    $content: message.content,
    $project: message.project || null,
    $importance: clampImportance(message.importance, 5),
    $provenance: message.provenance ?? null
  });
  return result.lastInsertRowid as number;
}

export function addMessagesBatch(messages: Omit<Message, 'id'>[]): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO messages (session_id, timestamp, role, content, project, importance, provenance)
    VALUES ($session_id, $timestamp, $role, $content, $project, $importance, $provenance)
  `);

  const insertMany = db.transaction((msgs: Omit<Message, 'id'>[]) => {
    let count = 0;
    for (const msg of msgs) {
      stmt.run({
        $session_id: msg.session_id,
        $timestamp: msg.timestamp,
        $role: msg.role,
        $content: msg.content,
        $project: msg.project || null,
        $importance: clampImportance(msg.importance, 5),
        $provenance: msg.provenance ?? null
      });
      count++;
    }
    return count;
  });

  return insertMany(messages);
}

// ============ Importance ============
//
// Importance is an integer 1-10 used by tiered session loading (L1 assembly)
// and as a ranking bias. Clamped here in application code because SQLite
// ALTER TABLE cannot add a CHECK constraint to existing rows (migration 7→8).
// Defaults: breadcrumbs/decisions/learnings/messages = 5, loa_entries = 8.
// LoA writes enforce a floor of 5 — the curated tier must never be demoted
// below "neutral" importance.
export function clampImportance(value: number | undefined, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(10, Math.max(1, n));
}

export function pinRecord(table: 'decisions' | 'learnings' | 'breadcrumbs' | 'loa_entries' | 'messages', id: number, importance = 10): boolean {
  const db = getDb();
  const clamped = clampImportance(importance, 10);
  const result = db.prepare(`UPDATE ${table} SET importance = ? WHERE id = ?`).run(clamped, id);
  return (result.changes as number) > 0;
}

// ============ Decisions ============

export function addDecision(decision: Omit<Decision, 'id' | 'created_at'>): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO decisions (session_id, category, project, decision, reasoning, alternatives, status, confidence, importance, provenance)
    VALUES ($session_id, $category, $project, $decision, $reasoning, $alternatives, $status, $confidence, $importance, $provenance)
  `);
  const result = stmt.run({
    $session_id: decision.session_id || null,
    $category: decision.category || null,
    $project: decision.project || null,
    $decision: decision.decision,
    $reasoning: decision.reasoning || null,
    $alternatives: decision.alternatives || null,
    $status: decision.status || 'active',
    $confidence: decision.confidence || 'medium',
    $importance: clampImportance(decision.importance, 5),
    $provenance: decision.provenance ?? null
  });
  return result.lastInsertRowid as number;
}

export function getDecision(id: number): Decision | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as Decision | undefined;
}

export function supersedeDecision(id: number): number {
  const db = getDb();
  // Check current status first — changes count includes FTS trigger operations
  const before = db.prepare('SELECT status FROM decisions WHERE id = ?').get(id) as { status: string } | undefined;
  if (!before || before.status !== 'active') return 0;
  db.prepare(
    `UPDATE decisions SET status = 'superseded' WHERE id = $id AND status = 'active'`
  ).run({ $id: id });
  return 1;
}

export function revertDecision(id: number): number {
  const db = getDb();
  // Check current status first — changes count includes FTS trigger operations
  const before = db.prepare('SELECT status FROM decisions WHERE id = ?').get(id) as { status: string } | undefined;
  if (!before || before.status !== 'active') return 0;
  db.prepare(
    `UPDATE decisions SET status = 'reverted' WHERE id = $id AND status = 'active'`
  ).run({ $id: id });
  return 1;
}

export function listDecisions(limit: number = 20, project?: string, status?: string): Decision[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (project) {
    conditions.push('project = ?');
    params.push(project);
  }
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit);

  return db.prepare(
    `SELECT * FROM decisions ${where} ORDER BY created_at DESC LIMIT ?`
  ).all(...params) as Decision[];
}

/**
 * Find active decisions similar to the given text using FTS5.
 * Used for auto-supersede when adding a new decision on the same topic.
 */
export function findSimilarDecisions(text: string, limit = 3): Decision[] {
  const db = getDb();
  // Extract key terms for FTS5 query (first 10 significant words)
  const terms = text.split(/\s+/).filter(w => w.length > 3).slice(0, 10).join(' OR ');
  if (!terms) return [];
  try {
    return db.prepare(`
      SELECT d.*
      FROM decisions_fts fts
      JOIN decisions d ON d.id = fts.rowid
      WHERE decisions_fts MATCH ? AND d.status = 'active'
      ORDER BY fts.rank
      LIMIT ?
    `).all(terms, limit) as Decision[];
  } catch {
    return []; // FTS query syntax error — no matches
  }
}

// ============ Learnings ============

export function addLearning(learning: Omit<Learning, 'id' | 'created_at'>): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO learnings (session_id, category, project, problem, solution, prevention, tags, confidence, importance, provenance)
    VALUES ($session_id, $category, $project, $problem, $solution, $prevention, $tags, $confidence, $importance, $provenance)
  `);
  const result = stmt.run({
    $session_id: learning.session_id || null,
    $category: learning.category || null,
    $project: learning.project || null,
    $problem: learning.problem,
    $solution: learning.solution || null,
    $prevention: learning.prevention || null,
    $tags: learning.tags || null,
    $confidence: learning.confidence || 'medium',
    $importance: clampImportance(learning.importance, 5),
    $provenance: learning.provenance ?? null
  });
  return result.lastInsertRowid as number;
}

export function getLearning(id: number): Learning | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM learnings WHERE id = ?').get(id) as Learning | undefined;
}

// ============ Breadcrumbs ============

export function addBreadcrumb(breadcrumb: Omit<Breadcrumb, 'id' | 'created_at'>): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO breadcrumbs (session_id, content, category, project, importance, expires_at, provenance)
    VALUES ($session_id, $content, $category, $project, $importance, $expires_at, $provenance)
  `);
  const result = stmt.run({
    $session_id: breadcrumb.session_id || null,
    $content: breadcrumb.content,
    $category: breadcrumb.category || null,
    $project: breadcrumb.project || null,
    $importance: breadcrumb.importance ?? 5,
    $expires_at: breadcrumb.expires_at || null,
    $provenance: breadcrumb.provenance ?? null
  });
  return result.lastInsertRowid as number;
}

export function getBreadcrumb(id: number): Breadcrumb | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM breadcrumbs WHERE id = ?').get(id) as Breadcrumb | undefined;
}

// ============ Search ============

// Track search errors for debugging (FIX #7)
let lastSearchErrors: string[] = [];

export const SEARCH_TABLES = ['messages', 'loa', 'decisions', 'learnings', 'breadcrumbs'] as const;
export type SearchTable = typeof SEARCH_TABLES[number];

export interface MemorySearchOptions {
  project?: string;
  table?: string;
  limit?: number;
  biasType?: SearchTable;
  /** Include records marked as duplicates by `recall dedup` (hidden by default). */
  includeDuplicates?: boolean;
}

// Marked duplicates (issue #45) are hidden from search by default — the
// lineage row in dedup_lineage keeps them recoverable and auditable.
function duplicateFilter(options: MemorySearchOptions | undefined, physicalTable: string, idExpr: string): string {
  if (options?.includeDuplicates) return '';
  return `AND ${notMarkedDuplicateSql(`'${physicalTable}'`, idExpr)}`;
}

const TYPE_BIAS_RANK_MULTIPLIER = 4;

function rankWithTypeBias(rank: number | undefined, shouldBias: boolean): number {
  const baseRank = rank || 0;
  if (!shouldBias) return baseRank;

  // SQLite FTS5 ranks sort ascending. In practice bm25 ranks are negative,
  // so multiplying makes a biased match more competitive without filtering
  // out stronger results from other tables. Positive/zero ranks get the
  // equivalent lower-is-better treatment.
  if (baseRank < 0) return baseRank * TYPE_BIAS_RANK_MULTIPLIER;
  if (baseRank > 0) return baseRank / TYPE_BIAS_RANK_MULTIPLIER;
  return -Number.EPSILON;
}

export function getLastSearchErrors(): string[] {
  return lastSearchErrors;
}

export function search(query: string, options?: MemorySearchOptions): SearchResult[] {
  const db = getDb();
  const limit = options?.limit || 20;
  const results: SearchResult[] = [];
  lastSearchErrors = []; // Reset errors for this search

  const tables = options?.table
    ? [options.table]
    : SEARCH_TABLES;

  for (const table of tables) {
    let sql: string;
    const params: (string | number)[] = [query];

    switch (table) {
      case 'messages':
        sql = `
          SELECT m.id, m.content, m.project, m.timestamp as created_at, m.provenance, f.rank
          FROM messages_fts f
          JOIN messages m ON m.id = f.rowid
          WHERE messages_fts MATCH ?
          ${duplicateFilter(options, 'messages', 'm.id')}
          ${options?.project ? 'AND m.project = ?' : ''}
          ORDER BY f.rank
          LIMIT ?
        `;
        break;
      case 'decisions':
        sql = `
          SELECT d.id, d.decision as content, d.project, d.created_at, d.provenance, f.rank
          FROM decisions_fts f
          JOIN decisions d ON d.id = f.rowid
          WHERE decisions_fts MATCH ?
          AND d.status = 'active'
          ${duplicateFilter(options, 'decisions', 'd.id')}
          ${options?.project ? 'AND d.project = ?' : ''}
          ORDER BY CASE d.confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 1 END, f.rank
          LIMIT ?
        `;
        break;
      case 'learnings':
        sql = `
          SELECT l.id, l.problem as content, l.project, l.created_at, l.provenance, f.rank
          FROM learnings_fts f
          JOIN learnings l ON l.id = f.rowid
          WHERE learnings_fts MATCH ?
          ${duplicateFilter(options, 'learnings', 'l.id')}
          ${options?.project ? 'AND l.project = ?' : ''}
          ORDER BY f.rank
          LIMIT ?
        `;
        break;
      case 'breadcrumbs':
        sql = `
          SELECT b.id, b.content, b.project, b.created_at, b.provenance, f.rank
          FROM breadcrumbs_fts f
          JOIN breadcrumbs b ON b.id = f.rowid
          WHERE breadcrumbs_fts MATCH ?
          ${duplicateFilter(options, 'breadcrumbs', 'b.id')}
          ${options?.project ? 'AND b.project = ?' : ''}
          ORDER BY f.rank
          LIMIT ?
        `;
        break;
      case 'loa':
        sql = `
          SELECT l.id, l.title || ': ' || SUBSTR(l.fabric_extract, 1, 200) as content, l.project, l.created_at, l.provenance, f.rank
          FROM loa_fts f
          JOIN loa_entries l ON l.id = f.rowid
          WHERE loa_fts MATCH ?
          ${duplicateFilter(options, 'loa_entries', 'l.id')}
          ${options?.project ? 'AND l.project = ?' : ''}
          ORDER BY f.rank
          LIMIT ?
        `;
        break;
      default:
        continue;
    }

    if (options?.project) {
      params.push(options.project);
    }
    params.push(limit);

    try {
      const rows = db.prepare(sql).all(...params) as Array<{
        id: number;
        content: string;
        project: string | null;
        created_at: string;
        provenance: Provenance | null;
        rank: number;
      }>;

      for (const row of rows) {
        results.push({
          table,
          id: row.id,
          content: row.content,
          project: row.project || undefined,
          created_at: row.created_at,
          provenance: row.provenance ?? null,
          rank: row.rank
        });
      }
    } catch (err) {
      // FIX #7: Record errors instead of silently swallowing
      const errorMsg = err instanceof Error ? err.message : String(err);
      lastSearchErrors.push(`[${table}] ${errorMsg}`);
      // Continue searching other tables even if one fails
    }
  }

  // Sort all results by rank, with an optional soft table-type bias.
  const biasType = options?.biasType;
  results.sort((a, b) => {
    const aSortRank = rankWithTypeBias(a.rank, biasType === a.table);
    const bSortRank = rankWithTypeBias(b.rank, biasType === b.table);

    if (aSortRank !== bSortRank) return aSortRank - bSortRank;
    return (a.rank || 0) - (b.rank || 0);
  });

  return results.slice(0, limit);
}

/**
 * Resolve display content + provenance for a record surfaced only by the
 * vector (embeddings) branch of hybrid search, keyed by its embeddings
 * source_table. Mirrors the four embedded tables (see EMBED_SOURCES in
 * repair.ts); an unknown table yields empty content and null provenance.
 * Centralizing this keeps the hybrid vec-branch from silently omitting a
 * table — issue #67, where a vector-only learnings match misreported its
 * provenance as unknown because the learnings case was missing.
 */
export function vectorRowContentProvenance(
  sourceTable: string,
  sourceId: number
): { content: string; provenance: Provenance | null } {
  const db = getDb();
  if (sourceTable === 'loa_entries') {
    const loa = db.prepare('SELECT title, fabric_extract, provenance FROM loa_entries WHERE id = ?').get(sourceId) as any;
    return {
      content: loa ? `${loa.title}: ${loa.fabric_extract?.slice(0, 200)}` : '',
      provenance: loa?.provenance ?? null
    };
  }
  if (sourceTable === 'decisions') {
    const dec = db.prepare('SELECT decision, provenance FROM decisions WHERE id = ?').get(sourceId) as any;
    return { content: dec?.decision || '', provenance: dec?.provenance ?? null };
  }
  if (sourceTable === 'messages') {
    const msg = db.prepare('SELECT content, provenance FROM messages WHERE id = ?').get(sourceId) as any;
    return { content: msg?.content?.slice(0, 200) || '', provenance: msg?.provenance ?? null };
  }
  if (sourceTable === 'learnings') {
    const learn = db.prepare('SELECT problem, provenance FROM learnings WHERE id = ?').get(sourceId) as any;
    return { content: learn?.problem?.slice(0, 200) || '', provenance: learn?.provenance ?? null };
  }
  return { content: '', provenance: null };
}

// ============ Recent ============

export function recentMessages(limit: number = 10, project?: string): Message[] {
  const db = getDb();
  const sql = project
    ? 'SELECT * FROM messages WHERE project = ? ORDER BY timestamp DESC LIMIT ?'
    : 'SELECT * FROM messages ORDER BY timestamp DESC LIMIT ?';
  const params = project ? [project, limit] : [limit];
  return db.prepare(sql).all(...params) as Message[];
}

export function recentDecisions(limit: number = 10, project?: string): Decision[] {
  const db = getDb();
  const sql = project
    ? "SELECT * FROM decisions WHERE project = ? AND status = 'active' ORDER BY CASE confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 1 END, created_at DESC LIMIT ?"
    : "SELECT * FROM decisions WHERE status = 'active' ORDER BY CASE confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 1 END, created_at DESC LIMIT ?";
  const params = project ? [project, limit] : [limit];
  return db.prepare(sql).all(...params) as Decision[];
}

export function recentLearnings(limit: number = 10, project?: string): Learning[] {
  const db = getDb();
  const sql = project
    ? 'SELECT * FROM learnings WHERE project = ? ORDER BY created_at DESC LIMIT ?'
    : 'SELECT * FROM learnings ORDER BY created_at DESC LIMIT ?';
  const params = project ? [project, limit] : [limit];
  return db.prepare(sql).all(...params) as Learning[];
}

export function recentBreadcrumbs(limit: number = 10, project?: string): Breadcrumb[] {
  const db = getDb();
  const sql = project
    ? 'SELECT * FROM breadcrumbs WHERE project = ? ORDER BY created_at DESC LIMIT ?'
    : 'SELECT * FROM breadcrumbs ORDER BY created_at DESC LIMIT ?';
  const params = project ? [project, limit] : [limit];
  return db.prepare(sql).all(...params) as Breadcrumb[];
}

// ============ Library of Alexandria ============

export function createLoaEntry(entry: Omit<LoaEntry, 'id' | 'created_at'>): number {
  const db = getDb();
  // LoA is the curated tier: importance defaults to 8 and is floored at 5
  // so a careless caller cannot demote curated knowledge below neutral.
  const importance = Math.max(5, clampImportance(entry.importance, 8));
  const stmt = db.prepare(`
    INSERT INTO loa_entries (title, description, fabric_extract, message_range_start, message_range_end, parent_loa_id, session_id, project, tags, message_count, importance, provenance)
    VALUES ($title, $description, $fabric_extract, $message_range_start, $message_range_end, $parent_loa_id, $session_id, $project, $tags, $message_count, $importance, $provenance)
  `);
  const result = stmt.run({
    $title: entry.title,
    $description: entry.description || null,
    $fabric_extract: entry.fabric_extract,
    $message_range_start: entry.message_range_start || null,
    $message_range_end: entry.message_range_end || null,
    $parent_loa_id: entry.parent_loa_id || null,
    $session_id: entry.session_id || null,
    $project: entry.project || null,
    $tags: entry.tags || null,
    $message_count: entry.message_count || null,
    $importance: importance,
    $provenance: entry.provenance ?? null
  });
  return result.lastInsertRowid as number;
}

export function getLoaEntry(id: number): LoaEntry | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM loa_entries WHERE id = ?').get(id) as LoaEntry | undefined;
}

export function getLastLoaEntry(): LoaEntry | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM loa_entries ORDER BY created_at DESC LIMIT 1').get() as LoaEntry | undefined;
}

export function getLoaMessages(loaId: number): Message[] {
  const db = getDb();
  const loa = getLoaEntry(loaId);
  if (!loa || !loa.message_range_start || !loa.message_range_end) {
    return [];
  }
  return db.prepare('SELECT * FROM messages WHERE id >= ? AND id <= ? ORDER BY timestamp')
    .all(loa.message_range_start, loa.message_range_end) as Message[];
}

export function getMessagesSinceLastLoa(limit?: number): { messages: Message[]; startId: number | null; endId: number | null } {
  const db = getDb();
  const lastLoa = getLastLoaEntry();

  let sql: string;
  let params: number[];

  if (lastLoa?.message_range_end) {
    sql = limit
      ? 'SELECT * FROM messages WHERE id > ? ORDER BY timestamp LIMIT ?'
      : 'SELECT * FROM messages WHERE id > ? ORDER BY timestamp';
    params = limit ? [lastLoa.message_range_end, limit] : [lastLoa.message_range_end];
  } else {
    sql = limit
      ? 'SELECT * FROM messages ORDER BY timestamp LIMIT ?'
      : 'SELECT * FROM messages ORDER BY timestamp';
    params = limit ? [limit] : [];
  }

  const messages = db.prepare(sql).all(...params) as Message[];

  return {
    messages,
    startId: messages.length > 0 ? messages[0].id! : null,
    endId: messages.length > 0 ? messages[messages.length - 1].id! : null
  };
}

export function recentLoaEntries(limit: number = 10, project?: string): LoaEntry[] {
  const db = getDb();
  const sql = project
    ? 'SELECT * FROM loa_entries WHERE project = ? ORDER BY created_at DESC LIMIT ?'
    : 'SELECT * FROM loa_entries ORDER BY created_at DESC LIMIT ?';
  const params = project ? [project, limit] : [limit];
  return db.prepare(sql).all(...params) as LoaEntry[];
}

// ============ Stats ============

export function getStats(): Stats {
  const db = getDb();
  const count = (sql: string) => (db.prepare(sql).get() as { count: number }).count;

  const sessions = count('SELECT COUNT(*) as count FROM sessions');
  const messages = count('SELECT COUNT(*) as count FROM messages');
  const decisions = count('SELECT COUNT(*) as count FROM decisions');
  const decisions_active = count("SELECT COUNT(*) as count FROM decisions WHERE status = 'active'");
  const decisions_superseded = count("SELECT COUNT(*) as count FROM decisions WHERE status = 'superseded'");
  const decisions_reverted = count("SELECT COUNT(*) as count FROM decisions WHERE status = 'reverted'");
  const learnings = count('SELECT COUNT(*) as count FROM learnings');
  const breadcrumbs = count('SELECT COUNT(*) as count FROM breadcrumbs');
  const breadcrumbs_expired = count("SELECT COUNT(*) as count FROM breadcrumbs WHERE expires_at IS NOT NULL AND expires_at < datetime('now')");
  const loa_entries = count('SELECT COUNT(*) as count FROM loa_entries');
  const telos = count('SELECT COUNT(*) as count FROM telos');
  const documents = count('SELECT COUNT(*) as count FROM documents');
  const extraction_tracker = count('SELECT COUNT(*) as count FROM extraction_tracker');
  const extraction_sessions = count('SELECT COUNT(*) as count FROM extraction_sessions');
  const extraction_errors = count('SELECT COUNT(*) as count FROM extraction_errors');
  const embeddings = count('SELECT COUNT(*) as count FROM embeddings');

  const dbPath = getDbPath();
  const db_size_bytes = existsSync(dbPath) ? statSync(dbPath).size : 0;

  return {
    sessions, messages,
    decisions, decisions_active, decisions_superseded, decisions_reverted,
    learnings,
    breadcrumbs, breadcrumbs_expired,
    loa_entries, telos, documents,
    extraction_tracker, extraction_sessions, extraction_errors, embeddings,
    db_size_bytes
  };
}
