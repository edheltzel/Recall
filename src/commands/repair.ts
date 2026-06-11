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
  applyEmbedRepair,
  applyFtsRepair,
  FTS_SOURCES,
  planRepair,
  type EmbedFn,
  type EmbedRepairResult,
  type FtsRepairResult,
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
}

const DEFAULT_DEPS: RepairDeps = { checkService: checkEmbeddingService, embedFn: embed };

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
      }
    } else if (execute && embeddable === 0) {
      console.log('  Nothing to embed.');
    }
  }
  console.log('');

  // ── Orphans / invariants (report-only) ───────────────────────
  console.log('Orphans / invariants (report-only, never repaired automatically):');
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
    if (ftsWork > 0 || embedWork > 0) {
      console.log("Re-run with --execute to apply repairs. Recommended: 'recall export --backup' first.");
    } else {
      console.log('Nothing to repair.');
    }
  }

  return { plan, fts: ftsResult, embeddings: embedResult, embedSkipped };
}
