import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';

// Drive the MCP server's hybridSearch VECTOR branch offline (issue #115).
// The embedding service is reported available and embed() returns a fixed
// vector matching the seeded embeddings, so seeded rows surface through the
// semantic path and the query exercises the inline `notMarkedDuplicateSql`
// fragment (src/mcp-server.ts) that hides recall-dedup marked duplicates
// (issue #45). Every other embeddings export stays real so RRF fuses for real.
// Pattern: tests/commands/embed-hybrid-vector-provenance.test.ts.
mock.module('../src/lib/embeddings', () => ({
  ...require('../src/lib/embeddings'),
  embed: async () => ({ embedding: [1, 0, 0, 0], model: 'test', dimensions: 4 }),
  checkEmbeddingService: async () => ({ available: true, model: 'test', url: 'mock://embed' }),
}));

import { setupTestDb, teardownTestDb } from './helpers/setup';
import { getDb } from '../src/db/connection';
import { embeddingToBlob } from '../src/lib/embeddings';
import { createSession, addDecision } from '../src/lib/memory';

function insertEmbedding(table: string, id: number, vector: number[]): void {
  getDb().prepare(
    `INSERT OR REPLACE INTO embeddings (source_table, source_id, model, dimensions, embedding)
     VALUES (?, ?, 'test', ?, ?)`
  ).run(table, id, vector.length, embeddingToBlob(vector));
}

// Imported dynamically AFTER setupTestDb() sets RECALL_DB_PATH, so the module's
// import-time initDb() (mcp-server.ts) hits the temp DB and never the real
// default path. hybridSearch is exported by this issue's production change; the
// `import.meta.main` guard keeps importing the module from starting a server.
let hybridSearch: typeof import('../src/mcp-server')['hybridSearch'];

let survivorId: number;
let duplicateId: number;

describe('MCP hybridSearch hides recall-dedup marked duplicates on the vector path (issue #115)', () => {
  beforeAll(async () => {
    setupTestDb();
    ({ hybridSearch } = await import('../src/mcp-server'));

    createSession({ session_id: 'mcp-dedup-1', started_at: '2026-01-01T00:00:00Z', project: 'demo' });

    // Two decisions with identical, query-matching embeddings. The query text
    // below matches NEITHER via FTS, so both can only reach results through the
    // vector branch — isolating the dedup-hiding SQL as the sole difference
    // between them.
    survivorId = addDecision({ session_id: 'mcp-dedup-1', decision: 'quokka meridian survivor ledger', status: 'active', provenance: 'user_authored' });
    duplicateId = addDecision({ session_id: 'mcp-dedup-1', decision: 'quokka meridian duplicate ledger', status: 'active', provenance: 'derived' });

    insertEmbedding('decisions', survivorId, [1, 0, 0, 0]);
    insertEmbedding('decisions', duplicateId, [1, 0, 0, 0]);

    // Record the duplicate as a recall-dedup MARKED duplicate (status 'marked').
    // notMarkedDuplicateSql excludes exactly this (duplicate_table, duplicate_id)
    // from the embeddings SELECT in the vector branch.
    getDb().prepare(
      `INSERT INTO dedup_lineage (survivor_table, survivor_id, duplicate_table, duplicate_id, reason, similarity, status)
       VALUES ('decisions', ?, 'decisions', ?, 'semantic', 0.97, 'marked')`
    ).run(survivorId, duplicateId);
  });

  afterAll(() => {
    teardownTestDb();
  });

  test('vector branch excludes the marked duplicate and includes the survivor', async () => {
    // No-FTS-match query → rows reach results only through the vector path.
    const { results, embeddingsAvailable } = await hybridSearch('zzznomatchxyz', { limit: 10 });

    // Sanity: we actually drove the vector branch, not the FTS-only fallback.
    expect(embeddingsAvailable).toBe(true);
    expect(results.some(r => r.source === 'vec' || r.source === 'both')).toBe(true);

    const has = (id: number) => results.some(r => r.table === 'decisions' && r.id === id);

    // The non-duplicate survivor surfaces via the vector path...
    expect(has(survivorId)).toBe(true);
    // ...and the marked duplicate is hidden by the inline notMarkedDuplicateSql
    // fragment. Neutering that fragment readmits this row and fails the test.
    expect(has(duplicateId)).toBe(false);
  });
});
