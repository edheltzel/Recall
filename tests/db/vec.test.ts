import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { getDb } from '../../src/db/connection';
import {
  isVecAvailable,
  reindexVec,
  knnSearch,
  createVecTable,
  resetVecSyncCache,
} from '../../src/db/vec';
import {
  embeddingToBlob,
  blobToEmbedding,
  cosineSimilarity,
  EMBEDDING_DIMENSIONS,
} from '../../src/lib/embeddings';

// A 1024-dim vector in the axis0/axis1 plane at angle `theta` from axis0.
// cosine(query=axis0, gradedVec(theta)) = cos(theta), so distinct angles give
// strictly distinct, tie-free similarities — making KNN-vs-brute-force ordering
// unambiguous to assert.
function gradedVec(theta: number): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  v[0] = Math.cos(theta);
  v[1] = Math.sin(theta);
  return v;
}

// A vector pointing (mostly) along axis `dir` — for the dedup test where exact
// ordering among non-duplicates doesn't matter.
function vec(dir: number, jitter = 0.01): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  v[dir % EMBEDDING_DIMENSIONS] = 1;
  v[(dir + 1) % EMBEDDING_DIMENSIONS] = jitter;
  return v;
}

function insertEmbedding(id: number, v: number[]): void {
  getDb().prepare(
    `INSERT OR REPLACE INTO embeddings (source_table, source_id, model, dimensions, embedding)
     VALUES ('decisions', ?, 'qwen3-embedding:0.6b', ?, ?)`
  ).run(id, v.length, embeddingToBlob(v));
}

/** Brute-force reference ranking — the path KNN must match. */
function bruteForceOrder(query: number[], k: number): string[] {
  const rows = getDb()
    .prepare('SELECT source_table, source_id, embedding FROM embeddings')
    .all() as Array<{ source_table: string; source_id: number; embedding: Buffer }>;
  return rows
    .map((r) => ({ key: `${r.source_table}:${r.source_id}`, sim: cosineSimilarity(query, blobToEmbedding(r.embedding)) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, k)
    .map((r) => r.key);
}

describe('sqlite-vec index (issue #148)', () => {
  beforeEach(() => {
    setupTestDb();
    resetVecSyncCache();
  });
  afterEach(() => {
    teardownTestDb();
    resetVecSyncCache();
  });

  test('reindexVec builds the index from the canonical BLOBs', () => {
    if (!isVecAvailable()) return; // extension-less host: brute-force only
    for (let i = 1; i <= 5; i++) insertEmbedding(i, vec(i * 10));
    expect(reindexVec(getDb())).toBe(5);
    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM vec_embeddings').get() as { c: number }).c;
    expect(count).toBe(5);
  });

  test('KNN ordering matches the brute-force cosine ranking (parity)', () => {
    if (!isVecAvailable()) return;
    // ids 1..8 at increasing angles from axis0 → strictly decreasing similarity
    // to the axis0 query, so the expected order is exactly ids 1,2,3,…
    for (let i = 1; i <= 8; i++) insertEmbedding(i, gradedVec(i * 0.1));
    reindexVec(getDb());

    const query = gradedVec(0); // axis0 — nearest is the smallest angle (id 1)
    const knn = knnSearch(getDb(), query, 5).map((h) => `${h.source_table}:${h.source_id}`);
    const brute = bruteForceOrder(query, 5);

    expect(knn).toEqual(brute);
    expect(knn).toEqual(['decisions:1', 'decisions:2', 'decisions:3', 'decisions:4', 'decisions:5']);
  });

  test('KNN excludes recall-dedup marked duplicates', () => {
    if (!isVecAvailable()) return;
    insertEmbedding(1, vec(70));
    insertEmbedding(2, vec(70, 0.02)); // near-identical direction to id 1
    reindexVec(getDb());

    getDb().prepare(
      `INSERT INTO dedup_lineage (survivor_table, survivor_id, duplicate_table, duplicate_id, reason, status)
       VALUES ('decisions', 1, 'decisions', 2, 'semantic', 'marked')`
    ).run();

    const keys = knnSearch(getDb(), vec(70), 5).map((h) => `${h.source_table}:${h.source_id}`);
    expect(keys).toContain('decisions:1');
    expect(keys).not.toContain('decisions:2'); // marked duplicate hidden
  });

  test('knnSearch throws when the extension is unavailable (callers fall back)', () => {
    if (isVecAvailable()) return; // only meaningful on an extension-less host
    expect(() => knnSearch(getDb(), vec(1), 5)).toThrow();
  });

  test('legacy cosine-metric index is dropped and rebuilt (#217)', () => {
    if (!isVecAvailable()) return;
    const db = getDb();
    // Simulate a pre-#217 install: cosine-metric vec0 table already on disk.
    db.exec('DROP TABLE IF EXISTS vec_embeddings');
    db.exec(`CREATE VIRTUAL TABLE vec_embeddings USING vec0(
      source_table TEXT,
      source_id INTEGER,
      embedding float[${EMBEDDING_DIMENSIONS}] distance_metric=cosine
    )`);
    for (let i = 1; i <= 3; i++) insertEmbedding(i, gradedVec(i * 0.2));

    createVecTable(db); // the every-open path must replace the stale metric
    const ddl = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vec_embeddings'`
    ).get() as { sql: string }).sql;
    expect(ddl).not.toContain('distance_metric=cosine');

    // The rebuilt index still serves the exact brute-force cosine ranking.
    reindexVec(db);
    const query = gradedVec(0);
    const knn = knnSearch(db, query, 3).map((h) => `${h.source_table}:${h.source_id}`);
    expect(knn).toEqual(bruteForceOrder(query, 3));
  });

  test('knnSearch distances are exact cosine distances, norm-invariant (#217)', () => {
    if (!isVecAvailable()) return;
    // Scaled (non-unit) stored vectors: cosine is norm-invariant, so distances
    // must still equal 1 - cos(theta) regardless of stored magnitude.
    for (let i = 1; i <= 3; i++) insertEmbedding(i, gradedVec(i * 0.3).map((x) => 3 * x));
    reindexVec(getDb());
    const hits = knnSearch(getDb(), gradedVec(0), 3);
    hits.forEach((h, idx) => {
      expect(h.distance).toBeCloseTo(1 - Math.cos((idx + 1) * 0.3), 5);
    });
  });
});
