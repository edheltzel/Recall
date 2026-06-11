// recall dedup command (issue #45).
//
// Dry-run by default. --execute marks duplicates (non-destructive: records
// stay intact, hidden from search via dedup_lineage). --delete is the
// destructive opt-in and requires --execute; take a `recall export --backup`
// first. Core logic lives in src/lib/dedup.ts.

import { getDb } from '../db/connection.js';
import {
  applyDedupPlan,
  DEDUP_TABLES,
  DEFAULT_SEMANTIC_THRESHOLD,
  planDedup,
  type ApplyResult,
  type DedupPlan,
} from '../lib/dedup.js';
import type { ProvenanceTable } from '../types/index.js';

export interface DedupOptions {
  execute?: boolean;
  delete?: boolean;
  table?: string;
  project?: string;
  threshold?: number;
  semantic?: boolean;
}

export interface DedupRunResult {
  plan: DedupPlan;
  applied: ApplyResult | null;
}

export function runDedup(options: DedupOptions = {}): DedupRunResult | undefined {
  const execute = options.execute ?? false;
  const destructive = options.delete ?? false;

  if (destructive && !execute) {
    console.error('--delete requires --execute. Dry-run never deletes.');
    process.exitCode = 1;
    return undefined;
  }

  const target = options.table ?? 'all';
  if (target !== 'all' && !(DEDUP_TABLES as readonly string[]).includes(target)) {
    console.error(
      `Invalid --table "${target}". Valid tables: ${DEDUP_TABLES.join(', ')}, all.`
    );
    process.exitCode = 1;
    return undefined;
  }

  const threshold = options.threshold ?? DEFAULT_SEMANTIC_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    console.error(`Invalid --threshold "${options.threshold}". Expected a number in (0, 1].`);
    process.exitCode = 1;
    return undefined;
  }

  const db = getDb();
  const plan = planDedup(db, {
    tables: target === 'all' ? undefined : [target as ProvenanceTable],
    project: options.project,
    threshold,
    semantic: options.semantic,
  });

  const mode = !execute
    ? '[DRY RUN — no changes written]'
    : destructive
      ? '[EXECUTE + DELETE — destructive: duplicates will be removed]'
      : '[EXECUTE — marking duplicates, non-destructive]';
  console.log(`${mode}\n`);

  if (destructive) {
    console.log("Recommended: run 'recall export --backup' before destructive dedup.\n");
  }

  const verb = execute ? (destructive ? 'delete' : 'mark') : 'would mark';
  let totalPlanned = 0;
  for (const report of plan.tables) {
    totalPlanned += report.planned.length;
    const unchanged = report.scanned - report.planned.length;
    const skipped: string[] = [];
    if (report.alreadyMarked > 0) skipped.push(`${report.alreadyMarked} already marked`);
    if (report.tooShort > 0) skipped.push(`${report.tooShort} too short`);
    if (report.stickySkipped > 0) skipped.push(`${report.stickySkipped} prior survivor(s) kept visible`);
    const skippedNote = skipped.length > 0 ? ` (${skipped.join(', ')})` : '';
    console.log(
      `${report.table}: scanned ${report.scanned}, exact groups ${report.exactGroups}, ` +
      `semantic pairs ${report.semanticPairs}, ${verb} ${report.planned.length}, ` +
      `unchanged ${unchanged}${skippedNote}`
    );
    for (const entry of report.planned.slice(0, 3)) {
      const sim = entry.similarity !== null ? ` @ ${entry.similarity.toFixed(3)}` : '';
      console.log(
        `  #${entry.duplicate_id} → survivor #${entry.survivor_id} [${entry.reason}${sim}]`
      );
    }
    if (report.planned.length > 3) {
      console.log(`  ...and ${report.planned.length - 3} more`);
    }
  }
  console.log('');

  if (plan.semanticSkipped) {
    console.log(`Semantic pass: skipped — ${plan.semanticSkipped}`);
  } else {
    console.log(`Semantic pass: threshold ${plan.threshold}`);
  }

  const crossText = plan.crossTable.textMatches;
  console.log(
    `Cross-table (report-only, never acted on): ${crossText.length} text match group(s), ` +
    `${plan.crossTable.semanticPairs} semantic pair(s)`
  );
  for (const match of crossText.slice(0, 5)) {
    const members = match.members.map(m => `${m.table}#${m.id}`).join(' ↔ ');
    const projectTag = match.project ? ` [${match.project}]` : '';
    console.log(`  ${members}${projectTag}`);
  }
  if (crossText.length > 5) {
    console.log(`  ...and ${crossText.length - 5} more`);
  }
  console.log('');

  if (!execute) {
    if (totalPlanned > 0) {
      console.log('Re-run with --execute to mark duplicates (non-destructive).');
      console.log("Marked duplicates are hidden from search; use 'recall search --include-duplicates' to see them.");
    } else {
      console.log('No duplicates found.');
    }
    return { plan, applied: null };
  }

  let applied: ApplyResult;
  try {
    applied = applyDedupPlan(db, plan, { destructive });
  } catch (err) {
    // The destructive survivor guard (issue #63) throws before writing;
    // surface its message as a clean refusal instead of a stack trace.
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return undefined;
  }
  if (destructive) {
    const fkNote = applied.fkProtected > 0
      ? ` (${applied.fkProtected} kept as marked — referenced by LoA lineage)`
      : '';
    console.log(`Deleted ${applied.deleted} duplicate(s)${fkNote}.`);
  } else {
    console.log(`Marked ${applied.marked} duplicate(s). Records remain intact and recoverable.`);
  }
  return { plan, applied };
}
