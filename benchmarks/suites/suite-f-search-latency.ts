// Suite F — Search latency.
//
// The A0 verify gate for the Search-Performance epic (#146 / #147). Captures a
// reproducible LATENCY baseline (p50/p95) for the brute-force and indexed
// search paths a query can take, at growing DB sizes, so the rest of the epic
// (sqlite-vec index in #148, the A1–A4 caches) can prove its wins against a
// fixed before/after.
//
// The measured paths, using the REAL production primitives:
//   - fts          — `search()` (src/lib/memory.ts): the FTS5 keyword path.
//   - vector       — the brute-force semantic scan inside `hybridSearch`
//                    (src/mcp-server.ts): SELECT every embedding, decode each
//                    BLOB, `cosineSimilarity` in a JS loop, sort, slice. This
//                    O(n) scan is the confirmed root cause #148 fixes.
//   - vec_index    — sqlite-vec KNN over the native vec0 index, when available.
//   - hybrid       — fts + brute-force vector + `reciprocalRankFusion` +
//                    vec-only content/provenance resolution.
//   - hybrid_index — the same hybrid fusion/content-resolution work as
//                    `hybrid`, but using sqlite-vec KNN semantic hits.
//
// Determinism without a model: the vector/hybrid paths need stored embeddings
// and a query embedding, which production gets from Ollama. To stay
// reproducible AND zero-dependency (no live embedding service), this suite
// seeds deterministic EMBEDDING_DIMENSIONS-length vectors directly into the `embeddings`
// table and uses a seeded query vector in place of the Ollama `embed()` call.
// That isolates the scan/fusion cost — exactly what the epic optimizes — and
// makes it measurable on any machine, in CI, with no network.
//
// What this suite is NOT:
//   - It does NOT measure relevance/precision (that is Suite C). The synthetic
//     vectors are random, so ranking from them is meaningless — only LATENCY is.
//   - It does NOT measure the Ollama `embed(query)` network call. Production
//     hybrid latency additionally pays that per query; this suite deliberately
//     excludes it to isolate the in-process scan growth the epic targets.
//
// No pass/fail threshold — baseline-first, like Suite C. Later runs re-run this
// same harness to confirm the ≤10 ms ideal / ≤50 ms acceptable SLO.

import type { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { search, getLastSearchErrors, vectorRowContentProvenance } from '../../src/lib/memory.js';
import { initDb, closeDb, getDb } from '../../src/db/connection.js';
import {
  cosineSimilarity,
  blobToEmbedding,
  embeddingToBlob,
  reciprocalRankFusion,
  EMBEDDING_DIMENSIONS,
} from '../../src/lib/embeddings.js';
import { notMarkedDuplicateSql, DEDUP_TABLES } from '../../src/lib/dedup.js';
import { isVecAvailable, reindexVec, knnSearch } from '../../src/db/vec.js';
import type { Provenance } from '../../src/types/index.js';
import type { SuiteResult, MetricSample } from '../types.js';
import {
  DEFAULT_SEED,
  mulberry32,
  generateFixtureSpec,
  seedFixture,
  percentile,
  type FixtureQuery,
} from './suite-c-internals.js';

export interface SuiteFOptions {
  /** Corpus sizes to run. Default 1k/10k; env RECALL_BENCH_F_SIZES overrides. */
  sizes?: number[];
  /** PRNG seed for fixtures + synthetic vectors. Default 47. */
  seed?: number;
  /** Measured repeats per query (after 1 unmeasured warmup pass). Default 5; env RECALL_BENCH_F_REPEATS overrides. */
  repeats?: number;
}

/** Default sizes kept modest so the default run finishes fast; the O(n) vector
 *  scan dominates at large sizes. Set RECALL_BENCH_F_SIZES=1000,10000,100000
 *  for the full growth curve. */
const DEFAULT_SIZES = [1_000, 10_000];
const DEFAULT_REPEATS = 5;
const WARMUP_PASSES = 1;
/** hybridSearch's default result limit; the vector scan slices to limit*2. */
const LIMIT = 10;

function parseEnvInts(name: string): number[] | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const values = raw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0);
  return values.length > 0 ? values : undefined;
}

const round = (value: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(value * f) / f;
};

// ── Deterministic synthetic embeddings ───────────────────────────────
// FNV-1a-style string hash, mixed with the base seed, so every (table,id) and
// every query gets a stable, distinct vector across runs and machines.

function hashSeed(base: number, label: string): number {
  let h = (base ^ 0x811c9dc5) >>> 0;
  for (let i = 0; i < label.length; i++) {
    h = Math.imul(h ^ label.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A deterministic EMBEDDING_DIMENSIONS-length vector in [-1, 1). */
export function syntheticVector(base: number, label: string): number[] {
  const rng = mulberry32(hashSeed(base, label));
  const vec = new Array<number>(EMBEDDING_DIMENSIONS);
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) vec[i] = rng() * 2 - 1;
  return vec;
}

/**
 * Backfill a synthetic embedding for every record in the provenance-bearing
 * tables (the same set `recall embed` / dedup touch), writing to the same
 * `embeddings` table the CLI does. Returns the number of embeddings indexed —
 * the size of the brute-force scan the vector path pays per query.
 */
function backfillSyntheticEmbeddings(db: Database, seed: number): number {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO embeddings (source_table, source_id, model, dimensions, embedding)
    VALUES (?, ?, ?, ?, ?)
  `);
  let indexed = 0;
  const run = db.transaction(() => {
    for (const table of DEDUP_TABLES) {
      const rows = db.prepare(`SELECT id FROM ${table}`).all() as Array<{ id: number }>;
      for (const row of rows) {
        const vec = syntheticVector(seed, `${table}#${row.id}`);
        insert.run(table, row.id, 'synthetic-bench', EMBEDDING_DIMENSIONS, embeddingToBlob(vec));
        indexed++;
      }
    }
  });
  run();
  return indexed;
}

// ── The measured search paths ─────────────────────────────────────────
// Each mirrors the production code path exactly, using its real primitives,
// substituting a seeded query vector for the Ollama embed() call.

interface SemanticHit {
  source_table: string;
  source_id: number;
  similarity: number;
}

type SemanticSearchPath = (db: Database, queryVec: number[]) => SemanticHit[];

/** The brute-force vector scan from hybridSearch (`bruteForceVectorScan` in
 *  mcp-server.ts): pull every non-duplicate embedding, decode + score against
 *  the query vector, sort by similarity, keep the top limit*2. Prepares per
 *  call, as prod does. */
function vectorScan(db: Database, queryVec: number[]): SemanticHit[] {
  const rows = db
    .prepare(`
      SELECT source_table, source_id, embedding FROM embeddings
      WHERE ${notMarkedDuplicateSql('source_table', 'source_id')}
    `)
    .all() as Array<{ source_table: string; source_id: number; embedding: Buffer }>;

  const hits: SemanticHit[] = [];
  for (const row of rows) {
    hits.push({
      source_table: row.source_table,
      source_id: row.source_id,
      similarity: cosineSimilarity(queryVec, blobToEmbedding(row.embedding)),
    });
  }
  hits.sort((a, b) => b.similarity - a.similarity);
  return hits.slice(0, LIMIT * 2);
}

/** The sqlite-vec native KNN path (#148) — the fast tier that replaces the
 *  brute-force scan above. Queries the vec0 index for the nearest LIMIT*2 by
 *  cosine distance. Only meaningful when the extension loaded (isVecAvailable);
 *  this is the "after" number compared to the brute-force `vec` baseline. */
function vecIndexPath(db: Database, queryVec: number[]): SemanticHit[] {
  return knnSearch(db, queryVec, LIMIT * 2).map((h) => ({
    source_table: h.source_table,
    source_id: h.source_id,
    similarity: 1 - h.distance,
  }));
}

/** FTS5 keyword path — the real search(), failing loud on a swallowed error so
 *  a broken FTS path can't masquerade as a fast (empty) baseline. */
function ftsPath(query: FixtureQuery): void {
  search(query.text, { project: query.project, limit: LIMIT });
  const errors = getLastSearchErrors();
  if (errors.length > 0) {
    throw new Error(`Suite F aborted: search() swallowed error(s) on "${query.text}": ${errors.join('; ')}`);
  }
}

/** Full hybridSearch fusion (`hybridSearch` in mcp-server.ts), minus the Ollama
 *  embed/availability calls: FTS + semantic hits + RRF + vec-only resolution. */
function hybridPath(db: Database, query: FixtureQuery, queryVec: number[], semanticPath: SemanticSearchPath = vectorScan): void {
  const ftsResults = search(query.text, { project: query.project, limit: LIMIT * 2 });
  const semanticResults = semanticPath(db, queryVec);

  const ftsRanked = ftsResults.map((r) => ({
    id: `${r.table === 'loa' ? 'loa_entries' : r.table}:${r.id}`,
  }));
  const semanticRanked = semanticResults.map((r) => ({ id: `${r.source_table}:${r.source_id}` }));
  const fusedScores = reciprocalRankFusion([ftsRanked, semanticRanked]);

  const resultMap = new Map<
    string,
    { table: string; id: number; score: number; source: 'fts' | 'vec' | 'both'; provenance: Provenance | null }
  >();
  for (const r of ftsResults) {
    const key = `${r.table === 'loa' ? 'loa_entries' : r.table}:${r.id}`;
    resultMap.set(key, { table: r.table, id: r.id, score: fusedScores.get(key) || 0, source: 'fts', provenance: r.provenance ?? null });
  }
  for (const r of semanticResults) {
    const key = `${r.source_table}:${r.source_id}`;
    const existing = resultMap.get(key);
    if (existing) {
      existing.source = 'both';
    } else {
      const { provenance } = vectorRowContentProvenance(r.source_table, r.source_id);
      resultMap.set(key, {
        table: r.source_table === 'loa_entries' ? 'loa' : r.source_table,
        id: r.source_id,
        score: fusedScores.get(key) || 0,
        source: 'vec',
        provenance,
      });
    }
  }
  Array.from(resultMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, LIMIT);
}

export async function runSuiteF(options: SuiteFOptions = {}): Promise<SuiteResult> {
  const t0 = performance.now();

  const sizes = options.sizes ?? parseEnvInts('RECALL_BENCH_F_SIZES') ?? DEFAULT_SIZES;
  const seed = options.seed ?? DEFAULT_SEED;
  const repeats = options.repeats ?? parseEnvInts('RECALL_BENCH_F_REPEATS')?.[0] ?? DEFAULT_REPEATS;

  const samples: MetricSample[] = [];
  let vecAvailableForRun = false;

  // Never touch the user's real DB: every corpus lives in a temp dir, and the
  // env override + module connection are restored after.
  const savedRecallPath = process.env.RECALL_DB_PATH;
  const savedMemPath = process.env.MEM_DB_PATH;
  const tempRoot = mkdtempSync(join(tmpdir(), 'recall-suite-f-'));

  try {
    for (const size of sizes) {
      const spec = generateFixtureSpec(seed, size);

      closeDb();
      process.env.RECALL_DB_PATH = join(tempRoot, `corpus-${size}.db`);
      delete process.env.MEM_DB_PATH;
      initDb();
      seedFixture(spec);
      const db = getDb();
      const indexed = backfillSyntheticEmbeddings(db, seed);
      // Build the sqlite-vec index (#148) from the same canonical BLOBs so the
      // native KNN path can be measured against the brute-force baseline.
      const vecReady = isVecAvailable();
      vecAvailableForRun = vecReady;
      if (vecReady) reindexVec(db);
      const scope = `corpus=${size}`;

      // Pre-compute one seeded query vector per query — deterministic, and not
      // part of the measured work (production gets this from Ollama, which we
      // intentionally exclude to isolate the scan).
      const queryVectors = new Map<string, number[]>(
        spec.queries.map((q) => [q.id, syntheticVector(seed, `query:${q.id}`)]),
      );

      const ftsLat: number[] = [];
      const vecLat: number[] = [];
      const vecIndexLat: number[] = [];
      const hybridLat: number[] = [];
      const hybridIndexLat: number[] = [];

      const measure = (bucket: number[] | null, fn: () => void) => {
        const t = performance.now();
        fn();
        if (bucket) bucket.push(performance.now() - t);
      };

      // Warmup — unmeasured pass(es) so first-touch page cache and statement
      // compilation don't pollute the distribution.
      for (let w = 0; w < WARMUP_PASSES; w++) {
        for (const q of spec.queries) {
          const qv = queryVectors.get(q.id)!;
          measure(null, () => ftsPath(q));
          measure(null, () => vectorScan(db, qv));
          if (vecReady) measure(null, () => vecIndexPath(db, qv));
          measure(null, () => hybridPath(db, q, qv));
          if (vecReady) measure(null, () => hybridPath(db, q, qv, vecIndexPath));
        }
      }

      for (let r = 0; r < repeats; r++) {
        for (const q of spec.queries) {
          const qv = queryVectors.get(q.id)!;
          measure(ftsLat, () => ftsPath(q));
          measure(vecLat, () => vectorScan(db, qv));
          if (vecReady) measure(vecIndexLat, () => vecIndexPath(db, qv));
          measure(hybridLat, () => hybridPath(db, q, qv));
          if (vecReady) measure(hybridIndexLat, () => hybridPath(db, q, qv, vecIndexPath));
        }
      }
      closeDb();

      samples.push({ name: 'corpus_records', value: size, unit: 'count', scope });
      samples.push({ name: 'embeddings_indexed', value: indexed, unit: 'count', scope });
      samples.push({ name: 'fts_latency_p50_ms', value: round(percentile(ftsLat, 50), 3), unit: 'ms', scope });
      samples.push({ name: 'fts_latency_p95_ms', value: round(percentile(ftsLat, 95), 3), unit: 'ms', scope });
      samples.push({ name: 'vec_latency_p50_ms', value: round(percentile(vecLat, 50), 3), unit: 'ms', scope });
      samples.push({ name: 'vec_latency_p95_ms', value: round(percentile(vecLat, 95), 3), unit: 'ms', scope });
      if (vecReady) {
        // sqlite-vec native KNN (#148) — the "after" vs the brute-force `vec` baseline.
        samples.push({ name: 'vec_index_latency_p50_ms', value: round(percentile(vecIndexLat, 50), 3), unit: 'ms', scope });
        samples.push({ name: 'vec_index_latency_p95_ms', value: round(percentile(vecIndexLat, 95), 3), unit: 'ms', scope });
      }
      samples.push({ name: 'hybrid_latency_p50_ms', value: round(percentile(hybridLat, 50), 3), unit: 'ms', scope });
      samples.push({ name: 'hybrid_latency_p95_ms', value: round(percentile(hybridLat, 95), 3), unit: 'ms', scope });
      if (vecReady) {
        // sqlite-vec native KNN plus the same hybrid RRF/content-resolution work.
        samples.push({ name: 'hybrid_index_latency_p50_ms', value: round(percentile(hybridIndexLat, 50), 3), unit: 'ms', scope });
        samples.push({ name: 'hybrid_index_latency_p95_ms', value: round(percentile(hybridIndexLat, 95), 3), unit: 'ms', scope });
      }
    }
  } finally {
    closeDb();
    if (savedRecallPath !== undefined) process.env.RECALL_DB_PATH = savedRecallPath;
    else delete process.env.RECALL_DB_PATH;
    if (savedMemPath !== undefined) process.env.MEM_DB_PATH = savedMemPath;
    else delete process.env.MEM_DB_PATH;
    rmSync(tempRoot, { recursive: true, force: true });
  }

  // Canary — the vector path must have scanned a non-empty index at every size,
  // or the latency numbers are measuring an empty table, not the real scan.
  for (const size of sizes) {
    const indexed = samples.find((s) => s.scope === `corpus=${size}` && s.name === 'embeddings_indexed');
    if (!indexed || indexed.value <= 0) {
      throw new Error(`Suite F canary failed: corpus ${size} indexed ${indexed?.value ?? 0} embeddings — the vector scan would measure an empty table.`);
    }
  }

  const durationMs = Math.round(performance.now() - t0);

  return {
    suite: 'F',
    name: 'Search latency',
    description:
      `Measures search latency (p50/p95) for the FTS5 keyword, brute-force vector, brute-force hybrid (RRF), ` +
      `and sqlite-vec indexed KNN vector/hybrid paths against seeded synthetic corpora (sizes: ${sizes.join(', ')}; seed: ${seed}). ` +
      `Establishes the A0 baseline (#147) for the Search-Performance epic (#146) so the sqlite-vec index (#148) and A1–A4 caches ` +
      `can be verified before/after without confusing brute-force hybrid with the indexed SLO path.`,
    ranAt: new Date().toISOString(),
    durationMs,
    samples,
    caveats: [
      `Latency only — NOT relevance. The vector/hybrid paths use DETERMINISTIC synthetic ${EMBEDDING_DIMENSIONS}-dim seeded random embeddings (seed ${seed}), not real model embeddings, so their ranking is meaningless. Precision lives in Suite C.`,
      `Latency protocol: ${WARMUP_PASSES} unmeasured warmup pass per corpus size, then ${repeats} measured repeats per query on a warm connection; p50/p95 are computed across all measured calls at that size.`,
      `Vector path measures the brute-force O(n) scan inside hybridSearch (SELECT all embeddings + JS cosine loop) — the confirmed bottleneck #148 (sqlite-vec) replaces. It scans every embedding in the corpus per query, so vec_latency_* and brute-force hybrid_latency_* p50/p95 grow with DB size by design; that growth is the number the epic must flatten.`,
      `vec_index_latency_* is the sqlite-vec native KNN semantic path (#148) — the "after" compared to the brute-force vec_latency "before". It is emitted ONLY when the extension loaded on this host (isVecAvailable).`,
      ...(vecAvailableForRun
        ? [
            `hybrid_index_latency_* is the KNN-backed hybrid path, emitted only when sqlite-vec is available: the same FTS + RRF + vec-only content/provenance resolution as hybrid_latency_*, but with vecIndexPath instead of vectorScan. Treat this as the indexed hybrid SLO measurement.`,
          ]
        : [
            `sqlite-vec unavailable: vec_index_latency_* and hybrid_index_latency_* are emitted only when sqlite-vec is available, so they were not emitted. hybrid_latency_* remains the brute-force fallback path and must NOT be read as the KNN-backed hybrid SLO measurement.`,
          ]),
      `The Ollama embed(query) network call is intentionally EXCLUDED — production hybrid latency additionally pays it per query. This suite isolates the in-process scan/fusion cost so before/after deltas reflect the index change, not embedding-service variance.`,
      `Absolute milliseconds are machine- and load-dependent and do NOT transfer across hosts; the harness (corpus, query set, sizes, synthetic vectors) is deterministic, so compare distributions only against runs of this same suite on the same machine.`,
      `Epic SLO (for reference, not gated here): ≤10 ms ideal / ≤50 ms acceptable per query. No pass/fail threshold — baseline-first; re-run post-fix to confirm.`,
      `Default sizes are kept small so the run finishes fast; set RECALL_BENCH_F_SIZES=1000,10000,100000 for the full growth curve.`,
    ],
  };
}
