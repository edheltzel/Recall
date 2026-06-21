// Type-aware aging policy (issue #139, Phase A of #53; subsumes #38).
//
// Pure planner + applier, mirroring planDedup/applyDedupPlan. `recall age`
// retires or demotes records per a per-type durability map, reusing the
// existing dedup/FK/importance guards — never inventing a new mechanism:
//
//   messages     → delete         (absorbs #38's message prune)
//   breadcrumbs  → expire          (set expires_at via the existing TTL)
//   decisions    → demote          (lower importance to a floor)
//   learnings    → demote
//   loa_entries  → demote          (floor 5 — the curated tier never drops below)
//
// Every type is guarded so aging never deletes/hides a recorded dedup survivor
// or a marked-duplicate, never orphans an FK-referenced row, never touches a
// pin (importance 10), and only ever changes importance via clampImportance.

import { Database } from 'bun:sqlite';
import type { ProvenanceTable } from '../types/index.js';
import { notRecordedSurvivorSql, notMarkedDuplicateSql, fkProtectedIds } from './dedup.js';
import { clampImportance } from './memory.js';
import { chunked } from './chunk.js';

/** Tables the aging policy operates on, in display order. */
export const AGE_TABLES: readonly ProvenanceTable[] = [
  'messages',
  'breadcrumbs',
  'decisions',
  'learnings',
  'loa_entries',
];

export type AgeAction = 'delete' | 'expire' | 'demote';

/** Pin convention (memory.ts:107): importance 10 is a pin — never aged. */
export const PIN_IMPORTANCE = 10;

// Defaults (design doc, Ed 2026-06-20). With these, pins (10) and LoA (8) are
// always safe: the threshold is strictly below the default importance, and the
// LoA demote floor equals the threshold so curated entries are never eligible.
export const DEFAULT_AGE_CUTOFF_DAYS = 180;
export const DEFAULT_BREADCRUMB_HORIZON_DAYS = 14;
export const DEFAULT_IMPORTANCE_THRESHOLD = 5;

interface AgeTableConfig {
  action: AgeAction;
  /** Age column — messages track `timestamp`, everything else `created_at`. */
  ageColumn: string;
  /** Demote target / floor (action='demote' only). */
  importanceFloor?: number;
  /** Messages alone are FK-referenced by loa_entries ranges. */
  fkProtect?: boolean;
}

// Per-type durability map (mirrors the TABLE_SCAN_CONFIG precedent, dedup.ts:292).
const AGE_CONFIG: Record<ProvenanceTable, AgeTableConfig> = {
  messages: { action: 'delete', ageColumn: 'timestamp', fkProtect: true },
  breadcrumbs: { action: 'expire', ageColumn: 'created_at' },
  decisions: { action: 'demote', ageColumn: 'created_at', importanceFloor: 1 },
  learnings: { action: 'demote', ageColumn: 'created_at', importanceFloor: 1 },
  loa_entries: { action: 'demote', ageColumn: 'created_at', importanceFloor: 5 },
};

export interface AgeCandidate {
  id: number;
  importance: number;
  /** Demote target (action='demote'); null for delete/expire. */
  newImportance: number | null;
}

export interface AgeTableReport {
  table: ProvenanceTable;
  action: AgeAction;
  /** Rows the apply step will act on. */
  eligible: AgeCandidate[];
  /** Rows matching the age/threshold cutoff but withheld by a guard
   *  (recorded survivor, marked duplicate, FK reference, or pin). */
  protected: number;
}

export interface AgePlan {
  tables: AgeTableReport[];
  ageCutoffDays: number;
  breadcrumbHorizonDays: number;
  importanceThreshold: number;
}

export interface PlanAgeOptions {
  tables?: ProvenanceTable[];
  ageCutoffDays?: number;
  breadcrumbHorizonDays?: number;
  importanceThreshold?: number;
}

/** Shared guard: never act on a recorded dedup survivor or a marked duplicate
 *  (ADR-0003). `tableExpr`/`idExpr` are SQL expressions, never user input. */
function guardSql(table: ProvenanceTable): string {
  const tableExpr = `'${table}'`;
  const idExpr = `${table}.id`;
  return `${notRecordedSurvivorSql(tableExpr, idExpr)} AND ${notMarkedDuplicateSql(tableExpr, idExpr)}`;
}

/** The WHERE body (without the leading `WHERE`) selecting age-eligible rows for
 *  one table, before the dedup guards are appended. */
function matchWhere(
  config: AgeTableConfig,
  ageCutoffDays: number,
  breadcrumbHorizonDays: number,
  importanceThreshold: number
): string {
  const unpinned = `importance < ${PIN_IMPORTANCE}`;
  if (config.action === 'expire') {
    const cutoff = `datetime('now', '-${breadcrumbHorizonDays} days')`;
    // Only crumbs not already expiring — keeps the plan idempotent.
    return `${config.ageColumn} < ${cutoff} AND ${unpinned} ` +
      `AND (expires_at IS NULL OR expires_at > datetime('now'))`;
  }
  const cutoff = `datetime('now', '-${ageCutoffDays} days')`;
  if (config.action === 'demote') {
    // importance > floor: a row already at the floor is left alone (idempotent).
    return `${config.ageColumn} < ${cutoff} ` +
      `AND importance < ${importanceThreshold} AND importance > ${config.importanceFloor}`;
  }
  // delete (messages): absorbs #38 — only messages whose session is already
  // consolidated into an LoA entry are prunable (the content survives in the
  // summary), and never a pin. Mirrors prune.ts's message criterion.
  return `${config.ageColumn} < ${cutoff} AND ${unpinned} ` +
    `AND session_id IN (SELECT session_id FROM loa_entries WHERE session_id IS NOT NULL)`;
}

function planTable(
  db: Database,
  table: ProvenanceTable,
  options: PlanAgeOptions
): AgeTableReport {
  const config = AGE_CONFIG[table];
  const ageCutoffDays = options.ageCutoffDays ?? DEFAULT_AGE_CUTOFF_DAYS;
  const horizon = options.breadcrumbHorizonDays ?? DEFAULT_BREADCRUMB_HORIZON_DAYS;
  const threshold = options.importanceThreshold ?? DEFAULT_IMPORTANCE_THRESHOLD;

  const where = matchWhere(config, ageCutoffDays, horizon, threshold);
  const matched = (db.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`
  ).get() as { count: number }).count;

  const rows = db.prepare(
    `SELECT id, importance FROM ${table} WHERE ${where} AND ${guardSql(table)} ORDER BY id`
  ).all() as Array<{ id: number; importance: number }>;

  // FK protection: a message referenced by a loa_entries range cannot be
  // hard-deleted under foreign_keys=ON. Withhold it (reuse the dedup precedent).
  const fkIds = config.fkProtect ? fkProtectedIds(db, table) : new Set<number>();

  const eligible: AgeCandidate[] = [];
  for (const row of rows) {
    if (fkIds.has(row.id)) continue;
    const newImportance = config.action === 'demote'
      ? clampImportance(config.importanceFloor, row.importance)
      : null;
    eligible.push({ id: row.id, importance: row.importance, newImportance });
  }

  return {
    table,
    action: config.action,
    eligible,
    protected: matched - eligible.length,
  };
}

/**
 * Compute the full aging plan without writing anything. The same plan is what
 * a dry run reports and what an execute run applies.
 */
export function planAge(db: Database, options: PlanAgeOptions = {}): AgePlan {
  const tables = options.tables ?? [...AGE_TABLES];
  return {
    tables: tables.map(t => planTable(db, t, options)),
    ageCutoffDays: options.ageCutoffDays ?? DEFAULT_AGE_CUTOFF_DAYS,
    breadcrumbHorizonDays: options.breadcrumbHorizonDays ?? DEFAULT_BREADCRUMB_HORIZON_DAYS,
    importanceThreshold: options.importanceThreshold ?? DEFAULT_IMPORTANCE_THRESHOLD,
  };
}

export interface AgeApplyResult {
  deleted: number;
  expired: number;
  demoted: number;
}

/**
 * Apply a plan in one transaction; failures roll back everything. Deletes
 * messages (and their embeddings), expires breadcrumbs via expires_at, and
 * demotes durable records' importance to their floor. Importance only ever
 * changes through the clamped value computed in planAge.
 */
export function applyAgePlan(db: Database, plan: AgePlan): AgeApplyResult {
  const result: AgeApplyResult = { deleted: 0, expired: 0, demoted: 0 };

  const apply = db.transaction(() => {
    for (const report of plan.tables) {
      const ids = report.eligible.map(c => c.id);
      if (ids.length === 0) continue;

      if (report.action === 'delete') {
        for (const chunk of chunked(ids)) {
          const placeholders = chunk.map(() => '?').join(', ');
          db.prepare(`DELETE FROM ${report.table} WHERE id IN (${placeholders})`).run(...chunk);
          db.prepare(
            `DELETE FROM embeddings WHERE source_table = ? AND source_id IN (${placeholders})`
          ).run(report.table, ...chunk);
        }
        result.deleted += ids.length;
      } else if (report.action === 'expire') {
        for (const chunk of chunked(ids)) {
          const placeholders = chunk.map(() => '?').join(', ');
          db.prepare(
            `UPDATE ${report.table} SET expires_at = datetime('now') WHERE id IN (${placeholders})`
          ).run(...chunk);
        }
        result.expired += ids.length;
      } else {
        // demote — newImportance is the per-type clampImportance floor computed
        // in planAge; it is a constant across every eligible row in a table, so
        // one bound value drives every chunked UPDATE.
        const floor = report.eligible[0].newImportance!;
        for (const chunk of chunked(ids)) {
          const placeholders = chunk.map(() => '?').join(', ');
          db.prepare(
            `UPDATE ${report.table} SET importance = ? WHERE id IN (${placeholders})`
          ).run(floor, ...chunk);
        }
        result.demoted += ids.length;
      }
    }
  });
  apply();

  return result;
}
