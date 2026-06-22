// Unit coverage for the embedding-service availability cache (issue #150).
//
// Pure / in-process — no DB or live Ollama. `checkEmbeddingServiceCached` takes
// an injectable check fn and clock, so a counting fake stands in for the HTTP
// liveness call and a fake clock drives the 30s TTL deterministically.
//
// `hybridSearch` (src/mcp-server.ts) cannot be imported in tests — the module
// starts a server on load — so the "stale-true still falls back" case is
// exercised through the real component modules (this cache + the #149 embed
// cache) in the exact gate shape hybridSearch uses.

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  checkEmbeddingServiceCached,
  AVAILABILITY_TTL_MS,
  __resetAvailabilityCache,
} from '../../src/lib/availability-cache';
import {
  embedQueryCached,
  __resetQueryEmbeddingCache,
} from '../../src/lib/query-embedding-cache';
import { EMBEDDING_MODEL, type EmbeddingResult } from '../../src/lib/embeddings';

type ServiceStatus = { available: boolean; model: string; url: string };
const status = (available: boolean): ServiceStatus => ({ available, model: 'm', url: 'u' });

beforeEach(() => __resetAvailabilityCache());

describe('checkEmbeddingServiceCached — no per-query liveness HTTP', () => {
  test('within the TTL window, the underlying check runs once across many queries', async () => {
    let calls = 0;
    const check = async () => {
      calls++;
      return status(true);
    };
    const now = () => 1000; // fixed — never crosses the TTL boundary

    for (let i = 0; i < 8; i++) {
      const r = await checkEmbeddingServiceCached(check, now);
      expect(r.available).toBe(true);
    }
    expect(calls).toBe(1); // 8 queries, ONE liveness round-trip
  });
});

describe('30s TTL re-detects a mid-session state change', () => {
  test('up → down: a service that drops is re-detected after the window', async () => {
    let available = true;
    const check = async () => status(available);
    let t = 0;
    const now = () => t;

    expect((await checkEmbeddingServiceCached(check, now)).available).toBe(true); // expiresAt = 30_000
    available = false; // service goes down mid-session

    t = AVAILABILITY_TTL_MS - 1; // still inside the window → cached "true"
    expect((await checkEmbeddingServiceCached(check, now)).available).toBe(true);

    t = AVAILABILITY_TTL_MS; // window elapsed → re-check picks up "down"
    expect((await checkEmbeddingServiceCached(check, now)).available).toBe(false);
  });

  test('down → up: a recovered service is re-detected (no permanent stale-false)', async () => {
    let available = false;
    const check = async () => status(available);
    let t = 0;
    const now = () => t;

    expect((await checkEmbeddingServiceCached(check, now)).available).toBe(false);
    available = true; // service recovers

    t = AVAILABILITY_TTL_MS - 1;
    expect((await checkEmbeddingServiceCached(check, now)).available).toBe(false); // cached

    t = AVAILABILITY_TTL_MS;
    expect((await checkEmbeddingServiceCached(check, now)).available).toBe(true); // recovered
  });
});

describe('graceful fallback invariants hold', () => {
  // Replicates hybridSearch's gate (cannot import mcp-server) using the REAL
  // availability cache + REAL #149 embed cache. A "semantic attempt" is gated on
  // status.available and wrapped in the same try/catch hybridSearch keeps.
  async function runGate(
    check: () => Promise<ServiceStatus>,
    embedFn: (q: string) => Promise<EmbeddingResult>,
  ): Promise<{ embeddingsAvailable: boolean; semantic: number[]; caught: boolean }> {
    let embeddingsAvailable = false;
    let semantic: number[] = [];
    let caught = false;
    try {
      const s = await checkEmbeddingServiceCached(check, () => 0);
      if (s.available) {
        embeddingsAvailable = true;
        await embedQueryCached('q', embedFn); // throws if the service is really down
        semantic = [1, 2, 3]; // "vector results" — only reached on a real embed
      }
    } catch {
      // Embedding service unavailable — continue with FTS only (unchanged).
      caught = true;
    }
    return { embeddingsAvailable, semantic, caught };
  }

  test('FTS5-optional: a cached "unavailable" skips the semantic path entirely', async () => {
    let embedCalls = 0;
    const embed = async (): Promise<EmbeddingResult> => {
      embedCalls++;
      return { embedding: [1], model: EMBEDDING_MODEL, dimensions: 1 };
    };
    const out = await runGate(async () => status(false), embed);
    expect(out.embeddingsAvailable).toBe(false);
    expect(out.semantic).toEqual([]); // FTS-only
    expect(embedCalls).toBe(0); // never attempted an embed
  });

  test('stale-true: a cached "available" that has gone stale still falls back to FTS', async () => {
    __resetQueryEmbeddingCache();
    const throwingEmbed = async (): Promise<EmbeddingResult> => {
      throw new Error('ollama died mid-session');
    };
    const out = await runGate(async () => status(true), throwingEmbed);
    expect(out.caught).toBe(true); // the embed failure was caught
    expect(out.semantic).toEqual([]); // semantic never populated → FTS-only stands
  });
});
