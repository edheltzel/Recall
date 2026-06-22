import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { getDb } from '../../src/db/connection';
import { embeddingToBlob, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from '../../src/lib/embeddings';
import {
  readEmbeddingMarker,
  writeEmbeddingMarker,
  expectedEmbeddingMarker,
  embeddingMarkerStatus,
  isRebackfillNeeded,
  resetEmbeddingMarkerCache,
} from '../../src/lib/embedding-marker';

// Insert an embeddings row directly — embeddingMarkerStatus only reads the
// embeddings table (count + model/dims), so no source row is needed.
function insertEmbedding(model: string, dims: number, id = 1): void {
  getDb().prepare(
    `INSERT OR REPLACE INTO embeddings (source_table, source_id, model, dimensions, embedding)
     VALUES ('decisions', ?, ?, ?, ?)`
  ).run(id, model, dims, embeddingToBlob(new Array(dims).fill(0.1)));
}

describe('embedding marker (issue #107)', () => {
  beforeEach(() => {
    setupTestDb();
    resetEmbeddingMarkerCache();
  });
  afterEach(() => {
    teardownTestDb();
    resetEmbeddingMarkerCache();
  });

  test('expected marker reflects the current model + dimensions', () => {
    expect(expectedEmbeddingMarker()).toEqual({ model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS });
  });

  test('read/write round-trips through schema_meta', () => {
    expect(readEmbeddingMarker(getDb())).toBeNull();
    writeEmbeddingMarker(getDb());
    expect(readEmbeddingMarker(getDb())).toEqual(expectedEmbeddingMarker());
  });

  test("status is 'absent' on an empty DB (nothing to migrate — OPTIONAL invariant)", () => {
    expect(embeddingMarkerStatus(getDb())).toBe('absent');
  });

  test("status is 'stale' when matching rows exist but the marker was never written", () => {
    insertEmbedding(EMBEDDING_MODEL, EMBEDDING_DIMENSIONS);
    expect(embeddingMarkerStatus(getDb())).toBe('stale');
  });

  test("status becomes 'match' once the marker is written for matching rows", () => {
    insertEmbedding(EMBEDDING_MODEL, EMBEDDING_DIMENSIONS);
    writeEmbeddingMarker(getDb());
    expect(embeddingMarkerStatus(getDb())).toBe('match');
  });

  test("status is 'stale' for a legacy-model row even if the marker claims a match", () => {
    insertEmbedding('nomic-embed-text', 768);
    writeEmbeddingMarker(getDb()); // optimistic marker
    expect(embeddingMarkerStatus(getDb())).toBe('stale'); // row-level check still flags the mix
  });

  test('isRebackfillNeeded computes once and caches for the process lifetime', () => {
    insertEmbedding('nomic-embed-text', 768);
    expect(isRebackfillNeeded(getDb())).toBe(true);

    // Fix the DB; the cached read-once result must NOT change without a reset.
    getDb().prepare('DELETE FROM embeddings').run();
    insertEmbedding(EMBEDDING_MODEL, EMBEDDING_DIMENSIONS);
    writeEmbeddingMarker(getDb());
    expect(isRebackfillNeeded(getDb())).toBe(true); // still cached

    resetEmbeddingMarkerCache();
    expect(isRebackfillNeeded(getDb())).toBe(false); // recomputed
  });
});
