import type { Database } from 'bun:sqlite';

export function publishedRecordTable(table: string): string {
  return table === 'messages' ? 'published_messages' : table;
}

function tableExists(db: Database, table: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(table));
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
  return `(${sourceTable} <> 'messages' OR (
    EXISTS (SELECT 1 FROM published_messages WHERE id = ${sourceId})
    ${invalidationGate}
  ))`;
}
