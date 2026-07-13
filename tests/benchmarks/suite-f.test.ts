// Tests for Suite F — search latency.
//
// Suite F measures LATENCY, which is machine-dependent, so the tests assert
// SHAPE and invariants (metric set present, p95 >= p50, one group per size,
// synthetic-vector determinism, DB isolation) — never absolute millisecond
// values. Mirrors the suite-c.test.ts approach.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync } from 'fs';
import { EMBEDDING_DIMENSIONS } from '../../src/lib/embeddings';
import { runSuiteF, syntheticVector } from '../../benchmarks/suites/suite-f-search-latency';
import { renderMarkdown } from '../../benchmarks/runner';
import { closeDb } from '../../src/db/connection';
import { isVecAvailable } from '../../src/db/vec';

let savedDbPath: string | undefined;
let savedMemPath: string | undefined;

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
});

describe('syntheticVector', () => {
  test('is deterministic for the same (seed, label)', () => {
    expect(syntheticVector(47, 'decisions#1')).toEqual(syntheticVector(47, 'decisions#1'));
  });

  test('differs across labels and across seeds', () => {
    expect(syntheticVector(47, 'decisions#1')).not.toEqual(syntheticVector(47, 'decisions#2'));
    expect(syntheticVector(47, 'decisions#1')).not.toEqual(syntheticVector(48, 'decisions#1'));
  });

  test('has the model dimension and stays in [-1, 1)', () => {
    const vec = syntheticVector(47, 'query:q_exact_zephyr');
    expect(vec.length).toBe(EMBEDDING_DIMENSIONS);
    for (const v of vec) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('Suite F — runSuiteF report generation', () => {
  const BRUTE_FORCE_LATENCY_PATHS = ['fts', 'vec', 'hybrid'] as const;
  const INDEX_LATENCY_PATHS = ['vec_index', 'hybrid_index'] as const;

  test('returns the documented latency metric set per corpus size', async () => {
    const result = await runSuiteF({ sizes: [200], repeats: 2 });
    expect(result.suite).toBe('F');
    expect(result.name).toBe('Search latency');
    expect(result.caveats.length).toBeGreaterThan(0);

    const at = (name: string) => result.samples.find((s) => s.name === name && s.scope === 'corpus=200');

    // Corpus accounting: every fixture record lives in a provenance-bearing
    // table, so all of them get a synthetic embedding.
    expect(at('corpus_records')!.value).toBe(200);
    expect(at('embeddings_indexed')!.value).toBe(200);

    // Baseline paths stay distinct: FTS, brute-force vector, and brute-force
    // hybrid all report p50/p95; latencies are non-negative and p95 >= p50.
    const expectLatencyPair = (path: string) => {
      const p50 = at(`${path}_latency_p50_ms`);
      const p95 = at(`${path}_latency_p95_ms`);
      expect(p50).toBeDefined();
      expect(p95).toBeDefined();
      expect(p50!.unit).toBe('ms');
      expect(p50!.value).toBeGreaterThanOrEqual(0);
      expect(p95!.value).toBeGreaterThanOrEqual(p50!.value);
    };

    for (const path of BRUTE_FORCE_LATENCY_PATHS) {
      expectLatencyPair(path);
    }

    // Indexed metrics are a separate after/before signal. On hosts with
    // sqlite-vec, both the standalone KNN path and KNN-backed hybrid path must
    // emit samples; on hosts without sqlite-vec they must be absent rather than
    // looking like successful SLO measurements.
    const sqliteVecAvailable = isVecAvailable();
    for (const path of INDEX_LATENCY_PATHS) {
      const p50 = at(`${path}_latency_p50_ms`);
      const p95 = at(`${path}_latency_p95_ms`);
      if (sqliteVecAvailable) {
        expectLatencyPair(path);
      } else {
        expect(p50).toBeUndefined();
        expect(p95).toBeUndefined();
      }
    }
  });

  test('one sample group per requested corpus size', async () => {
    const result = await runSuiteF({ sizes: [200, 300], repeats: 1 });
    const scopes = new Set(result.samples.map((s) => s.scope));
    expect(scopes.has('corpus=200')).toBe(true);
    expect(scopes.has('corpus=300')).toBe(true);
  });

  test('caveats document the latency protocol, synthetic embeddings, and conditional indexed metrics', async () => {
    const result = await runSuiteF({ sizes: [200], repeats: 3 });
    const protocol = result.caveats.find((c) => c.includes('warmup'));
    expect(protocol).toBeDefined();
    expect(protocol).toContain('3 measured repeats');
    expect(result.caveats.some((c) => c.includes('synthetic') && c.includes('NOT relevance'))).toBe(true);
    expect(result.caveats.some((c) => c.includes('O(n)'))).toBe(true);
    const vecIndexMetricCaveat = result.caveats.find((c) => c.includes('vec_index_latency_*'));
    expect(vecIndexMetricCaveat).toBeDefined();
    expect(vecIndexMetricCaveat!.toLowerCase()).toContain('sqlite-vec');
    expect(vecIndexMetricCaveat!.toLowerCase()).toContain('only when');

    const hybridIndexMetricCaveat = result.caveats.find((c) => c.includes('hybrid_index_latency_*'));
    expect(hybridIndexMetricCaveat).toBeDefined();
    expect(hybridIndexMetricCaveat!.toLowerCase()).toContain('sqlite-vec');
    expect(hybridIndexMetricCaveat!.toLowerCase()).toContain('only when');
    expect(hybridIndexMetricCaveat!.toLowerCase()).toContain('knn-backed hybrid');
  });

  test('restores the DB env override and never touches the previous DB path', async () => {
    process.env.RECALL_DB_PATH = '/tmp/suite-f-sentinel-does-not-exist.db';
    await runSuiteF({ sizes: [200], repeats: 1 });
    expect(process.env.RECALL_DB_PATH).toBe('/tmp/suite-f-sentinel-does-not-exist.db');
    expect(existsSync('/tmp/suite-f-sentinel-does-not-exist.db')).toBe(false);
  });

  test('renderMarkdown renders the Suite F section', async () => {
    const suite = await runSuiteF({ sizes: [200], repeats: 1 });
    const md = renderMarkdown({
      startedAt: '',
      finishedAt: '',
      recallVersion: 'test',
      hostInfo: { platform: 'test', bunVersion: 'test' },
      suites: [suite],
    });
    expect(md).toContain('## Suite F — Search latency');
    expect(md).toContain('| vec_latency_p50_ms |');
    expect(md).toContain('### Caveats');
  });
});
