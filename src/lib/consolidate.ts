// recall consolidate — deterministic clustering planner (issue #141, Phase B of #53).
//
// PURE, src-side half of the consolidate command. Computes WHICH old, low-value
// source records cluster together — no model call, no writes, no subprocess. This
// is exactly what a dry run renders AND what the --execute path hands to the
// hook-side engine (hooks/lib/consolidate-core.ts) for summarization.
//
// Locked design (Ed, 2026-06-21):
//  - Deterministic bucket clustering: per project, old + importance<threshold +
//    un-pinned, grouped by type + time window. No embeddings / semantic similarity.
//  - Eligible source tables for v1: decisions + learnings ONLY. These are the
//    importance-DEMOTE-aged types (AGE_CONFIG, aging.ts), so demoting their
//    importance is what lets `recall age` retire them over time (locked decision
//    #1: demote-not-delete, composes with Phase A). Messages (deleted by
//    session-in-LoA, not importance) and breadcrumbs (TTL-expired) don't compose
//    with demotion and are out of scope for v1; loa_entries is the curated target.
//  - Reuses the dedup/importance guards exactly (notRecordedSurvivorSql,
//    notMarkedDuplicateSql, clampImportance) — pins (importance 10) and recorded
//    survivors / marked duplicates are never eligible (ADR-0003).

import type { Database } from 'bun:sqlite';
import { notRecordedSurvivorSql, notMarkedDuplicateSql } from './dedup.js';
import { clampImportance } from './memory.js';
import {
  PIN_IMPORTANCE,
  DEFAULT_AGE_CUTOFF_DAYS,
  DEFAULT_IMPORTANCE_THRESHOLD,
} from './aging.js';

/** Source record types eligible for consolidation in v1. */
export type ConsolidateTable = 'decisions' | 'learnings';
export const CONSOLIDATE_TABLES: readonly ConsolidateTable[] = ['decisions', 'learnings'];

/** Demote floor — mirrors AGE_CONFIG's decisions/learnings floor (aging.ts). */
export const DEMOTE_FLOOR = 1;

/** Default width of a time-window bucket, in days. */
export const DEFAULT_WINDOW_DAYS = 30;

/** A cluster must hold at least this many records to be worth a summary. */
export const DEFAULT_MIN_CLUSTER_SIZE = 3;

/** The text column carrying each table's primary content. */
const TEXT_COLUMN: Record<ConsolidateTable, string> = {
  decisions: 'decision',
  learnings: 'problem',
};

export interface ConsolidateSourceRecord {
  id: number;
  importance: number;
  created_at: string;
  /** Primary content (decision / problem) — fed to the summarization prompt. */
  text: string;
  /** Demote target = clampImportance(DEMOTE_FLOOR, importance). */
  newImportance: number;
}

export interface ConsolidateCluster {
  table: ConsolidateTable;
  project: string | null;
  /** Bucket-start date 'YYYY-MM-DD' — the deterministic time-window label. */
  window: string;
  records: ConsolidateSourceRecord[];
  /** Id of the richest record (shown in dry-run as the cluster's representative). */
  representativeId: number;
}

export interface ConsolidatePlan {
  clusters: ConsolidateCluster[];
  ageCutoffDays: number;
  importanceThreshold: number;
  windowDays: number;
  minClusterSize: number;
  /** Records past the age/threshold/pin filter but withheld by a dedup guard. */
  protectedCount: number;
}

export interface PlanConsolidateOptions {
  tables?: ConsolidateTable[];
  project?: string;
  ageCutoffDays?: number;
  importanceThreshold?: number;
  windowDays?: number;
  minClusterSize?: number;
}

interface EligibleRow {
  id: number;
  importance: number;
  created_at: string;
  text: string;
  project: string | null;
}

/** Shared guard: never act on a recorded dedup survivor or a marked duplicate
 *  (ADR-0003). The table name is a code literal, never user input. */
function guardSql(table: ConsolidateTable): string {
  const tableExpr = `'${table}'`;
  const idExpr = `${table}.id`;
  return `${notRecordedSurvivorSql(tableExpr, idExpr)} AND ${notMarkedDuplicateSql(tableExpr, idExpr)}`;
}

/**
 * Parse a SQLite 'YYYY-MM-DD HH:MM:SS' (UTC) timestamp to epoch ms. Mirrors the
 * `.replace(' ', 'T') + 'Z'` idiom used elsewhere (tests/commands/age.test.ts).
 */
function parseUtcMs(created_at: string): number {
  return Date.parse(created_at.replace(' ', 'T') + 'Z');
}

/** Deterministic window bucket: floor(epochDays / windowDays), labelled by its
 *  UTC start date. Both keys derive purely from created_at — no wall clock. */
function windowOf(created_at: string, windowDays: number): { key: number; label: string } {
  const ms = parseUtcMs(created_at);
  const widthMs = windowDays * 86400000;
  const key = Number.isFinite(ms) ? Math.floor(ms / widthMs) : 0;
  const label = new Date(key * widthMs).toISOString().slice(0, 10);
  return { key, label };
}

/** Richness comparator (survivor-style, dedup.ts): longest text, then highest
 *  importance, then newest, then lowest id — total and deterministic. */
function richerFirst(a: ConsolidateSourceRecord, b: ConsolidateSourceRecord): number {
  if (a.text.length !== b.text.length) return b.text.length - a.text.length;
  if (a.importance !== b.importance) return b.importance - a.importance;
  if (a.created_at !== b.created_at) return a.created_at > b.created_at ? -1 : 1;
  return a.id - b.id;
}

function planTable(
  db: Database,
  table: ConsolidateTable,
  ageCutoffDays: number,
  importanceThreshold: number,
  windowDays: number,
  minClusterSize: number,
  project: string | undefined,
): { clusters: ConsolidateCluster[]; protectedCount: number } {
  const textCol = TEXT_COLUMN[table];
  const cutoff = `datetime('now', '-${ageCutoffDays} days')`;
  // Old + below threshold + un-pinned. Pins (importance 10) are excluded by the
  // `< PIN_IMPORTANCE` clause; the threshold clause is the low-value filter.
  const where =
    `created_at < ${cutoff} AND importance < ${importanceThreshold} AND importance < ${PIN_IMPORTANCE}` +
    (project ? ` AND project = '${project.replace(/'/g, "''")}'` : '');

  const matched = (db.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`
  ).get() as { count: number }).count;

  const rows = db.prepare(
    `SELECT id, importance, created_at, ${textCol} AS text, project
       FROM ${table}
      WHERE ${where} AND ${guardSql(table)}
      ORDER BY id`
  ).all() as EligibleRow[];

  // Bucket by (project, time window). Insertion order of buckets is driven by
  // the id-ordered scan, so the resulting cluster list is deterministic.
  const buckets = new Map<string, { project: string | null; window: string; records: ConsolidateSourceRecord[] }>();
  for (const row of rows) {
    const { key, label } = windowOf(row.created_at, windowDays);
    const bucketKey = `${row.project ?? ''}\x00${key}`;
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = { project: row.project, window: label, records: [] };
      buckets.set(bucketKey, bucket);
    }
    bucket.records.push({
      id: row.id,
      importance: row.importance,
      created_at: row.created_at,
      text: row.text,
      newImportance: clampImportance(DEMOTE_FLOOR, row.importance),
    });
  }

  const clusters: ConsolidateCluster[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.records.length < minClusterSize) continue;
    const representativeId = [...bucket.records].sort(richerFirst)[0].id;
    clusters.push({
      table,
      project: bucket.project,
      window: bucket.window,
      records: bucket.records,
      representativeId,
    });
  }

  return { clusters, protectedCount: matched - rows.length };
}

/**
 * Compute the full consolidation plan without writing anything or calling a
 * model. The same plan is what a dry run reports and what an --execute run hands
 * to the hook-side engine.
 */
export function planConsolidate(db: Database, options: PlanConsolidateOptions = {}): ConsolidatePlan {
  const tables = options.tables ?? [...CONSOLIDATE_TABLES];
  const ageCutoffDays = options.ageCutoffDays ?? DEFAULT_AGE_CUTOFF_DAYS;
  const importanceThreshold = options.importanceThreshold ?? DEFAULT_IMPORTANCE_THRESHOLD;
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const minClusterSize = options.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE;

  const clusters: ConsolidateCluster[] = [];
  let protectedCount = 0;
  for (const table of tables) {
    const result = planTable(
      db, table, ageCutoffDays, importanceThreshold, windowDays, minClusterSize, options.project
    );
    clusters.push(...result.clusters);
    protectedCount += result.protectedCount;
  }

  return { clusters, ageCutoffDays, importanceThreshold, windowDays, minClusterSize, protectedCount };
}
