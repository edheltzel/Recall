// Shared SQLite-safe chunking helper (issue #41).
//
// SQLite caps bind variables per statement (SQLITE_MAX_VARIABLE_NUMBER —
// historically 999, 32766 in modern builds). Any statement whose bind count
// scales with input size (e.g. `IN (?,?,...)` lists, multi-row VALUES) must
// chunk its input through this helper instead of relying on the limit.
//
// Audit note (2026-06-10): every other SQL statement in src/ and hooks/ binds
// a fixed number of parameters per statement — single-row inserts inside
// loops/transactions, or small fixed filter params (project/limit/type) — so
// their bind counts cannot scale past the safe limit and they are
// intentionally left unchunked.

/**
 * Conservative default chunk size. Well under the historical 999-variable
 * limit, leaving room for a few extra fixed bind params alongside the list.
 */
export const SQLITE_SAFE_CHUNK_SIZE = 500;

/**
 * Split `items` into consecutive chunks of at most `size` elements.
 * Preserves input order; every item appears exactly once across chunks.
 * An empty input yields zero chunks.
 */
export function chunked<T>(items: readonly T[], size: number = SQLITE_SAFE_CHUNK_SIZE): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`chunk size must be a positive integer, got ${size}`);
  }
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
