import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import * as vecReal from '../src/db/vec';
import * as embeddingsReal from '../src/lib/embeddings';
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
// VecHit[] to return, or an Error for the mocked knnSearch to throw (pins the
// knn→bruteforce catch fallback).
let knnHits: VecHit[] | Error = [];

// bun's mock.module is PROCESS-GLOBAL and applies to every test file sharing
// the run, so BOTH mocks below must delegate to the real module unless this
// file's tests are actually running (mockEngaged, set in beforeAll / cleared
// in afterAll). Without the gate, tests/db/vec.test.ts sees the stub knnSearch
// (empty hits) and fails whenever the two files run in one invocation.
let mockEngaged = false;
// When engaged, makes the mocked embed() reject — pins the stale-liveness
// window where checkEmbeddingService said available but the embed call fails.
let embedThrows = false;

// Snapshot the real implementations BEFORE mock.module registers below: bun
// patches existing importers too, so a namespace/require lookup made after
// registration resolves to the mock — delegating through it would self-recurse.
// (The `...require(...)` spread inside each factory is safe: it runs while the
// factory executes, where bun still serves the original module.)
const realIsVecAvailable = vecReal.isVecAvailable;
const realEnsureVecIndexSynced = vecReal.ensureVecIndexSynced;
const realKnnSearch = vecReal.knnSearch;
const realEmbed = embeddingsReal.embed;
const realCheckEmbeddingService = embeddingsReal.checkEmbeddingService;

function resetVecMock(): void {
  vecAvailable = false;
  ensureVecIndexSyncedCalls = 0;
  knnCalls = [];
  knnHits = [];
  embedThrows = false;
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
    if (knnHits instanceof Error) throw knnHits;
    return knnHits;
  },
}));
mock.module('../src/lib/embeddings', () => ({
  ...require('../src/lib/embeddings'),
  embed: async (text: string) => {
    if (!mockEngaged) return realEmbed(text);
    if (embedThrows) throw new Error('mock embed failure (stale liveness window)');
    return { embedding: QV, model: 'test', dimensions: 1024 };
  },
  checkEmbeddingService: async () => {
    if (!mockEngaged) return realCheckEmbeddingService();
    return { available: true, model: 'test', url: 'mock://embed' };
  },
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

  test('falls back to brute-force and reports it when the KNN tier throws', async () => {
    // The most SLO-relevant transition (#224 review): vec available but failing
    // (e.g. dimension-mismatched or corrupt index) must reach the brute-force
    // scan, not lose the semantic tier.
    resetVecMock();
    vecAvailable = true;
    knnHits = new Error('mock vec failure (corrupt index)');

    const { results, embeddingsAvailable, semanticBackend } = await hybridSearch('nonmatchingkeyword12345', {});

    expect(knnCalls).toHaveLength(1); // KNN was attempted...
    expect(semanticBackend).toBe('bruteforce'); // ...and the fallback ran
    expect(embeddingsAvailable).toBe(true);
    const hit = results.find((r) => r.table === 'decisions' && r.id === bruteForceDecisionId);
    expect(hit).toBeDefined(); // the seeded row still surfaces via brute-force
  });

  test('reports embeddings unavailable and backend none when the query embed throws', async () => {
    // Stale-liveness window (#224 review): checkEmbeddingService said available
    // but embed() fails. For THIS query embeddings were not available, so the
    // flag must reset and the semantic tier reports it never executed.
    resetVecMock();
    embedThrows = true;

    // Fresh query text: embedQueryCached would serve a prior test's cached
    // embedding for a reused query and never reach the throwing embed().
    // 'zharkon' still FTS-matches the seeded decision.
    const { results, embeddingsAvailable, semanticBackend } = await hybridSearch('zharkon', { limit: 5 });

    expect(embeddingsAvailable).toBe(false);
    expect(semanticBackend).toBe('none');
    expect(results.every((r) => r.source === 'fts')).toBe(true);
    expect(results.some((r) => r.table === 'decisions' && r.id === bruteForceDecisionId)).toBe(true);
  });

  test('formats the external MCP hybrid-search mode note with backend detail', () => {
    expect(formatHybridModeNote(true, 'knn')).toBe('(hybrid: FTS5 + embeddings; semantic backend: knn)');
    expect(formatHybridModeNote(true, 'bruteforce')).toBe('(hybrid: FTS5 + embeddings; semantic backend: bruteforce)');
    expect(formatHybridModeNote(false, 'none')).toBe('(keyword-only: embeddings unavailable; semantic backend: none)');
  });
});
