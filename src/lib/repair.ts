// recall repair — core logic (issue #46).
//
// Explicit data/index maintenance, separate from `recall doctor --fix`
// (doctor --fix only repairs install-layout symlinks and never runs data
// repair; doctor may *recommend* repair).
//
// Safety model:
// - Dry-run by default; mutations require an explicit execute step.
// - Repair never changes Record Provenance — no repair statement writes a
//   source-table column. FTS rebuild regenerates index shadow tables from
//   the source rows; re-embed only inserts into the embeddings table.
// - Repair never hard-deletes rows. Orphan/invariant findings are
//   report-only — every check is named in code and covered by tests.
// - Initial repair scope is limited to unambiguous maintenance: FTS5
//   rebuild (including recreating a missing index from the canonical
//   schema DDL) and re-embedding rows missing embeddings. No heuristic
//   data mutation.
//
// Bind-count note (see src/lib/chunk.ts): all SQL here binds a fixed number
// of parameters — aggregate counts, EXISTS anti-joins with constant table
// names, and keyset pagination (`WHERE id > ? LIMIT ?`) for the embed
// candidate walk. Nothing scales with input size.

import { Database } from 'bun:sqlite';
import { SQLITE_SAFE_CHUNK_SIZE } from './chunk.js';
import { FTS_SCHEMA } from '../db/schema.js';
import { MIGRATIONS, getMigrationVersion } from '../db/migrations.js';
import { notMarkedDuplicateSql } from './dedup.js';
import { embeddingToBlob, type EmbeddingResult } from './embeddings.js';
import { PROVENANCE_TABLES } from '../types/index.js';

/** Source tables carrying an FTS5 index — derived from the schema map. */
export const FTS_SOURCES = Object.keys(FTS_SCHEMA);

/**
 * Minimum trimmed text length a row needs to be embedded. Matches the
 * eligibility rule `recall embed backfill` has always applied.
 */
export const MIN_EMBED_TEXT_LENGTH = 10;

// ---------------------------------------------------------------------------
// Embedding sources — which rows are expected to carry embeddings, and what
// text gets embedded. Single source of truth shared with `recall embed`.
// ---------------------------------------------------------------------------

export interface EmbedSourceConfig {
  table: 'messages' | 'decisions' | 'learnings' | 'loa_entries';
  /** Columns selected to build the embedding text. */
  columns: string[];
  /** Restricts which rows are expected to be embedded (constant SQL). */
  extraWhere?: string;
  text: (row: Record<string, unknown>) => string;
}

export const EMBED_SOURCES: EmbedSourceConfig[] = [
  {
    table: 'loa_entries',
    columns: ['title', 'fabric_extract'],
    text: r => `${r.title}\n\n${r.fabric_extract}`,
  },
  {
    table: 'decisions',
    columns: ['decision', 'reasoning'],
    text: r => `${r.decision}\n\nReasoning: ${r.reasoning || 'N/A'}`,
  },
  {
    table: 'learnings',
    columns: ['problem', 'solution'],
    text: r => `${r.problem}\n\nSolution: ${r.solution || 'N/A'}`,
  },
  {
    table: 'messages',
    columns: ['content'],
    extraWhere: "t.role = 'assistant'",
    text: r => String(r.content ?? ''),
  },
];

/**
 * Canonical embedding text for a source table row. Unknown tables fall back
 * to a generic content/text lookup (legacy `recall embed` behavior).
 */
export function embeddingTextFor(table: string, row: Record<string, unknown>): string {
  const source = EMBED_SOURCES.find(s => s.table === table);
  if (source) return source.text(row);
  return String((row.content as string) || (row.text as string) || '');
}

// ---------------------------------------------------------------------------
// FTS5 index health
// ---------------------------------------------------------------------------

export type FtsStatus = 'ok' | 'drift' | 'missing-fts' | 'missing-source';
export type FtsAction = 'none' | 'rebuild' | 'create-and-rebuild' | 'report-only';

export interface FtsReport {
  source: string;
  ftsTable: string;
  sourceRows: number | null;
  indexedRows: number | null;
  status: FtsStatus;
  action: FtsAction;
  detail: string;
}

function tableExists(db: Database, name: string): boolean {
  // FTS5 virtual tables are recorded in sqlite_master with type 'table'.
  return !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(name);
}

/**
 * FTS sync trigger names derive from the FTS table name: messages_fts →
 * messages_ai / messages_ad / messages_au (matches the schema DDL).
 */
function missingFtsTriggers(db: Database, ftsTable: string): string[] {
  const prefix = ftsTable.replace(/_fts$/, '');
  const stmt = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?");
  return ['ai', 'ad', 'au']
    .map(suffix => `${prefix}_${suffix}`)
    .filter(name => !stmt.get(name));
}

function countRows(db: Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

/**
 * Rows actually present in an FTS5 index. `SELECT COUNT(*)` on an
 * external-content FTS table reads through to the content table, so the
 * docsize shadow table (one row per indexed document) is the truthful
 * count. Returns null when it cannot be read.
 */
function countIndexedRows(db: Database, ftsTable: string): number | null {
  try {
    return (db.prepare(`SELECT COUNT(*) AS c FROM ${ftsTable}_docsize`).get() as { c: number }).c;
  } catch {
    return null;
  }
}

/**
 * FTS5 external-content integrity check. The `rank` form (SQLite >= 3.42)
 * validates the index against its content table and raises SQLITE_CORRUPT
 * on mismatch. Any non-corruption error (e.g. the command form is
 * unsupported on an older SQLite) is treated as "no evidence of drift" so
 * the row-count comparison stands alone.
 */
function ftsIndexConsistent(db: Database, ftsTable: string): boolean {
  try {
    db.prepare(`INSERT INTO ${ftsTable}(${ftsTable}, rank) VALUES('integrity-check', 1)`).run();
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A locked DB is a normal transient state given Recall's concurrent
    // writers — NOT evidence the index is in sync. Reporting "consistent"
    // here masks a check that never actually ran. Flag it as drift so the
    // check is surfaced for retry rather than silently passing. (#71)
    if (/database( table)? is locked/i.test(msg)) return false;
    return !/malformed|corrupt/i.test(msg);
  }
}

export function checkFts(db: Database, source: string): FtsReport {
  const schema = FTS_SCHEMA[source];
  if (!schema) {
    throw new Error(`Unknown FTS source table: ${source}`);
  }
  const ftsTable = schema.ftsTable;

  if (!tableExists(db, source)) {
    return {
      source, ftsTable, sourceRows: null, indexedRows: null,
      status: 'missing-source', action: 'report-only',
      detail: `source table ${source} is missing — run 'recall init' to recreate the schema`,
    };
  }
  const sourceRows = countRows(db, source);

  if (!tableExists(db, ftsTable)) {
    return {
      source, ftsTable, sourceRows, indexedRows: null,
      status: 'missing-fts', action: 'create-and-rebuild',
      detail: `FTS index ${ftsTable} is missing — searches over ${source} fail or return nothing`,
    };
  }

  const indexedRows = countIndexedRows(db, ftsTable);

  const lostTriggers = missingFtsTriggers(db, ftsTable);
  if (lostTriggers.length > 0) {
    return {
      source, ftsTable, sourceRows, indexedRows,
      status: 'drift', action: 'rebuild',
      detail: `sync trigger(s) missing (${lostTriggers.join(', ')}) — writes to ${source} are not being indexed`,
    };
  }
  if (indexedRows !== null && indexedRows !== sourceRows) {
    return {
      source, ftsTable, sourceRows, indexedRows,
      status: 'drift', action: 'rebuild',
      detail: `index has ${indexedRows} row(s), source has ${sourceRows}`,
    };
  }
  if (!ftsIndexConsistent(db, ftsTable)) {
    return {
      source, ftsTable, sourceRows, indexedRows,
      status: 'drift', action: 'rebuild',
      detail: 'integrity-check failed (index content out of sync with source)',
    };
  }
  return { source, ftsTable, sourceRows, indexedRows, status: 'ok', action: 'none', detail: 'in sync' };
}

/** FTS health for every indexed table — shared by repair and doctor. */
export function checkAllFts(db: Database): FtsReport[] {
  return FTS_SOURCES.map(s => checkFts(db, s));
}

// ---------------------------------------------------------------------------
// Embedding gaps
// ---------------------------------------------------------------------------

export interface EmbedGapReport {
  table: string;
  /** Rows expected to carry an embedding that have none. */
  missing: number;
  /** Subset of `missing` whose source text is too short to embed. */
  tooShort: number;
}

function embedGapQuery(config: EmbedSourceConfig, excludeMarkedDuplicates: boolean): string {
  const where = [
    't.id > ?',
    ...(config.extraWhere ? [config.extraWhere] : []),
    'e.id IS NULL',
    // Marked duplicates are hidden from every search path; embedding them
    // would index records search can never return. On a pre-dedup legacy DB
    // (no dedup_lineage table yet — its DDL ships via recall init) nothing
    // can be marked, so the clause is dropped instead of referencing a
    // missing table and crashing the plan.
    ...(excludeMarkedDuplicates ? [notMarkedDuplicateSql(`'${config.table}'`, 't.id')] : []),
  ].join(' AND ');
  return `
    SELECT t.id, ${config.columns.map(c => `t.${c}`).join(', ')}
    FROM ${config.table} t
    LEFT JOIN embeddings e ON e.source_table = '${config.table}' AND e.source_id = t.id
    WHERE ${where}
    ORDER BY t.id
    LIMIT ?
  `;
}

/** Keyset-paginated walk over rows missing embeddings (fixed binds). */
function* iterateEmbedGapRows(
  db: Database,
  config: EmbedSourceConfig,
  batchSize: number = SQLITE_SAFE_CHUNK_SIZE
): Generator<Record<string, unknown>> {
  const stmt = db.prepare(embedGapQuery(config, tableExists(db, 'dedup_lineage')));
  let lastId = 0;
  for (;;) {
    const batch = stmt.all(lastId, batchSize) as Array<Record<string, unknown>>;
    if (batch.length === 0) return;
    for (const row of batch) yield row;
    lastId = batch[batch.length - 1].id as number;
  }
}

/**
 * "Enough source text to embed" is measured on the raw column values, not
 * the composed embedding text — boilerplate like "Reasoning: N/A" must not
 * make an empty record look embeddable.
 */
function sourceTextLength(config: EmbedSourceConfig, row: Record<string, unknown>): number {
  return config.columns
    .map(c => row[c])
    .filter(v => v !== null && v !== undefined && String(v).length > 0)
    .join('\n')
    .trim()
    .length;
}

export function countEmbedGaps(db: Database, config: EmbedSourceConfig): EmbedGapReport {
  let missing = 0;
  let tooShort = 0;
  for (const row of iterateEmbedGapRows(db, config)) {
    missing++;
    if (sourceTextLength(config, row) < MIN_EMBED_TEXT_LENGTH) tooShort++;
  }
  return { table: config.table, missing, tooShort };
}

// ---------------------------------------------------------------------------
// Orphan / invariant checks — report-only, never repaired automatically
// ---------------------------------------------------------------------------

export interface OrphanReport {
  /** Stable check id — named in code and tests. */
  check: string;
  description: string;
  count: number;
  /** Up to 5 sample references for triage. */
  sample: string[];
  /** Set when the check itself could not run (e.g. table missing). */
  error?: string;
}

const SAMPLE_LIMIT = 5;

interface OrphanCheckDef {
  check: string;
  description: string;
  countSql: string;
  sampleSql: string;
  sampleLabel: (row: Record<string, unknown>) => string;
}

function orphanCheckDefs(): OrphanCheckDef[] {
  const defs: OrphanCheckDef[] = [];

  // Embeddings whose source row no longer exists.
  for (const table of FTS_SOURCES) {
    const where = `e.source_table = '${table}'
      AND NOT EXISTS (SELECT 1 FROM ${table} t WHERE t.id = e.source_id)`;
    defs.push({
      check: `orphaned-embeddings:${table}`,
      description: `embeddings rows pointing at deleted ${table} rows`,
      countSql: `SELECT COUNT(*) AS c FROM embeddings e WHERE ${where}`,
      sampleSql: `SELECT e.source_id AS id FROM embeddings e WHERE ${where} ORDER BY e.source_id LIMIT ${SAMPLE_LIMIT}`,
      sampleLabel: r => `${table}#${r.id}`,
    });
  }

  // Embeddings with a source_table value no known table resolves.
  const knownList = FTS_SOURCES.map(t => `'${t}'`).join(', ');
  defs.push({
    check: 'unknown-embedding-source',
    description: 'embeddings rows with an unrecognized source_table',
    countSql: `SELECT COUNT(*) AS c FROM embeddings WHERE source_table NOT IN (${knownList})`,
    sampleSql: `SELECT source_table, source_id FROM embeddings WHERE source_table NOT IN (${knownList}) ORDER BY id LIMIT ${SAMPLE_LIMIT}`,
    sampleLabel: r => `${r.source_table}#${r.source_id}`,
  });

  // Actively marked dedup lineage whose duplicate or survivor row is gone.
  // 'marked' means hidden-but-intact, so both sides must still exist.
  for (const side of ['duplicate', 'survivor'] as const) {
    for (const table of PROVENANCE_TABLES) {
      const where = `dl.status = 'marked' AND dl.${side}_table = '${table}'
        AND NOT EXISTS (SELECT 1 FROM ${table} t WHERE t.id = dl.${side}_id)`;
      defs.push({
        check: `lineage-missing-${side}:${table}`,
        description: `dedup_lineage 'marked' rows whose ${side} ${table} row no longer exists`,
        countSql: `SELECT COUNT(*) AS c FROM dedup_lineage dl WHERE ${where}`,
        sampleSql: `SELECT dl.id FROM dedup_lineage dl WHERE ${where} ORDER BY dl.id LIMIT ${SAMPLE_LIMIT}`,
        sampleLabel: r => `dedup_lineage#${r.id}`,
      });
    }
  }

  // Messages referencing a session that does not exist.
  defs.push({
    check: 'messages-without-session',
    description: 'messages whose session_id has no sessions row',
    countSql: `SELECT COUNT(*) AS c FROM messages m
      WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.session_id = m.session_id)`,
    sampleSql: `SELECT m.id FROM messages m
      WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.session_id = m.session_id)
      ORDER BY m.id LIMIT ${SAMPLE_LIMIT}`,
    sampleLabel: r => `messages#${r.id}`,
  });

  // LoA entries whose message range points at deleted messages.
  const loaRangeWhere = `(l.message_range_start IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = l.message_range_start))
     OR (l.message_range_end IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = l.message_range_end))`;
  defs.push({
    check: 'loa-broken-message-range',
    description: 'loa_entries whose message_range_start/end points at a missing message',
    countSql: `SELECT COUNT(*) AS c FROM loa_entries l WHERE ${loaRangeWhere}`,
    sampleSql: `SELECT l.id FROM loa_entries l WHERE ${loaRangeWhere} ORDER BY l.id LIMIT ${SAMPLE_LIMIT}`,
    sampleLabel: r => `loa_entries#${r.id}`,
  });

  // LoA entries whose parent link is broken.
  const loaParentWhere = `l.parent_loa_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM loa_entries p WHERE p.id = l.parent_loa_id)`;
  defs.push({
    check: 'loa-broken-parent',
    description: 'loa_entries whose parent_loa_id points at a missing entry',
    countSql: `SELECT COUNT(*) AS c FROM loa_entries l WHERE ${loaParentWhere}`,
    sampleSql: `SELECT l.id FROM loa_entries l WHERE ${loaParentWhere} ORDER BY l.id LIMIT ${SAMPLE_LIMIT}`,
    sampleLabel: r => `loa_entries#${r.id}`,
  });

  return defs;
}

export function checkOrphans(db: Database): OrphanReport[] {
  const reports: OrphanReport[] = [];
  for (const def of orphanCheckDefs()) {
    try {
      const count = (db.prepare(def.countSql).get() as { c: number }).c;
      if (count === 0) continue;
      const rows = db.prepare(def.sampleSql).all() as Array<Record<string, unknown>>;
      reports.push({
        check: def.check,
        description: def.description,
        count,
        sample: rows.map(def.sampleLabel),
      });
    } catch (err) {
      reports.push({
        check: def.check,
        description: def.description,
        count: 0,
        sample: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return reports;
}

// ---------------------------------------------------------------------------
// Schema/migration state — report-only
// ---------------------------------------------------------------------------

export interface MigrationReport {
  current: number;
  target: number;
  pending: number;
}

export function checkMigrations(db: Database): MigrationReport {
  const current = getMigrationVersion(db);
  const target = MIGRATIONS.length;
  return { current, target, pending: Math.max(0, target - current) };
}

// ---------------------------------------------------------------------------
// Plan and apply
// ---------------------------------------------------------------------------

export interface RepairPlan {
  fts: FtsReport[];
  embedGaps: EmbedGapReport[];
  orphans: OrphanReport[];
  migrations: MigrationReport;
}

export interface PlanRepairOptions {
  /** Restrict the FTS and embedding passes to one source table. */
  table?: string;
  /** Set false to skip the embedding pass entirely (--no-embed). */
  embed?: boolean;
}

export function planRepair(db: Database, options: PlanRepairOptions = {}): RepairPlan {
  const ftsSources = options.table ? [options.table] : FTS_SOURCES;
  const fts = ftsSources.map(s => checkFts(db, s));

  const missingSources = new Set(fts.filter(f => f.status === 'missing-source').map(f => f.source));
  const embedConfigs = (options.embed ?? true)
    ? EMBED_SOURCES.filter(c =>
        (!options.table || c.table === options.table) &&
        !missingSources.has(c.table) &&
        tableExists(db, c.table) &&
        tableExists(db, 'embeddings'))
    : [];
  const embedGaps = embedConfigs.map(c => countEmbedGaps(db, c));

  return {
    fts,
    embedGaps,
    orphans: checkOrphans(db),
    migrations: checkMigrations(db),
  };
}

export interface FtsRepairResult {
  /** FTS tables recreated from the canonical schema DDL before rebuilding. */
  created: string[];
  rebuilt: string[];
  failed: Array<{ ftsTable: string; error: string }>;
}

/**
 * Apply the planned FTS repairs: recreate missing indexes from the canonical
 * per-table DDL (idempotent IF NOT EXISTS), then rebuild each planned index
 * from its source table via the FTS5 'rebuild' command.
 */
export function applyFtsRepair(db: Database, plan: RepairPlan): FtsRepairResult {
  const result: FtsRepairResult = { created: [], rebuilt: [], failed: [] };
  for (const report of plan.fts) {
    if (report.action !== 'rebuild' && report.action !== 'create-and-rebuild') continue;
    const schema = FTS_SCHEMA[report.source];
    try {
      // The canonical DDL is idempotent (IF NOT EXISTS): recreating covers a
      // missing virtual table and any missing sync triggers in one pass.
      db.exec(schema.createTable);
      db.exec(schema.createTriggers);
      if (report.action === 'create-and-rebuild') {
        result.created.push(report.ftsTable);
      }
      db.prepare(`INSERT INTO ${report.ftsTable}(${report.ftsTable}) VALUES('rebuild')`).run();
      result.rebuilt.push(report.ftsTable);
    } catch (err) {
      result.failed.push({
        ftsTable: report.ftsTable,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

export interface EmbedRepairResult {
  embedded: number;
  /** Rows skipped because their source text is too short to embed. */
  skippedTooShort: number;
  /** Per-row embedding failures — reported, never hidden. */
  failed: Array<{ table: string; id: number; error: string }>;
}

export type EmbedFn = (text: string) => Promise<EmbeddingResult>;

/**
 * Re-embed rows missing embeddings. `embedFn` is injected so the command can
 * wire the real Ollama client while tests run deterministically offline.
 * Failed rows stay missing and are retried on the next run.
 */
export async function applyEmbedRepair(
  db: Database,
  plan: RepairPlan,
  embedFn: EmbedFn,
  onProgress?: (table: string, done: number, total: number) => void
): Promise<EmbedRepairResult> {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO embeddings (source_table, source_id, model, dimensions, embedding)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result: EmbedRepairResult = { embedded: 0, skippedTooShort: 0, failed: [] };

  for (const gap of plan.embedGaps) {
    if (gap.missing === 0) continue;
    const config = EMBED_SOURCES.find(c => c.table === gap.table);
    if (!config) continue;
    let done = 0;
    for (const row of iterateEmbedGapRows(db, config)) {
      done++;
      if (sourceTextLength(config, row) < MIN_EMBED_TEXT_LENGTH) {
        result.skippedTooShort++;
        continue;
      }
      try {
        const res = await embedFn(config.text(row).trim());
        insert.run(config.table, row.id as number, res.model, res.dimensions, embeddingToBlob(res.embedding));
        result.embedded++;
      } catch (err) {
        result.failed.push({
          table: config.table,
          id: row.id as number,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      onProgress?.(gap.table, done, gap.missing);
    }
  }
  return result;
}
