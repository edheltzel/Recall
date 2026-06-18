// Suite C — Precision under noise.
//
// Measures whether search() retrieves the right high-signal memory when the
// database contains many irrelevant records. Builds seeded synthetic corpora
// (100 / 1k / 10k / 100k records by default) in a temporary DB using the real
// schema and write paths, then runs a ground-truth-labeled query set through
// the real FTS5 search path and reports P@5, R@5, MRR@5, and latency p50/p95
// per corpus size, with breakdowns by table, provenance, and query category.
//
// What this suite is NOT:
// - It does NOT measure the wake-up bundle cost (Suite B).
// - It does NOT measure answer accuracy (Suite A's grader).
// - It does NOT exercise semantic/hybrid retrieval — FTS5 keyword path only.
// First implementation records an honest baseline; there is no pass/fail
// threshold. Regression gating compares future runs against the checked-in
// baseline JSONL.

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { search, getLastSearchErrors } from '../../src/lib/memory.js';
import { initDb, closeDb, getDb } from '../../src/db/connection.js';
import { planDedup, applyDedupPlan, DEDUP_TABLES, DEFAULT_SEMANTIC_THRESHOLD } from '../../src/lib/dedup.js';
import { checkEmbeddingService, embed, embeddingToBlob } from '../../src/lib/embeddings.js';
import { embeddingTextFor } from '../../src/lib/repair.js';
import type { SuiteResult, MetricSample } from '../types.js';
import {
  K,
  DEFAULT_SEED,
  generateFixtureSpec,
  seedFixture,
  precisionAtK,
  recallAtK,
  reciprocalRank,
  percentile,
  mean,
  refKey,
  searchTableName,
  type FixtureQuery,
  type SeededRecord,
} from './suite-c-internals.js';

export interface SuiteCOptions {
  /** Corpus sizes to run. Default 100/1k/10k/100k; env RECALL_BENCH_C_SIZES overrides. */
  sizes?: number[];
  /** PRNG seed for fixture generation. Default 47. */
  seed?: number;
  /** Measured repeats per query (after 1 unmeasured warmup pass). Default 5; env RECALL_BENCH_C_REPEATS overrides. */
  repeats?: number;
  /** Run `recall dedup --execute` over each corpus before measuring (issue #78). Default off; env RECALL_BENCH_C_DEDUP overrides. */
  dedup?: boolean;
  /**
   * Backfill embeddings for every dedup-eligible record before the dedup pass,
   * so the semantic pass actually runs (issue #99). Mirrors `recall embed
   * backfill` over the seeded corpus and requires a live embedding service.
   * Only meaningful together with `dedup`. Default off; env
   * RECALL_BENCH_C_EMBED_BACKFILL overrides.
   */
  embedBackfill?: boolean;
}

const DEFAULT_SIZES = [100, 1_000, 10_000, 100_000];
const DEFAULT_REPEATS = 5;
const WARMUP_PASSES = 1;

function parseEnvInts(name: string): number[] | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const values = raw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0);
  return values.length > 0 ? values : undefined;
}

function parseEnvFlag(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v != null && v !== '' && v !== '0' && v !== 'false';
}

const round = (value: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(value * f) / f;
};

interface QueryOutcome {
  query: FixtureQuery;
  p5: number;
  r5: number;
  rr: number;
  /** Per-expected-record retrieval flags for table/provenance breakdowns. */
  expectedHits: Array<{ record: SeededRecord; retrieved: boolean }>;
}

function runQuery(query: FixtureQuery, targets: Map<string, SeededRecord>): QueryOutcome {
  const results = search(query.text, { project: query.project, limit: K });

  // search() swallows per-table SQL failures into lastSearchErrors and keeps
  // going, so a broken FTS path returns silently-empty results that look like
  // genuine retrieval misses. Fail the run loudly instead of recording an
  // all-zero baseline indistinguishable from real retrieval collapse.
  const searchErrors = getLastSearchErrors();
  if (searchErrors.length > 0) {
    throw new Error(
      `Suite C aborted: search() swallowed ${searchErrors.length} error(s) on query "${query.text}": ${searchErrors.join('; ')}`,
    );
  }

  const retrieved = results.map((r) => ({ table: r.table, id: r.id }));

  const expected = query.expected.map((key) => {
    const record = targets.get(key);
    if (!record) throw new Error(`Suite C ground-truth key ${key} did not resolve to a seeded record`);
    return record;
  });
  const relevant = new Set(expected.map((r) => refKey(searchTableName(r.table), r.id)));
  const topKeys = new Set(retrieved.slice(0, K).map((r) => refKey(r.table, r.id)));

  return {
    query,
    p5: precisionAtK(retrieved, relevant, K),
    r5: recallAtK(retrieved, relevant, K),
    rr: reciprocalRank(retrieved, relevant, K),
    expectedHits: expected.map((record) => ({
      record,
      retrieved: topKeys.has(refKey(searchTableName(record.table), record.id)),
    })),
  };
}

function pushBreakdown(
  samples: MetricSample[],
  outcomes: QueryOutcome[],
  scope: string,
): void {
  // By query category — P@5 and MRR@5 per category, so ambiguous-query
  // failures are attributable separately from exact-lookup failures.
  const categories = [...new Set(outcomes.map((o) => o.query.category))];
  for (const category of categories) {
    const group = outcomes.filter((o) => o.query.category === category);
    samples.push({
      name: `p_at_5_cat_${category}`,
      value: round(mean(group.map((o) => o.p5)), 4),
      unit: 'ratio',
      scope,
    });
    samples.push({
      name: `mrr_cat_${category}`,
      value: round(mean(group.map((o) => o.rr)), 4),
      unit: 'ratio',
      scope,
    });
  }

  // By table and provenance — recall of ground-truth records grouped by the
  // record's own table/provenance: of the labeled-relevant records in this
  // dimension, what fraction surfaced in a top-5?
  const hits = outcomes.flatMap((o) => o.expectedHits);
  const byDimension = (dim: 'table' | 'provenance', prefix: string) => {
    const values = [...new Set(hits.map((h) => h.record[dim]))];
    for (const value of values) {
      const group = hits.filter((h) => h.record[dim] === value);
      samples.push({
        name: `${prefix}_${value}`,
        value: round(group.filter((h) => h.retrieved).length / group.length, 4),
        unit: 'ratio',
        scope,
      });
    }
  };
  byDimension('table', 'r_at_5_table');
  byDimension('provenance', 'r_at_5_prov');
}

/** Minimum content length to embed — matches `recall embed backfill`. */
const MIN_BACKFILL_TEXT_LENGTH = 10;

/**
 * Backfill embeddings for every dedup-eligible record in the current corpus
 * DB (issue #99), so `planDedup`'s semantic pass has stored vectors to compare.
 *
 * This is the embedding-backed counterpart to #78's exact-only dedup run. It
 * uses the production primitives — `embeddingTextFor` (the same per-table
 * content composition `recall embed backfill` and `recall repair` use), `embed`
 * (the real Ollama nomic-embed-text client), and `embeddingToBlob` — and writes
 * to the same `embeddings` table the CLI does. It covers ALL `DEDUP_TABLES`
 * (including breadcrumbs, which the `recall embed` CLI omits) so the semantic
 * pass gets maximal coverage: a superset of what a user running `recall embed
 * backfill` per supported table would store. Returns the number embedded.
 */
async function backfillCorpusEmbeddings(db: ReturnType<typeof getDb>): Promise<number> {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO embeddings (source_table, source_id, model, dimensions, embedding)
    VALUES (?, ?, ?, ?, ?)
  `);
  let embedded = 0;
  for (const table of DEDUP_TABLES) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const text = embeddingTextFor(table, row).trim();
      if (text.length < MIN_BACKFILL_TEXT_LENGTH) continue;
      const result = await embed(text);
      insert.run(table, row.id as number, result.model, result.dimensions, embeddingToBlob(result.embedding));
      embedded++;
    }
  }
  return embedded;
}

export async function runSuiteC(options: SuiteCOptions = {}): Promise<SuiteResult> {
  const t0 = performance.now();

  const sizes = options.sizes ?? parseEnvInts('RECALL_BENCH_C_SIZES') ?? DEFAULT_SIZES;
  const seed = options.seed ?? DEFAULT_SEED;
  const repeats = options.repeats ?? parseEnvInts('RECALL_BENCH_C_REPEATS')?.[0] ?? DEFAULT_REPEATS;
  const dedup = options.dedup ?? parseEnvFlag('RECALL_BENCH_C_DEDUP');
  const embedBackfill = options.embedBackfill ?? parseEnvFlag('RECALL_BENCH_C_EMBED_BACKFILL');

  const embedding = await checkEmbeddingService().catch(() => ({ available: false, model: 'unknown', url: 'unknown' }));

  // The embedding-backed variant (issue #99) only does anything alongside the
  // dedup pass it feeds. Fail loudly rather than silently no-op, and refuse to
  // run without a real embedding service rather than fabricate vectors.
  if (embedBackfill) {
    if (!dedup) {
      throw new Error(
        'RECALL_BENCH_C_EMBED_BACKFILL=1 requires RECALL_BENCH_C_DEDUP=1 — the embedding backfill only feeds the dedup semantic pass.',
      );
    }
    if (!embedding.available) {
      throw new Error(
        `RECALL_BENCH_C_EMBED_BACKFILL=1 requires a live embedding service, but checkEmbeddingService reported unavailable at ${embedding.url}. ` +
          'Start Ollama with the nomic-embed-text model (or point OLLAMA_URL/EMBEDDING_MODEL at a compatible service). Refusing to fabricate embeddings.',
      );
    }
  }

  const samples: MetricSample[] = [];
  let totalMarked = 0;

  // Suite C must never touch the user's real DB: every corpus lives in a
  // temp dir, and the env override + module connection are restored after.
  const savedRecallPath = process.env.RECALL_DB_PATH;
  const savedMemPath = process.env.MEM_DB_PATH;
  const tempRoot = mkdtempSync(join(tmpdir(), 'recall-suite-c-'));

  try {
    for (const size of sizes) {
      const spec = generateFixtureSpec(seed, size);

      closeDb();
      process.env.RECALL_DB_PATH = join(tempRoot, `corpus-${size}.db`);
      delete process.env.MEM_DB_PATH;
      initDb();
      const targets = seedFixture(spec);
      const scope = `corpus=${size}`;

      // Optional dedup pass (issue #78): mirror `recall dedup --execute` over
      // the seeded corpus before measuring, so the diff vs the no-dedup
      // baseline is dedup's efficacy report. Non-destructive marking (no
      // --delete); search() then excludes records marked in dedup_lineage.
      // Uses stored embeddings only, exactly like the CLI — the semantic pass
      // is skipped when the corpus has none.
      if (dedup) {
        const db = getDb();
        // Embedding-backed variant (issue #99): backfill stored embeddings
        // first so planDedup's semantic pass runs instead of skipping. Without
        // this the corpus has no embeddings and only the exact pass acts —
        // exactly the #78 path. New samples are recorded only on this variant,
        // so a plain RECALL_BENCH_C_DEDUP=1 run still matches #78 sample-for-sample.
        if (embedBackfill) {
          const backfilled = await backfillCorpusEmbeddings(db);
          samples.push({ name: 'embeddings_backfilled', value: backfilled, unit: 'count', scope });
        }
        const plan = planDedup(db);
        const planned = plan.tables.reduce((sum, t) => sum + t.planned.length, 0);
        const semanticPairs = plan.tables.reduce((sum, t) => sum + t.semanticPairs, 0);
        const applied = applyDedupPlan(db, plan, { destructive: false });
        totalMarked += applied.marked;
        samples.push({ name: 'dedup_planned', value: planned, unit: 'count', scope });
        samples.push({ name: 'dedup_marked', value: applied.marked, unit: 'count', scope });
        if (embedBackfill) {
          samples.push({ name: 'dedup_semantic_pairs', value: semanticPairs, unit: 'count', scope });
        }
      }

      // Warmup — unmeasured pass(es) so first-touch page cache and statement
      // compilation don't pollute the latency distribution.
      for (let w = 0; w < WARMUP_PASSES; w++) {
        for (const query of spec.queries) runQuery(query, targets);
      }

      const latencies: number[] = [];
      let outcomes: QueryOutcome[] = [];
      for (let r = 0; r < repeats; r++) {
        const pass: QueryOutcome[] = [];
        for (const query of spec.queries) {
          const tq = performance.now();
          pass.push(runQuery(query, targets));
          latencies.push(performance.now() - tq);
        }
        // Retrieval is deterministic for a fixed corpus — relevance metrics
        // come from the first measured pass; later passes only feed latency.
        if (r === 0) outcomes = pass;
      }
      closeDb();

      samples.push({ name: 'p_at_5', value: round(mean(outcomes.map((o) => o.p5)), 4), unit: 'ratio', scope });
      samples.push({ name: 'r_at_5', value: round(mean(outcomes.map((o) => o.r5)), 4), unit: 'ratio', scope });
      samples.push({ name: 'mrr', value: round(mean(outcomes.map((o) => o.rr)), 4), unit: 'ratio (MRR@5)', scope });
      samples.push({ name: 'latency_p50_ms', value: round(percentile(latencies, 50), 3), unit: 'ms', scope });
      samples.push({ name: 'latency_p95_ms', value: round(percentile(latencies, 95), 3), unit: 'ms', scope });
      pushBreakdown(samples, outcomes, scope);
    }
  } finally {
    closeDb();
    if (savedRecallPath !== undefined) process.env.RECALL_DB_PATH = savedRecallPath;
    else delete process.env.RECALL_DB_PATH;
    if (savedMemPath !== undefined) process.env.MEM_DB_PATH = savedMemPath;
    else delete process.env.MEM_DB_PATH;
    rmSync(tempRoot, { recursive: true, force: true });
  }

  // Canary — the smallest (least-noisy) corpus must produce a nonzero
  // aggregate relevance score. A zero aggregate means a broken harness or a
  // silently-erroring search path, not an honest baseline; refuse to return
  // numbers that a baseline re-record would lock in as if they were real.
  const smallestSize = Math.min(...sizes);
  const smallestScope = `corpus=${smallestSize}`;
  const aggregate = samples
    .filter((s) => s.scope === smallestScope && (s.name === 'p_at_5' || s.name === 'r_at_5' || s.name === 'mrr'))
    .reduce((sum, s) => sum + s.value, 0);
  if (aggregate <= 0) {
    throw new Error(
      `Suite C canary failed: smallest corpus (${smallestSize}) produced a zero aggregate relevance score ` +
        `(p_at_5 + r_at_5 + mrr = ${aggregate}). This indicates a broken harness or silent retrieval collapse, not a real baseline.`,
    );
  }

  const durationMs = Math.round(performance.now() - t0);

  return {
    suite: 'C',
    name: 'Precision under noise',
    description:
      `Measures FTS5 search() precision against seeded synthetic corpora (sizes: ${sizes.join(', ')}; seed: ${seed}). ` +
      `A ground-truth-labeled query set (exact lookup, paraphrase, problem lookup, ambiguous-with-collisions) runs at each size; ` +
      `reports P@5, R@5, MRR@5, latency p50/p95, and breakdowns by query category, target table, and provenance.`,
    ranAt: new Date().toISOString(),
    durationMs,
    samples,
    caveats: [
      `Synthetic corpus: deterministic seeded fixtures (seed ${seed}). Absolute scores do not transfer to real-world corpora; compare runs only against this same fixture set.`,
      `Latency protocol: ${WARMUP_PASSES} unmeasured warmup pass per corpus size, then ${repeats} measured repeats per query on a warm connection; p50/p95 are computed across all measured calls at that size. Relevance metrics come from the first measured pass (retrieval is deterministic for a fixed corpus).`,
      `Embedding service available: ${embedding.available ? `yes (${embedding.model})` : 'no'}. Suite C exercises the FTS5 keyword path (search()) only — semantic/hybrid retrieval is NOT measured in this baseline either way.`,
      'FTS5 MATCH is implicit AND with no stemming — paraphrase-category queries are expected to score near zero on keyword search. That gap is part of the honest baseline this suite records.',
      dedup
        ? embedBackfill
          ? `Dedup WAS run before measurement WITH embedding backfill (issue #99): every dedup-eligible record was embedded via ${embedding.model} (\`recall embed backfill\` semantics) before \`recall dedup --execute\`, so the semantic pass ran on stored embeddings at threshold ${DEFAULT_SEMANTIC_THRESHOLD} (the CLI default) in addition to the exact pass. Non-destructive marking (no --delete). ${totalMarked} record(s) marked across all sizes; search() excludes records marked in dedup_lineage.`
          : `Dedup WAS run before measurement (issue #78): \`recall dedup --execute\` semantics — exact + stored-embedding-semantic detection, non-destructive marking (no --delete). ${totalMarked} record(s) marked across all sizes; search() excludes records marked in dedup_lineage. The semantic pass uses stored embeddings only, of which the seeded corpus has none, so only the exact pass runs.`
        : 'Dedup was NOT run before measurement: the corpus contains unmarked near-duplicates that legitimately compete in ranking. search() excludes only records already marked in dedup_lineage.',
      'Ground truth never includes messages-table records — messages are noise-only in this corpus. The project column is part of every FTS index, so unscoped queries can match records via their project name alone.',
      'No pass/fail threshold — baseline-first. Later regression gating can diff future runs against the checked-in baseline JSONL.',
    ],
  };
}
