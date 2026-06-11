// recall provenance — conservative backfill for the Record Provenance column.
//
// Background (ADR-0001, CONTEXT.md, issue #42):
// Migration 8→9 added a nullable `provenance` column to messages/decisions/
// learnings/breadcrumbs/loa_entries. Write paths stamp provenance going
// forward; legacy rows are NULL ("unknown"). This command classifies legacy
// rows — and ONLY where the source table or a write-path marker gives
// deterministic evidence.
//
// Binding rules:
// - NEVER guess. A row with no deterministic evidence stays NULL and is
//   reported as unknown.
// - NEVER overwrite. Only rows with provenance IS NULL are touched.
// - `user_authored` is never assigned by backfill: nothing in the data
//   distinguishes a CLI/MCP-authored row from an extraction row that was
//   given a custom category.
//
// Evidence table:
// - messages    → 'verbatim'  — every message writer that has ever existed
//                 (JSONL import, conversation import, dump, PreCompact flush)
//                 captures raw transcript text without semantic rewriting.
// - loa_entries → 'extracted' — every LoA writer stores machine-generated
//                 content (Fabric/Haiku extracts, basic-summary fallback, or
//                 prior DISTILLED.md extraction output via import-legacy).
// - decisions   → 'extracted' iff category = 'auto-extracted' (the marker the
//                 extraction writers stamp). Other rows: unknown.
// - learnings   → 'extracted' iff category = 'auto-extracted'. Else unknown.
// - breadcrumbs → 'extracted' iff category = 'extracted-idea'. Else unknown.
//
// Bind-count note (see src/lib/chunk.ts): every statement here binds zero
// variables — bulk UPDATEs with literal predicates — so no chunking applies.

import { getDb } from '../db/connection.js';
import { PROVENANCE_TABLES } from '../types/index.js';

type BackfillTable = typeof PROVENANCE_TABLES[number];

export interface ProvenanceBackfillOptions {
  dryRun?: boolean;
  table?: BackfillTable | 'all';
}

interface TableRule {
  table: BackfillTable;
  value: 'verbatim' | 'extracted';
  // SQL predicate (beyond provenance IS NULL) that constitutes the
  // deterministic evidence; undefined = the whole table qualifies.
  evidenceWhere?: string;
  evidence: string;
}

const RULES: TableRule[] = [
  {
    table: 'messages',
    value: 'verbatim',
    evidence: 'raw conversation capture is the only historical write path',
  },
  {
    table: 'loa_entries',
    value: 'extracted',
    evidence: 'all historical LoA writers store machine-generated extracts',
  },
  {
    table: 'decisions',
    value: 'extracted',
    evidenceWhere: "category = 'auto-extracted'",
    evidence: "category = 'auto-extracted' (extraction-writer marker)",
  },
  {
    table: 'learnings',
    value: 'extracted',
    evidenceWhere: "category = 'auto-extracted'",
    evidence: "category = 'auto-extracted' (extraction-writer marker)",
  },
  {
    table: 'breadcrumbs',
    value: 'extracted',
    evidenceWhere: "category = 'extracted-idea'",
    evidence: "category = 'extracted-idea' (extraction-writer marker)",
  },
];

export interface ProvenanceBackfillResult {
  table: string;
  value: string;
  unknownBefore: number;
  classified: number;
  remainingUnknown: number;
  evidence: string;
}

export function runProvenanceBackfill(options: ProvenanceBackfillOptions = {}): ProvenanceBackfillResult[] {
  const dryRun = options.dryRun ?? true;
  const target = options.table ?? 'all';

  if (target !== 'all' && !(PROVENANCE_TABLES as readonly string[]).includes(target)) {
    console.error(`Unknown table: ${target}. Use one of: ${PROVENANCE_TABLES.join(', ')}, all`);
    process.exitCode = 1;
    return [];
  }

  const db = getDb();
  const results: ProvenanceBackfillResult[] = [];

  for (const rule of RULES) {
    if (target !== 'all' && target !== rule.table) continue;

    const count = (where: string) =>
      (db.prepare(`SELECT COUNT(*) as count FROM ${rule.table} WHERE ${where}`).get() as { count: number }).count;

    const unknownBefore = count('provenance IS NULL');
    const evidenceClause = rule.evidenceWhere
      ? `provenance IS NULL AND ${rule.evidenceWhere}`
      : 'provenance IS NULL';
    const classified = count(evidenceClause);

    if (!dryRun && classified > 0) {
      db.prepare(`UPDATE ${rule.table} SET provenance = '${rule.value}' WHERE ${evidenceClause}`).run();
    }

    results.push({
      table: rule.table,
      value: rule.value,
      unknownBefore,
      classified,
      remainingUnknown: unknownBefore - classified,
      evidence: rule.evidence,
    });
  }

  // Report
  console.log(dryRun ? '[DRY RUN — no changes written]\n' : '[LIVE — changes written]\n');
  for (const r of results) {
    const verb = dryRun ? 'would set' : 'set';
    console.log(`${r.table}: ${r.unknownBefore} unknown — ${verb} ${r.classified} to ${r.value}`);
    console.log(`  evidence: ${r.evidence}`);
    if (r.remainingUnknown > 0) {
      console.log(`  ${r.remainingUnknown} left unknown (no deterministic evidence — staying NULL)`);
    }
    console.log('');
  }

  if (dryRun) {
    console.log('Re-run with --execute to apply changes.');
  }

  return results;
}
