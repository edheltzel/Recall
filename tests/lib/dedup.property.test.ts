// Property-based tests for dedup invariants (issue #44 phase 2; dedup from
// issue #45, merged in PR #60).
//
// Every oracle is computed from generator inputs only (the tuple-multiset
// pattern from PR #57). Duplicate groups are built structurally: each group
// has a canonical lowercase single-spaced text and members vary only by
// case/whitespace/quoting, so expected grouping is generator-known without
// calling normalizeText. The survivor comparator and cosine similarity are
// restated from the issue #45 spec (provenance > richness > importance >
// recency > lowest id; cos of the angle difference), never read back from
// the implementation.
//
// Scope note: the one-hop lineage guarantee holds WITHIN a single plan ("a
// planned survivor never re-marked" — the PR #60 blocker fix) AND across
// runs (issue #63 sticky survivors: a survivor recorded in dedup_lineage is
// never re-marked by a later run, so every hidden or deleted record keeps a
// visible survivor). The repeated-runs property asserts auditability
// (uniqueness, record preservation, no re-marking of marked records); the
// cross-run sticky-survivor property below pins the cross-run invariant.
//
// Generator sizes are bounded (≤5 groups × ≤4 members) so the suite stays
// practical under normal `bun test` runs.

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import fc from 'fast-check';
import {
  applyDedupPlan,
  MIN_DEDUP_TEXT_LENGTH,
  planDedup,
  type DedupPlan,
} from '../../src/lib/dedup';
import { embeddingToBlob } from '../../src/lib/embeddings';
import { createMemoryDb } from '../helpers/memdb';

type Prov = 'user_authored' | 'verbatim' | 'extracted' | 'derived' | null;
type DedupTestTable = 'breadcrumbs' | 'decisions';

// Spec restated (issue #45 / ADR-0001): survivor priority order, unknown
// (NULL) last. Deliberately not imported from src/types so a reordering
// regression fails here instead of silently reordering the oracle too.
const SURVIVOR_PRIORITY = ['user_authored', 'verbatim', 'extracted', 'derived'] as const;
const specRank = (p: Prov): number =>
  p === null ? SURVIVOR_PRIORITY.length : SURVIVOR_PRIORITY.indexOf(p);

interface InsRecord {
  table: DedupTestTable;
  id: number;
  project: string | null;
  provenance: Prov;
  importance: number;
  createdAt: string;
  /** Generator-known normalized text (the group canonical). */
  normalized: string;
  angleDeg: number;
}

// Spec comparator: provenance rank, richness (longer normalized text),
// importance, recency (lexicographic created_at desc), lowest id.
function specCompare(a: InsRecord, b: InsRecord): number {
  const rank = specRank(a.provenance) - specRank(b.provenance);
  if (rank !== 0) return rank;
  if (a.normalized.length !== b.normalized.length) return b.normalized.length - a.normalized.length;
  if (a.importance !== b.importance) return b.importance - a.importance;
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
  return a.id - b.id;
}

// Cosine of two unit vectors at the generated angles — pure math over
// generator inputs. Stored vectors round-trip through float32 blobs, so
// comparisons against implementation output use F32_TOLERANCE.
const specCos = (aDeg: number, bDeg: number): number =>
  Math.cos(((aDeg - bDeg) * Math.PI) / 180);
const F32_TOLERANCE = 1e-4;

const provArb = fc.constantFrom<Prov>('user_authored', 'verbatim', 'extracted', 'derived', null);
const importanceArb = fc.integer({ min: 1, max: 10 });
const dayArb = fc.integer({ min: 1, max: 28 });
const angleArb = fc.integer({ min: 0, max: 359 });

const createdAt = (day: number): string => `2026-01-${String(day).padStart(2, '0')} 12:00:00`;

// Canonical group text: lowercase, single-spaced — its own normalized form.
const canonical = (groupIdx: number): string => `dedup group ${groupIdx} canonical body text`;

interface GenMember {
  table: DedupTestTable;
  project: 'p-a' | 'p-b' | null;
  provenance: Prov;
  importance: number;
  day: number;
  angleDeg: number;
  upper: boolean;
  pad: boolean;
  quote: boolean;
}

// Members vary only by case, whitespace, and quoting — all of which the
// documented normalization erases — so every member of a group shares the
// canonical normalized text by construction.
function decorate(text: string, m: GenMember): string {
  let t = text;
  if (m.upper) t = t.toUpperCase();
  if (m.pad) t = `  ${t.split(' ').join('  ')}  `;
  if (m.quote) t = `"${t}"`;
  return t;
}

const memberArb: fc.Arbitrary<GenMember> = fc.record({
  table: fc.constantFrom<DedupTestTable>('breadcrumbs', 'decisions'),
  project: fc.constantFrom<'p-a' | 'p-b' | null>('p-a', 'p-b', null),
  provenance: provArb,
  importance: importanceArb,
  day: dayArb,
  angleDeg: angleArb,
  upper: fc.boolean(),
  pad: fc.boolean(),
  quote: fc.boolean(),
});

interface GenCorpus {
  groups: GenMember[][];
  /** Records below MIN_DEDUP_TEXT_LENGTH — must never become candidates. */
  shorts: number;
}

const corpusArb: fc.Arbitrary<GenCorpus> = fc.record({
  groups: fc.array(fc.array(memberArb, { minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 5 }),
  shorts: fc.integer({ min: 0, max: 2 }),
});

function insertRecord(
  db: Database,
  table: DedupTestTable,
  text: string,
  m: Pick<GenMember, 'project' | 'provenance' | 'importance' | 'day'>
): number {
  const sql = table === 'breadcrumbs'
    ? `INSERT INTO breadcrumbs (content, project, importance, provenance, created_at) VALUES (?, ?, ?, ?, ?)`
    : `INSERT INTO decisions (decision, project, importance, provenance, created_at) VALUES (?, ?, ?, ?, ?)`;
  const result = db.prepare(sql).run(text, m.project, m.importance, m.provenance, createdAt(m.day));
  return result.lastInsertRowid as number;
}

function insertCorpus(db: Database, corpus: GenCorpus): InsRecord[] {
  const records: InsRecord[] = [];
  corpus.groups.forEach((members, groupIdx) => {
    const base = canonical(groupIdx);
    expect(base.length).toBeGreaterThanOrEqual(MIN_DEDUP_TEXT_LENGTH); // generator validity guard
    for (const m of members) {
      const id = insertRecord(db, m.table, decorate(base, m), m);
      records.push({
        table: m.table,
        id,
        project: m.project,
        provenance: m.provenance,
        importance: m.importance,
        createdAt: createdAt(m.day),
        normalized: base,
        angleDeg: m.angleDeg,
      });
    }
  });
  for (let i = 0; i < corpus.shorts; i++) {
    insertRecord(db, 'breadcrumbs', 'tiny note', { project: null, provenance: null, importance: 5, day: 1 });
  }
  return records;
}

function insertEmbeddings(db: Database, records: InsRecord[]): void {
  const stmt = db.prepare(
    `INSERT INTO embeddings (source_table, source_id, model, dimensions, embedding) VALUES (?, ?, 'test', 2, ?)`
  );
  for (const r of records) {
    const rad = (r.angleDeg * Math.PI) / 180;
    stmt.run(r.table, r.id, embeddingToBlob([Math.cos(rad), Math.sin(rad)]));
  }
}

type LineageTuple = [string, number, string, number, string, number | null];

const sortedTuples = (tuples: LineageTuple[]): string[] =>
  tuples.map(t => JSON.stringify(t)).sort();

function plannedTuples(plan: DedupPlan): LineageTuple[] {
  return plan.tables.flatMap(t => t.planned).map(e =>
    [e.survivor_table, e.survivor_id, e.duplicate_table, e.duplicate_id, e.reason, e.similarity] as LineageTuple
  );
}

// Generator oracle for the exact pass: group by (table, project, canonical),
// survivor by the spec comparator, one lineage tuple per other member.
function expectedExactTuples(records: InsRecord[]): LineageTuple[] {
  const byKey = new Map<string, InsRecord[]>();
  for (const r of records) {
    const k = `${r.table}|${r.project ?? '<null>'}|${r.normalized}`;
    const group = byKey.get(k);
    if (group) group.push(r);
    else byKey.set(k, [r]);
  }
  const tuples: LineageTuple[] = [];
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort(specCompare);
    for (const dup of sorted.slice(1)) {
      tuples.push([sorted[0].table, sorted[0].id, dup.table, dup.id, 'exact', 1]);
    }
  }
  return tuples;
}

const SNAPSHOT_TABLES = [
  'sessions', 'messages', 'decisions', 'learnings', 'breadcrumbs', 'loa_entries', 'dedup_lineage', 'embeddings',
];

function snapshot(db: Database): string {
  return JSON.stringify(
    SNAPSHOT_TABLES.map(t => [t, db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()])
  );
}

function markedLineageTuples(db: Database): LineageTuple[] {
  const rows = db.prepare(
    `SELECT survivor_table, survivor_id, duplicate_table, duplicate_id, reason, similarity
     FROM dedup_lineage WHERE status = 'marked'`
  ).all() as Array<{
    survivor_table: string; survivor_id: number;
    duplicate_table: string; duplicate_id: number;
    reason: string; similarity: number | null;
  }>;
  return rows.map(r =>
    [r.survivor_table, r.survivor_id, r.duplicate_table, r.duplicate_id, r.reason, r.similarity] as LineageTuple
  );
}

function withDb<T>(fn: (db: Database) => T): T {
  const db = createMemoryDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

describe('dedup exact-pass properties', () => {
  test('planned lineage is exactly the generator-expected (survivor, duplicate) tuple multiset; non-duplicates and too-short records never appear', () => {
    fc.assert(
      fc.property(corpusArb, corpus => {
        withDb(db => {
          const records = insertCorpus(db, corpus);
          const plan = planDedup(db, { semantic: false });

          // Tuple-multiset equality pins survivor order under arbitrary
          // provenance mixes AND non-duplicate preservation in one oracle:
          // singletons and short records appear in no expected tuple.
          expect(sortedTuples(plannedTuples(plan))).toEqual(sortedTuples(expectedExactTuples(records)));

          for (const table of ['breadcrumbs', 'decisions'] as const) {
            const report = plan.tables.find(t => t.table === table)!;
            const inserted = records.filter(r => r.table === table).length
              + (table === 'breadcrumbs' ? corpus.shorts : 0);
            expect(report.scanned).toBe(inserted);
            if (table === 'breadcrumbs') expect(report.tooShort).toBe(corpus.shorts);
          }
        });
      })
    );
  });
});

describe('dedup semantic threshold properties', () => {
  interface SemRecord {
    angleDeg: number;
    extraLen: number;
    provenance: Prov;
    importance: number;
    day: number;
  }
  const semRecordArb: fc.Arbitrary<SemRecord> = fc.record({
    angleDeg: angleArb,
    extraLen: fc.integer({ min: 0, max: 30 }),
    provenance: provArb,
    importance: importanceArb,
    day: dayArb,
  });
  const semCorpusArb = fc.array(semRecordArb, { minLength: 2, maxLength: 7 });

  // Unique texts (no exact groups), varied lengths (richness tie-breaker is
  // live, unlike exact groups where normalized lengths are equal by
  // definition), one table + project so every pair is actionable.
  function insertSemCorpus(db: Database, corpus: SemRecord[]): InsRecord[] {
    const records: InsRecord[] = corpus.map((r, i) => {
      const text = `semantic record ${i} body text${'x'.repeat(r.extraLen)}`;
      const id = insertRecord(db, 'breadcrumbs', text, { project: null, ...r });
      return {
        table: 'breadcrumbs' as const,
        id,
        project: null,
        provenance: r.provenance,
        importance: r.importance,
        createdAt: createdAt(r.day),
        normalized: text,
        angleDeg: r.angleDeg,
      };
    });
    insertEmbeddings(db, records);
    return records;
  }

  test('a threshold above every pairwise similarity plans nothing — never merge below the threshold', () => {
    fc.assert(
      fc.property(semCorpusArb, fc.integer({ min: 1, max: 10 }), (corpus, gapPct) => {
        withDb(db => {
          insertSemCorpus(db, corpus);
          let maxSim = -1;
          for (let i = 0; i < corpus.length; i++) {
            for (let j = i + 1; j < corpus.length; j++) {
              maxSim = Math.max(maxSim, specCos(corpus[i].angleDeg, corpus[j].angleDeg));
            }
          }
          const plan = planDedup(db, { semantic: true, threshold: maxSim + gapPct / 100 });
          expect(plannedTuples(plan)).toEqual([]);
        });
      })
    );
  });

  test('every planned semantic pair is at/above the threshold, records its true similarity, and keeps the spec-ordered survivor', () => {
    fc.assert(
      fc.property(semCorpusArb, fc.integer({ min: 30, max: 99 }), (corpus, thresholdPct) => {
        withDb(db => {
          const records = insertSemCorpus(db, corpus);
          const byId = new Map(records.map(r => [r.id, r]));
          const threshold = thresholdPct / 100;
          const plan = planDedup(db, { semantic: true, threshold });

          for (const entry of plan.tables.flatMap(t => t.planned)) {
            expect(entry.reason).toBe('semantic');
            const survivor = byId.get(entry.survivor_id)!;
            const duplicate = byId.get(entry.duplicate_id)!;
            const expectedSim = specCos(survivor.angleDeg, duplicate.angleDeg);
            expect(expectedSim).toBeGreaterThanOrEqual(threshold - F32_TOLERANCE);
            expect(Math.abs((entry.similarity ?? 0) - expectedSim)).toBeLessThanOrEqual(F32_TOLERANCE);
            expect(specCompare(survivor, duplicate)).toBeLessThan(0);
          }
        });
      })
    );
  });

  // Completeness, not soundness. The two tests above only constrain what IS
  // planned (nothing below threshold, correct survivor/similarity) — they stay
  // green even if findSemanticPairs dropped every pair. This exactly-determined
  // two-record corpus pins the other direction: the single possible pair sits a
  // fixed margin above the threshold, so it MUST be found. A dropped-pair
  // regression (e.g. an off-by-one in the O(n^2) scan, or `>=` → `>`) fails here.
  test('completeness: an exactly-determined pair above the threshold is always found', () => {
    fc.assert(
      fc.property(
        angleArb,
        fc.integer({ min: 0, max: 30 }), // separation in degrees → cos ∈ [cos 30°, 1]
        semRecordArb,
        semRecordArb,
        (angleA, separationDeg, recA, recB) => {
          withDb(db => {
            const angleB = (angleA + separationDeg) % 360;
            const records = insertSemCorpus(db, [
              { ...recA, angleDeg: angleA },
              { ...recB, angleDeg: angleB },
            ]);
            const trueSim = specCos(angleA, angleB);
            // A 0.05 margin below the true similarity dwarfs F32_TOLERANCE, so
            // the float32-stored similarity is guaranteed to clear the threshold.
            const threshold = trueSim - 0.05;
            const planned = planDedup(db, { semantic: true, threshold }).tables.flatMap(t => t.planned);

            expect(planned.length).toBe(1);
            const entry = planned[0];
            expect(entry.reason).toBe('semantic');
            const survivor = records.find(r => r.id === entry.survivor_id);
            const duplicate = records.find(r => r.id === entry.duplicate_id);
            expect(survivor).toBeDefined();
            expect(duplicate).toBeDefined();
            expect(entry.survivor_id).not.toBe(entry.duplicate_id);
            // The found pair still keeps the spec-ordered survivor and records
            // its true similarity — completeness without regressing soundness.
            expect(specCompare(survivor!, duplicate!)).toBeLessThan(0);
            expect(Math.abs((entry.similarity ?? 0) - trueSim)).toBeLessThanOrEqual(F32_TOLERANCE);
          });
        }
      )
    );
  });
});

describe('dedup one-hop lineage and write-freeness', () => {
  const thresholdArb = fc.integer({ min: 50, max: 99 }).map(n => n / 100);

  test('within a plan, survivor and duplicate key sets are disjoint and every duplicate is marked at most once', () => {
    fc.assert(
      fc.property(corpusArb, thresholdArb, (corpus, threshold) => {
        withDb(db => {
          const records = insertCorpus(db, corpus);
          insertEmbeddings(db, records);
          const entries = planDedup(db, { semantic: true, threshold }).tables.flatMap(t => t.planned);

          const duplicateKeys = entries.map(e => `${e.duplicate_table}:${e.duplicate_id}`);
          const duplicateSet = new Set(duplicateKeys);
          expect(duplicateKeys.length).toBe(duplicateSet.size);
          for (const e of entries) {
            // A planned survivor is never re-marked — lineage stays one hop.
            expect(duplicateSet.has(`${e.survivor_table}:${e.survivor_id}`)).toBe(false);
          }
        });
      })
    );
  });

  test('planDedup is write-free: the database is byte-identical before and after planning', () => {
    fc.assert(
      fc.property(corpusArb, thresholdArb, (corpus, threshold) => {
        withDb(db => {
          const records = insertCorpus(db, corpus);
          insertEmbeddings(db, records);
          const before = snapshot(db);
          planDedup(db, { semantic: true, threshold });
          expect(snapshot(db)).toBe(before);
        });
      })
    );
  });
});

describe('dedup apply, idempotence, and repeated-run auditability', () => {
  test('apply marks exactly the planned tuples, preserves every record, and a re-plan finds nothing (exact pass)', () => {
    fc.assert(
      fc.property(corpusArb, corpus => {
        withDb(db => {
          const records = insertCorpus(db, corpus);
          const expected = sortedTuples(expectedExactTuples(records));

          const plan1 = planDedup(db, { semantic: false });
          const result1 = applyDedupPlan(db, plan1);
          expect(result1).toEqual({ marked: expected.length, deleted: 0, fkProtected: 0 });
          expect(sortedTuples(markedLineageTuples(db))).toEqual(expected);

          // Non-destructive default: every generated record is still there.
          for (const table of ['breadcrumbs', 'decisions'] as const) {
            const inserted = records.filter(r => r.table === table).length
              + (table === 'breadcrumbs' ? corpus.shorts : 0);
            const { c } = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
            expect(c).toBe(inserted);
          }

          // Idempotence: marked duplicates are excluded, surviving groups
          // are singletons, so the second plan is empty and changes nothing.
          const plan2 = planDedup(db, { semantic: false });
          expect(plannedTuples(plan2)).toEqual([]);
          for (const table of ['breadcrumbs', 'decisions'] as const) {
            const report = plan2.tables.find(t => t.table === table)!;
            const expectedMarked = expectedExactTuples(records)
              .filter(t => t[2] === table).length;
            expect(report.alreadyMarked).toBe(expectedMarked);
          }
          expect(applyDedupPlan(db, plan2)).toEqual({ marked: 0, deleted: 0, fkProtected: 0 });
          expect(sortedTuples(markedLineageTuples(db))).toEqual(expected);
        });
      })
    );
  });

  test('repeated semantic plan/apply cycles stay auditable: unique active marks, no re-marking, all records preserved', () => {
    fc.assert(
      fc.property(corpusArb, fc.integer({ min: 50, max: 99 }).map(n => n / 100), (corpus, threshold) => {
        withDb(db => {
          const records = insertCorpus(db, corpus);
          insertEmbeddings(db, records);
          const totalRows = (table: DedupTestTable): number =>
            records.filter(r => r.table === table).length + (table === 'breadcrumbs' ? corpus.shorts : 0);

          applyDedupPlan(db, planDedup(db, { semantic: true, threshold }));
          const markedAfterFirst = new Set(
            markedLineageTuples(db).map(t => `${t[2]}:${t[3]}`)
          );

          const plan2 = planDedup(db, { semantic: true, threshold });
          // Already-marked records are excluded from later runs entirely.
          for (const e of plan2.tables.flatMap(t => t.planned)) {
            expect(markedAfterFirst.has(`${e.duplicate_table}:${e.duplicate_id}`)).toBe(false);
            expect(markedAfterFirst.has(`${e.survivor_table}:${e.survivor_id}`)).toBe(false);
          }
          applyDedupPlan(db, plan2);

          // Each record is an actively marked duplicate at most once, and
          // the non-destructive default never removes rows.
          const allMarked = markedLineageTuples(db).map(t => `${t[2]}:${t[3]}`);
          expect(allMarked.length).toBe(new Set(allMarked).size);
          for (const table of ['breadcrumbs', 'decisions'] as const) {
            const { c } = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
            expect(c).toBe(totalRows(table));
          }
        });
      })
    );
  });
});

describe('dedup cross-run sticky survivors (issue #63)', () => {
  const thresholdArb = fc.integer({ min: 50, max: 99 }).map(n => n / 100);

  // A challenger shadows one wave-1 record: same table, project, and
  // embedding angle (so it pairs at/above any threshold with whatever
  // visible record that angle reaches — recorded survivors included), with
  // top provenance, importance, and richness so it out-ranks incumbents.
  // Without sticky survivors, a challenger landing on a recorded survivor
  // re-marks it — exactly the issue #63 hazard.
  interface Challenger {
    /** Index into the wave-1 records (mod length). */
    target: number;
    extraLen: number;
    day: number;
  }
  const challengerArb: fc.Arbitrary<Challenger> = fc.record({
    target: fc.nat({ max: 30 }),
    extraLen: fc.integer({ min: 40, max: 60 }),
    day: dayArb,
  });

  function insertChallengers(db: Database, challengers: Challenger[], wave1: InsRecord[]): void {
    const records: InsRecord[] = challengers.map((c, i) => {
      const target = wave1[c.target % wave1.length];
      const text = `cross-run challenger ${i} body text ${'x'.repeat(c.extraLen)}`;
      // Wave-1 records all come from GenMember, so the project narrowing is sound.
      const meta = {
        project: target.project as GenMember['project'],
        provenance: 'user_authored' as Prov,
        importance: 10,
        day: c.day,
      };
      const id = insertRecord(db, target.table, text, meta);
      return {
        table: target.table,
        id,
        project: target.project,
        provenance: meta.provenance,
        importance: meta.importance,
        createdAt: createdAt(c.day),
        normalized: text,
        angleDeg: target.angleDeg,
      };
    });
    insertEmbeddings(db, records);
  }

  test('a recorded survivor is never re-marked by a later run, in plan or in final lineage', () => {
    fc.assert(
      fc.property(
        corpusArb,
        corpusArb,
        fc.array(challengerArb, { minLength: 1, maxLength: 3 }),
        thresholdArb,
        (wave1Corpus, wave2Corpus, challengers, threshold) => {
          withDb(db => {
            const wave1 = insertCorpus(db, wave1Corpus);
            insertEmbeddings(db, wave1);
            applyDedupPlan(db, planDedup(db, { semantic: true, threshold }));
            const survivorsAfterRun1 = new Set(
              markedLineageTuples(db).map(t => `${t[0]}:${t[1]}`)
            );

            // Wave 2 arrives between runs: a second corpus reusing the same
            // canonical texts (new members join wave-1 exact groups and can
            // out-rank the recorded survivor) plus angle-targeted semantic
            // challengers.
            const wave2 = insertCorpus(db, wave2Corpus);
            insertEmbeddings(db, wave2);
            insertChallengers(db, challengers, wave1);

            // Sticky: run 2 never plans a run-1 survivor as a duplicate.
            const plan2 = planDedup(db, { semantic: true, threshold });
            for (const e of plan2.tables.flatMap(t => t.planned)) {
              expect(survivorsAfterRun1.has(`${e.duplicate_table}:${e.duplicate_id}`)).toBe(false);
            }
            applyDedupPlan(db, plan2);

            // Visible-survivor property over the final lineage: no record is
            // both a recorded survivor and an actively marked duplicate, so
            // every hidden record's survivor is itself visible.
            const finalTuples = markedLineageTuples(db);
            const markedDupKeys = new Set(finalTuples.map(t => `${t[2]}:${t[3]}`));
            for (const t of finalTuples) {
              expect(markedDupKeys.has(`${t[0]}:${t[1]}`)).toBe(false);
            }
          });
        }
      )
    );
  });

  test('destructive apply refuses, without writing, a plan that would delete a recorded survivor (defense-in-depth)', () => {
    withDb(db => {
      // Real run 1: an exact pair — the user-authored record survives.
      const idA = insertRecord(db, 'breadcrumbs', canonical(0), {
        project: null, provenance: 'user_authored', importance: 10, day: 1,
      });
      insertRecord(db, 'breadcrumbs', canonical(0), {
        project: null, provenance: null, importance: 5, day: 1,
      });
      applyDedupPlan(db, planDedup(db, { semantic: false }));
      expect(markedLineageTuples(db).map(t => `${t[0]}:${t[1]}`)).toEqual([`breadcrumbs:${idA}`]);

      // Handcrafted plan claiming the recorded survivor as a duplicate —
      // planDedup never produces this (the sticky-survivor exclusion), so
      // the guard is exercised directly.
      const idC = insertRecord(db, 'breadcrumbs', canonical(1), {
        project: null, provenance: 'user_authored', importance: 10, day: 2,
      });
      const plan: DedupPlan = {
        threshold: 0.95,
        semanticSkipped: null,
        crossTable: { textMatches: [], semanticPairs: 0 },
        tables: [{
          table: 'breadcrumbs',
          scanned: 0,
          tooShort: 0,
          alreadyMarked: 0,
          stickySkipped: 0,
          exactGroups: 0,
          semanticPairs: 1,
          planned: [{
            survivor_table: 'breadcrumbs',
            survivor_id: idC,
            duplicate_table: 'breadcrumbs',
            duplicate_id: idA,
            reason: 'semantic',
            similarity: 0.99,
            detail: '{}',
          }],
        }],
      };

      const before = snapshot(db);
      expect(() => applyDedupPlan(db, plan, { destructive: true })).toThrow(/destructive dedup refused/);
      expect(snapshot(db)).toBe(before);
    });
  });

  test("a survivor recorded by a destructive run ('deleted' lineage) is sticky: never re-planned, and the guard still refuses", () => {
    withDb(db => {
      // Run 1, destructive: exact pair — A survives, B is hard-deleted, so
      // the only lineage row carries status 'deleted' (not 'marked').
      const idA = insertRecord(db, 'breadcrumbs', canonical(0), {
        project: null, provenance: 'user_authored', importance: 10, day: 1,
      });
      insertRecord(db, 'breadcrumbs', canonical(0), {
        project: null, provenance: null, importance: 5, day: 1,
      });
      const run1 = applyDedupPlan(db, planDedup(db, { semantic: false }), { destructive: true });
      expect(run1).toEqual({ marked: 0, deleted: 1, fkProtected: 0 });
      const lineage = db.prepare(
        `SELECT survivor_id, status FROM dedup_lineage`
      ).all() as Array<{ survivor_id: number; status: string }>;
      expect(lineage).toEqual([{ survivor_id: idA, status: 'deleted' }]);

      // Run 2: an equally-ranked but newer exact duplicate of A arrives and
      // wins the group on recency — without 'deleted'-status stickiness, A
      // (the only visible trace of hard-deleted B) would be re-marked.
      const idC = insertRecord(db, 'breadcrumbs', canonical(0), {
        project: null, provenance: 'user_authored', importance: 10, day: 2,
      });
      const plan2 = planDedup(db, { semantic: false });
      expect(plan2.tables.flatMap(t => t.planned)).toEqual([]);
      expect(plan2.tables.find(t => t.table === 'breadcrumbs')!.stickySkipped).toBe(1);

      // Defense-in-depth shares the same loader: a handcrafted destructive
      // plan against the 'deleted'-row survivor must still refuse.
      const handcrafted: DedupPlan = {
        threshold: 0.95,
        semanticSkipped: null,
        crossTable: { textMatches: [], semanticPairs: 0 },
        tables: [{
          table: 'breadcrumbs',
          scanned: 0,
          tooShort: 0,
          alreadyMarked: 0,
          stickySkipped: 0,
          exactGroups: 1,
          semanticPairs: 0,
          planned: [{
            survivor_table: 'breadcrumbs',
            survivor_id: idC,
            duplicate_table: 'breadcrumbs',
            duplicate_id: idA,
            reason: 'exact',
            similarity: 1.0,
            detail: '{}',
          }],
        }],
      };
      const before = snapshot(db);
      expect(() => applyDedupPlan(db, handcrafted, { destructive: true })).toThrow(/destructive dedup refused/);
      expect(snapshot(db)).toBe(before);
    });
  });
});
