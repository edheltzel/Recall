// recall age command (issue #139, Phase A of #53; subsumes #38).
//
// Type-aware aging: dry-run by default, --execute to apply. Deletes old
// messages, expires old breadcrumbs via their TTL, and demotes old
// low-importance decisions/learnings/loa_entries — reusing the dedup/FK/
// importance guards. Core logic lives in src/lib/aging.ts.

import { getDb } from '../db/connection.js';
import {
  AGE_TABLES,
  applyAgePlan,
  DEFAULT_AGE_CUTOFF_DAYS,
  DEFAULT_BREADCRUMB_HORIZON_DAYS,
  DEFAULT_IMPORTANCE_THRESHOLD,
  planAge,
  type AgeApplyResult,
  type AgePlan,
} from '../lib/aging.js';
import type { ProvenanceTable } from '../types/index.js';

export interface AgeOptions {
  execute?: boolean;
  table?: string;
  ageCutoff?: string;
  breadcrumbHorizon?: string;
  importanceThreshold?: number;
}

export interface AgeRunResult {
  plan: AgePlan;
  applied: AgeApplyResult | null;
}

/** Parse a `<n>d` duration into days; null on malformed input. */
function parseDays(value: string): number | null {
  const match = value.match(/^(\d+)d$/);
  return match ? parseInt(match[1], 10) : null;
}

const ACTION_VERB: Record<string, [string, string]> = {
  // [dry-run verb, execute verb]
  delete: ['would delete', 'deleted'],
  expire: ['would expire', 'expired'],
  demote: ['would demote', 'demoted'],
};

export function runAge(options: AgeOptions = {}): AgeRunResult | undefined {
  const execute = options.execute ?? false;

  const target = options.table ?? 'all';
  if (target !== 'all' && !(AGE_TABLES as readonly string[]).includes(target)) {
    console.error(`Invalid --table "${target}". Valid tables: ${AGE_TABLES.join(', ')}, all.`);
    process.exitCode = 1;
    return undefined;
  }

  const ageCutoffDays = parseDays(options.ageCutoff ?? `${DEFAULT_AGE_CUTOFF_DAYS}d`);
  if (ageCutoffDays === null) {
    console.error(`Invalid --age-cutoff "${options.ageCutoff}". Use a duration like '90d' or '180d'.`);
    process.exitCode = 1;
    return undefined;
  }

  const breadcrumbHorizonDays = parseDays(options.breadcrumbHorizon ?? `${DEFAULT_BREADCRUMB_HORIZON_DAYS}d`);
  if (breadcrumbHorizonDays === null) {
    console.error(`Invalid --breadcrumb-horizon "${options.breadcrumbHorizon}". Use a duration like '14d'.`);
    process.exitCode = 1;
    return undefined;
  }

  const importanceThreshold = options.importanceThreshold ?? DEFAULT_IMPORTANCE_THRESHOLD;
  if (!Number.isInteger(importanceThreshold) || importanceThreshold < 1 || importanceThreshold > 10) {
    console.error(`Invalid --importance-threshold "${options.importanceThreshold}". Expected an integer in [1, 10].`);
    process.exitCode = 1;
    return undefined;
  }

  const db = getDb();
  const plan = planAge(db, {
    tables: target === 'all' ? undefined : [target as ProvenanceTable],
    ageCutoffDays,
    breadcrumbHorizonDays,
    importanceThreshold,
  });

  console.log(execute ? '[EXECUTE — aging records]\n' : '[DRY RUN — no changes written]\n');
  if (execute) {
    console.log("Recommended: run 'recall export --backup' before applying aging.\n");
  }
  console.log(
    `Age cutoff: ${ageCutoffDays}d  ·  breadcrumb horizon: ${breadcrumbHorizonDays}d  ·  ` +
    `importance threshold: <${importanceThreshold}\n`
  );

  let totalPlanned = 0;
  for (const report of plan.tables) {
    totalPlanned += report.eligible.length;
    const [dryVerb, execVerb] = ACTION_VERB[report.action];
    const verb = execute ? execVerb : dryVerb;
    // Pins (importance 10) and already-expiring crumbs never enter `matched`,
    // so `protected` only ever counts guard withholds: survivors, marked
    // duplicates, and (messages) FK-referenced rows.
    const protectedNote = report.protected > 0
      ? ` (${report.protected.toLocaleString()} withheld: survivors/duplicates/FK-referenced)`
      : '';
    console.log(
      `${report.table}: ${verb} ${report.eligible.length.toLocaleString()} [${report.action}]${protectedNote}`
    );
  }

  console.log(`\nTotal: ${totalPlanned.toLocaleString()} record(s) to age`);

  if (!execute) {
    console.log(totalPlanned > 0
      ? '\nRe-run with --execute to apply the plan.'
      : '\nNothing to age.');
    return { plan, applied: null };
  }

  if (totalPlanned === 0) {
    console.log('\nNothing to age.');
    return { plan, applied: null };
  }

  const applied = applyAgePlan(db, plan);
  console.log(
    `\nAged: deleted ${applied.deleted.toLocaleString()} message(s), ` +
    `expired ${applied.expired.toLocaleString()} breadcrumb(s), ` +
    `demoted ${applied.demoted.toLocaleString()} durable record(s).`
  );
  return { plan, applied };
}
