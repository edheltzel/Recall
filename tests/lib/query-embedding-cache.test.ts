// Unit coverage for the in-process query-embedding LRU (issue #149).
//
// Pure / in-process — no DB or live Ollama. `embedQueryCached` takes an
// injectable embedder, so a counting fake stands in for the HTTP call and lets
// us assert exactly when (and whether) a real embed would have happened.

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  LruCache,
  queryEmbeddingCacheKey,
  embedQueryCached,
  __resetQueryEmbeddingCache,
} from '../../src/lib/query-embedding-cache';
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, type EmbeddingResult } from '../../src/lib/embeddings';

describe('LruCache', () => {
  test('hit returns the value, miss returns undefined', () => {
    const c = new LruCache<number>(4);
    expect(c.get('absent')).toBeUndefined();
    c.set('a', 1);
    expect(c.has('a')).toBe(true);
    expect(c.get('a')).toBe(1);
  });

  test('evicts the least-recently-used key when over the bound', () => {
    const c = new LruCache<number>(2);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3); // over bound → 'a' (oldest, untouched) is evicted
    expect(c.size).toBe(2);
    expect(c.has('a')).toBe(false);
    expect(c.has('b')).toBe(true);
    expect(c.has('c')).toBe(true);
  });

  test('get() marks a key most-recently-used, sparing it from eviction', () => {
    const c = new LruCache<number>(2);
    c.set('a', 1);
    c.set('b', 2);
    expect(c.get('a')).toBe(1); // touch 'a' → now MRU, 'b' is LRU
    c.set('c', 3); // evicts 'b', not 'a'
    expect(c.has('a')).toBe(true);
    expect(c.has('b')).toBe(false);
    expect(c.has('c')).toBe(true);
  });

  test('re-setting an existing key updates value and refreshes recency', () => {
    const c = new LruCache<number>(2);
    c.set('a', 1);
    c.set('b', 2);
    c.set('a', 11); // update + touch → 'b' becomes LRU
    expect(c.get('a')).toBe(11);
    c.set('c', 3); // evicts 'b'
    expect(c.has('b')).toBe(false);
    expect(c.has('a')).toBe(true);
  });

  test('rejects a non-positive bound', () => {
    expect(() => new LruCache<number>(0)).toThrow();
    expect(() => new LruCache<number>(-1)).toThrow();
    expect(() => new LruCache<number>(1.5)).toThrow();
  });
});

describe('queryEmbeddingCacheKey — model tag + dims are part of the key', () => {
  test('same query but a different model tag yields a different key (⇒ a miss)', () => {
    const q = 'how does hybrid search work';
    expect(queryEmbeddingCacheKey(q, 'qwen3-embedding:0.6b', 1024)).not.toBe(
      queryEmbeddingCacheKey(q, 'nomic-embed-text', 1024),
    );
  });

  test('same query + model but different dims yields a different key', () => {
    const q = 'how does hybrid search work';
    expect(queryEmbeddingCacheKey(q, EMBEDDING_MODEL, 1024)).not.toBe(
      queryEmbeddingCacheKey(q, EMBEDDING_MODEL, 768),
    );
  });

  test('identical (query, model, dims) yields a stable key', () => {
    expect(queryEmbeddingCacheKey('q', EMBEDDING_MODEL, EMBEDDING_DIMENSIONS)).toBe(
      queryEmbeddingCacheKey('q', EMBEDDING_MODEL, EMBEDDING_DIMENSIONS),
    );
  });

  test('NUL-joining prevents field-boundary forgery between query and model', () => {
    // "a" + model vs "a\x00<model>" as the query must not collide.
    expect(queryEmbeddingCacheKey('a', 'm', 1)).not.toBe(queryEmbeddingCacheKey('a\x00m\x001', '', 0));
  });
});

describe('embedQueryCached', () => {
  beforeEach(() => __resetQueryEmbeddingCache());

  /** Deterministic fake embedder that counts calls. */
  function countingEmbedder() {
    let calls = 0;
    const fn = async (text: string): Promise<EmbeddingResult> => {
      calls++;
      // A value derived from the text so identical input ⇒ identical output.
      const seed = text.length;
      return {
        embedding: Array.from({ length: 4 }, (_, i) => seed + i * 0.5),
        model: EMBEDDING_MODEL,
        dimensions: 4,
      };
    };
    return { fn, calls: () => calls };
  }

  test('miss embeds once; a repeated query is a hit that skips the embed call', async () => {
    const e = countingEmbedder();
    await embedQueryCached('repeated query', e.fn);
    await embedQueryCached('repeated query', e.fn);
    await embedQueryCached('repeated query', e.fn);
    expect(e.calls()).toBe(1); // only the first (cold) query hit the embedder
  });

  test('a distinct (cold) query is unaffected — it still embeds', async () => {
    const e = countingEmbedder();
    await embedQueryCached('query one', e.fn);
    await embedQueryCached('query two', e.fn);
    expect(e.calls()).toBe(2);
  });

  test('correctness invariant: a cache hit is byte-identical to the fresh embed', async () => {
    const e = countingEmbedder();
    const fresh = await embedQueryCached('invariant query', e.fn);
    const hit = await embedQueryCached('invariant query', e.fn);
    expect(e.calls()).toBe(1);
    expect(hit).toEqual(fresh); // same model, dims, and every float
    expect(hit.embedding).toEqual(fresh.embedding);
  });

  test('failures are not cached — a throwing embedder is retried on the next call', async () => {
    let calls = 0;
    const flaky = async (): Promise<EmbeddingResult> => {
      calls++;
      if (calls === 1) throw new Error('ollama down');
      return { embedding: [1, 2, 3, 4], model: EMBEDDING_MODEL, dimensions: 4 };
    };
    await expect(embedQueryCached('flaky query', flaky)).rejects.toThrow('ollama down');
    // The miss did not poison the cache: the retry embeds again and succeeds.
    const ok = await embedQueryCached('flaky query', flaky);
    expect(calls).toBe(2);
    expect(ok.embedding).toEqual([1, 2, 3, 4]);
  });
});
