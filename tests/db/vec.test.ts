import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { getDb } from '../../src/db/connection';
import {
  isVecAvailable,
  reindexVec,
  knnSearch,
  createVecTable,
  ensureVecIndexSynced,
  invalidateVecIndex,
  resetVecSyncCache,
  withReadSnapshot,
  withConsistentVecIndex,
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

function writeSchemaMetaFromPeer(key: string, value: string): void {
  const result = Bun.spawnSync(
    ['bun', '-e', `
      import { Database } from 'bun:sqlite';
      const db = new Database(process.env.RECALL_PEER_DB);
      db.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)')
        .run(process.env.RECALL_PEER_KEY, process.env.RECALL_PEER_VALUE);
      db.close();
    `],
    {
      env: {
        ...process.env,
        RECALL_PEER_DB: process.env.RECALL_DB_PATH!,
        RECALL_PEER_KEY: key,
        RECALL_PEER_VALUE: value,
      },
    },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
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

  test('deleting an embedding source removes its vector and dirties the index', () => {
    const db = getDb();
    const decisionId = Number(db.prepare(
      `INSERT INTO decisions (decision) VALUES ('delete source vector')`
    ).run().lastInsertRowid);
    insertEmbedding(decisionId, vec(1));
    db.prepare(`DELETE FROM schema_meta WHERE key IN ('vec_index_dirty', 'vec_index_generation')`).run();

    db.prepare('DELETE FROM decisions WHERE id = ?').run(decisionId);

    expect(db.prepare(
      `SELECT 1 FROM embeddings WHERE source_table = 'decisions' AND source_id = ?`
    ).get(decisionId)).toBeNull();
    expect(db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('vec_index_dirty'))
      .toEqual({ value: '1' });
    expect(db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('vec_index_generation'))
      .toEqual({ value: '1' });
  });

  test('honors persisted invalidation after the process cache is warm', () => {
    if (!isVecAvailable()) return;
    const db = getDb();
    insertEmbedding(1, vec(1));
    reindexVec(db);
    ensureVecIndexSynced(db);

    db.prepare("DELETE FROM embeddings WHERE source_table = 'decisions' AND source_id = 1").run();
    db.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)')
      .run('vec_index_dirty', '1');
    db.exec('DELETE FROM vec_embeddings');
    insertEmbedding(1, vec(2));
    ensureVecIndexSynced(db);

    expect(db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('vec_index_dirty'))
      .toBeNull();
    expect(knnSearch(db, vec(2), 1)[0].distance).toBeLessThan(0.001);
  });

  test('retries a KNN read when the vector generation changes', () => {
    if (!isVecAvailable()) return;
    const db = getDb();
    insertEmbedding(1, vec(1));
    reindexVec(db);
    let calls = 0;

    const result = withConsistentVecIndex(db, () => {
      calls += 1;
      if (calls === 1) invalidateVecIndex(db);
      return knnSearch(db, vec(1), 1);
    });

    expect(calls).toBe(2);
    expect(result?.[0]?.distance).toBeLessThan(0.001);
    expect(db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('vec_index_dirty'))
      .toBeNull();
    expect(db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('vec_index_generation'))
      .toEqual({ value: '1' });
  });

  test('rejects a KNN read after two vector generation changes', () => {
    if (!isVecAvailable()) return;
    const db = getDb();
    insertEmbedding(1, vec(1));
    reindexVec(db);
    let calls = 0;

    const result = withConsistentVecIndex(db, () => {
      calls += 1;
      const hits = knnSearch(db, vec(1), 1);
      invalidateVecIndex(db);
      return hits;
    });

    expect(calls).toBe(2);
    expect(result).toBeNull();
    expect(db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('vec_index_dirty'))
      .toEqual({ value: '1' });
    expect(db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('vec_index_generation'))
      .toEqual({ value: '2' });
  });

  test('keeps a KNN read stable across an unrelated writer commit', () => {
    if (!isVecAvailable()) return;
    const db = getDb();
    insertEmbedding(1, vec(1));
    reindexVec(db);
    let calls = 0;

    const result = withConsistentVecIndex(db, () => {
      calls += 1;
      if (calls === 1) writeSchemaMetaFromPeer('vec_publication_test', '1');
      return knnSearch(db, vec(1), 1);
    });

    expect(calls).toBe(1);
    expect(result?.[0]?.distance).toBeLessThan(0.001);
  });

  test('keeps a stable WAL snapshot across an unrelated writer commit', () => {
    const db = getDb();
    db.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)')
      .run('canonical_publication_test', 'before');

    const result = withReadSnapshot(db, () => {
      const before = db.prepare('SELECT value FROM schema_meta WHERE key = ?')
        .get('canonical_publication_test');
      writeSchemaMetaFromPeer('canonical_publication_test', 'after');
      const after = db.prepare('SELECT value FROM schema_meta WHERE key = ?')
        .get('canonical_publication_test');
      return { before, after };
    });

    expect(result.before).toEqual({ value: 'before' });
    expect(result.after).toEqual({ value: 'before' });
    expect(db.prepare('SELECT value FROM schema_meta WHERE key = ?')
      .get('canonical_publication_test')).toEqual({ value: 'after' });
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
