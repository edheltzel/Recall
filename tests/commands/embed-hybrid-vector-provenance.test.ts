import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';

// Drive the hybrid VECTOR/RRF branch of runHybridSearch offline (issue #119).
// Unlike embed.test.ts (which forces the FTS-only fallback by reporting the
// service unavailable), here the service is available and embed() returns a
// fixed vector that matches the seeded embeddings — so the seeded rows surface
// through the semantic path and hit the per-table vector SELECTs that resolve
// content + provenance. Every other embeddings export stays real so RRF scores
// and fuses for real. Pattern: tests/commands/dedup.test.ts.
mock.module('../../src/lib/embeddings', () => ({
  ...require('../../src/lib/embeddings'),
  embed: async () => ({ embedding: [1, 0, 0, 0], model: 'test', dimensions: 4 }),
  checkEmbeddingService: async () => ({ available: true, model: 'test', url: 'mock://embed' }),
}));

import { runHybridSearch } from '../../src/commands/embed';
import { embeddingToBlob } from '../../src/lib/embeddings';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { getDb } from '../../src/db/connection';
import { createSession, addDecision, addBreadcrumb } from '../../src/lib/memory';

function insertEmbedding(table: string, id: number, vector: number[]): void {
  getDb().prepare(
    `INSERT OR REPLACE INTO embeddings (source_table, source_id, model, dimensions, embedding)
     VALUES (?, ?, 'test', ?, ?)`
  ).run(table, id, vector.length, embeddingToBlob(vector));
}

// Guards the silent-unknown class (#67) on the hybrid VECTOR branch: a row that
// HAS provenance must not render as `⚠ unknown` because a per-table vector
// SELECT dropped its provenance column. Covers a known-provenance row
// (decisions) and a legacy NULL-provenance row (breadcrumbs) — the latter being
// the 5th table the embeddable-only resolver does not cover.
describe('runHybridSearch VECTOR-branch provenance display (issue #119, #67)', () => {
  const originalLog = console.log;
  const originalError = console.error;
  let output: string;
  let decisionId: number;
  let crumbId: number;

  beforeEach(() => {
    setupTestDb();
    output = '';
    console.log = (msg?: unknown) => { output += `${String(msg ?? '')}\n`; };
    console.error = () => {};

    createSession({ session_id: 'vec-1', started_at: '2026-01-01T00:00:00Z', project: 'demo' });
    // Distinctive text that the query below does NOT match, so these rows reach
    // the results purely via the vector path (source indicator: VEC).
    decisionId = addDecision({ session_id: 'vec-1', decision: 'quokka meridian ledger', status: 'active', provenance: 'extracted' });
    crumbId = addBreadcrumb({ session_id: 'vec-1', content: 'quokka tideline parchment', importance: 5 }); // provenance NULL

    insertEmbedding('decisions', decisionId, [1, 0, 0, 0]);
    insertEmbedding('breadcrumbs', crumbId, [1, 0, 0, 0]);
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    teardownTestDb();
  });

  test('rows surface via the vector branch (FTS misses, semantic hits)', async () => {
    await runHybridSearch('zzznomatchxyz', {});

    const decisionLine = output.split('\n').find(l => l.includes('Decision #'));
    const crumbLine = output.split('\n').find(l => l.includes('Breadcrumb #'));

    expect(decisionLine).toBeDefined();
    expect(crumbLine).toBeDefined();
    // Vector-only contributions — proves these came through the VECTOR SELECTs.
    expect(decisionLine).toContain('VEC');
    expect(crumbLine).toContain('VEC');
  });

  test('default: known provenance stays quiet, unknown is flagged', async () => {
    await runHybridSearch('zzznomatchxyz', {});

    const decisionLine = output.split('\n').find(l => l.includes('Decision #'));
    const crumbLine = output.split('\n').find(l => l.includes('Breadcrumb #'));

    // extracted is a known provenance → no tag in the default (quiet) view.
    expect(decisionLine).not.toContain('provenance');

    // NULL provenance → flagged as unknown even in the quiet view.
    expect(crumbLine).toContain('⚠');
    expect(crumbLine).toContain('provenance: unknown');
  });

  test('--show-provenance renders every provenance value', async () => {
    await runHybridSearch('zzznomatchxyz', { showProvenance: true });

    const decisionLine = output.split('\n').find(l => l.includes('Decision #'));
    const crumbLine = output.split('\n').find(l => l.includes('Breadcrumb #'));

    // Proves r.provenance flows through each per-table vector SELECT: a dropped
    // provenance column here would render the decision as unknown and fail this.
    expect(decisionLine).toContain('provenance: extracted');
    expect(crumbLine).toContain('provenance: unknown');
  });
});
