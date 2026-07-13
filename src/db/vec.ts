// sqlite-vec native vector index (issue #148, A1 of epic #146).
//
// A best-effort FAST TIER layered over the canonical `embeddings` BLOB table:
// when the sqlite-vec extension loads, vector search runs as a native KNN query
// against a `vec0` virtual table; when it can't load, callers fall back to the
// existing brute-force JS cosine scan. The `embeddings` BLOB table stays
// canonical — it is both the re-index source and the fallback's source.
//
// 🔒 Invariants:
// - sqlite-vec is OPTIONAL. With the extension unloadable (e.g. a macOS without
//   a Homebrew libsqlite3), nothing here throws to the caller and search still
//   works on FTS5 + brute-force cosine. The vec index is never required.
// - The index is synced from the canonical BLOBs ONCE per process and cached
//   (ensureVecIndexSynced) — never rebuilt per query/turn.
//
// Loading notes (spike-validated 2026-06-22, sqlite-vec v0.1.9):
// - macOS system libsqlite3 ships with extension loading DISABLED. bun:sqlite
//   must be pointed at a capable build via Database.setCustomSQLite() BEFORE the
//   first Database is opened (it is process-global). We auto-detect Homebrew's
//   libsqlite3 (arm64 + Intel paths) and silently keep the default if absent.
// - Linux: Bun's bundled SQLite loads the extension natively — no custom build.

import { Database } from 'bun:sqlite';
import { existsSync } from 'fs';
import * as sqliteVec from 'sqlite-vec';
import { EMBEDDING_DIMENSIONS, embeddingToBlob } from '../lib/embeddings.js';
import { notMarkedDuplicateSql } from '../lib/dedup.js';

// Homebrew libsqlite3 (extension-capable) — arm64 then Intel prefix.
const MACOS_SQLITE_CANDIDATES = [
  '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib',
  '/usr/local/opt/sqlite/lib/libsqlite3.dylib',
];

let customSqliteAttempted = false;

// Point bun:sqlite at an extension-capable libsqlite3 on macOS, once, before
// any Database is opened. No-op on Linux (bundled SQLite already supports it)
// and when no Homebrew libsqlite3 is present (→ vec stays unavailable, callers
// fall back to brute-force).
function ensureCustomSqlite(): void {
  if (customSqliteAttempted) return;
  customSqliteAttempted = true;
  if (process.platform !== 'darwin') return;
  for (const path of MACOS_SQLITE_CANDIDATES) {
    if (!existsSync(path)) continue;
    try {
      Database.setCustomSQLite(path);
    } catch {
      // A Database was already opened, or the path is unusable — keep the
      // default SQLite; vec simply won't load and search falls back.
    }
    return;
  }
}

// Runs at module import. connection.ts imports this module at its own top, which
// precedes every DB open in the CLI/MCP processes, satisfying the
// "before the first new Database()" requirement.
ensureCustomSqlite();

let vecAvailable = false;

/**
 * Attempt to load sqlite-vec into an open DB connection. Per-connection (the
 * extension is loaded into each `Database`), so connection.ts calls this on
 * every open. Never throws; returns whether the load succeeded.
 */
export function loadVecExtension(db: Database): boolean {
  try {
    sqliteVec.load(db);
    vecAvailable = true;
    return true;
  } catch {
    return false;
  }
}

/** Whether sqlite-vec loaded successfully in this process. */
export function isVecAvailable(): boolean {
  return vecAvailable;
}

/** vec0 index DDL, declared at the canonical embedding dimension. The index
 *  stores NORMALIZED vectors under the default L2 metric (#217): sqlite-vec's
 *  L2 kernel is SIMD-accelerated while its cosine kernel is scalar (~2× slower
 *  per row at 100k), and for unit vectors L2² = 2·(1 − cosine), so the KNN
 *  ordering matches the brute-force cosineSimilarity ranking (exact for
 *  practically-distinct vectors; see the precision note in knnSearch) and
 *  knnSearch converts distances back. Idempotent. */
function vecTableDdl(): string {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(
    source_table TEXT,
    source_id INTEGER,
    embedding float[${EMBEDDING_DIMENSIONS}]
  )`;
}

/** Create the vec0 index table (idempotent). Caller ensures vec is loaded.
 *  Self-heals a pre-#217 cosine-metric index: the metric is baked into the
 *  vec0 DDL, so a legacy table is dropped here and re-synced from the
 *  canonical BLOBs by the next ensureVecIndexSynced (counts now differ). */
export function createVecTable(db: Database): void {
  const existing = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vec_embeddings'`
  ).get() as { sql: string } | null;
  if (existing?.sql?.includes('distance_metric=cosine')) {
    db.exec('DROP TABLE IF EXISTS vec_embeddings');
  }
  db.exec(vecTableDdl());
}

/**
 * Rebuild vec_embeddings from the canonical embeddings BLOBs, all-or-nothing.
 * Only rows at the expected dimension are indexed — a stale (pre-rebackfill)
 * row at a different dimension cannot be inserted into a float[N] table, and
 * such a DB is already prompted to re-backfill (#107). Returns rows indexed;
 * no-op (0) when vec is unavailable.
 */
export function reindexVec(db: Database): number {
  if (!vecAvailable) return 0;
  createVecTable(db);
  const rebuild = db.transaction(() => {
    db.exec('DELETE FROM vec_embeddings');
    // vec_normalize: the index stores unit vectors so the default L2 metric
    // reproduces the exact cosine ranking (see vecTableDdl).
    db.prepare(
      `INSERT INTO vec_embeddings (source_table, source_id, embedding)
       SELECT source_table, source_id, vec_normalize(embedding) FROM embeddings WHERE dimensions = ?`
    ).run(EMBEDDING_DIMENSIONS);
  });
  rebuild();
  return (db.prepare('SELECT COUNT(*) AS c FROM vec_embeddings').get() as { c: number }).c;
}

let syncedThisProcess = false;
let syncInFlight = false;

/**
 * Ensure the vec index reflects the canonical BLOBs. Runs the (O(n)) rebuild
 * only when out of sync (row counts differ) — e.g. the first vector query
 * after a #107 re-backfill or a #217 legacy-index drop — and caches SUCCESS
 * for the process lifetime; never rebuilt per query. A FAILED sync (e.g.
 * SQLITE_BUSY losing the rebuild race to a concurrent writer) does NOT latch:
 * it logs to stderr and retries on the next query, so a process can't spend
 * its lifetime silently serving an empty index (#217 review, 225-1). Never
 * throws.
 */
export function ensureVecIndexSynced(db: Database): void {
  if (!vecAvailable || syncedThisProcess || syncInFlight) return;
  syncInFlight = true;
  try {
    createVecTable(db);
    const want = (db.prepare('SELECT COUNT(*) AS c FROM embeddings WHERE dimensions = ?').get(EMBEDDING_DIMENSIONS) as { c: number }).c;
    const have = (db.prepare('SELECT COUNT(*) AS c FROM vec_embeddings').get() as { c: number }).c;
    if (have !== want) {
      // One-time O(n) rebuild (~4s @100k) inside the first vector query after
      // an upgrade — say so on stderr so an agent host doesn't read it as a hang.
      console.error(`[recall] vec index out of sync (${have}/${want} rows) — rebuilding from canonical embeddings...`);
      reindexVec(db);
    }
    syncedThisProcess = true;
  } catch (err) {
    // Never block startup/query on index sync — brute-force remains available,
    // and the un-latched flag retries the rebuild on the next vector query.
    console.error(`[recall] vec index rebuild failed (will retry on next vector query): ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    syncInFlight = false;
  }
}

/** Reset the once-per-process sync cache. Test-only. */
export function resetVecSyncCache(): void {
  syncedThisProcess = false;
}

export interface VecHit {
  source_table: string;
  source_id: number;
  /** cosine distance (0 = identical). similarity = 1 - distance. */
  distance: number;
}

/**
 * Native KNN over the vec index, nearest-first. Excludes recall-dedup marked
 * duplicates (same contract as the brute-force path's `notMarkedDuplicateSql`)
 * by over-fetching and filtering. Throws if vec is unavailable or the index is
 * missing — callers catch and fall back to brute-force.
 */
export function knnSearch(db: Database, queryEmbedding: number[], k: number): VecHit[] {
  if (!vecAvailable) throw new Error('sqlite-vec unavailable');
  const blob = embeddingToBlob(queryEmbedding);

  // Marked duplicates are excluded after the KNN (vec0 KNN cannot join), so
  // over-fetch by the number of marked rows to still return a full k.
  const markedCount = (db.prepare(
    `SELECT COUNT(*) AS c FROM dedup_lineage WHERE status = 'marked'`
  ).get() as { c: number }).c;

  const hits = db.prepare(
    `SELECT source_table, source_id, distance
     FROM vec_embeddings
     WHERE embedding MATCH vec_normalize(?) AND k = ?
     ORDER BY distance`
  ).all(blob, k + markedCount) as VecHit[];

  // The index is normalized-L2 (#217); convert each L2 distance back to the
  // cosine distance the VecHit contract promises: for unit vectors
  // L2² = 2·(1 − cos), so cos_dist = L2²/2. Monotonic, so ordering is exact
  // for practically-distinct vectors; at genuine near-ties (≲1e-6
  // cosine-distance separation, float32 noise floor) positions may permute
  // within the top-K while distance values stay accurate to ~5e-7.
  for (const h of hits) h.distance = (h.distance * h.distance) / 2;

  if (markedCount === 0) return hits.slice(0, k);

  const marked = new Set<string>(
    (db.prepare(
      `SELECT duplicate_table AS t, duplicate_id AS id FROM dedup_lineage WHERE status = 'marked'`
    ).all() as Array<{ t: string; id: number }>).map((r) => `${r.t}\x00${r.id}`)
  );
  return hits.filter((h) => !marked.has(`${h.source_table}\x00${h.source_id}`)).slice(0, k);
}

// notMarkedDuplicateSql is re-used by the brute-force fallback path in
// mcp-server; referenced here only to keep the dedup contract co-located.
export { notMarkedDuplicateSql };
