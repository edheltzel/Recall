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
import { ingestHostTranscript } from '../src/lib/host-ingest';

let hybridSearch: typeof import('../src/mcp-server')['hybridSearch'];

describe('hybridSearch FTS5 fallback when the embedding model/backend is absent (issue #107)', () => {
  beforeAll(async () => {
    setupTestDb();
    ({ hybridSearch } = await import('../src/mcp-server'));

    createSession({ session_id: 'fts-fallback-1', started_at: '2026-01-01T00:00:00Z', project: 'demo' });
    const id = addDecision({
      session_id: 'fts-fallback-1',
      decision: 'quokka meridian ledger entry',
      project: 'demo',
      status: 'active',
    });

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

  test('returns physical results with typed lifecycle readiness', async () => {
    ingestHostTranscript({
      source: 'codex',
      sessionId: 'hybrid-readiness',
      project: 'demo',
      messages: Array.from({ length: 501 }, (_, index) => ({
        role: 'assistant' as const,
        content: `lifecycle readiness frame ${index}`,
        nativeId: `readiness-${index}`,
      })),
    });
    const db = getDb();
    const generation = (db.prepare(`
      SELECT active_generation FROM host_ingest_state
      WHERE source = 'codex' AND session_id = 'hybrid-readiness'
    `).get() as { active_generation: string }).active_generation;
    db.prepare(`
      UPDATE host_ingest_generation_messages SET fts_pending = 1
      WHERE generation_id = ?
    `).run(generation);
    db.prepare(`
      UPDATE host_ingest_generations SET fts_ready = 0 WHERE generation_id = ?
    `).run(generation);

    const { results, readiness } = await hybridSearch('quokka meridian', {
      project: 'demo',
    });

    expect(results.some(result => result.content.includes('quokka meridian'))).toBe(true);
    expect(readiness).toEqual({
      status: 'retryable',
      pendingGenerations: 1,
      message: expect.stringContaining('RETRYABLE:'),
    });
  });
});
