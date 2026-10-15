import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';

// Issue #163: a stored vector at a different dimension than the live query
// must not throw out of recall semantic / recall hybrid. Matching-dim rows
// still score; the mismatch is skipped with one repair warning.
mock.module('../../src/lib/embeddings', () => ({
  ...require('../../src/lib/embeddings'),
  embed: async () => ({ embedding: [1, 0, 0, 0], model: 'test', dimensions: 4 }),
  checkEmbeddingService: async () => ({ available: true, model: 'test', url: 'mock://embed' }),
}));

import { runHybridSearch, runSemanticSearch } from '../../src/commands/embed';
import { embeddingToBlob } from '../../src/lib/embeddings';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { getDb } from '../../src/db/connection';
import { createSession, addDecision } from '../../src/lib/memory';

function insertEmbedding(id: number, vector: number[]): void {
  getDb().prepare(
    `INSERT OR REPLACE INTO embeddings (source_table, source_id, model, dimensions, embedding)
     VALUES ('decisions', ?, 'test', ?, ?)`,
  ).run(id, vector.length, embeddingToBlob(vector));
}

describe('CLI vector search skips embedding dimension mismatches (#163)', () => {
  const originalLog = console.log;
  const originalError = console.error;
  let output: string;
  let errors: string;
  let matchId: number;
  let staleId: number;

  beforeEach(() => {
    setupTestDb();
    output = '';
    errors = '';
    console.log = (msg?: unknown) => { output += `${String(msg ?? '')}\n`; };
    console.error = (msg?: unknown) => { errors += `${String(msg ?? '')}\n`; };

    createSession({ session_id: 'dim-1', started_at: '2026-01-01T00:00:00Z', project: 'demo' });
    matchId = addDecision({ session_id: 'dim-1', decision: 'matching dim quokka', status: 'active' });
    staleId = addDecision({ session_id: 'dim-1', decision: 'stale dim wombat', status: 'active' });
    insertEmbedding(matchId, [1, 0, 0, 0]);
    insertEmbedding(staleId, new Array(768).fill(0.1));
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    teardownTestDb();
  });

  test('semantic search returns the matching row and warns once', async () => {
    await runSemanticSearch('zzznomatchxyz', {});

    expect(output).toContain(`Decision #${matchId}`);
    expect(output).not.toContain(`Decision #${staleId}`);
    expect(errors).toContain('recall embed rebackfill');
    expect(errors.match(/different dimension/g)?.length).toBe(1);
  });

  test('hybrid search returns the matching row and does not throw', async () => {
    await runHybridSearch('zzznomatchxyz', {});

    expect(output).toContain(`Decision #${matchId}`);
    expect(output).not.toContain(`#${staleId}`);
    expect(errors).toContain('recall embed rebackfill');
  });
});
