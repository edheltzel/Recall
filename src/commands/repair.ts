// recall repair command (issue #46).
//
// Explicit data/index maintenance: rebuild FTS5 indexes from their source
// tables (recreating missing indexes from the canonical schema DDL) and
// re-embed rows missing embeddings when the Ollama service is available.
// Orphan/invariant problems that cannot be repaired safely are report-only.
//
// Dry-run by default; --execute applies. Deliberately separate from
// `recall doctor --fix`, which only repairs install-layout symlinks and
// never runs data repair. Core logic lives in src/lib/repair.ts.

import { getDb } from '../db/connection.js';
import { checkEmbeddingService, embed } from '../lib/embeddings.js';
import {
  repairLifecycleSearchIndex,
  type LifecycleSearchReadiness,
} from '../lib/lifecycle-search.js';
import {
  applyEmbedRepair,
  applyFtsRepair,
  applyOrphanEmbeddingRepair,
  FTS_SOURCES,
  planRepair,
  type EmbedFn,
  type EmbedRepairResult,
  type FtsRepairResult,
  type OrphanEmbeddingRepairResult,
  type RepairPlan,
} from '../lib/repair.js';

export interface RepairOptions {
  execute?: boolean;
  table?: string;
  /** Commander maps --no-embed to embed: false. */
  embed?: boolean;
}

/**
 * Injectable service/embedding clients so tests run deterministically
 * offline. The CLI always uses the real Ollama-backed defaults.
 */
export interface RepairDeps {
  checkService: () => Promise<{ available: boolean; model: string; url: string }>;
  embedFn: EmbedFn;
}

export interface RepairRunResult {
  plan: RepairPlan;
  fts: FtsRepairResult | null;
  embeddings: EmbedRepairResult | null;
  /** Why the embedding pass did not run, or null if it ran. */
  embedSkipped: string | null;
  lifecycle: LifecycleSearchReadiness | null;
  orphanEmbeddings: OrphanEmbeddingRepairResult | null;
  orphanEmbeddingErrors: Array<{ check: string; error: string }>;
}

const DEFAULT_DEPS: RepairDeps = { checkService: checkEmbeddingService, embedFn: embed };

function isRepairableOrphanEmbeddingCheck(check: string, target: string): boolean {
  return check === `orphaned-embeddings:${target}` ||
    (target === 'all' && (
      check.startsWith('orphaned-embeddings:') ||
      check === 'unknown-embedding-source'
    ));
}

export async function runRepair(
  options: RepairOptions = {},
  deps: RepairDeps = DEFAULT_DEPS
): Promise<RepairRunResult | undefined> {
  const execute = options.execute ?? false;
  const embedPass = options.embed ?? true;

  const target = options.table ?? 'all';
  if (target !== 'all' && !FTS_SOURCES.includes(target)) {
    console.error(`Invalid --table "${target}". Valid tables: ${FTS_SOURCES.join(', ')}, all.`);
    process.exitCode = 1;
    return undefined;
  }

  const db = getDb();
  const plan = planRepair(db, {
    table: target === 'all' ? undefined : target,
    embed: embedPass,
  });

  console.log(execute ? '[EXECUTE — applying repairs]\n' : '[DRY RUN — no changes written]\n');
  if (execute) {
    console.log("Recommended: run 'recall export --backup' before applying repairs.\n");
  }

  // ── FTS indexes ──────────────────────────────────────────────
  console.log('FTS indexes:');
  for (const report of plan.fts) {
    const rows = report.sourceRows !== null ? `${report.sourceRows} source row(s)` : 'source missing';
    const planned =
      report.action === 'rebuild' ? (execute ? 'rebuilding' : 'would rebuild')
      : report.action === 'create-and-rebuild' ? (execute ? 'creating + rebuilding' : 'would create + rebuild')
      : report.action === 'report-only' ? 'unrepairable here'
      : 'no action';
    console.log(`  ${report.ftsTable}: ${report.status} (${rows}) — ${report.detail} [${planned}]`);
  }

  let ftsResult: FtsRepairResult | null = null;
  if (execute) {
    ftsResult = applyFtsRepair(db, plan);
    if (ftsResult.created.length > 0) {
      console.log(`  Created from canonical schema: ${ftsResult.created.join(', ')}`);
    }
    if (ftsResult.rebuilt.length > 0) {
      console.log(`  Rebuilt from source tables: ${ftsResult.rebuilt.join(', ')}`);
    }
    for (const failure of ftsResult.failed) {
      console.error(`  FAILED ${failure.ftsTable}: ${failure.error}`);
      process.exitCode = 1;
    }
  }
  let lifecycle = plan.lifecycle;
  if (lifecycle) {
    lifecycle = execute
      ? repairLifecycleSearchIndex(db, { maxPages: 8 })
      : lifecycle;
    if (lifecycle.status === 'ready') {
      console.log('  Lifecycle message index: ready');
    } else {
      const action = execute ? 'repair remains' : 'would repair';
      console.log(
        `  Lifecycle message index: ${lifecycle.pendingGenerations} generation(s) pending — ${action}`
      );
      if (execute) process.exitCode = 1;
    }
  }
  console.log('');

  // ── Embeddings ───────────────────────────────────────────────
  console.log('Embeddings:');
  let embedResult: EmbedRepairResult | null = null;
  let embedSkipped: string | null = null;

  if (!embedPass) {
    embedSkipped = 'disabled (--no-embed)';
    console.log(`  Skipped — ${embedSkipped}`);
  } else if (plan.embedGaps.length === 0) {
    console.log('  No embeddable tables in scope.');
  } else {
    for (const gap of plan.embedGaps) {
      const shortNote = gap.tooShort > 0 ? ` (${gap.tooShort} too short to embed)` : '';
      console.log(`  ${gap.table}: ${gap.missing} missing${shortNote}`);
    }
    const embeddable = plan.embedGaps.reduce((sum, g) => sum + (g.missing - g.tooShort), 0);

    if (execute && embeddable > 0) {
      const service = await deps.checkService();
      if (!service.available) {
        // Diagnostic path: report and stay successful — an unreachable
        // embedding service is an environment state, not a repair failure.
        embedSkipped = `embedding service unavailable at ${service.url} (model ${service.model})`;
        console.log(`  Skipped re-embedding — ${embedSkipped}.`);
        console.log(`  ${embeddable} row(s) still missing embeddings; re-run when Ollama is up.`);
      } else {
        embedResult = await applyEmbedRepair(db, plan, deps.embedFn);
        console.log(`  Embedded ${embedResult.embedded} row(s), skipped ${embedResult.skippedTooShort} too-short row(s), ${embedResult.failed.length} failure(s).`);
        for (const failure of embedResult.failed.slice(0, 5)) {
          console.error(`  FAILED ${failure.table}#${failure.id}: ${failure.error}`);
        }
        if (embedResult.failed.length > 5) {
          console.error(`  ...and ${embedResult.failed.length - 5} more failures`);
        }
        // Re-embedding is a requested repair: per-row failures with the
        // service reachable mean it did not fully succeed, so the exit code
        // must reflect that — matching the FTS-failure policy above. (#71)
        if (embedResult.failed.length > 0) {
          process.exitCode = 1;
        }
      }
    } else if (execute && embeddable === 0) {
      console.log('  Nothing to embed.');
    }
  }
  console.log('');

  const repairableOrphanEmbeddingReports = plan.orphans.filter(orphan =>
    isRepairableOrphanEmbeddingCheck(orphan.check, target)
  );
  const orphanEmbeddingErrors = repairableOrphanEmbeddingReports.flatMap(orphan =>
    orphan.error ? [{ check: orphan.check, error: orphan.error }] : []
  );
  const orphanEmbeddingWork = repairableOrphanEmbeddingReports
    .filter(orphan => !orphan.error)
    .reduce((sum, orphan) => sum + orphan.count, 0);
  let orphanEmbeddings: OrphanEmbeddingRepairResult | null = null;
  if (execute && orphanEmbeddingWork > 0 && orphanEmbeddingErrors.length === 0) {
    orphanEmbeddings = applyOrphanEmbeddingRepair(
      db,
      target === 'all' ? undefined : target
    );
  }

  // ── Orphans / invariants ─────────────────────────────────────
  console.log('Orphans / invariants:');
  if (plan.orphans.length === 0) {
    console.log('  None found.');
  } else {
    for (const orphan of plan.orphans) {
      if (orphan.error) {
        console.log(`  ${orphan.check}: check failed — ${orphan.error}`);
      } else {
        const sample = orphan.sample.length > 0 ? ` — ${orphan.sample.join(', ')}` : '';
        console.log(`  ${orphan.check}: ${orphan.count} (${orphan.description})${sample}`);
      }
    }
  }
  if (orphanEmbeddingErrors.length > 0) {
    console.error(
      `  RETRYABLE: ${orphanEmbeddingErrors.length} orphan embedding repair check(s) failed; cleanup is incomplete.`
    );
    process.exitCode = 1;
  }
  if (orphanEmbeddingWork > 0) {
    if (!execute) {
      console.log(`  ${orphanEmbeddingWork} orphan embedding(s) would be removed.`);
    } else if (orphanEmbeddings) {
      console.log(`  Removed ${orphanEmbeddings.removed} orphan embedding(s).`);
      if (orphanEmbeddings.vectorError) {
        console.error(`  FAILED vector reindex: ${orphanEmbeddings.vectorError}`);
        process.exitCode = 1;
      } else if (orphanEmbeddings.vectorReindexed) {
        console.log(`  Reindexed ${orphanEmbeddings.vectorRows} vector row(s).`);
      } else {
        console.log('  Vector index marked for rebuild on the next available vector query.');
      }
    }
  }
  console.log('');

  // ── Schema state ─────────────────────────────────────────────
  if (plan.migrations.pending > 0) {
    console.log(
      `Schema: ${plan.migrations.pending} migration(s) pending ` +
      `(version ${plan.migrations.current}, target ${plan.migrations.target}) — run 'recall init' to apply.`
    );
  } else {
    console.log(`Schema: migrations up to date (version ${plan.migrations.current}).`);
  }
  console.log('');

  if (!execute) {
    const ftsWork = plan.fts.filter(f => f.action === 'rebuild' || f.action === 'create-and-rebuild').length;
    const embedWork = plan.embedGaps.reduce((sum, g) => sum + (g.missing - g.tooShort), 0);
    const lifecycleWork = lifecycle?.status === 'retryable';
    if (
      ftsWork > 0 || embedWork > 0 || lifecycleWork || orphanEmbeddingWork > 0 ||
      orphanEmbeddingErrors.length > 0
    ) {
      console.log("Re-run with --execute to apply repairs. Recommended: 'recall export --backup' first.");
    } else {
      console.log('Nothing to repair.');
    }
  }

  return {
    plan,
    fts: ftsResult,
    embeddings: embedResult,
    embedSkipped,
    lifecycle,
    orphanEmbeddings,
    orphanEmbeddingErrors,
  };
}
