import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import * as vecReal from '../src/db/vec';
import type { VecHit } from '../src/db/vec';
import type { hybridSearch as HybridSearchFn, formatHybridModeNote as FormatHybridModeNoteFn } from '../src/mcp-server';

// 🔒 sqlite-vec runtime invariants (issues #146/#148): this file drives
// hybridSearch through both semantic tiers without requiring a host sqlite-vec
// extension. The vec module seam is forced per test: unavailable → real
// brute-force fallback over seeded embeddings; available → deterministic KNN
// hits returned by the sqlite-vec mock. The query text matches NOTHING via FTS
// in both cases, so vec/both results prove the semantic path supplied the row.
const QV = new Array(1024).fill(0);
QV[0] = 1;

let vecAvailable = false;
let ensureVecIndexSyncedCalls = 0;
let knnCalls: Array<{ queryEmbedding: number[]; k: number }> = [];
let knnHits: VecHit[] = [];

// bun's mock.module is PROCESS-GLOBAL and applies to every test file sharing
// the run, so the mock must delegate to the real module unless this file's
// tests are actually running (mockEngaged, set in beforeAll / cleared in
// afterAll). Without the gate, tests/db/vec.test.ts sees the stub knnSearch
// (empty hits) and fails whenever the two files run in one invocation.
let mockEngaged = false;

// Snapshot the real implementations BEFORE mock.module registers below: bun
// patches existing importers too, so reading them any later (even via require
// inside the factory) returns the mock and the delegation self-recurses.
const realIsVecAvailable = vecReal.isVecAvailable;
const realEnsureVecIndexSynced = vecReal.ensureVecIndexSynced;
const realKnnSearch = vecReal.knnSearch;

function resetVecMock(): void {
  vecAvailable = false;
  ensureVecIndexSyncedCalls = 0;
  knnCalls = [];
  knnHits = [];
}

mock.module('../src/db/vec', () => ({
  ...require('../src/db/vec'),
  isVecAvailable: () => (mockEngaged ? vecAvailable : realIsVecAvailable()),
  ensureVecIndexSynced: (db: Parameters<typeof realEnsureVecIndexSynced>[0]) => {
    if (!mockEngaged) return realEnsureVecIndexSynced(db);
    ensureVecIndexSyncedCalls += 1;
  },
  knnSearch: (db: Parameters<typeof realKnnSearch>[0], queryEmbedding: number[], k: number) => {
    if (!mockEngaged) return realKnnSearch(db, queryEmbedding, k);
    knnCalls.push({ queryEmbedding, k });
    return knnHits;
  },
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

let hybridSearch: typeof HybridSearchFn;
let formatHybridModeNote: typeof FormatHybridModeNoteFn;
let bruteForceDecisionId: number;
let knnDecisionId: number;

describe('hybridSearch sqlite-vec semantic backends (issues #146/#148)', () => {
  beforeAll(async () => {
    mockEngaged = true;
    setupTestDb();
    // Dynamic import is required: mcp-server performs import-time DB
    // initialization, so setupTestDb() must set RECALL_DB_PATH first.
    ({ hybridSearch, formatHybridModeNote } = await import('../src/mcp-server'));

    createSession({ session_id: 'vec-fallback-1', started_at: '2026-01-01T00:00:00Z', project: 'demo' });
    bruteForceDecisionId = addDecision({ session_id: 'vec-fallback-1', decision: 'wibblefrotz zharkon decision', status: 'active' });
    knnDecisionId = addDecision({ session_id: 'vec-fallback-1', decision: 'knn deterministic vector-only issue 146', status: 'active' });
    // Embedding identical to the query vector → cosine similarity 1 via brute-force.
    getDb().prepare(
      `INSERT OR REPLACE INTO embeddings (source_table, source_id, model, dimensions, embedding)
       VALUES ('decisions', ?, 'qwen3-embedding:0.6b', 1024, ?)`
    ).run(bruteForceDecisionId, embeddingToBlob(QV));
  });
  afterAll(() => {
    mockEngaged = false;
    teardownTestDb();
  });

  test('reports brute-force backend while preserving the vector fallback result', async () => {
    resetVecMock();
    vecAvailable = false;
    // Query matches nothing in FTS, so the result can only come from the vector path.
    const { results, embeddingsAvailable, semanticBackend } = await hybridSearch('nonmatchingkeyword12345', {});

    expect(embeddingsAvailable).toBe(true);
    expect(semanticBackend).toBe('bruteforce');
    const hit = results.find((r) => r.table === 'decisions' && r.id === bruteForceDecisionId);
    expect(hit).toBeDefined();
    expect(['vec', 'both']).toContain(hit!.source);
  });

  test('reports knn backend while preserving the sqlite-vec KNN result', async () => {
    resetVecMock();
    vecAvailable = true;
    knnHits = [{ source_table: 'decisions', source_id: knnDecisionId, distance: 0.01 }];

    const { results, embeddingsAvailable, semanticBackend } = await hybridSearch('knnnonmatchingkeyword146', { limit: 5 });

    expect(embeddingsAvailable).toBe(true);
    expect(semanticBackend).toBe('knn');
    expect(ensureVecIndexSyncedCalls).toBe(1);
    expect(knnCalls).toHaveLength(1);
    expect(knnCalls[0]!.queryEmbedding).toEqual(QV);
    expect(knnCalls[0]!.k).toBe(10);

    const hit = results.find((r) => r.table === 'decisions' && r.id === knnDecisionId);
    expect(hit).toBeDefined();
    expect(hit!.source).toBe('vec');
    expect(hit!.content).toContain('knn deterministic vector-only issue 146');
  });

  test('keeps embeddings available when KNN is empty and FTS supplies fallback results', async () => {
    resetVecMock();
    vecAvailable = true;
    knnHits = [];

    const { results, embeddingsAvailable, semanticBackend } = await hybridSearch('wibblefrotz zharkon', { limit: 5 });

    expect(semanticBackend).toBe('knn');
    expect(embeddingsAvailable).toBe(true);
    expect(knnCalls).toHaveLength(1);
    expect(results.every((r) => r.source === 'fts')).toBe(true);
    expect(results.some((r) => r.table === 'decisions' && r.id === bruteForceDecisionId)).toBe(true);
  });

  test('formats the external MCP hybrid-search mode note with backend detail', () => {
    expect(formatHybridModeNote(true, 'knn')).toBe('(hybrid: FTS5 + embeddings; semantic backend: knn)');
    expect(formatHybridModeNote(true, 'bruteforce')).toBe('(hybrid: FTS5 + embeddings; semantic backend: bruteforce)');
    expect(formatHybridModeNote(false, 'none')).toBe('(keyword-only: embeddings unavailable; semantic backend: none)');
  });
});
