import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';

// 🔒 OPTIONAL-model invariant (issue #107): with the embedding service/model
// absent, hybridSearch MUST still return results on FTS5 — never throw. The
// service is reported unavailable and embed() throws if ever reached; the
// vector branch must be skipped entirely. A stale legacy (768-dim) embedding is
// seeded so that, if the vector branch were wrongly taken, cosineSimilarity
// would throw on the dimension mismatch — proving the branch is truly skipped.
mock.module('../src/lib/embeddings', () => ({
  ...require('../src/lib/embeddings'),
  checkEmbeddingService: async () => ({ available: false, model: 'qwen3-embedding:0.6b', url: 'mock://down' }),
  embed: async () => { throw new Error('embedding service unavailable'); },
}));

import { setupTestDb, teardownTestDb } from './helpers/setup';
import { getDb } from '../src/db/connection';
import { embeddingToBlob } from '../src/lib/embeddings';
import { createSession, addDecision } from '../src/lib/memory';

let hybridSearch: typeof import('../src/mcp-server')['hybridSearch'];

describe('hybridSearch FTS5 fallback when the embedding model/backend is absent (issue #107)', () => {
  beforeAll(async () => {
    setupTestDb();
    ({ hybridSearch } = await import('../src/mcp-server'));

    createSession({ session_id: 'fts-fallback-1', started_at: '2026-01-01T00:00:00Z', project: 'demo' });
    const id = addDecision({ session_id: 'fts-fallback-1', decision: 'quokka meridian ledger entry', status: 'active' });

    // Legacy 768-dim embedding — a tripwire: if the vector branch ran, the
    // 1024-vs-768 mismatch would throw inside cosineSimilarity.
    getDb().prepare(
      `INSERT OR REPLACE INTO embeddings (source_table, source_id, model, dimensions, embedding)
       VALUES ('decisions', ?, 'nomic-embed-text', 768, ?)`
    ).run(id, embeddingToBlob(new Array(768).fill(0.5)));
  });
  afterAll(() => teardownTestDb());

  test('returns FTS matches and reports no semantic backend when embeddings are unavailable', async () => {
    const { results, embeddingsAvailable, semanticBackend } = await hybridSearch('quokka meridian', {});

    expect(embeddingsAvailable).toBe(false);
    expect(semanticBackend).toBe('none');
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => r.source === 'fts')).toBe(true);
    expect(results.some(r => r.content.includes('quokka meridian'))).toBe(true);
  });
});
