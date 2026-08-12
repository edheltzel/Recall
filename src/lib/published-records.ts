import type { Database } from 'bun:sqlite';
import { tableExists } from '../db/introspection.js';

export function publishedRecordTable(table: string): string {
  return table === 'messages' ? 'published_messages' : table;
}

export function publishedEmbeddingSql(
  db: Database,
  sourceTable = 'source_table',
  sourceId = 'source_id'
): string {
  const invalidationGate = tableExists(db, 'host_ingest_embedding_invalidations')
    ? `AND NOT EXISTS (
        SELECT 1
        FROM host_ingest_embedding_invalidations AS invalidation
        JOIN host_ingest_state AS state
          ON state.active_generation = invalidation.generation_id
        WHERE invalidation.message_id = ${sourceId}
      )`
    : '';
  return `(
    (${sourceTable} = 'loa_entries' AND EXISTS (
      SELECT 1 FROM loa_entries WHERE id = ${sourceId}
    )) OR
    (${sourceTable} = 'decisions' AND EXISTS (
      SELECT 1 FROM decisions WHERE id = ${sourceId}
    )) OR
    (${sourceTable} = 'learnings' AND EXISTS (
      SELECT 1 FROM learnings WHERE id = ${sourceId}
    )) OR
    (${sourceTable} = 'breadcrumbs' AND EXISTS (
      SELECT 1 FROM breadcrumbs WHERE id = ${sourceId}
    )) OR
    (${sourceTable} = 'messages' AND EXISTS (
      SELECT 1 FROM published_messages WHERE id = ${sourceId}
    ) ${invalidationGate})
  )`;
}
