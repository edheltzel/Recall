import type { Database } from 'bun:sqlite';
import { tableExists } from '../db/introspection.js';
import { invalidateVecIndex } from '../db/vec.js';
import { EMBEDDING_CLEANUP_TRIGGERS } from '../db/schema.js';
import { chunked } from './chunk.js';
import type { ProvenanceTable } from '../types/index.js';

const invalidationTableAvailability = new WeakMap<Database, boolean>();

export interface EmbeddingWrite {
  sourceTable: string;
  sourceId: number;
  model: string;
  dimensions: number;
  embedding: Buffer;
  sourceContent?: string;
}

const EMBEDDING_CLEANUP_TRIGGER_NAMES = [
  'embeddings_ad',
  'messages_embedding_ad',
  'decisions_embedding_ad',
  'learnings_embedding_ad',
  'breadcrumbs_embedding_ad',
  'loa_entries_embedding_ad',
];

export function ensureEmbeddingCleanupReady(db: Database): void {
  db.exec(EMBEDDING_CLEANUP_TRIGGERS);
  const placeholders = EMBEDDING_CLEANUP_TRIGGER_NAMES.map(() => '?').join(', ');
  const count = db.prepare(
    `SELECT COUNT(*) AS count FROM sqlite_master
     WHERE type = 'trigger' AND name IN (${placeholders})`
  ).get(...EMBEDDING_CLEANUP_TRIGGER_NAMES) as { count: number };
  if (count.count !== EMBEDDING_CLEANUP_TRIGGER_NAMES.length) {
    throw new Error('embedding cleanup schema is not ready');
  }
}

function finishEmbeddingDeletion(db: Database, changes: number): number {
  if (changes > 0 && !db.prepare(
    `SELECT 1 FROM schema_meta WHERE key = 'vec_index_dirty'`
  ).get()) {
    invalidateVecIndex(db);
  }
  return changes;
}

export function deleteRecordEmbeddingsByIdsInTransaction(
  db: Database,
  sourceTable: ProvenanceTable,
  sourceIds: number[]
): number {
  ensureEmbeddingCleanupReady(db);
  let changes = 0;
  for (const ids of chunked(sourceIds)) {
    const placeholders = ids.map(() => '?').join(', ');
    changes += db.prepare(
      `DELETE FROM embeddings WHERE source_table = ? AND source_id IN (${placeholders})`
    ).run(sourceTable, ...ids).changes;
  }
  return finishEmbeddingDeletion(db, changes);
}

export function deleteRecordEmbeddingsBySelectionInTransaction(
  db: Database,
  sourceTable: ProvenanceTable,
  sourceIdSelection: string,
  params: Array<string | number> = []
): number {
  ensureEmbeddingCleanupReady(db);
  const changes = db.prepare(
    `DELETE FROM embeddings WHERE source_table = ? AND source_id IN (${sourceIdSelection})`
  ).run(sourceTable, ...params).changes;
  return finishEmbeddingDeletion(db, changes);
}

function acknowledgeLifecycleInvalidation(
  db: Database,
  sourceTable: string,
  sourceId: number,
  sourceContent?: string
): void {
  if (sourceTable !== 'messages' || sourceContent === undefined) {
    return;
  }
  let invalidationsAvailable = invalidationTableAvailability.get(db);
  if (invalidationsAvailable === undefined) {
    invalidationsAvailable = tableExists(db, 'host_ingest_embedding_invalidations');
    invalidationTableAvailability.set(db, invalidationsAvailable);
  }
  if (!invalidationsAvailable) return;
  db.prepare(`
    DELETE FROM host_ingest_embedding_invalidations
    WHERE message_id = ?
      AND EXISTS (
        SELECT 1
        FROM host_ingest_state AS state
        JOIN host_ingest_generation_messages AS message
          ON message.generation_id = state.active_generation
         AND message.message_id = host_ingest_embedding_invalidations.message_id
        WHERE state.active_generation = host_ingest_embedding_invalidations.generation_id
          AND message.content = ?
          AND (message.source <> 'grok' OR message.source_position IS NOT NULL)
      )
  `).run(sourceId, sourceContent);
}

function persistEmbedding(db: Database, write: EmbeddingWrite): void {
  db.prepare(`
    INSERT OR REPLACE INTO embeddings (
      source_table, source_id, model, dimensions, embedding
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    write.sourceTable,
    write.sourceId,
    write.model,
    write.dimensions,
    write.embedding
  );
  acknowledgeLifecycleInvalidation(
    db,
    write.sourceTable,
    write.sourceId,
    write.sourceContent
  );
}

export function upsertEmbeddingInTransaction(db: Database, write: EmbeddingWrite): void {
  invalidateVecIndex(db);
  persistEmbedding(db, write);
}

export function upsertEmbeddingsInTransaction(
  db: Database,
  writes: Iterable<EmbeddingWrite>
): void {
  invalidateVecIndex(db);
  for (const write of writes) persistEmbedding(db, write);
}

export function upsertEmbedding(db: Database, write: EmbeddingWrite): void {
  db.transaction(() => upsertEmbeddingInTransaction(db, write)).immediate();
}
