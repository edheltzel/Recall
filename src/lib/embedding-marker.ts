// Embedding model+dims marker (issue #107).
//
// The marker records which embedding model and dimension count the stored
// embeddings were produced with. It guards the one-time atomic re-backfill:
// when the marker is missing/mismatched (e.g. after upgrading the default
// model from nomic-embed-text/768 to qwen3-embedding:0.6b/1024), a stale DB is
// detected so its embeddings can be re-embedded uniformly rather than silently
// failing in cosineSimilarity on a mixed-dimension table.
//
// 🔒 Invariants (Ed-locked, #107):
// - The local embedding model stays OPTIONAL. A DB with no embeddings reports
//   'absent' (nothing to migrate); search still works on FTS5. The marker
//   never makes embeddings a hard requirement.
// - Checked ONCE at session/process start and cached for the process lifetime
//   (isRebackfillNeeded) — never per query/turn.
//
// Persisted in the existing schema_meta key-value table (no migration needed).

import { Database } from 'bun:sqlite';
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from './embeddings.js';

const MARKER_MODEL_KEY = 'embedding_model';
const MARKER_DIMS_KEY = 'embedding_dimensions';

export interface EmbeddingMarker {
  model: string;
  dimensions: number;
}

/** The model+dims the current build expects all embeddings to use. */
export function expectedEmbeddingMarker(): EmbeddingMarker {
  return { model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS };
}

/** Read the stored marker, or null if it was never written. */
export function readEmbeddingMarker(db: Database): EmbeddingMarker | null {
  const get = (key: string) =>
    (db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  const model = get(MARKER_MODEL_KEY);
  const dims = get(MARKER_DIMS_KEY);
  if (model === undefined || dims === undefined) return null;
  return { model, dimensions: Number(dims) };
}

/** Write (upsert) the current expected marker into schema_meta. */
export function writeEmbeddingMarker(db: Database, marker: EmbeddingMarker = expectedEmbeddingMarker()): void {
  const upsert = db.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)');
  upsert.run(MARKER_MODEL_KEY, marker.model);
  upsert.run(MARKER_DIMS_KEY, String(marker.dimensions));
}

export type MarkerStatus = 'match' | 'stale' | 'absent';

/**
 * Compute the live marker status from the DB:
 * - 'absent' — no embeddings exist (nothing to migrate; OPTIONAL invariant).
 * - 'stale'  — embeddings exist but any row, or the stored marker, disagrees
 *              with the expected model/dims (re-backfill needed).
 * - 'match'  — embeddings exist and both the rows and the marker match.
 *
 * Row-level checking (not just the marker) catches a mixed-model table even if
 * a partial backfill stamped an optimistic marker.
 */
export function embeddingMarkerStatus(db: Database): MarkerStatus {
  const expected = expectedEmbeddingMarker();

  const total = (db.prepare('SELECT COUNT(*) AS c FROM embeddings').get() as { c: number }).c;
  if (total === 0) return 'absent';

  const mismatched = (db
    .prepare('SELECT COUNT(*) AS c FROM embeddings WHERE model != ? OR dimensions != ?')
    .get(expected.model, expected.dimensions) as { c: number }).c;
  if (mismatched > 0) return 'stale';

  const marker = readEmbeddingMarker(db);
  if (!marker || marker.model !== expected.model || marker.dimensions !== expected.dimensions) {
    return 'stale';
  }
  return 'match';
}

let cachedRebackfillNeeded: boolean | undefined;

/**
 * Whether a re-backfill is needed, computed ONCE per process and cached.
 * Subsequent calls return the cached result without touching the DB — this is
 * the read-once-at-process-start contract (#107). Never call this on a
 * per-query path. Best-effort: any error resolves to false (never block).
 */
export function isRebackfillNeeded(db: Database): boolean {
  if (cachedRebackfillNeeded === undefined) {
    try {
      cachedRebackfillNeeded = embeddingMarkerStatus(db) === 'stale';
    } catch {
      cachedRebackfillNeeded = false;
    }
  }
  return cachedRebackfillNeeded;
}

/** Reset the read-once cache. Test-only — production checks once per process. */
export function resetEmbeddingMarkerCache(): void {
  cachedRebackfillNeeded = undefined;
}
