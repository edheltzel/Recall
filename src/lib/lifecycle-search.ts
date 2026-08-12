import { Database } from 'bun:sqlite';
import { SQLITE_SAFE_CHUNK_SIZE } from './chunk.js';

export const LIFECYCLE_SEARCH_RETRYABLE =
  'RETRYABLE: Lifecycle message search index is not ready; retry the search or run recall repair --execute.';

export type LifecycleSearchReadiness =
  | { status: 'ready'; pendingGenerations: 0 }
  | { status: 'retryable'; pendingGenerations: number; message: string };

interface LifecycleSearchRepairOptions {
  project?: string;
  generationId?: string;
  maxPages?: number;
}

function tableExists(db: Database, name: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name));
}

function lifecycleStorageAvailable(db: Database): boolean {
  return [
    'host_ingest_generations',
    'host_ingest_generation_messages',
    'host_ingest_state',
  ].every(table => tableExists(db, table));
}

function lifecycleFtsAvailable(db: Database): boolean {
  if (!tableExists(db, 'host_ingest_generation_messages_fts')) return false;
  return (db.prepare(`
    PRAGMA table_info(host_ingest_generation_messages_fts)
  `).all() as Array<{ name: string }>).some(column => column.name === 'generation_id');
}

function generationReadinessAvailable(db: Database): boolean {
  if (!tableExists(db, 'host_ingest_generations')) return false;
  return (db.prepare(`
    PRAGMA table_info(host_ingest_generations)
  `).all() as Array<{ name: string }>).some(column => column.name === 'fts_ready');
}

function activeGenerationCount(db: Database, project?: string, unreadyOnly = false): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM host_ingest_generations AS generation
    JOIN host_ingest_state AS state
      ON state.active_generation = generation.generation_id
     AND state.source = generation.source
     AND state.session_id = generation.session_id
    WHERE generation.status = 'active'
      ${unreadyOnly ? 'AND generation.fts_ready = 0' : ''}
      ${project ? `AND EXISTS (
        SELECT 1 FROM host_ingest_generation_messages AS message
        WHERE message.generation_id = generation.generation_id
          AND message.project = ?
          AND message.content IS NOT NULL
          AND (message.source <> 'grok' OR message.source_position IS NOT NULL)
      )` : ''}
  `).get(...(project ? [project] : [])) as { count: number };
  return row.count;
}

export function getLifecycleSearchReadiness(
  db: Database,
  project?: string
): LifecycleSearchReadiness {
  if (!lifecycleStorageAvailable(db)) {
    return { status: 'ready', pendingGenerations: 0 };
  }
  const active = activeGenerationCount(db, project);
  if (active === 0) return { status: 'ready', pendingGenerations: 0 };
  if (!lifecycleFtsAvailable(db) || !generationReadinessAvailable(db)) {
    return {
      status: 'retryable',
      pendingGenerations: active,
      message: LIFECYCLE_SEARCH_RETRYABLE,
    };
  }
  const pending = activeGenerationCount(db, project, true);
  return pending === 0
    ? { status: 'ready', pendingGenerations: 0 }
    : {
        status: 'retryable',
        pendingGenerations: pending,
        message: LIFECYCLE_SEARCH_RETRYABLE,
      };
}

function isPublishedGeneration(db: Database, generationId: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM host_ingest_generations AS generation
    JOIN host_ingest_state AS state
      ON state.active_generation = generation.generation_id
     AND state.source = generation.source
     AND state.session_id = generation.session_id
    WHERE generation.generation_id = ? AND generation.status = 'active'
  `).get(generationId));
}

export function repairLifecycleSearchGenerationPage(
  db: Database,
  generationId: string
): boolean {
  const generation = db.prepare(`
    SELECT generation.fts_ready
    FROM host_ingest_generations AS generation
    JOIN host_ingest_state AS state
      ON state.active_generation = generation.generation_id
     AND state.source = generation.source
     AND state.session_id = generation.session_id
    WHERE generation.generation_id = ? AND generation.status = 'active'
  `).get(generationId) as { fts_ready: number } | undefined;
  if (!generation || generation.fts_ready === 1) return true;

  const rows = db.prepare(`
    SELECT ordinal, source, message_id, content, project, source_position
    FROM host_ingest_generation_messages
    WHERE generation_id = ? AND fts_pending = 1
    ORDER BY ordinal LIMIT ?
  `).all(generationId, SQLITE_SAFE_CHUNK_SIZE) as Array<{
    ordinal: number;
    source: string;
    message_id: number | null;
    content: string | null;
    project: string | null;
    source_position: number | null;
  }>;

  if (rows.length > 0) {
    const remove = db.prepare(`
      DELETE FROM host_ingest_generation_messages_fts WHERE rowid = ?
    `);
    const insert = db.prepare(`
      INSERT INTO host_ingest_generation_messages_fts(
        rowid, content, project, generation_id
      ) VALUES (?, ?, ?, ?)
    `);
    const complete = db.prepare(`
      UPDATE host_ingest_generation_messages SET fts_pending = 0
      WHERE generation_id = ? AND ordinal = ?
    `);
    const indexed = db.transaction(() => {
      if (!isPublishedGeneration(db, generationId)) return false;
      for (const row of rows) {
        if (row.message_id !== null) {
          remove.run(row.message_id);
          if (row.content !== null &&
            (row.source !== 'grok' || row.source_position !== null)) {
            insert.run(row.message_id, row.content, row.project, generationId);
          }
        }
        complete.run(generationId, row.ordinal);
      }
      return true;
    }).immediate();
    if (!indexed) return true;
    if (db.prepare(`
      SELECT 1 FROM host_ingest_generation_messages
      WHERE generation_id = ? AND fts_pending = 1 LIMIT 1
    `).get(generationId)) return false;
  }

  db.transaction(() => {
    db.prepare(`
      UPDATE host_ingest_generations SET fts_ready = 1
      WHERE generation_id = ? AND status = 'active' AND EXISTS (
        SELECT 1 FROM host_ingest_state AS state
        WHERE state.active_generation = host_ingest_generations.generation_id
          AND state.source = host_ingest_generations.source
          AND state.session_id = host_ingest_generations.session_id
      )
    `).run(generationId);
  }).immediate();
  return true;
}

export function repairLifecycleSearchIndex(
  db: Database,
  options: LifecycleSearchRepairOptions = {}
): LifecycleSearchReadiness {
  let readiness = getLifecycleSearchReadiness(db, options.project);
  if (readiness.status === 'ready' || !lifecycleFtsAvailable(db) ||
    !generationReadinessAvailable(db)) {
    return readiness;
  }

  const maxPages = options.maxPages ?? 1;
  for (let page = 0; page < maxPages; page++) {
    const generation = db.prepare(`
      SELECT generation.generation_id
      FROM host_ingest_generations AS generation
      JOIN host_ingest_state AS state
        ON state.active_generation = generation.generation_id
       AND state.source = generation.source
       AND state.session_id = generation.session_id
      WHERE generation.status = 'active' AND generation.fts_ready = 0
        ${options.generationId ? 'AND generation.generation_id = ?' : ''}
        ${options.project ? `AND EXISTS (
          SELECT 1 FROM host_ingest_generation_messages AS message
          WHERE message.generation_id = generation.generation_id
            AND message.project = ?
            AND message.content IS NOT NULL
            AND (message.source <> 'grok' OR message.source_position IS NOT NULL)
        )` : ''}
      ORDER BY generation.created_at, generation.generation_id
      LIMIT 1
    `).get(
      ...[
        ...(options.generationId ? [options.generationId] : []),
        ...(options.project ? [options.project] : []),
      ]
    ) as { generation_id: string } | undefined;
    if (!generation) break;
    repairLifecycleSearchGenerationPage(db, generation.generation_id);
    readiness = getLifecycleSearchReadiness(db, options.project);
    if (readiness.status === 'ready') break;
  }
  return readiness;
}
