import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';

// 🔒 OPTIONAL sqlite-vec invariant (issue #148): with the extension UNLOADABLE,
// vector search must still work via the brute-force cosine fallback. We force
// isVecAvailable() → false (simulating a host without an extension-capable
// libsqlite3) and report the embedding service available with a fixed 1024-dim
// query vector, then assert the seeded record still surfaces through the vector
// path. The query text matches NOTHING via FTS, so a hit can only come from the
// brute-force vector scan — isolating the fallback.
const QV = new Array(1024).fill(0);
QV[0] = 1;

mock.module('../src/db/vec', () => ({
  ...require('../src/db/vec'),
  isVecAvailable: () => false, // force the brute-force fallback path
}));
mock.module('../src/lib/embeddings', () => ({
  ...require('../src/lib/embeddings'),
  embed: async () => ({ embedding: QV, model: 'test', dimensions: 1024 }),
  checkEmbeddingService: async () => ({ available: true, model: 'test', url: 'mock://embed' }),
}));

import { setupTestDb, teardownTestDb } from './helpers/setup';
import { getDb } from '../src/db/connection';
import { embeddingToBlob } from '../src/lib/embeddings';
import { createSession, addDecision } from '../src/lib/memory';

let hybridSearch: typeof import('../src/mcp-server')['hybridSearch'];

describe('hybridSearch brute-force fallback when sqlite-vec is unavailable (issue #148)', () => {
  beforeAll(async () => {
    setupTestDb();
    ({ hybridSearch } = await import('../src/mcp-server'));

    createSession({ session_id: 'vec-fallback-1', started_at: '2026-01-01T00:00:00Z', project: 'demo' });
    const id = addDecision({ session_id: 'vec-fallback-1', decision: 'wibblefrotz zharkon decision', status: 'active' });
    // Embedding identical to the query vector → cosine similarity 1 via brute-force.
    getDb().prepare(
      `INSERT OR REPLACE INTO embeddings (source_table, source_id, model, dimensions, embedding)
       VALUES ('decisions', ?, 'qwen3-embedding:0.6b', 1024, ?)`
    ).run(id, embeddingToBlob(QV));
  });
  afterAll(() => teardownTestDb());

  test('returns the vector match via brute-force, never throwing', async () => {
    // Query matches nothing in FTS, so the result can only come from the vector path.
    const { results, embeddingsAvailable } = await hybridSearch('nonmatchingkeyword12345', {});

    expect(embeddingsAvailable).toBe(true);
    const hit = results.find((r) => r.table === 'decisions');
    expect(hit).toBeDefined();
    expect(['vec', 'both']).toContain(hit!.source);
  });
});
