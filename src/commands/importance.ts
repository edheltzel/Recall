// mem importance — heuristic backfill + pin/unpin for the importance column.
//
// Background:
// Migration 7→8 added `importance INTEGER` to messages/decisions/learnings/loa_entries
// (breadcrumbs already had it). Existing rows carry the DEFAULT value; this command
// sets smarter values based on cheap, deterministic heuristics — no LLM involved.
//
// Design rules:
// - LoA is the curated tier. Backfill NEVER reassigns LoA importance below 5.
//   Existing LoA rows with the default 8 are left alone; this respects the
//   write-time curation gate those rows passed.
// - Confidence-bearing records (decisions/learnings with confidence=high) get a
//   small bump over the default, confidence=low gets a small demotion.
// - Breadcrumbs already have meaningful importance — skipped unless --force.
// - Messages stay at the default 5 (they're the noise tier by design).

import { getDb } from '../db/connection.js';
import { clampImportance, pinRecord } from '../lib/memory.js';

export interface BackfillOptions {
  dryRun?: boolean;
  force?: boolean; // overwrite non-default values too
  table?: 'decisions' | 'learnings' | 'loa_entries' | 'breadcrumbs' | 'messages' | 'all';
}

interface BackfillResult {
  table: string;
  examined: number;
  updated: number;
  sampleChanges: Array<{ id: number; from: number; to: number }>;
}

export function runImportanceBackfill(options: BackfillOptions = {}): void {
  const dryRun = options.dryRun ?? true;
  const force = options.force ?? false;
  const target = options.table ?? 'all';

  const db = getDb();
  const results: BackfillResult[] = [];

  const shouldRun = (t: string) => target === 'all' || target === t;

  if (shouldRun('decisions')) {
    results.push(backfillDecisions(db, dryRun, force));
  }
  if (shouldRun('learnings')) {
    results.push(backfillLearnings(db, dryRun, force));
  }
  if (shouldRun('loa_entries')) {
    results.push(backfillLoa(db, dryRun, force));
  }
  if (shouldRun('breadcrumbs') && force) {
    results.push(backfillBreadcrumbs(db, dryRun));
  }

  // Report
  console.log(dryRun ? '[DRY RUN — no changes written]\n' : '[LIVE — changes written]\n');
  for (const r of results) {
    console.log(`${r.table}: examined ${r.examined}, ${dryRun ? 'would update' : 'updated'} ${r.updated}`);
    if (r.sampleChanges.length > 0) {
      const preview = r.sampleChanges.slice(0, 3)
        .map(c => `  #${c.id}: ${c.from} → ${c.to}`)
        .join('\n');
      console.log(preview);
      if (r.sampleChanges.length > 3) {
        console.log(`  ...and ${r.sampleChanges.length - 3} more`);
      }
    }
    console.log('');
  }

  if (dryRun) {
    console.log('Re-run with --execute to apply changes.');
  }
}

// Decisions: confidence=high → 7, confidence=medium → 5 (default, leave), confidence=low → 3
function backfillDecisions(db: ReturnType<typeof getDb>, dryRun: boolean, force: boolean): BackfillResult {
  const rows = db.prepare(
    `SELECT id, confidence, importance FROM decisions WHERE ${force ? '1=1' : 'importance = 5'}`
  ).all() as Array<{ id: number; confidence: string | null; importance: number }>;

  const changes: Array<{ id: number; from: number; to: number }> = [];
  for (const row of rows) {
    let target = 5;
    if (row.confidence === 'high') target = 7;
    else if (row.confidence === 'low') target = 3;
    if (target !== row.importance) {
      changes.push({ id: row.id, from: row.importance, to: target });
    }
  }

  if (!dryRun) {
    const update = db.prepare('UPDATE decisions SET importance = ? WHERE id = ?');
    const apply = db.transaction((cs: typeof changes) => {
      for (const c of cs) update.run(c.to, c.id);
    });
    apply(changes);
  }

  return { table: 'decisions', examined: rows.length, updated: changes.length, sampleChanges: changes };
}

// Learnings: same confidence-based heuristic as decisions.
function backfillLearnings(db: ReturnType<typeof getDb>, dryRun: boolean, force: boolean): BackfillResult {
  const rows = db.prepare(
    `SELECT id, confidence, importance FROM learnings WHERE ${force ? '1=1' : 'importance = 5'}`
  ).all() as Array<{ id: number; confidence: string | null; importance: number }>;

  const changes: Array<{ id: number; from: number; to: number }> = [];
  for (const row of rows) {
    let target = 5;
    if (row.confidence === 'high') target = 7;
    else if (row.confidence === 'low') target = 3;
    if (target !== row.importance) {
      changes.push({ id: row.id, from: row.importance, to: target });
    }
  }

  if (!dryRun) {
    const update = db.prepare('UPDATE learnings SET importance = ? WHERE id = ?');
    const apply = db.transaction((cs: typeof changes) => {
      for (const c of cs) update.run(c.to, c.id);
    });
    apply(changes);
  }

  return { table: 'learnings', examined: rows.length, updated: changes.length, sampleChanges: changes };
}

// LoA: the curated tier — floor at 5, default is 8. Only move rows UP, never down.
// This respects the write-time curation gate: rows that have been manually
// set to 9 or 10 stay that way; rows below 5 (shouldn't exist) get raised to 5.
function backfillLoa(db: ReturnType<typeof getDb>, dryRun: boolean, _force: boolean): BackfillResult {
  const rows = db.prepare(`SELECT id, importance FROM loa_entries WHERE importance < 5`)
    .all() as Array<{ id: number; importance: number }>;

  const changes = rows.map(r => ({ id: r.id, from: r.importance, to: 5 }));

  if (!dryRun) {
    const update = db.prepare('UPDATE loa_entries SET importance = ? WHERE id = ?');
    const apply = db.transaction((cs: typeof changes) => {
      for (const c of cs) update.run(c.to, c.id);
    });
    apply(changes);
  }

  return { table: 'loa_entries (floor enforcement only)', examined: rows.length, updated: changes.length, sampleChanges: changes };
}

// Breadcrumbs: only with --force. They already have curated importance from addBreadcrumb().
function backfillBreadcrumbs(db: ReturnType<typeof getDb>, dryRun: boolean): BackfillResult {
  // No-op by default: breadcrumbs carry user-provided importance.
  // Reserved for future category-based heuristics.
  void db; void dryRun;
  return { table: 'breadcrumbs', examined: 0, updated: 0, sampleChanges: [] };
}

// ───────────────────────────────────────────────────────────────────────────
// mem pin — force importance to 10 on a specific record.
// mem unpin — reset importance to table default.

const PIN_DEFAULTS: Record<string, number> = {
  messages: 5,
  decisions: 5,
  learnings: 5,
  breadcrumbs: 5,
  loa_entries: 8,
};

const PIN_TABLES = ['messages', 'decisions', 'learnings', 'breadcrumbs', 'loa_entries'] as const;
type PinTable = typeof PIN_TABLES[number];

function isPinTable(t: string): t is PinTable {
  return (PIN_TABLES as readonly string[]).includes(t);
}

export function runPin(table: string, id: number, value?: number): void {
  if (!isPinTable(table)) {
    console.error(`Unknown table: ${table}. Use one of: ${PIN_TABLES.join(', ')}`);
    process.exit(1);
  }
  const importance = clampImportance(value, 10);
  // LoA floor enforcement applies to direct pins too
  const applied = table === 'loa_entries' ? Math.max(5, importance) : importance;
  const ok = pinRecord(table, id, applied);
  if (ok) {
    console.log(`Pinned ${table}#${id} → importance=${applied}`);
  } else {
    console.error(`No record found: ${table}#${id}`);
    process.exit(1);
  }
}

export function runUnpin(table: string, id: number): void {
  if (!isPinTable(table)) {
    console.error(`Unknown table: ${table}. Use one of: ${PIN_TABLES.join(', ')}`);
    process.exit(1);
  }
  const defaultVal = PIN_DEFAULTS[table];
  const ok = pinRecord(table, id, defaultVal);
  if (ok) {
    console.log(`Unpinned ${table}#${id} → importance=${defaultVal} (default)`);
  } else {
    console.error(`No record found: ${table}#${id}`);
    process.exit(1);
  }
}
