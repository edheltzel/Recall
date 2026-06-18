// recall dedup — core logic (issue #45).
//
// Non-destructive dedup with provenance-aware survivor selection. The decision
// logic (normalization, survivor ordering, grouping, semantic pairing) is kept
// as pure exported functions over plain data so it stays unit-testable
// (issue #44 phase 2 adds property tests over these functions).
//
// Safety model:
// - Dry-run by default; mutations require an explicit execute step.
// - Default action marks duplicates in dedup_lineage — records stay intact.
//   Hard deletion is a separate destructive opt-in.
// - Dedup acts within a table (and within a project) only. Cross-table
//   duplicate candidates are report-only.
// - Survivor priority: user_authored > verbatim > extracted > derived >
//   unknown (PROVENANCE_VALUES in types/index.ts is the single source of
//   truth). Ties break by richness (normalized length), importance, recency,
//   then lowest id for determinism.
// - Semantic detection compares stored embeddings pairwise — no embedding
//   service call is needed. Pairs are never chained transitively: every
//   marked duplicate has a direct similarity >= threshold to its survivor.
// - Survivors are sticky across runs (issue #63): a record recorded as a
//   survivor in dedup_lineage (status 'marked' or 'deleted') is never
//   re-marked as a duplicate by a later run, so every hidden or deleted
//   record keeps a visible survivor. Conservative and order-dependent by
//   design — an early survivor is never consolidated under a later record.
//   Destructive mode independently refuses to delete a recorded survivor
//   (defense-in-depth should planning ever regress).
//
// Bind-count note (see src/lib/chunk.ts): scans use keyset pagination
// (`WHERE id > ? LIMIT ?`, fixed binds). Destructive deletion builds
// input-scaled `IN (?,...)` lists and therefore goes through chunked().

import { createHash } from 'crypto';
import { Database } from 'bun:sqlite';
import { chunked, SQLITE_SAFE_CHUNK_SIZE } from './chunk.js';
import { blobToEmbedding, cosineSimilarity } from './embeddings.js';
import {
  PROVENANCE_TABLES,
  PROVENANCE_VALUES,
  type Provenance,
  type ProvenanceTable,
} from '../types/index.js';

/** Tables dedup operates on — the provenance-bearing memory tables. */
export const DEDUP_TABLES = PROVENANCE_TABLES;

/**
 * Conservative default for semantic matching. At 0.95 cosine similarity on
 * nomic-embed-text vectors, two records are near-verbatim restatements;
 * anything below stays untouched (never auto-merge below the threshold).
 */
export const DEFAULT_SEMANTIC_THRESHOLD = 0.95;

/**
 * Records whose normalized text is shorter than this are never dedup
 * candidates. Short acknowledgments ("ok", "thanks", "yes") repeat
 * legitimately across sessions — mass-marking them would be noise.
 */
export const MIN_DEDUP_TEXT_LENGTH = 20;

export type DedupReason = 'exact' | 'semantic';
export type LineageStatus = 'marked' | 'deleted' | 'reverted';

export interface DedupCandidate {
  table: ProvenanceTable;
  id: number;
  project: string | null;
  provenance: Provenance | null;
  importance: number;
  created_at: string;
  /** sha256 of the normalized dedup text — exact-match grouping key. */
  key: string;
  /** Length of the normalized text — the richness tie-breaker. */
  textLength: number;
}

export interface LineageEntry {
  survivor_table: ProvenanceTable;
  survivor_id: number;
  duplicate_table: ProvenanceTable;
  duplicate_id: number;
  reason: DedupReason;
  similarity: number | null;
  /** JSON audit detail (project, survivor/duplicate provenance). */
  detail: string;
}

// ---------------------------------------------------------------------------
// Pure functions — text normalization and survivor selection
// ---------------------------------------------------------------------------

/**
 * Canonical text normalization for duplicate detection: lowercase, strip
 * quote characters, collapse whitespace. Same convention the extraction
 * hooks use for their log-level dedup.
 */
export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/['"]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Survivor priority rank — lower wins. Order comes from PROVENANCE_VALUES
 * (user_authored > verbatim > extracted > derived); unknown (NULL) ranks
 * last. Note PROVENANCE_VALUES is already declared in survivor order.
 */
export function provenanceRank(p: Provenance | null | undefined): number {
  if (!p) return PROVENANCE_VALUES.length;
  const idx = PROVENANCE_VALUES.indexOf(p);
  return idx === -1 ? PROVENANCE_VALUES.length : idx;
}

/**
 * Comparator placing the survivor first: provenance rank, then richness
 * (longer normalized text), importance, recency (newer created_at), and
 * finally lowest id so ordering is total and deterministic.
 */
export function compareForSurvivor(a: DedupCandidate, b: DedupCandidate): number {
  const rank = provenanceRank(a.provenance) - provenanceRank(b.provenance);
  if (rank !== 0) return rank;
  if (a.textLength !== b.textLength) return b.textLength - a.textLength;
  const importance = (b.importance ?? 5) - (a.importance ?? 5);
  if (importance !== 0) return importance;
  // ISO and SQLite CURRENT_TIMESTAMP formats both sort lexicographically.
  if (a.created_at !== b.created_at) return a.created_at > b.created_at ? -1 : 1;
  return a.id - b.id;
}

export function selectSurvivor(group: DedupCandidate[]): {
  survivor: DedupCandidate;
  duplicates: DedupCandidate[];
} {
  if (group.length === 0) throw new Error('selectSurvivor: empty group');
  const sorted = [...group].sort(compareForSurvivor);
  return { survivor: sorted[0], duplicates: sorted.slice(1) };
}

/**
 * Grouping key: same table, same project, same normalized text. Fields are
 * joined with the NUL escape `\x00` — a separator that cannot occur in any
 * field, so boundaries can never be forged by content.
 */
function groupKey(c: DedupCandidate): string {
  return `${c.table}\x00${c.project ?? ''}\x00${c.key}`;
}

/**
 * Exact (normalized-text) duplicate groups within a table and project.
 * Returns only groups with two or more members.
 */
export function findExactGroups(candidates: DedupCandidate[]): DedupCandidate[][] {
  const byKey = new Map<string, DedupCandidate[]>();
  for (const c of candidates) {
    const k = groupKey(c);
    const group = byKey.get(k);
    if (group) group.push(c);
    else byKey.set(k, [c]);
  }
  return [...byKey.values()].filter(g => g.length >= 2);
}

export interface CrossTableMatch {
  project: string | null;
  members: Array<{ table: ProvenanceTable; id: number }>;
}

/**
 * Report-only: normalized-text matches spanning two or more tables within
 * the same project. Dedup never acts across tables.
 */
export function findCrossTableMatches(candidates: DedupCandidate[]): CrossTableMatch[] {
  const byKey = new Map<string, DedupCandidate[]>();
  for (const c of candidates) {
    const k = `${c.project ?? ''}\x00${c.key}`;
    const group = byKey.get(k);
    if (group) group.push(c);
    else byKey.set(k, [c]);
  }
  const matches: CrossTableMatch[] = [];
  for (const group of byKey.values()) {
    const tables = new Set(group.map(c => c.table));
    if (tables.size < 2) continue;
    matches.push({
      project: group[0].project,
      members: group.map(c => ({ table: c.table, id: c.id })),
    });
  }
  return matches;
}

export interface EmbeddedCandidate {
  candidate: DedupCandidate;
  embedding: number[];
}

export interface SemanticPair {
  a: DedupCandidate;
  b: DedupCandidate;
  similarity: number;
  sameTable: boolean;
}

/**
 * Pairwise cosine similarity over stored embeddings. Returns every pair at
 * or above the threshold, split into actionable (same table + project) and
 * cross-table report-only pairs. Pairs within one table but across projects
 * are ignored — dedup scope is per-project, matching the exact pass.
 *
 * O(n^2) over embedded records — acceptable at personal-memory scale and the
 * same brute-force shape the cluster command and hybrid search already use.
 */
export function findSemanticPairs(
  embedded: EmbeddedCandidate[],
  threshold: number
): SemanticPair[] {
  const pairs: SemanticPair[] = [];
  for (let i = 0; i < embedded.length; i++) {
    for (let j = i + 1; j < embedded.length; j++) {
      const x = embedded[i];
      const y = embedded[j];
      const sameTable = x.candidate.table === y.candidate.table;
      if (sameTable && x.candidate.project !== y.candidate.project) continue;
      // Exact duplicates are the exact pass's job; identical keys here would
      // double-report the same records under a second reason.
      if (x.candidate.key === y.candidate.key) continue;
      const similarity = cosineSimilarity(x.embedding, y.embedding);
      if (similarity >= threshold) {
        pairs.push({ a: x.candidate, b: y.candidate, similarity, sameTable });
      }
    }
  }
  // Deterministic processing order: strongest pairs first.
  pairs.sort((p, q) =>
    q.similarity - p.similarity ||
    p.a.table.localeCompare(q.a.table) ||
    p.a.id - q.a.id ||
    p.b.id - q.b.id
  );
  return pairs;
}

// ---------------------------------------------------------------------------
// SQL fragments shared with the search paths
// ---------------------------------------------------------------------------

/**
 * SQL fragment excluding records marked as duplicates. `tableExpr` and
 * `idExpr` are SQL expressions (a quoted literal like `'messages'` or a
 * column reference like `e.source_table`) — never user input.
 */
export function notMarkedDuplicateSql(tableExpr: string, idExpr: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM dedup_lineage dl
    WHERE dl.duplicate_table = ${tableExpr}
      AND dl.duplicate_id = ${idExpr}
      AND dl.status = 'marked'
  )`;
}

/**
 * SQL fragment excluding records that are recorded dedup survivors. Mirrors
 * `notMarkedDuplicateSql` for the survivor side: active lineage is status
 * IN ('marked', 'deleted') — the same set `loadRecordedSurvivors` treats as
 * binding ('reverted' rows carry no obligation). `prune` uses this so it never
 * deletes a survivor and orphans the duplicates marked under it (#80) —
 * mirroring PR #79's destructive-mode survivor guard (ADR-0003). `tableExpr`
 * and `idExpr` are SQL expressions (a quoted literal or column reference),
 * never user input.
 */
export function notRecordedSurvivorSql(tableExpr: string, idExpr: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM dedup_lineage dl
    WHERE dl.survivor_table = ${tableExpr}
      AND dl.survivor_id = ${idExpr}
      AND dl.status IN ('marked', 'deleted')
  )`;
}

// ---------------------------------------------------------------------------
// Database plumbing — scans, lineage, deletion
// ---------------------------------------------------------------------------

interface TableScanConfig {
  textColumns: string[];
  createdAtColumn: string;
  extraWhere?: string;
}

// Which columns constitute "the text" of a record for duplicate detection.
// Decisions are scanned at status='active' only: supersede/revert already
// manage lifecycle copies, and a superseded row must never win survivorship
// over (and thereby hide) an active decision.
const TABLE_SCAN_CONFIG: Record<ProvenanceTable, TableScanConfig> = {
  messages: { textColumns: ['content'], createdAtColumn: 'timestamp' },
  decisions: { textColumns: ['decision'], createdAtColumn: 'created_at', extraWhere: "status = 'active'" },
  learnings: { textColumns: ['problem', 'solution'], createdAtColumn: 'created_at' },
  breadcrumbs: { textColumns: ['content'], createdAtColumn: 'created_at' },
  loa_entries: { textColumns: ['title', 'fabric_extract'], createdAtColumn: 'created_at' },
};

export interface ScanResult {
  candidates: DedupCandidate[];
  scanned: number;
  tooShort: number;
}

/**
 * Read one table's dedup candidates in bounded batches via keyset pagination
 * (fixed binds per statement regardless of table size). Rows below
 * MIN_DEDUP_TEXT_LENGTH are counted but excluded.
 */
export function scanCandidates(
  db: Database,
  table: ProvenanceTable,
  project?: string,
  batchSize: number = SQLITE_SAFE_CHUNK_SIZE
): ScanResult {
  const config = TABLE_SCAN_CONFIG[table];
  const where = [
    'id > ?',
    ...(config.extraWhere ? [config.extraWhere] : []),
    ...(project !== undefined ? ['project = ?'] : []),
  ].join(' AND ');
  const stmt = db.prepare(`
    SELECT id, project, provenance, importance,
           ${config.createdAtColumn} AS created_at,
           ${config.textColumns.join(', ')}
    FROM ${table}
    WHERE ${where}
    ORDER BY id
    LIMIT ?
  `);

  const candidates: DedupCandidate[] = [];
  let scanned = 0;
  let tooShort = 0;
  let lastId = 0;
  for (;;) {
    const params = project !== undefined ? [lastId, project, batchSize] : [lastId, batchSize];
    const batch = stmt.all(...params) as Array<Record<string, unknown>>;
    if (batch.length === 0) break;
    for (const row of batch) {
      scanned++;
      const text = config.textColumns
        .map(c => row[c])
        .filter(v => v !== null && v !== undefined && String(v).length > 0)
        .join('\n');
      const normalized = normalizeText(text);
      if (normalized.length < MIN_DEDUP_TEXT_LENGTH) {
        tooShort++;
        continue;
      }
      candidates.push({
        table,
        id: row.id as number,
        project: (row.project as string | null) ?? null,
        provenance: (row.provenance as Provenance | null) ?? null,
        importance: (row.importance as number | null) ?? 5,
        created_at: String(row.created_at),
        key: createHash('sha256').update(normalized).digest('hex'),
        textLength: normalized.length,
      });
    }
    lastId = batch[batch.length - 1].id as number;
  }
  return { candidates, scanned, tooShort };
}

/** (table, id) pairs currently marked as duplicates — excluded from scans. */
export function loadMarkedDuplicates(db: Database): Set<string> {
  const rows = db.prepare(
    `SELECT duplicate_table, duplicate_id FROM dedup_lineage WHERE status = 'marked'`
  ).all() as Array<{ duplicate_table: string; duplicate_id: number }>;
  return new Set(rows.map(r => `${r.duplicate_table}:${r.duplicate_id}`));
}

/**
 * (table, id) pairs recorded as survivors in dedup_lineage — sticky across
 * runs (issue #63): their hidden ('marked') or removed ('deleted')
 * duplicates rely on the survivor staying visible, so these records are
 * never re-marked. 'reverted' rows carry no such obligation — the duplicate
 * is visible again.
 */
export function loadRecordedSurvivors(db: Database): Set<string> {
  const rows = db.prepare(
    `SELECT DISTINCT survivor_table, survivor_id FROM dedup_lineage
     WHERE status IN ('marked', 'deleted')`
  ).all() as Array<{ survivor_table: string; survivor_id: number }>;
  return new Set(rows.map(r => `${r.survivor_table}:${r.survivor_id}`));
}

/** Stored embeddings for one table, keyed by source row id. */
export function loadEmbeddings(db: Database, table: ProvenanceTable): Map<number, number[]> {
  const rows = db.prepare(
    `SELECT source_id, embedding FROM embeddings WHERE source_table = ?`
  ).all(table) as Array<{ source_id: number; embedding: Buffer }>;
  const map = new Map<number, number[]>();
  for (const row of rows) {
    map.set(row.source_id, blobToEmbedding(row.embedding));
  }
  return map;
}

/**
 * Ids in `table` that other rows reference via foreign keys (loa_entries
 * message ranges, loa parent links). With foreign_keys=ON these cannot be
 * hard-deleted; destructive mode downgrades them to 'marked' instead of
 * failing the whole transaction.
 */
export function fkProtectedIds(db: Database, table: ProvenanceTable): Set<number> {
  const ids = new Set<number>();
  if (table === 'messages') {
    const rows = db.prepare(
      `SELECT message_range_start AS s, message_range_end AS e FROM loa_entries
       WHERE message_range_start IS NOT NULL OR message_range_end IS NOT NULL`
    ).all() as Array<{ s: number | null; e: number | null }>;
    for (const row of rows) {
      if (row.s !== null) ids.add(row.s);
      if (row.e !== null) ids.add(row.e);
    }
  } else if (table === 'loa_entries') {
    const rows = db.prepare(
      `SELECT DISTINCT parent_loa_id AS p FROM loa_entries WHERE parent_loa_id IS NOT NULL`
    ).all() as Array<{ p: number }>;
    for (const row of rows) ids.add(row.p);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Plan and apply
// ---------------------------------------------------------------------------

export interface DedupTableReport {
  table: ProvenanceTable;
  scanned: number;
  tooShort: number;
  alreadyMarked: number;
  /** Marks not planned because a sticky prior survivor was involved (issue #63). */
  stickySkipped: number;
  exactGroups: number;
  semanticPairs: number;
  planned: LineageEntry[];
}

export interface DedupPlan {
  tables: DedupTableReport[];
  threshold: number;
  /** Reason the semantic pass did not run, or null if it ran. */
  semanticSkipped: string | null;
  crossTable: {
    textMatches: CrossTableMatch[];
    semanticPairs: number;
  };
}

export interface PlanDedupOptions {
  tables?: ProvenanceTable[];
  project?: string;
  threshold?: number;
  semantic?: boolean;
}

function lineageDetail(survivor: DedupCandidate, duplicate: DedupCandidate): string {
  return JSON.stringify({
    project: duplicate.project,
    survivor_provenance: survivor.provenance ?? 'unknown',
    duplicate_provenance: duplicate.provenance ?? 'unknown',
  });
}

function toLineage(
  survivor: DedupCandidate,
  duplicate: DedupCandidate,
  reason: DedupReason,
  similarity: number | null
): LineageEntry {
  return {
    survivor_table: survivor.table,
    survivor_id: survivor.id,
    duplicate_table: duplicate.table,
    duplicate_id: duplicate.id,
    reason,
    similarity,
    detail: lineageDetail(survivor, duplicate),
  };
}

/**
 * Compute the full dedup plan without writing anything. The same plan is
 * what a dry run reports and what an execute run applies.
 */
export function planDedup(db: Database, options: PlanDedupOptions = {}): DedupPlan {
  const tables = options.tables ?? [...DEDUP_TABLES];
  const threshold = options.threshold ?? DEFAULT_SEMANTIC_THRESHOLD;
  const semantic = options.semantic ?? true;
  const marked = loadMarkedDuplicates(db);
  // Sticky survivors (issue #63): seeding plannedSurvivorKeys with survivors
  // recorded by prior runs extends the within-plan one-hop guard across
  // runs — a recorded survivor is never re-marked, so its hidden or deleted
  // duplicates always keep a visible representative.
  const stickySurvivors = loadRecordedSurvivors(db);

  const reports = new Map<ProvenanceTable, DedupTableReport>();
  const eligible = new Map<ProvenanceTable, DedupCandidate[]>();

  // Exact pass — within table + project.
  const plannedDuplicateKeys = new Set<string>();
  const plannedSurvivorKeys = new Set<string>(stickySurvivors);
  for (const table of tables) {
    const scan = scanCandidates(db, table, options.project);
    const fresh = scan.candidates.filter(c => !marked.has(`${c.table}:${c.id}`));
    const report: DedupTableReport = {
      table,
      scanned: scan.scanned,
      tooShort: scan.tooShort,
      alreadyMarked: scan.candidates.length - fresh.length,
      stickySkipped: 0,
      exactGroups: 0,
      semanticPairs: 0,
      planned: [],
    };
    for (const group of findExactGroups(fresh)) {
      report.exactGroups++;
      const { survivor, duplicates } = selectSurvivor(group);
      plannedSurvivorKeys.add(`${survivor.table}:${survivor.id}`);
      for (const dup of duplicates) {
        // A sticky prior survivor stays visible even when a newer record
        // out-ranks it within its exact group (issue #63).
        if (stickySurvivors.has(`${dup.table}:${dup.id}`)) {
          report.stickySkipped++;
          continue;
        }
        report.planned.push(toLineage(survivor, dup, 'exact', 1.0));
        plannedDuplicateKeys.add(`${dup.table}:${dup.id}`);
      }
    }
    reports.set(table, report);
    eligible.set(table, fresh);
  }

  // Records still standing after the exact pass (survivors + unmatched).
  const remaining = [...eligible.values()].flat()
    .filter(c => !plannedDuplicateKeys.has(`${c.table}:${c.id}`));

  // Cross-table normalized-text matches — report-only.
  const crossTableText = findCrossTableMatches(remaining);

  // Semantic pass — stored embeddings only; no embedding service required.
  let semanticSkipped: string | null = null;
  let crossTableSemantic = 0;
  if (!semantic) {
    semanticSkipped = 'disabled (--no-semantic)';
  } else {
    const embedded: EmbeddedCandidate[] = [];
    for (const table of tables) {
      const embeddings = loadEmbeddings(db, table);
      if (embeddings.size === 0) continue;
      for (const candidate of remaining) {
        if (candidate.table !== table) continue;
        const embedding = embeddings.get(candidate.id);
        if (embedding) embedded.push({ candidate, embedding });
      }
    }
    if (embedded.length === 0) {
      semanticSkipped =
        'no stored embeddings for the scanned records (run `recall embed backfill` to enable semantic detection)';
    } else {
      const pairs = findSemanticPairs(embedded, threshold);
      for (const pair of pairs) {
        if (!pair.sameTable) {
          crossTableSemantic++;
          continue;
        }
        const aKey = `${pair.a.table}:${pair.a.id}`;
        const bKey = `${pair.b.table}:${pair.b.id}`;
        // Greedy, strongest-first: a record planned as a duplicate can
        // neither survive nor be re-marked, and a record planned as a
        // survivor (in either pass, this run or — via the sticky seed — any
        // prior run) can never be re-marked by a weaker pair — lineage stays
        // one hop deep, no transitive chaining.
        if (plannedDuplicateKeys.has(aKey) || plannedDuplicateKeys.has(bKey)) continue;
        if (plannedSurvivorKeys.has(aKey) || plannedSurvivorKeys.has(bKey)) {
          if (stickySurvivors.has(aKey) || stickySurvivors.has(bKey)) {
            reports.get(pair.a.table)!.stickySkipped++;
          }
          continue;
        }
        const { survivor, duplicates } = selectSurvivor([pair.a, pair.b]);
        const report = reports.get(pair.a.table)!;
        report.semanticPairs++;
        report.planned.push(toLineage(survivor, duplicates[0], 'semantic', pair.similarity));
        plannedDuplicateKeys.add(`${duplicates[0].table}:${duplicates[0].id}`);
        plannedSurvivorKeys.add(`${survivor.table}:${survivor.id}`);
      }
    }
  }

  return {
    tables: tables.map(t => reports.get(t)!),
    threshold,
    semanticSkipped,
    crossTable: { textMatches: crossTableText, semanticPairs: crossTableSemantic },
  };
}

export interface ApplyResult {
  marked: number;
  deleted: number;
  /** Duplicates kept as 'marked' in destructive mode because of FK references. */
  fkProtected: number;
}

/**
 * Apply a plan: insert lineage rows ('marked' by default). With
 * `destructive`, duplicate rows are hard-deleted (with their embeddings) and
 * lineage status is 'deleted' — except FK-referenced rows, which stay marked.
 * Runs in one transaction; failures roll back everything. Destructive mode
 * refuses (throws, nothing written) when a planned duplicate is itself a
 * recorded survivor in dedup_lineage — planDedup never produces such a plan,
 * so this guard is defense-in-depth for issue #63.
 */
export function applyDedupPlan(
  db: Database,
  plan: DedupPlan,
  options: { destructive?: boolean } = {}
): ApplyResult {
  const destructive = options.destructive ?? false;
  const entries = plan.tables.flatMap(t => t.planned);
  const result: ApplyResult = { marked: 0, deleted: 0, fkProtected: 0 };
  if (entries.length === 0) return result;

  if (destructive) {
    const survivors = loadRecordedSurvivors(db);
    const conflicts = entries.filter(e => survivors.has(`${e.duplicate_table}:${e.duplicate_id}`));
    if (conflicts.length > 0) {
      const sample = conflicts[0];
      throw new Error(
        `destructive dedup refused: ${conflicts.length} planned duplicate(s) are recorded survivors ` +
        `in dedup_lineage (e.g. ${sample.duplicate_table}#${sample.duplicate_id}). Deleting a survivor ` +
        `would leave its marked or deleted duplicates with no visible record. No changes were made.`
      );
    }
  }

  const insert = db.prepare(`
    INSERT INTO dedup_lineage
      (survivor_table, survivor_id, duplicate_table, duplicate_id, reason, similarity, status, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // FK lookups are per-table constants within this transaction; cache them so
  // a large plan doesn't re-query loa_entries per duplicate row.
  const fkCache = new Map<ProvenanceTable, Set<number>>();
  const fkProtected = (table: ProvenanceTable): Set<number> => {
    let cached = fkCache.get(table);
    if (!cached) {
      cached = fkProtectedIds(db, table);
      fkCache.set(table, cached);
    }
    return cached;
  };

  const apply = db.transaction(() => {
    const toDelete = new Map<ProvenanceTable, number[]>();
    for (const entry of entries) {
      let status: LineageStatus = 'marked';
      if (destructive) {
        const protectedIds = fkProtected(entry.duplicate_table);
        if (protectedIds.has(entry.duplicate_id)) {
          result.fkProtected++;
        } else {
          status = 'deleted';
          const list = toDelete.get(entry.duplicate_table);
          if (list) list.push(entry.duplicate_id);
          else toDelete.set(entry.duplicate_table, [entry.duplicate_id]);
        }
      }
      insert.run(
        entry.survivor_table,
        entry.survivor_id,
        entry.duplicate_table,
        entry.duplicate_id,
        entry.reason,
        entry.similarity,
        status,
        entry.detail
      );
      if (status === 'marked') result.marked++;
      else result.deleted++;
    }

    // Input-scaled IN lists — chunked() per the src/lib/chunk.ts audit note.
    for (const [table, ids] of toDelete) {
      for (const chunk of chunked(ids)) {
        const placeholders = chunk.map(() => '?').join(', ');
        db.prepare(`DELETE FROM ${table} WHERE id IN (${placeholders})`).run(...chunk);
        db.prepare(
          `DELETE FROM embeddings WHERE source_table = ? AND source_id IN (${placeholders})`
        ).run(table, ...chunk);
      }
    }
  });
  apply();

  return result;
}
