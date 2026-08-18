// Core memory operations for RECALL

import { getDb, getDbPath } from '../db/connection.js';
import { existsSync, statSync } from 'fs';
import { notMarkedDuplicateSql } from './dedup.js';
import { chunked, SQLITE_SAFE_CHUNK_SIZE } from './chunk.js';
import { scrub } from './write-safety.js';
import { deleteRecordEmbeddingsByIdsInTransaction } from './embedding-store.js';
import { publishedRecordTable } from './published-records.js';
import {
  LIFECYCLE_SEARCH_RETRYABLE,
  countActiveLifecycleGenerations,
  getLifecycleSearchCapabilities,
  repairLifecycleSearchIndex,
  type LifecycleSearchReadiness,
} from './lifecycle-search.js';
import type { Session, Message, Decision, Learning, Breadcrumb, LoaEntry, Stats, SearchResult, Provenance, ProvenanceTable } from '../types/index.js';

export { LIFECYCLE_SEARCH_RETRYABLE } from './lifecycle-search.js';

// Choke point for redacting known-prefix secrets (and stripping invisible
// unicode) on the EXPLICIT add paths — `recall add` (CLI) and `memory_add`
// (MCP) both route through addDecision/addLearning/addBreadcrumb below, so
// scrubbing here covers both surfaces (and any future caller) in one place.
// Only free-text fields are scrubbed; structured/enum fields (category, status,
// confidence, tags, importance, provenance) are never secret carriers and are
// left untouched. Distinct redacted kinds are returned so the caller can
// surface them to the user. Mirrors the session-extract precedent in
// hooks/lib/extract-core.ts.
function scrubFreeText<T extends object>(
  record: T,
  fields: readonly (keyof T)[],
): { record: T; redactions: string[] } {
  const kinds = new Set<string>();
  const out: T = { ...record };
  const bag = out as Record<string, unknown>;
  for (const field of fields) {
    const value = bag[field as string];
    if (typeof value !== 'string' || value.length === 0) continue;
    const scrubbed = scrub(value);
    bag[field as string] = scrubbed.text;
    for (const kind of scrubbed.redactions) kinds.add(kind);
  }
  return { record: out, redactions: [...kinds] };
}

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
    $source: session.source || 'unknown'
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

export function addDecision(
  decision: Omit<Decision, 'id' | 'created_at'>,
  redactionsOut?: string[]
): number {
  const db = getDb();
  const { record, redactions } = scrubFreeText(decision, ['decision', 'reasoning', 'alternatives']);
  if (redactionsOut) redactionsOut.push(...redactions);
  const stmt = db.prepare(`
    INSERT INTO decisions (session_id, category, project, decision, reasoning, alternatives, status, confidence, importance, provenance)
    VALUES ($session_id, $category, $project, $decision, $reasoning, $alternatives, $status, $confidence, $importance, $provenance)
  `);
  const result = stmt.run({
    $session_id: record.session_id || null,
    $category: record.category || null,
    $project: record.project || null,
    $decision: record.decision,
    $reasoning: record.reasoning || null,
    $alternatives: record.alternatives || null,
    $status: record.status || 'active',
    $confidence: record.confidence || 'medium',
    $importance: clampImportance(record.importance, 5),
    $provenance: record.provenance ?? null
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

export function addLearning(
  learning: Omit<Learning, 'id' | 'created_at'>,
  redactionsOut?: string[]
): number {
  const db = getDb();
  const { record, redactions } = scrubFreeText(learning, ['problem', 'solution', 'prevention']);
  if (redactionsOut) redactionsOut.push(...redactions);
  const stmt = db.prepare(`
    INSERT INTO learnings (session_id, category, project, problem, solution, prevention, tags, confidence, importance, provenance)
    VALUES ($session_id, $category, $project, $problem, $solution, $prevention, $tags, $confidence, $importance, $provenance)
  `);
  const result = stmt.run({
    $session_id: record.session_id || null,
    $category: record.category || null,
    $project: record.project || null,
    $problem: record.problem,
    $solution: record.solution || null,
    $prevention: record.prevention || null,
    $tags: record.tags || null,
    $confidence: record.confidence || 'medium',
    $importance: clampImportance(record.importance, 5),
    $provenance: record.provenance ?? null
  });
  return result.lastInsertRowid as number;
}

export function getLearning(id: number): Learning | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM learnings WHERE id = ?').get(id) as Learning | undefined;
}

// ============ Breadcrumbs ============

export function addBreadcrumb(
  breadcrumb: Omit<Breadcrumb, 'id' | 'created_at'>,
  redactionsOut?: string[]
): number {
  const db = getDb();
  const { record, redactions } = scrubFreeText(breadcrumb, ['content']);
  if (redactionsOut) redactionsOut.push(...redactions);
  const stmt = db.prepare(`
    INSERT INTO breadcrumbs (session_id, content, category, project, importance, expires_at, provenance)
    VALUES ($session_id, $content, $category, $project, $importance, $expires_at, $provenance)
  `);
  const result = stmt.run({
    $session_id: record.session_id || null,
    $content: record.content,
    $category: record.category || null,
    $project: record.project || null,
    $importance: record.importance ?? 5,
    $expires_at: record.expires_at || null,
    $provenance: record.provenance ?? null
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
let lastSearchReadiness: LifecycleSearchReadiness = {
  status: 'ready',
  pendingGenerations: 0,
};

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

export function getLastSearchReadiness(): LifecycleSearchReadiness {
  return lastSearchReadiness;
}

type RankedSearchRow = {
  id: number;
  content: string;
  project: string | null;
  created_at: string;
  provenance: Provenance | null;
  rank: number;
};

function asSearchResult(table: string, row: RankedSearchRow): SearchResult {
  return {
    table,
    id: row.id,
    content: row.content,
    project: row.project || undefined,
    created_at: row.created_at,
    provenance: row.provenance ?? null,
    rank: row.rank,
  };
}

function fuseMessageSearchGroups(groups: RankedSearchRow[][]): SearchResult[] {
  const populated = groups.filter(group => group.length > 0);
  if (populated.length <= 1) {
    return (populated[0] ?? []).map(row => asSearchResult('messages', row));
  }
  const scores = new Map<number, number>();
  const rows = new Map<number, RankedSearchRow>();
  for (const group of populated) {
    group.forEach((row, index) => {
      rows.set(row.id, row);
      scores.set(row.id, (scores.get(row.id) ?? 0) + 1 / (60 + index + 1));
    });
  }
  const ranked = [...rows.values()].sort((left, right) =>
    (scores.get(right.id) ?? 0) - (scores.get(left.id) ?? 0) ||
    right.created_at.localeCompare(left.created_at) || left.id - right.id
  );
  const rawRanks = ranked.map(row => row.rank).sort((left, right) => left - right);
  const best = rawRanks[0] ?? -Number.EPSILON;
  const worst = rawRanks.at(-1) ?? best;
  return ranked.map((row, index) => ({
    ...asSearchResult('messages', row),
    rank: ranked.length === 1
      ? best
      : best + ((worst - best) * index) / (ranked.length - 1),
  }));
}

export function search(query: string, options?: MemorySearchOptions): SearchResult[] {
  const db = getDb();
  const limit = options?.limit || 20;
  const results: SearchResult[] = [];
  lastSearchErrors = []; // Reset errors for this search
  lastSearchReadiness = { status: 'ready', pendingGenerations: 0 };
  const lifecycleCapabilities = getLifecycleSearchCapabilities(db);
  const generationStorageAvailable = lifecycleCapabilities.storage;
  const generationFtsAvailable = lifecycleCapabilities.fts;
  const generationFtsReadinessAvailable = lifecycleCapabilities.readiness;

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
          JOIN published_messages m ON m.id = f.rowid
          WHERE messages_fts MATCH ?
          ${generationStorageAvailable ? `AND NOT EXISTS (
            SELECT 1
            FROM host_ingest_generation_messages AS generated
            JOIN host_ingest_state AS state
              ON state.active_generation = generated.generation_id
             AND state.source = generated.source
             AND state.session_id = generated.session_id
            WHERE generated.message_id = m.id
          )` : ''}
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

    if (table === 'messages') {
      const messageGroups: RankedSearchRow[][] = [];
      try {
        messageGroups.push(db.query(sql).all(...params) as RankedSearchRow[]);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        lastSearchErrors.push(`[messages] ${errorMsg}`);
      }

      let activeGeneration = false;
      if (generationStorageAvailable) {
        try {
          lastSearchReadiness = repairLifecycleSearchIndex(db, {
            project: options?.project,
            maxPages: 1,
          });
          activeGeneration = countActiveLifecycleGenerations(db, options?.project) > 0;
        } catch {
          lastSearchReadiness = {
            status: 'retryable',
            pendingGenerations: 1,
            message: LIFECYCLE_SEARCH_RETRYABLE,
          };
        }
      }
      if (lastSearchReadiness.status === 'retryable') {
        lastSearchErrors.push(`[messages:lifecycle] ${lastSearchReadiness.message}`);
      }

      if (activeGeneration && generationFtsAvailable && generationFtsReadinessAvailable) {
        const generationParams: Array<string | number> = [query];
        if (options?.project) generationParams.push(options.project);
        generationParams.push(limit);
        try {
          const generationRows = db.prepare(`
            SELECT generated.message_id AS id, generated.content, generated.project,
              generated.timestamp AS created_at, generated.provenance, f.rank
            FROM host_ingest_generation_messages_fts AS f
            JOIN host_ingest_generation_messages AS generated
              ON generated.message_id = f.rowid
            JOIN host_ingest_generations AS generation
              ON generation.generation_id = generated.generation_id
             AND generation.status = 'active'
             AND generation.fts_ready = 1
            JOIN host_ingest_state AS state
              ON state.active_generation = generated.generation_id
             AND state.source = generated.source
             AND state.session_id = generated.session_id
            WHERE host_ingest_generation_messages_fts MATCH ?
              AND generated.message_id IS NOT NULL
              AND (generated.source <> 'grok' OR generated.source_position IS NOT NULL)
              ${duplicateFilter(options, 'messages', 'generated.message_id')}
              ${options?.project ? 'AND generated.project = ?' : ''}
            ORDER BY f.rank LIMIT ?
          `).all(...generationParams) as RankedSearchRow[];
          messageGroups.push(generationRows);
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          lastSearchReadiness = {
            status: 'retryable',
            pendingGenerations: 1,
            message: LIFECYCLE_SEARCH_RETRYABLE,
          };
          lastSearchErrors.push(
            `[messages:lifecycle] ${LIFECYCLE_SEARCH_RETRYABLE} (${errorMsg})`
          );
        }
      }
      results.push(...fuseMessageSearchGroups(messageGroups));
      continue;
    }

    try {
      const rows = db.query(sql).all(...params) as RankedSearchRow[];
      for (const row of rows) results.push(asSearchResult(table, row));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      lastSearchErrors.push(`[${table}] ${errorMsg}`);
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

// ============ Access tracking (frecency B1, issue #153) ============

// Physical tables carrying access_count / last_accessed (migration 13→14).
// Search results label LoA rows as 'loa'; the physical table is 'loa_entries'.
const BUMP_TABLES = new Set(['messages', 'decisions', 'learnings', 'breadcrumbs', 'loa_entries']);

function physicalBumpTable(table: string): string | null {
  const physical = table === 'loa' ? 'loa_entries' : table;
  return BUMP_TABLES.has(physical) ? physical : null;
}

/**
 * Bump-on-use (issue #153): record that these records were surfaced in returned
 * recall results — increment `access_count` and set `last_accessed` to now. This
 * is the access signal #154's frecency score will consume; it does NOT change
 * ranking here.
 *
 * Call ONLY with the FINAL returned/sliced result set of a user-facing surface
 * (the `memory_search` tool + `recall search` CLI, and `hybridSearch`'s returned
 * results). NEVER call it with an internal candidate pool — e.g. the `limit * 2`
 * `search()` call inside `hybridSearch` — or matches that were never returned
 * would be bumped, corrupting the frecency signal.
 *
 * One batched UPDATE per table. The UPDATE touches only access_count /
 * last_accessed, which (after migration 14→15 scopes the FTS `AFTER UPDATE OF`
 * triggers to indexed columns) does NOT re-fire FTS reindexing. Best-effort: a
 * bump failure must never break the read path.
 */
export function bumpAccess(records: Array<{ table: string; id: number }>): void {
  if (records.length === 0) return;

  // Group unique ids per physical table (dedup so a row surfaced twice in one
  // result set still counts as a single access).
  const idsByTable = new Map<string, Set<number>>();
  for (const { table, id } of records) {
    const physical = physicalBumpTable(table);
    if (!physical) continue;
    let ids = idsByTable.get(physical);
    if (!ids) { ids = new Set(); idsByTable.set(physical, ids); }
    ids.add(id);
  }
  if (idsByTable.size === 0) return;

  try {
    const db = getDb();
    const apply = db.transaction(() => {
      for (const [table, ids] of idsByTable) {
        // Input-scaled IN (...) list: a large surfaced result set (e.g. a
        // high --limit recall) could otherwise exceed the bind-variable limit,
        // so chunk through the SQLite-safe helper. All chunks share one
        // transaction, keeping the bump all-or-nothing.
        for (const chunk of chunked([...ids])) {
          const placeholders = chunk.map(() => '?').join(', ');
          db.prepare(
            `UPDATE ${table} SET access_count = access_count + 1, last_accessed = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`
          ).run(...chunk);
        }
      }
    });
    apply();
  } catch {
    // Best-effort: a frecency bump must never break the read path.
  }
}

/**
 * Resolve display fields + provenance for a record surfaced by hybrid search,
 * keyed by its source_table. Returns:
 *  - `content`    — semantic / MCP preview source (title+extract for LoA, the
 *                   primary text otherwise); consumed by runSemanticSearch and
 *                   the MCP hybridSearch resolver.
 *  - `preview`    — the hybrid-CLI table preview (LoA title only; first 50 chars
 *                   of the primary text for the rest).
 *  - `meta`       — the hybrid-CLI label, e.g. `Decision #12` (empty when the
 *                   row is missing or the table is unrecognized).
 *  - `provenance` — the row's provenance, or null for legacy rows.
 *
 * Centralizing the table → column + provenance mapping keeps the hybrid
 * vec-branch from silently omitting a table — issue #67, where a vector-only
 * learnings match misreported its provenance as unknown because the learnings
 * case was missing. Covers all five hybrid tables: the four embeddable ones
 * (see EMBED_SOURCES in repair.ts) plus breadcrumbs, which the FTS side can
 * fuse into the hybrid result set (issue #119). An unknown table or missing row
 * yields empty strings and null provenance.
 */
export interface VectorRowResolution {
  content: string;
  preview: string;
  meta: string;
  provenance: Provenance | null;
}

export function vectorRowContentProvenance(
  sourceTable: string,
  sourceId: number
): VectorRowResolution {
  const db = getDb();
  const empty: VectorRowResolution = { content: '', preview: '', meta: '', provenance: null };
  if (sourceTable === 'loa_entries') {
    const loa = db.prepare('SELECT title, fabric_extract, provenance FROM loa_entries WHERE id = ?').get(sourceId) as any;
    if (!loa) return empty;
    return {
      content: `${loa.title}: ${loa.fabric_extract?.slice(0, 200)}`,
      preview: loa.title,
      meta: `LoA #${sourceId}`,
      provenance: loa.provenance ?? null
    };
  }
  if (sourceTable === 'decisions') {
    const dec = db.prepare('SELECT decision, provenance FROM decisions WHERE id = ?').get(sourceId) as any;
    if (!dec) return empty;
    return {
      content: dec.decision || '',
      preview: dec.decision.slice(0, 50),
      meta: `Decision #${sourceId}`,
      provenance: dec.provenance ?? null
    };
  }
  if (sourceTable === 'messages') {
    const msg = db.prepare(
      `SELECT content, provenance FROM ${publishedRecordTable(sourceTable)} WHERE id = ?`
    ).get(sourceId) as any;
    if (!msg) return empty;
    return {
      content: msg.content?.slice(0, 200) || '',
      preview: msg.content.slice(0, 50).replace(/\n/g, ' '),
      meta: `Message #${sourceId}`,
      provenance: msg.provenance ?? null
    };
  }
  if (sourceTable === 'learnings') {
    const learn = db.prepare('SELECT problem, provenance FROM learnings WHERE id = ?').get(sourceId) as any;
    if (!learn) return empty;
    return {
      content: learn.problem?.slice(0, 200) || '',
      preview: learn.problem.slice(0, 50),
      meta: `Learning #${sourceId}`,
      provenance: learn.provenance ?? null
    };
  }
  if (sourceTable === 'breadcrumbs') {
    const bc = db.prepare('SELECT content, provenance FROM breadcrumbs WHERE id = ?').get(sourceId) as any;
    if (!bc) return empty;
    return {
      content: bc.content?.slice(0, 200) || '',
      preview: bc.content.slice(0, 50),
      meta: `Breadcrumb #${sourceId}`,
      provenance: bc.provenance ?? null
    };
  }
  return empty;
}

// ============ Recent ============

export function recentMessages(limit: number = 10, project?: string): Message[] {
  const db = getDb();
  const sql = project
    ? 'SELECT * FROM published_messages WHERE project = ? ORDER BY timestamp DESC LIMIT ?'
    : 'SELECT * FROM published_messages ORDER BY timestamp DESC LIMIT ?';
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
    INSERT INTO loa_entries (title, description, fabric_extract, message_range_start, message_range_end, snapshot_max_message_id, parent_loa_id, session_id, project, tags, message_count, importance, provenance, source_ids)
    VALUES ($title, $description, $fabric_extract, $message_range_start, $message_range_end, $snapshot_max_message_id, $parent_loa_id, $session_id, $project, $tags, $message_count, $importance, $provenance, $source_ids)
  `);
  const result = stmt.run({
    $title: entry.title,
    $description: entry.description || null,
    $fabric_extract: entry.fabric_extract,
    $message_range_start: entry.message_range_start || null,
    $message_range_end: entry.message_range_end || null,
    $snapshot_max_message_id: entry.snapshot_max_message_id ?? entry.message_range_end ?? null,
    $parent_loa_id: entry.parent_loa_id || null,
    $session_id: entry.session_id || null,
    $project: entry.project || null,
    $tags: entry.tags || null,
    $message_count: entry.message_count || null,
    $importance: importance,
    $provenance: entry.provenance ?? null,
    $source_ids: entry.source_ids ?? null
  });
  return result.lastInsertRowid as number;
}

export function invalidateRecordEmbedding(
  db: ReturnType<typeof getDb>,
  sourceTable: ProvenanceTable,
  sourceId: number
): boolean {
  return deleteRecordEmbeddingsByIdsInTransaction(
    db,
    sourceTable,
    [sourceId]
  ) > 0;
}

export function getLoaEntry(id: number): LoaEntry | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM loa_entries WHERE id = ?').get(id) as LoaEntry | undefined;
}

export function getLastLoaEntry(): LoaEntry | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM loa_entries ORDER BY created_at DESC LIMIT 1').get() as LoaEntry | undefined;
}

function getPinnedLoaMessages(loaId: number): Message[] {
  const db = getDb();
  const statement = db.prepare(`
    SELECT message_id AS id, session_id, timestamp, role, content, project,
      importance, provenance, ordinal
    FROM loa_message_sources
    WHERE loa_id = ? AND ordinal > ? AND content <> ''
    ORDER BY ordinal LIMIT ?
  `);
  const messages: Message[] = [];
  let ordinal = -1;
  for (;;) {
    const batch = statement.all(loaId, ordinal, SQLITE_SAFE_CHUNK_SIZE) as Array<
      Message & { ordinal: number }
    >;
    if (batch.length === 0) break;
    for (const message of batch) {
      ordinal = message.ordinal;
      const { ordinal: _ordinal, ...source } = message;
      messages.push(source);
    }
  }
  return messages;
}

function getGenerationLoaMessages(generationId: string): Message[] {
  const db = getDb();
  const statement = db.prepare(`
    SELECT message_id AS id, session_id, timestamp, role, content, project,
      importance, provenance, ordinal
    FROM host_ingest_generation_messages
    WHERE generation_id = ? AND ordinal > ? AND message_id IS NOT NULL
      AND content IS NOT NULL
      AND (source <> 'grok' OR source_position IS NOT NULL)
    ORDER BY ordinal LIMIT ?
  `);
  const messages: Message[] = [];
  let ordinal = -1;
  for (;;) {
    const batch = statement.all(generationId, ordinal, SQLITE_SAFE_CHUNK_SIZE) as Array<
      Message & { ordinal: number }
    >;
    if (batch.length === 0) break;
    for (const message of batch) {
      ordinal = message.ordinal;
      const { ordinal: _ordinal, ...source } = message;
      messages.push(source);
    }
  }
  return messages;
}

export function getLoaMessages(loaId: number): Message[] {
  const db = getDb();
  const loa = getLoaEntry(loaId);
  if (!loa) return [];

  if (loa.source_ids) {
    try {
      const sources = JSON.parse(loa.source_ids) as unknown;
      if (
        typeof sources === 'object' && sources !== null &&
        (sources as { table?: unknown }).table === 'loa_message_sources' &&
        (sources as { loa_id?: unknown }).loa_id === loaId
      ) {
        return getPinnedLoaMessages(loaId);
      }
      if (
        typeof sources === 'object' && sources !== null &&
        (sources as { table?: unknown }).table === 'host_ingest_generation_messages' &&
        typeof (sources as { generation_id?: unknown }).generation_id === 'string'
      ) {
        return getGenerationLoaMessages((sources as { generation_id: string }).generation_id);
      }
      if (
        Array.isArray(sources) &&
        sources.every(source =>
          typeof source === 'object' && source !== null &&
          (source as { table?: unknown }).table === 'messages' &&
          Number.isSafeInteger((source as { id?: unknown }).id)
        )
      ) {
        const ids = sources.map(source => (source as { id: number }).id);
        const messages: Message[] = [];
        for (const idChunk of chunked(ids)) {
          messages.push(...db.prepare(`
            SELECT * FROM published_messages WHERE id IN (${idChunk.map(() => '?').join(',')})
          `).all(...idChunk) as Message[]);
        }
        const order = new Map(ids.map((id, index) => [id, index]));
        return messages.sort((left, right) =>
          (order.get(left.id!) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(right.id!) ?? Number.MAX_SAFE_INTEGER)
        );
      }
    } catch {
      return [];
    }
  }

  if (!loa.message_range_start || !loa.message_range_end) {
    return [];
  }
  if (loa.session_id) {
    return db.prepare(`
      SELECT * FROM published_messages
      WHERE id >= ? AND id <= ? AND session_id = ?
      ORDER BY timestamp
    `).all(loa.message_range_start, loa.message_range_end, loa.session_id) as Message[];
  }
  return db.prepare(`
    SELECT * FROM published_messages WHERE id >= ? AND id <= ? ORDER BY timestamp
  `).all(loa.message_range_start, loa.message_range_end) as Message[];
}

export function getMessagesSinceLastLoa(limit?: number): { messages: Message[]; startId: number | null; endId: number | null } {
  const db = getDb();
  const lastLoa = db.prepare(`
    SELECT * FROM loa_entries
    WHERE tags IS NULL OR tags NOT LIKE 'automatic-capture,%'
    ORDER BY id DESC LIMIT 1
  `).get() as LoaEntry | undefined;

  let sql: string;
  let params: number[];

  const cursor = lastLoa?.snapshot_max_message_id ?? lastLoa?.message_range_end;
  if (cursor !== undefined && cursor !== null) {
    sql = limit
      ? 'SELECT * FROM published_messages WHERE id > ? ORDER BY timestamp LIMIT ?'
      : 'SELECT * FROM published_messages WHERE id > ? ORDER BY timestamp';
    params = limit ? [cursor, limit] : [cursor];
  } else {
    sql = limit
      ? 'SELECT * FROM published_messages ORDER BY timestamp LIMIT ?'
      : 'SELECT * FROM published_messages ORDER BY timestamp';
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
  const messages = count('SELECT COUNT(*) as count FROM published_messages');
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
