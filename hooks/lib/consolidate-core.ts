#!/usr/bin/env bun
// hooks/lib/consolidate-core.ts — hook-side engine for `recall consolidate --execute`
// (issue #141, Phase B of #53).
//
// WHY THIS LIVES IN hooks/lib (Ed's Option 1, 2026-06-21):
// The mandatory #51 security scrub (write-safety.ts), the quality gate
// (extraction-quality.ts), and the cheap model cascade (extract-model.ts) all
// live in hooks/lib and are single-sourced there. tsconfig's `rootDir: "src"`
// forbids src/ importing hooks/lib (TS6059), so the --execute APPLY step runs
// here, on the hook side, and the src CLI invokes it via SUBPROCESS — the same
// pattern RecallBatchExtract uses to drive RecallExtract. Zero duplication; the
// hooks/src boundary stays intact.
//
// Self-contained per Key Conventions: imports only from other hooks/lib modules,
// never from src/. The deterministic CLUSTER PLAN is computed in src
// (src/lib/consolidate.ts) and handed to us as JSON via stdin; we do the
// model+scrub+quality+write+demote half.
//
// FLOW per cluster (mirrors runExtractCore's extract → quality → scrub order):
//   buildConsolidationPrompt → summarize (cascade) → evaluateQuality(raw)
//   → scrub(raw) → write derived LoA (provenance='derived' + source_ids)
//   → DEMOTE source records' importance. All within one transaction per cluster.
//   A null model result or a failed quality gate SKIPS the cluster (no write).

import { Database } from 'bun:sqlite';
import { scrub } from './write-safety';
import { evaluateQuality } from './extraction-quality';
import { runExtractionCascade } from './extract-model';
import { resolveDbPath } from './db-path';

/** Eligible source tables (must match src/lib/consolidate.ts CONSOLIDATE_TABLES). */
const ALLOWED_TABLES = new Set(['decisions', 'learnings']);

/** Derived consolidation summaries land at the LoA neutral floor (curated tier
 *  minimum) — they compress low-value records, so they are never inflated. */
const DERIVED_LOA_IMPORTANCE = 5;

export interface ConsolidateInputRecord {
  id: number;
  text: string;
  /** Demote target computed by the planner (clampImportance(DEMOTE_FLOOR, ...)). */
  newImportance: number;
}

export interface ConsolidateInputCluster {
  table: string;
  project: string | null;
  window: string;
  records: ConsolidateInputRecord[];
}

/** Why a cluster produced no write. */
export type SkipReason = 'extraction_failed' | 'quality_failed' | 'empty' | 'invalid_table';

export interface ConsolidateApplyResult {
  /** Derived LoA rows written. */
  written: number;
  /** Source records whose importance was demoted. */
  demoted: number;
  /** Distinct secret kinds redacted across all written summaries. */
  redactions: string[];
  skipped: Array<{ table: string; window: string; reason: SkipReason }>;
}

/** Injected model behavior — defaults to the cheap cascade; tests pass a fake. */
export interface ConsolidateDeps {
  summarize: (prompt: string) => Promise<string | null>;
  /** Called with the running cumulative totals after each cluster commits, so a
   *  parent that kills us on timeout can still report the work we landed. */
  onProgress?: (progress: { written: number; demoted: number }) => void;
}

/** stderr marker the child prints after each committed cluster. The parent
 *  (src/commands/consolidate.ts) matches the same literal to recover committed
 *  counts when it kills us on timeout — restated there per the hooks/src split. */
export const PROGRESS_PREFIX = 'RECALL_CONSOLIDATE_PROGRESS ';

/**
 * Build the summarization prompt for one cluster. Pure. The output structure
 * (## ONE SENTENCE SUMMARY + ## MAIN IDEAS) is required so evaluateQuality's
 * strict gate is meaningful on the model's response.
 */
export function buildConsolidationPrompt(cluster: ConsolidateInputCluster): string {
  const label = cluster.project ? `project "${cluster.project}"` : 'no specific project';
  const body = cluster.records
    .map((r, i) => `${i + 1}. ${r.text}`)
    .join('\n');

  return `You are consolidating ${cluster.records.length} older, low-importance ${cluster.table} records from ${label} (time window starting ${cluster.window}) into a single durable summary that preserves their collective signal.

Records:
${body}

Write a faithful consolidation. Do not invent facts not present above. Output EXACTLY this structure:

## ONE SENTENCE SUMMARY
A single sentence capturing what these ${cluster.table} collectively cover.

## MAIN IDEAS
- 3 to 7 bullet points distilling the durable, reusable content across the records.`;
}

function openDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

function columnExists(db: Database, table: string, column: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return rows.some((r) => r.name === column);
  } catch {
    return false;
  }
}

/**
 * Apply the consolidation plan. For each cluster: summarize → quality-gate →
 * scrub → write a derived LoA with source lineage → demote the sources'
 * importance. Nothing is deleted (locked decision #1: demote-not-delete).
 */
export async function applyConsolidation(
  dbPath: string,
  clusters: ConsolidateInputCluster[],
  deps: ConsolidateDeps,
): Promise<ConsolidateApplyResult> {
  const result: ConsolidateApplyResult = { written: 0, demoted: 0, redactions: [], skipped: [] };
  const db = openDb(dbPath);
  try {
    // Lineage columns are guaranteed by migration 13 (#140). If they are absent
    // the schema is unmigrated/corrupt — fail loudly rather than silently writing
    // NULL provenance/source_ids and losing the lineage we just computed.
    if (!columnExists(db, 'loa_entries', 'provenance') || !columnExists(db, 'loa_entries', 'source_ids')) {
      throw new Error(
        'loa_entries is missing provenance/source_ids columns — run `recall migrate` (schema must be >= v13) before consolidating',
      );
    }
    const cols = ['title', 'description', 'fabric_extract', 'project', 'tags', 'importance', 'provenance', 'source_ids'];
    const insertSql =
      `INSERT INTO loa_entries (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    const insertLoa = db.prepare(insertSql);
    const redactions = new Set<string>();

    for (const cluster of clusters) {
      if (!ALLOWED_TABLES.has(cluster.table)) {
        result.skipped.push({ table: cluster.table, window: cluster.window, reason: 'invalid_table' });
        continue;
      }
      if (cluster.records.length === 0) {
        result.skipped.push({ table: cluster.table, window: cluster.window, reason: 'empty' });
        continue;
      }

      // 1) Model — the cheap cascade (or an injected fake). null ⇒ skip, no write.
      const raw = await deps.summarize(buildConsolidationPrompt(cluster));
      if (!raw) {
        result.skipped.push({ table: cluster.table, window: cluster.window, reason: 'extraction_failed' });
        continue;
      }

      // 2) Quality gate — BEFORE any write. A failed gate skips the cluster.
      if (!evaluateQuality(raw).pass) {
        result.skipped.push({ table: cluster.table, window: cluster.window, reason: 'quality_failed' });
        continue;
      }

      // 3) Scrub — mandatory #51 guard. Only scrubbed text is ever persisted.
      const scrubbed = scrub(raw);
      for (const kind of scrubbed.redactions) redactions.add(kind);

      const sourceIds = JSON.stringify(cluster.records.map((r) => ({ table: cluster.table, id: r.id })));
      const title = `Consolidated ${cluster.table} — ${cluster.project ?? 'global'} (${cluster.window})`;
      const values: Array<string | number | null> = [
        title,
        `Derived summary of ${cluster.records.length} ${cluster.table} records.`,
        scrubbed.text,
        cluster.project,
        'consolidated,derived',
        DERIVED_LOA_IMPORTANCE,
        'derived',
        sourceIds,
      ];

      // 4) Write + demote atomically. Sources are demoted, never deleted.
      // Re-clamp in the child (defense-in-depth): MIN(…, importance) so a demote can
      // only ever LOWER importance — a directly-piped payload can't raise it.
      // COALESCE(?, importance) makes a NULL payload a no-op (never nulls the column),
      // and MAX(1, …) re-pins the absolute floor of 1 for every input, NULL included.
      const writeCluster = db.transaction(() => {
        insertLoa.run(...values);
        const demote = db.prepare(
          `UPDATE ${cluster.table} SET importance = MAX(1, MIN(CAST(COALESCE(?, importance) AS INTEGER), importance)) WHERE id = ?`,
        );
        for (const r of cluster.records) demote.run(r.newImportance, r.id);
      });
      writeCluster();

      result.written += 1;
      result.demoted += cluster.records.length;
      deps.onProgress?.({ written: result.written, demoted: result.demoted });
    }

    result.redactions = [...redactions];
    return result;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Child entrypoint: `bun run consolidate-core.ts` with the plan on stdin.
// The src CLI marks this as nested extraction; each native provider maps that
// host-neutral signal to any host-specific recursion guard it requires. Reads { clusters } JSON from
// stdin, runs the real cascade, prints the ConsolidateApplyResult JSON.
// ---------------------------------------------------------------------------

async function readStdin(): Promise<string> {
  let input = '';
  try {
    const decoder = new TextDecoder();
    const reader = Bun.stdin.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      input += decoder.decode(value, { stream: true });
    }
  } catch {
    // return whatever we got
  }
  return input;
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let payload: { clusters?: ConsolidateInputCluster[] } = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify({ written: 0, demoted: 0, redactions: [], skipped: [], error: 'bad_input' }));
    process.exit(0);
  }

  const result = await applyConsolidation(
    resolveDbPath(),
    payload.clusters ?? [],
    {
      summarize: runExtractionCascade,
      // Cumulative progress to stderr — the parent reads the last marker to report
      // committed work if it has to SIGTERM us on timeout (stdout carries only the
      // final JSON result, so progress must not pollute it).
      onProgress: (p) => process.stderr.write(`${PROGRESS_PREFIX}${JSON.stringify(p)}\n`),
    },
  );
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

if (import.meta.main) {
  main().catch((err) => {
    process.stdout.write(JSON.stringify({ written: 0, demoted: 0, redactions: [], skipped: [], error: String(err?.message || err) }));
    process.exit(0);
  });
}
