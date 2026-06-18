// Tests for Suite C — precision under noise.
//
// Coverage per the issue spec: fixture determinism, ground-truth label
// consistency, metric calculation, and report generation. Mirrors the
// suite-b.test.ts approach: assert SHAPE and invariants, not absolute scores —
// the whole point of Suite C is that scores are an honest measurement, so the
// tests must not encode expectations about how well search ranks.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import {
  K,
  mulberry32,
  generateFixtureSpec,
  seedFixture,
  precisionAtK,
  recallAtK,
  reciprocalRank,
  percentile,
  mean,
  refKey,
  searchTableName,
} from '../../benchmarks/suites/suite-c-internals';
import { runSuiteC } from '../../benchmarks/suites/suite-c-precision-noise';
import { renderMarkdown } from '../../benchmarks/runner';
import { initDb, closeDb } from '../../src/db/connection';

const QUERY_CATEGORIES = ['exact_lookup', 'paraphrase', 'problem_lookup', 'ambiguous'] as const;

let savedDbPath: string | undefined;
let savedMemPath: string | undefined;
let tempDirs: string[] = [];

beforeEach(() => {
  savedDbPath = process.env.RECALL_DB_PATH;
  savedMemPath = process.env.MEM_DB_PATH;
});

afterEach(() => {
  closeDb();
  if (savedDbPath !== undefined) process.env.RECALL_DB_PATH = savedDbPath;
  else delete process.env.RECALL_DB_PATH;
  if (savedMemPath !== undefined) process.env.MEM_DB_PATH = savedMemPath;
  else delete process.env.MEM_DB_PATH;
  for (const dir of tempDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

/** Point RECALL_DB_PATH at a fresh initialized temp DB, ready for seedFixture. */
function seedIntoTempDb(): { dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'recall-suite-c-test-'));
  tempDirs.push(dir);
  const dbPath = join(dir, 'fixture.db');
  closeDb();
  process.env.RECALL_DB_PATH = dbPath;
  delete process.env.MEM_DB_PATH;
  initDb();
  return { dbPath };
}

/** Stable digest of corpus text content, independent of row IDs. */
function corpusDigest(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    const texts: string[] = [];
    const pull = (sql: string) => {
      for (const row of db.prepare(sql).all() as Array<{ t: string }>) texts.push(row.t);
    };
    pull('SELECT decision || COALESCE(reasoning, \'\') AS t FROM decisions');
    pull('SELECT problem || COALESCE(solution, \'\') AS t FROM learnings');
    pull('SELECT content AS t FROM breadcrumbs');
    pull('SELECT title || fabric_extract AS t FROM loa_entries');
    pull('SELECT content AS t FROM messages');
    texts.sort();
    return String(Bun.hash(texts.join('\u0000')));
  } finally {
    db.close();
  }
}

describe('Metric helpers', () => {
  const retrieved = [
    { table: 'decisions', id: 1 },
    { table: 'learnings', id: 2 },
    { table: 'decisions', id: 3 },
    { table: 'breadcrumbs', id: 4 },
    { table: 'loa', id: 5 },
  ];

  test('precisionAtK divides hits in top-k by k', () => {
    const relevant = new Set(['decisions#1', 'decisions#3']);
    expect(precisionAtK(retrieved, relevant, 5)).toBe(2 / 5);
    expect(precisionAtK(retrieved, relevant, 1)).toBe(1);
    expect(precisionAtK(retrieved, new Set(), 5)).toBe(0);
    expect(precisionAtK([], relevant, 5)).toBe(0);
    expect(precisionAtK(retrieved, relevant, 0)).toBe(0);
  });

  test('recallAtK divides retrieved relevant by total relevant', () => {
    const relevant = new Set(['decisions#1', 'learnings#2', 'messages#99']);
    expect(recallAtK(retrieved, relevant, 5)).toBe(2 / 3);
    expect(recallAtK(retrieved, relevant, 1)).toBe(1 / 3);
    expect(recallAtK(retrieved, new Set(), 5)).toBe(0);
  });

  test('reciprocalRank returns 1/rank of first relevant within k', () => {
    expect(reciprocalRank(retrieved, new Set(['decisions#1']), 5)).toBe(1);
    expect(reciprocalRank(retrieved, new Set(['decisions#3']), 5)).toBe(1 / 3);
    expect(reciprocalRank(retrieved, new Set(['loa#5']), 5)).toBe(1 / 5);
    // Relevant exists but is outside the top-k cutoff
    expect(reciprocalRank(retrieved, new Set(['loa#5']), 4)).toBe(0);
    expect(reciprocalRank(retrieved, new Set(['messages#99']), 5)).toBe(0);
  });

  test('percentile uses nearest-rank on a sorted copy', () => {
    const values = [5, 1, 4, 2, 3];
    expect(percentile(values, 50)).toBe(3);
    expect(percentile(values, 95)).toBe(5);
    expect(percentile(values, 100)).toBe(5);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBe(0);
    // Input must not be mutated
    expect(values).toEqual([5, 1, 4, 2, 3]);
  });

  test('mean averages, empty is 0', () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([])).toBe(0);
  });

  test('refKey and searchTableName align ground truth with search() identities', () => {
    expect(refKey('decisions', 7)).toBe('decisions#7');
    expect(searchTableName('loa_entries')).toBe('loa');
    expect(searchTableName('decisions')).toBe('decisions');
    expect(searchTableName('messages')).toBe('messages');
  });
});

describe('mulberry32 PRNG', () => {
  test('same seed produces the same sequence', () => {
    const a = mulberry32(47);
    const b = mulberry32(47);
    for (let i = 0; i < 10; i++) expect(a()).toBe(b());
  });

  test('different seeds diverge and values stay in [0,1)', () => {
    const a = mulberry32(47);
    const b = mulberry32(48);
    const av = Array.from({ length: 5 }, () => a());
    const bv = Array.from({ length: 5 }, () => b());
    expect(av).not.toEqual(bv);
    for (const v of [...av, ...bv]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('Fixture determinism', () => {
  test('same seed and size produce an identical spec', () => {
    const a = generateFixtureSpec(47, 500);
    const b = generateFixtureSpec(47, 500);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('different seeds produce different noise', () => {
    const a = generateFixtureSpec(47, 500);
    const b = generateFixtureSpec(48, 500);
    expect(JSON.stringify(a.records)).not.toBe(JSON.stringify(b.records));
  });

  test('record count matches the requested size', () => {
    expect(generateFixtureSpec(47, 100).records.length).toBe(100);
    expect(generateFixtureSpec(47, 1000).records.length).toBe(1000);
  });

  test('rejects sizes too small to hold targets and queries', () => {
    expect(() => generateFixtureSpec(47, 10)).toThrow();
  });

  test('seeding the same spec yields byte-identical corpus content', () => {
    const spec = generateFixtureSpec(47, 100);
    const first = seedIntoTempDb();
    seedFixture(spec);
    closeDb();
    const second = seedIntoTempDb();
    seedFixture(spec);
    closeDb();
    expect(corpusDigest(first.dbPath)).toBe(corpusDigest(second.dbPath));
  });
});

describe('Ground-truth label consistency', () => {
  const spec = generateFixtureSpec(47, 100);

  test('every expected key references a target record in the spec', () => {
    const targetKeys = new Set(spec.records.filter((r) => r.role === 'target').map((r) => r.key));
    for (const query of spec.queries) {
      expect(query.expected.length).toBeGreaterThan(0);
      for (const key of query.expected) {
        expect(targetKeys.has(key)).toBe(true);
      }
    }
  });

  test('project-scoped queries only expect records from that project', () => {
    const byKey = new Map(spec.records.map((r) => [r.key, r]));
    const scoped = spec.queries.filter((q) => q.project);
    expect(scoped.length).toBeGreaterThan(0);
    for (const query of scoped) {
      for (const key of query.expected) {
        expect(byKey.get(key)!.project).toBe(query.project!);
      }
    }
  });

  test('all four query categories are present and ambiguous queries carry collision labels', () => {
    const categories = new Set(spec.queries.map((q) => q.category));
    for (const category of QUERY_CATEGORIES) expect(categories.has(category)).toBe(true);
    for (const query of spec.queries) {
      if (query.category === 'ambiguous') {
        expect(query.collision).toBeDefined();
        expect(['name', 'project', 'topic']).toContain(query.collision!.kind);
      }
    }
  });

  test('targets are constant across corpus sizes', () => {
    const targetsAt = (size: number) =>
      JSON.stringify(generateFixtureSpec(47, size).records.filter((r) => r.role === 'target').sort((a, b) => a.key.localeCompare(b.key)));
    expect(targetsAt(100)).toBe(targetsAt(1000));
  });

  test('seeded targets resolve with matching table, project, and provenance', () => {
    seedIntoTempDb();
    const targets = seedFixture(spec);
    closeDb();
    const byKey = new Map(spec.records.map((r) => [r.key, r]));
    for (const query of spec.queries) {
      for (const key of query.expected) {
        const seeded = targets.get(key);
        expect(seeded).toBeDefined();
        const declared = byKey.get(key)!;
        expect(seeded!.table).toBe(declared.table);
        expect(seeded!.project).toBe(declared.project);
        expect(seeded!.provenance).toBe(declared.provenance);
        expect(seeded!.id).toBeGreaterThan(0);
      }
    }
  });
});

describe('Suite C — runSuiteC report generation', () => {
  test('returns the documented metric set per corpus size', async () => {
    const result = await runSuiteC({ sizes: [100], repeats: 2 });
    expect(result.suite).toBe('C');
    expect(result.name).toBe('Precision under noise');
    expect(result.caveats.length).toBeGreaterThan(0);

    const at = (name: string) => result.samples.find((s) => s.name === name && s.scope === 'corpus=100');
    for (const required of ['p_at_5', 'r_at_5', 'mrr', 'latency_p50_ms', 'latency_p95_ms']) {
      expect(at(required)).toBeDefined();
    }

    // Ratios stay in [0,1]; latencies are non-negative.
    for (const name of ['p_at_5', 'r_at_5', 'mrr']) {
      const sample = at(name)!;
      expect(sample.value).toBeGreaterThanOrEqual(0);
      expect(sample.value).toBeLessThanOrEqual(1);
    }
    expect(at('latency_p50_ms')!.value).toBeGreaterThanOrEqual(0);
    expect(at('latency_p95_ms')!.value).toBeGreaterThanOrEqual(at('latency_p50_ms')!.value);

    // Breakdowns: every query category, plus table and provenance dimensions.
    const names = result.samples.map((s) => s.name);
    for (const category of QUERY_CATEGORIES) {
      expect(names).toContain(`p_at_5_cat_${category}`);
      expect(names).toContain(`mrr_cat_${category}`);
    }
    expect(names.some((n) => n.startsWith('r_at_5_table_'))).toBe(true);
    expect(names.some((n) => n.startsWith('r_at_5_prov_'))).toBe(true);
  });

  test('smallest corpus produces a nonzero aggregate relevance score (silent-zero canary)', async () => {
    const result = await runSuiteC({ sizes: [100], repeats: 1 });
    const aggregate = result.samples
      .filter((s) => s.scope === 'corpus=100' && ['p_at_5', 'r_at_5', 'mrr'].includes(s.name))
      .reduce((sum, s) => sum + s.value, 0);
    expect(aggregate).toBeGreaterThan(0);
  });

  test('one sample group per requested corpus size', async () => {
    const result = await runSuiteC({ sizes: [100, 150], repeats: 1 });
    const scopes = new Set(result.samples.map((s) => s.scope));
    expect(scopes.has('corpus=100')).toBe(true);
    expect(scopes.has('corpus=150')).toBe(true);
  });

  test('restores the DB env override and never touches the previous DB path', async () => {
    process.env.RECALL_DB_PATH = '/tmp/suite-c-sentinel-does-not-exist.db';
    await runSuiteC({ sizes: [100], repeats: 1 });
    expect(process.env.RECALL_DB_PATH).toBe('/tmp/suite-c-sentinel-does-not-exist.db');
    expect(existsSync('/tmp/suite-c-sentinel-does-not-exist.db')).toBe(false);
  });

  test('latency caveat documents the warmup and repeat protocol', async () => {
    const result = await runSuiteC({ sizes: [100], repeats: 3 });
    const latencyCaveat = result.caveats.find((c) => c.includes('warmup'));
    expect(latencyCaveat).toBeDefined();
    expect(latencyCaveat).toContain('3 measured repeats');
    const embeddingCaveat = result.caveats.find((c) => c.includes('Embedding service available'));
    expect(embeddingCaveat).toBeDefined();
  });

  test('renderMarkdown renders the Suite C section', async () => {
    const suite = await runSuiteC({ sizes: [100], repeats: 1 });
    const md = renderMarkdown({
      startedAt: '',
      finishedAt: '',
      recallVersion: 'test',
      hostInfo: { platform: 'test', bunVersion: 'test' },
      suites: [suite],
    });
    expect(md).toContain('## Suite C — Precision under noise');
    expect(md).toContain('| p_at_5 |');
    expect(md).toContain('### Caveats');
  });

  test('K cutoff is 5 — the metric names match the measurement', () => {
    expect(K).toBe(5);
  });

  test('dedup pass (issue #78) is opt-in: emits dedup samples and updates the caveat only when enabled', async () => {
    const off = await runSuiteC({ sizes: [100], repeats: 1 });
    expect(off.samples.some((s) => s.name === 'dedup_marked')).toBe(false);
    expect(off.caveats.some((c) => c.startsWith('Dedup was NOT run'))).toBe(true);

    const on = await runSuiteC({ sizes: [100], repeats: 1, dedup: true });
    const planned = on.samples.find((s) => s.name === 'dedup_planned' && s.scope === 'corpus=100');
    const marked = on.samples.find((s) => s.name === 'dedup_marked' && s.scope === 'corpus=100');
    expect(planned).toBeDefined();
    expect(marked).toBeDefined();
    expect(marked!.value).toBeGreaterThanOrEqual(0);
    expect(marked!.value).toBeLessThanOrEqual(planned!.value);
    expect(on.caveats.some((c) => c.startsWith('Dedup WAS run'))).toBe(true);
  });
});
