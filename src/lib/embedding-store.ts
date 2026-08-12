import type { Database } from 'bun:sqlite';
import { tableExists } from '../db/introspection.js';
import { invalidateVecIndex } from '../db/vec.js';

const invalidationTableAvailability = new WeakMap<Database, boolean>();

export interface EmbeddingWrite {
  sourceTable: string;
  sourceId: number;
  model: string;
  dimensions: number;
  embedding: Buffer;
  sourceContent?: string;
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
