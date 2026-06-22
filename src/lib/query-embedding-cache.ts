// In-process LRU cache for query embeddings (issue #149, Epic #146).
//
// The long-lived `recall-mcp` server re-embeds the query on every hybrid search.
// That `embed(query)` is an Ollama HTTP round-trip — a hot per-query cost paid
// even when the same query repeats within a session. This caches the result so
// repeated/identical queries skip the call. MCP-server scoped on purpose: the
// server process is long-lived; the CLI is per-process and would never see a
// hit, so the cache lives here (at the MCP call site) rather than inside embed()
// itself.
//
// Correctness (the #149 constraint): the key includes the embedding MODEL TAG
// and DIMENSIONS, not just the query text. The model changed in #107
// (→ qwen3-embedding:0.6b, 1024-dim); a stale-model hit would hand back
// wrong-dimension vectors and silently corrupt results. Keying on
// (model, dims, query) makes a different model/dims a guaranteed miss, never a
// collision. A hit returns the byte-identical EmbeddingResult a fresh embed()
// produced — the cache only skips recomputation, it never changes output.

import {
  embed,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  type EmbeddingResult,
} from './embeddings.js';

// ~1024 float64 per stored vector ≈ 8 KB; 256 entries ≈ 2 MB — a sane ceiling
// for the distinct queries one session asks, with no unbounded growth. The
// bound is a constructor arg so eviction is unit-testable at a small size.
const DEFAULT_MAX_ENTRIES = 256;

/**
 * Minimal insertion-ordered LRU over a Map. A Map preserves insertion order, so
 * the first key is the least-recently-used; `get`/`set` re-insert to mark a key
 * most-recently-used. Exported for direct unit testing.
 */
export class LruCache<V> {
  private readonly map = new Map<string, V>();

  constructor(private readonly maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error('LruCache maxEntries must be a positive integer');
    }
  }

  get size(): number {
    return this.map.size;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  get(key: string): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key) as V;
    // Touch: delete + re-set moves this key to the most-recently-used end.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.maxEntries) {
      // Evict the least-recently-used = the oldest (first-inserted) key.
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }
}

/**
 * Cache key for a query embedding. NUL-joined (`\x00`) so no field value can
 * forge a boundary into another — the same separator convention dedup uses.
 */
export function queryEmbeddingCacheKey(query: string, model: string, dims: number): string {
  return `${model}\x00${dims}\x00${query}`;
}

const queryEmbeddingCache = new LruCache<EmbeddingResult>(DEFAULT_MAX_ENTRIES);

/**
 * `embed(query)` with an in-process LRU. On a hit, returns the cached
 * EmbeddingResult (byte-identical to a fresh embed under the same model/dims).
 * On a miss, embeds, stores, and returns. Failures are NOT cached: if the
 * embedder throws (service down), the error propagates to hybridSearch's
 * existing try/catch, so the FTS-only graceful-fallback path is unchanged.
 *
 * `embedFn` is injectable for tests (defaults to the real Ollama embed); the
 * MCP call site uses the default.
 */
export async function embedQueryCached(
  query: string,
  embedFn: (text: string) => Promise<EmbeddingResult> = embed,
): Promise<EmbeddingResult> {
  const key = queryEmbeddingCacheKey(query, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS);
  const hit = queryEmbeddingCache.get(key);
  if (hit) return hit;
  const result = await embedFn(query);
  queryEmbeddingCache.set(key, result);
  return result;
}

/** Test-only: reset the module singleton between cases. */
export function __resetQueryEmbeddingCache(): void {
  queryEmbeddingCache.clear();
}
