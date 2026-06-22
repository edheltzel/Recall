// Short-TTL cache for the embedding-service liveness check (issue #150, Epic #146).
//
// `hybridSearch` calls `checkEmbeddingService()` on every query — an Ollama
// `/api/tags` HTTP round-trip just to learn whether the service is up. In the
// long-lived recall-mcp server that liveness almost never changes between two
// queries seconds apart, so the per-query round-trip is pure overhead.
//
// Strategy (agreed with PM): a 30s TTL, NOT once-per-process. A TTL bounds
// staleness in BOTH directions — a service that goes down (or recovers) is
// re-detected within the window — which avoids the once-per-process failure
// mode where the long-lived server outlives an Ollama restart and is stuck
// treating it as permanently down. A cached "available: true" that goes stale
// mid-window is still self-correcting: the subsequent `embed()` throws and
// hybridSearch's existing try/catch falls back to FTS-only. This cache only
// removes the redundant liveness call; it changes nothing else.
//
// MCP-server scoped: only the per-query hybridSearch path is hot. The CLI
// callers (loa/embed/repair/dump) are one-shot per process, so `checkEmbedding\
// Service()` itself is left pure — only this wrapper is cached.

import { checkEmbeddingService } from './embeddings.js';

type ServiceStatus = Awaited<ReturnType<typeof checkEmbeddingService>>;

/** Liveness is re-checked at most once per this window. */
export const AVAILABILITY_TTL_MS = 30_000;

interface CacheEntry {
  status: ServiceStatus;
  expiresAt: number;
}

let cached: CacheEntry | null = null;

/**
 * `checkEmbeddingService()` with a 30s TTL. Within the window, returns the
 * cached status and issues no HTTP. After it expires (or on first call), the
 * check runs once and refreshes the window.
 *
 * `checkFn` / `nowFn` are injectable for tests (default to the real check and
 * `Date.now`); the MCP call site uses the defaults. `checkEmbeddingService`
 * never throws (it catches internally and reports `available: false`), so there
 * is no failure to special-case here.
 */
export async function checkEmbeddingServiceCached(
  checkFn: () => Promise<ServiceStatus> = checkEmbeddingService,
  nowFn: () => number = Date.now,
): Promise<ServiceStatus> {
  const now = nowFn();
  if (cached && now < cached.expiresAt) return cached.status;
  const status = await checkFn();
  cached = { status, expiresAt: now + AVAILABILITY_TTL_MS };
  return status;
}

/** Test-only: clear the module singleton between cases. */
export function __resetAvailabilityCache(): void {
  cached = null;
}
