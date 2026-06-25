// Shared SQLite-safe chunking helper (issue #41).
//
// SQLite caps bind variables per statement (SQLITE_MAX_VARIABLE_NUMBER —
// historically 999, 32766 in modern builds). Any statement whose bind count
// scales with input size (e.g. `IN (?,?,...)` lists, multi-row VALUES) must
// chunk its input through this helper instead of relying on the limit.
//
// Audit note (last verified 2026-06-24): every input-scaled SQL path in src/
// routes through `chunked()` — `dump.ts` (LoA recursive delete), `aging.ts`,
// `dedup.ts`, and `memory.ts` (frecency bump). Every other statement binds a
// fixed parameter count per statement — single-row inserts inside
// loops/transactions, small fixed filter params (project/limit/type), or a
// placeholder list sized by a fixed column set (e.g. `consolidate-core.ts`'s
// VALUES) — so it cannot scale past the safe limit and is intentionally left
// unchunked.
//
// hooks/ carve-out: the self-contained-hooks rule (AGENTS.md "Hooks are
// self-contained") forbids hooks/ importing from src/, so a hook that builds an
// input-scaled bind list cannot call this helper — it must inline a local
// equivalent, the way hooks already duplicate other small utilities. No hook
// builds an input-scaled list today.
//
// `tests/lib/chunk-audit.test.ts` partly enforces this note: it fails when a new
// input-scaled placeholder list (`.map(() => '?')` / `Array.from(x, () => '?')`)
// appears in a src/ or hooks/ file that doesn't already route some query through
// `chunked()` (and isn't allowlisted fixed-size). The guard is file-granular, not
// per-statement: a file that already calls `chunked()` anywhere is exempt
// wholesale, so a new un-chunked sibling list added to one of these bulk-SQL
// files (dump.ts, aging.ts, dedup.ts, memory.ts) is NOT caught — chunk those by
// hand. (Per-statement granularity would need data-flow analysis: dump.ts binds
// its chunk var two hops from `chunked()`, so a line-level regex can't tell a
// chunk-derived `.map(() => '?')` from a raw-input one.)

/**
 * Conservative default chunk size. Well under the historical 999-variable
 * limit, leaving room for a few extra fixed bind params alongside the list.
 */
export const SQLITE_SAFE_CHUNK_SIZE = 500;

/**
 * Split `items` into consecutive chunks of at most `size` elements.
 * Preserves input order; every item appears exactly once across chunks.
 * An empty input yields zero chunks.
 *
 * @throws {RangeError} if `size` is not a positive integer. `size` is validated
 *   before the empty-input check, so `chunked([], 0)` throws rather than
 *   returning `[]`.
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
