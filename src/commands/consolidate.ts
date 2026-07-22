// recall consolidate command (issue #141, Phase B of #53). risk:high.
//
// Compresses clusters of old, low-importance, un-pinned decisions/learnings into
// derived LoA summaries, then DEMOTES the sources so `recall age` retires them
// (locked decision #1: demote-not-delete). Dry-run by default; --execute applies.
//
// SPLIT (Ed's Option 1):
//  - DRY-RUN (default) is computed and printed ENTIRELY here in src, from the
//    pure planner (src/lib/consolidate.ts). NO subprocess, NO model call, NO write.
//  - --execute hands the plan to the hook-side engine (hooks/lib/consolidate-core.ts)
//    via SUBPROCESS — the established RecallBatchExtract→RecallExtract pattern —
//    because the mandatory #51 scrub + quality gate + model cascade live in
//    hooks/lib and src cannot import them (tsconfig rootDir). The child does
//    model+scrub+quality+write+demote and returns counts as JSON.

import { existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { getDb } from '../db/connection.js';
import {
  planConsolidate,
  CONSOLIDATE_TABLES,
  DEFAULT_WINDOW_DAYS,
  DEFAULT_MIN_CLUSTER_SIZE,
  type ConsolidatePlan,
  type ConsolidateTable,
} from '../lib/consolidate.js';
import { DEFAULT_AGE_CUTOFF_DAYS, DEFAULT_IMPORTANCE_THRESHOLD } from '../lib/aging.js';
import { getRecallHome } from '../lib/runtime-paths.js';

export interface ConsolidateOptions {
  execute?: boolean;
  table?: string;
  ageCutoff?: string;
  importanceThreshold?: number;
  windowDays?: number;
  minClusterSize?: number;
}

/** Result returned by the hook-side engine (structural mirror of
 *  hooks/lib/consolidate-core.ts's ConsolidateApplyResult — src cannot import
 *  across the hooks boundary, so the small DTO shape is restated here). */
export interface ConsolidateApplyResult {
  written: number;
  demoted: number;
  redactions: string[];
  skipped: Array<{ table: string; window: string; reason: string }>;
  error?: string;
}

/** Injectable apply seam — default spawns the hook-side child via subprocess;
 *  tests pass a spy/fake so the gate is exercised without a real model. */
export interface ConsolidateRunDeps {
  apply?: (plan: ConsolidatePlan) => Promise<ConsolidateApplyResult>;
}

export interface ConsolidateRunResult {
  plan: ConsolidatePlan;
  applied: ConsolidateApplyResult | null;
}

/** stderr marker the hook-side child emits after each committed cluster. Restated
 *  here (not imported) because src cannot cross the hooks/src boundary — the
 *  literal must stay in lockstep with PROGRESS_PREFIX in consolidate-core.ts. */
const PROGRESS_PREFIX = 'RECALL_CONSOLIDATE_PROGRESS ';

/** Recover the child's last cumulative {written, demoted} from its captured
 *  stderr. Used when the subprocess is killed on timeout so the summary reflects
 *  the per-cluster transactions it committed before SIGTERM. null if none found. */
export function parseConsolidateProgress(stderr: string): { written: number; demoted: number } | null {
  let latest: { written: number; demoted: number } | null = null;
  for (const line of stderr.split('\n')) {
    const at = line.indexOf(PROGRESS_PREFIX);
    if (at === -1) continue;
    try {
      const parsed = JSON.parse(line.slice(at + PROGRESS_PREFIX.length));
      if (typeof parsed?.written === 'number' && typeof parsed?.demoted === 'number') {
        latest = { written: parsed.written, demoted: parsed.demoted };
      }
    } catch { /* ignore a partially-flushed marker line */ }
  }
  return latest;
}

/** Parse a `<n>d` duration into days; null on malformed input. */
function parseDays(value: string): number | null {
  const match = value.match(/^(\d+)d$/);
  return match ? parseInt(match[1], 10) : null;
}

function resolveBunPath(): string {
  const candidates = [
    process.argv[0],
    `${process.env.HOME}/.bun/bin/bun`,
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
  ];
  for (const c of candidates) {
    try { if (c && existsSync(c)) return c; } catch { /* keep trying */ }
  }
  return 'bun';
}

/** Default apply: spawn the installed hook-side engine and return its JSON. */
function spawnConsolidateChild(plan: ConsolidatePlan): Promise<ConsolidateApplyResult> {
  const script = join(getRecallHome(), 'shared', 'hooks', 'lib', 'consolidate-core.ts');
  if (!existsSync(script)) {
    return Promise.resolve({
      written: 0, demoted: 0, redactions: [], skipped: [],
      error: `consolidate engine not found at ${script} — reinstall Recall hooks`,
    });
  }
  const payload = JSON.stringify({ clusters: plan.clusters });
  try {
    const out = execSync(`${resolveBunPath()} run ${script}`, {
      input: payload,
      encoding: 'utf-8',
      timeout: 180000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, RECALL_NESTED_EXTRACTION: '1' },
    });
    return Promise.resolve(JSON.parse(out) as ConsolidateApplyResult);
  } catch (err: any) {
    // On timeout the child is SIGTERM'd after committing N per-cluster transactions;
    // recover those counts from its captured stderr so the summary doesn't understate.
    const progress = parseConsolidateProgress(String(err?.stderr ?? ''));
    return Promise.resolve({
      written: progress?.written ?? 0, demoted: progress?.demoted ?? 0, redactions: [], skipped: [],
      error: `consolidate engine failed: ${(err?.message || String(err)).slice(0, 200)}`,
    });
  }
}

export async function runConsolidate(
  options: ConsolidateOptions = {},
  deps: ConsolidateRunDeps = {},
): Promise<ConsolidateRunResult | undefined> {
  const execute = options.execute ?? false;

  const target = options.table ?? 'all';
  if (target !== 'all' && !(CONSOLIDATE_TABLES as readonly string[]).includes(target)) {
    console.error(`Invalid --table "${target}". Valid tables: ${CONSOLIDATE_TABLES.join(', ')}, all.`);
    process.exitCode = 1;
    return undefined;
  }

  const ageCutoffDays = parseDays(options.ageCutoff ?? `${DEFAULT_AGE_CUTOFF_DAYS}d`);
  if (ageCutoffDays === null) {
    console.error(`Invalid --age-cutoff "${options.ageCutoff}". Use a duration like '90d' or '180d'.`);
    process.exitCode = 1;
    return undefined;
  }

  const importanceThreshold = options.importanceThreshold ?? DEFAULT_IMPORTANCE_THRESHOLD;
  if (!Number.isInteger(importanceThreshold) || importanceThreshold < 1 || importanceThreshold > 10) {
    console.error(`Invalid --importance-threshold "${options.importanceThreshold}". Expected an integer in [1, 10].`);
    process.exitCode = 1;
    return undefined;
  }

  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  if (!Number.isInteger(windowDays) || windowDays < 1) {
    console.error(`Invalid --window-days "${options.windowDays}". Expected a positive integer.`);
    process.exitCode = 1;
    return undefined;
  }

  const minClusterSize = options.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE;
  if (!Number.isInteger(minClusterSize) || minClusterSize < 2) {
    console.error(`Invalid --min-cluster-size "${options.minClusterSize}". Expected an integer >= 2.`);
    process.exitCode = 1;
    return undefined;
  }

  const db = getDb();
  const plan = planConsolidate(db, {
    tables: target === 'all' ? undefined : [target as ConsolidateTable],
    ageCutoffDays,
    importanceThreshold,
    windowDays,
    minClusterSize,
  });

  console.log(execute ? '[EXECUTE — consolidating records]\n' : '[DRY RUN — no changes written]\n');
  if (execute) {
    console.log("Recommended: run 'recall export --backup' before consolidating.\n");
  }
  console.log(
    `Age cutoff: ${ageCutoffDays}d  ·  importance threshold: <${importanceThreshold}  ·  ` +
    `window: ${windowDays}d  ·  min cluster: ${minClusterSize}\n`
  );

  let totalRecords = 0;
  for (const cluster of plan.clusters) {
    totalRecords += cluster.records.length;
    const proj = cluster.project ?? 'global';
    const ids = cluster.records.map((r) => r.id).join(', ');
    const floor = cluster.records[0].newImportance;
    console.log(
      `${cluster.table} [${proj}] window ${cluster.window}: ${cluster.records.length} record(s) ` +
      `→ ${execute ? 'demote' : 'would demote'} importance to ${floor} (rep #${cluster.representativeId}; ids: ${ids})`
    );
  }
  if (plan.protectedCount > 0) {
    console.log(`\n${plan.protectedCount.toLocaleString()} record(s) withheld: survivors/marked-duplicates.`);
  }
  console.log(`\nTotal: ${plan.clusters.length} cluster(s), ${totalRecords.toLocaleString()} record(s) to consolidate`);

  if (!execute) {
    console.log(plan.clusters.length > 0
      ? '\nRe-run with --execute to summarize each cluster and demote its sources.'
      : '\nNothing to consolidate.');
    return { plan, applied: null };
  }

  if (plan.clusters.length === 0) {
    console.log('\nNothing to consolidate.');
    return { plan, applied: null };
  }

  const apply = deps.apply ?? spawnConsolidateChild;
  const applied = await apply(plan);

  if (applied.error) {
    console.error(`\nConsolidation failed: ${applied.error}`);
    if (applied.written > 0 || applied.demoted > 0) {
      console.error(
        `Partial progress before failure: wrote ${applied.written.toLocaleString()} derived summary(ies), ` +
        `demoted ${applied.demoted.toLocaleString()} source record(s).`
      );
    }
    process.exitCode = 1;
    return { plan, applied };
  }

  console.log(
    `\nConsolidated: wrote ${applied.written.toLocaleString()} derived summary(ies), ` +
    `demoted ${applied.demoted.toLocaleString()} source record(s).`
  );
  if (applied.skipped.length > 0) {
    console.log(`Skipped ${applied.skipped.length} cluster(s):`);
    for (const s of applied.skipped) {
      console.log(`  ${s.table} (${s.window}): ${s.reason}`);
    }
  }
  if (applied.redactions.length > 0) {
    console.log(`Redacted secret kinds in summaries: ${applied.redactions.join(', ')}`);
  }
  return { plan, applied };
}
