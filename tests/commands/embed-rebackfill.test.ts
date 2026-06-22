import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';

// Drive the atomic re-backfill offline (issue #107). The embedding service is
// reported available and embed() returns a fixed 1024-dim qwen3 vector; every
// other embeddings export (embeddingToBlob, EMBEDDING_MODEL, …) stays real.
// embedShouldFailAt lets a test force a mid-run failure to prove atomicity.
// Pattern: tests/mcp-server-hybrid-dedup.test.ts.
let embedCalls = 0;
let embedShouldFailAt = -1;
mock.module('../../src/lib/embeddings', () => ({
  ...require('../../src/lib/embeddings'),
  checkEmbeddingService: async () => ({ available: true, model: 'qwen3-embedding:0.6b', url: 'mock://embed' }),
  embed: async () => {
    embedCalls++;
    if (embedShouldFailAt === embedCalls) throw new Error('mock embed failure');
    return { embedding: new Array(1024).fill(0.01), model: 'qwen3-embedding:0.6b', dimensions: 1024 };
  },
}));

import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { getDb } from '../../src/db/connection';
import { embeddingToBlob } from '../../src/lib/embeddings';
import { createSession, addDecision } from '../../src/lib/memory';
import { readEmbeddingMarker } from '../../src/lib/embedding-marker';
import { runRebackfill } from '../../src/commands/embed';

// Seed two decisions, each with a stale legacy (nomic, 768-dim) embedding.
function seedLegacyEmbeddings(): number[] {
  createSession({ session_id: 'rebackfill-1', started_at: '2026-01-01T00:00:00Z', project: 'demo' });
  const a = addDecision({ session_id: 'rebackfill-1', decision: 'first decision with enough text', reasoning: 'because reasons', status: 'active' });
  const b = addDecision({ session_id: 'rebackfill-1', decision: 'second decision with enough text', reasoning: 'more reasons', status: 'active' });
  const insert = getDb().prepare(
    `INSERT OR REPLACE INTO embeddings (source_table, source_id, model, dimensions, embedding)
     VALUES ('decisions', ?, 'nomic-embed-text', 768, ?)`
  );
  insert.run(a, embeddingToBlob(new Array(768).fill(0.5)));
  insert.run(b, embeddingToBlob(new Array(768).fill(0.5)));
  return [a, b];
}

function embeddingRows() {
  return getDb()
    .prepare('SELECT source_id, model, dimensions FROM embeddings ORDER BY source_id')
    .all() as Array<{ source_id: number; model: string; dimensions: number }>;
}

describe('recall embed rebackfill — atomic model swap (issue #107)', () => {
  beforeEach(() => {
    setupTestDb();
    embedCalls = 0;
    embedShouldFailAt = -1;
  });
  afterEach(() => teardownTestDb());

  test('re-embeds every row at the new model/dims and stamps the marker', async () => {
    seedLegacyEmbeddings();

    await runRebackfill();

    const rows = embeddingRows();
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.model).toBe('qwen3-embedding:0.6b');
      expect(r.dimensions).toBe(1024);
    }
    expect(readEmbeddingMarker(getDb())).toEqual({ model: 'qwen3-embedding:0.6b', dimensions: 1024 });
  });

  test('is atomic — a mid-run embed failure leaves the DB untouched', async () => {
    seedLegacyEmbeddings();
    embedShouldFailAt = 2; // fail while embedding the second row

    let err: unknown;
    await runRebackfill().catch((e) => { err = e; });
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('mock embed failure');

    // No mutation: both rows still legacy, marker never written.
    const rows = embeddingRows();
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.model).toBe('nomic-embed-text');
      expect(r.dimensions).toBe(768);
    }
    expect(readEmbeddingMarker(getDb())).toBeNull();
  });

  test('empty DB: no rows to re-embed, marker still stamped', async () => {
    await runRebackfill();
    expect(embeddingRows().length).toBe(0);
    expect(readEmbeddingMarker(getDb())).toEqual({ model: 'qwen3-embedding:0.6b', dimensions: 1024 });
  });
});
