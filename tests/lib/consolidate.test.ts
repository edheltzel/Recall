// recall consolidate — planner + CLI dry-run/execute gate (issue #141, Phase B of #53).
//
// Behavior under test (src half only — no model, no subprocess):
// - planConsolidate: deterministic clustering of eligible decisions/learnings
//   (old + importance<threshold + un-pinned), grouped per project + time window,
//   excluding pins, recorded survivors, marked duplicates, recent, and
//   above-threshold rows; LoA is never scanned.
// - runConsolidate dry-run (default): makes NO model call / NO apply / NO writes.
// - runConsolidate --execute: hands the plan to the injected apply seam.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { getDb } from '../../src/db/connection';
import { addDecision, addLearning, createLoaEntry } from '../../src/lib/memory';
import { planConsolidate, type ConsolidatePlan } from '../../src/lib/consolidate';
import {
  runConsolidate,
  type ConsolidateApplyResult,
} from '../../src/commands/consolidate';
import type { LineageStatus } from '../../src/lib/dedup';

const originalLog = console.log;
const originalError = console.error;
const originalExitCode = process.exitCode;

// Far outside the default 180d age window.
const OLD = '2020-01-01 00:00:00';

let logged: string[] = [];

beforeEach(() => {
  setupTestDb();
  logged = [];
  console.log = (...args: unknown[]) => { logged.push(args.join(' ')); };
  console.error = (...args: unknown[]) => { logged.push(args.join(' ')); };
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  process.exitCode = originalExitCode ?? 0;
  teardownTestDb();
});

function makeOld(table: string, id: number): void {
  getDb().prepare(`UPDATE ${table} SET created_at = ? WHERE id = ?`).run(OLD, id);
}
function importanceOf(table: string, id: number): number {
  return (getDb().prepare(`SELECT importance AS i FROM ${table} WHERE id = ?`).get(id) as { i: number }).i;
}
function rowExists(table: string, id: number): boolean {
  return getDb().prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) != null;
}
function recordLineage(
  survivorTable: string, survivorId: number,
  duplicateTable: string, duplicateId: number,
  status: LineageStatus = 'marked',
): void {
  getDb().prepare(
    `INSERT INTO dedup_lineage
       (survivor_table, survivor_id, duplicate_table, duplicate_id, reason, similarity, status, detail)
     VALUES (?, ?, ?, ?, 'exact', NULL, ?, '{}')`
  ).run(survivorTable, survivorId, duplicateTable, duplicateId, status);
}
/** Insert an old, eligible decision in project 'p' with the given text/importance. */
function oldDecision(text: string, importance = 3): number {
  const id = addDecision({ decision: text, status: 'active', project: 'p', importance });
  makeOld('decisions', id);
  return id;
}

describe('planConsolidate — deterministic clustering', () => {
  test('clusters eligible decisions; excludes pins, recent, above-threshold, survivors, marked-dups, and LoA', () => {
    // 3 eligible old low decisions in one project/window → one cluster.
    // Distinct text lengths so the representative is deterministic (richest).
    const a = oldDecision('aaa');                 // shortest
    const b = oldDecision('aaaaaa');
    const rep = oldDecision('aaaaaaaaaaaa');       // longest → representative

    // Excluded rows.
    const pinned = oldDecision('pinned decision', 10);
    const recent = addDecision({ decision: 'recent low', status: 'active', project: 'p', importance: 3 });
    const aboveThreshold = oldDecision('exactly at threshold', 5);

    // Recorded survivor + marked duplicate → both withheld (protected).
    const survivor = oldDecision('survivor decision');
    const markedDup = oldDecision('marked dup decision');
    recordLineage('decisions', survivor, 'decisions', markedDup, 'marked');

    // LoA is never a source table — an old low LoA must not be scanned.
    const loa = createLoaEntry({ title: 'curated', fabric_extract: 'x', project: 'p', importance: 4 });
    makeOld('loa_entries', loa);

    const plan = planConsolidate(getDb());

    expect(plan.clusters.length).toBe(1);
    const cluster = plan.clusters[0];
    expect(cluster.table).toBe('decisions');
    expect(cluster.project).toBe('p');
    expect(new Set(cluster.records.map((r) => r.id))).toEqual(new Set([a, b, rep]));
    expect(cluster.representativeId).toBe(rep);
    // Every demote target is the clamped floor (1).
    expect(cluster.records.every((r) => r.newImportance === 1)).toBe(true);
    // survivor + markedDup matched the filter but were guard-withheld.
    expect(plan.protectedCount).toBe(2);

    // No cluster references the excluded ids or the LoA table.
    const allIds = plan.clusters.flatMap((c) => c.records.map((r) => r.id));
    for (const id of [pinned, recent, aboveThreshold, survivor, markedDup]) {
      expect(allIds).not.toContain(id);
    }
    expect(plan.clusters.every((c) => c.table === 'decisions' || c.table === 'learnings')).toBe(true);
  });

  test('min cluster size is respected — a 2-record bucket forms no cluster', () => {
    const l1 = addLearning({ problem: 'learning one', project: 'q', importance: 2 });
    const l2 = addLearning({ problem: 'learning two', project: 'q', importance: 2 });
    makeOld('learnings', l1);
    makeOld('learnings', l2);

    const plan = planConsolidate(getDb()); // default minClusterSize = 3
    expect(plan.clusters.length).toBe(0);

    const plan2 = planConsolidate(getDb(), { minClusterSize: 2 });
    expect(plan2.clusters.length).toBe(1);
    expect(plan2.clusters[0].table).toBe('learnings');
  });

  test('separate projects bucket into separate clusters', () => {
    for (const proj of ['p', 'q']) {
      for (let i = 0; i < 3; i++) {
        const id = addDecision({ decision: `${proj} decision ${i}`, status: 'active', project: proj, importance: 3 });
        makeOld('decisions', id);
      }
    }
    const plan = planConsolidate(getDb());
    expect(plan.clusters.length).toBe(2);
    expect(new Set(plan.clusters.map((c) => c.project))).toEqual(new Set(['p', 'q']));
  });
});

describe('runConsolidate — dry-run / execute gate', () => {
  function spyApply() {
    const calls: ConsolidatePlan[] = [];
    const fake: ConsolidateApplyResult = { written: 0, demoted: 0, redactions: [], skipped: [] };
    return {
      calls,
      apply: async (plan: ConsolidatePlan) => { calls.push(plan); return fake; },
    };
  }

  test('dry-run makes no apply/model call and writes nothing', async () => {
    const ids = [oldDecision('alpha'), oldDecision('beta'), oldDecision('gamma')];
    const spy = spyApply();

    const result = await runConsolidate({}, { apply: spy.apply });

    expect(spy.calls.length).toBe(0);                 // no subprocess / no model
    expect(result!.applied).toBeNull();
    for (const id of ids) {
      expect(rowExists('decisions', id)).toBe(true);  // nothing deleted
      expect(importanceOf('decisions', id)).toBe(3);  // nothing demoted
    }
    expect(logged.join('\n')).toContain('DRY RUN');
    expect(logged.join('\n')).toContain('Re-run with --execute');
  });

  test('--execute hands the plan to the apply seam', async () => {
    oldDecision('alpha'); oldDecision('beta'); oldDecision('gamma');
    const spy = spyApply();

    await runConsolidate({ execute: true }, { apply: spy.apply });

    expect(spy.calls.length).toBe(1);
    expect(spy.calls[0].clusters.length).toBe(1);
    expect(logged.join('\n')).toContain('EXECUTE');
    expect(logged.join('\n')).toContain("recall export --backup"); // backup nudge
  });

  test('invalid --table fails cleanly without calling apply', async () => {
    const spy = spyApply();
    const result = await runConsolidate({ execute: true, table: 'messages' }, { apply: spy.apply });
    expect(result).toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(spy.calls.length).toBe(0);
  });
});
