// recall dump command - Flush current session to DB + capture LoA
// Core functions are exported for use by the MCP server's memory_dump tool.

import { getDb } from '../db/connection.js';
import { createSession, sessionExists, addMessagesBatch, createLoaEntry } from '../lib/memory.js';
import { chunked } from '../lib/chunk.js';
import { embed, embeddingToBlob, checkEmbeddingService } from '../lib/embeddings.js';
import { formatMessagesForExtraction, generateBasicSummary, runFabricExtract } from '../lib/extraction.js';
import { discoverCurrentSession } from '../hosts/session-sources.js';
import type { ParsedSession, SessionSource } from '../hosts/session-source.js';

export type { ParsedSession, SessionSource } from '../hosts/session-source.js';
export { parseMarkdownDrop } from '../hosts/markdown-session-source.js';

interface DumpOptions {
  project?: string;
  continues?: number;
  tags?: string;
  limit?: number;
  skipFabric?: boolean;
  /** Test/internal seam; normal CLI and MCP behavior still attempts LoA embedding. */
  skipEmbed?: boolean;
}

const EXPLICIT_DUMP_DESCRIPTION = 'Explicit memory dump.';

interface DumpMessageRow {
  id: number;
  content: string;
  role: 'user' | 'assistant' | 'system';
  timestamp: string;
  project: string | null;
}

// ============ Internal Helpers ============

async function autoEmbedLoaEntry(id: number, title: string, fabricExtract: string): Promise<void> {
  try {
    const serviceStatus = await checkEmbeddingService();
    if (!serviceStatus.available) return;

    const content = `${title}\n\n${fabricExtract}`;
    const result = await embed(content);
    const blob = embeddingToBlob(result.embedding);

    const db = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO embeddings (source_table, source_id, model, dimensions, embedding)
      VALUES (?, ?, ?, ?, ?)
    `).run('loa_entries', id, result.model, result.dimensions, blob);
  } catch {
    // Non-fatal
  }
}

// Exported for tests — bind count scales with the number of LoA entries,
// so the IN lists are chunked (see src/lib/chunk.ts).
//
// The chunked deletes run statement-by-statement, so the body runs inside
// db.transaction() to keep the traversal all-or-nothing for every caller.
// bun:sqlite nests transactions via SAVEPOINT, so calling this from within
// an outer transaction (as deleteSession does) is safe.
export function deleteLoaEntriesRecursive(db: ReturnType<typeof getDb>, loaIds: number[]): void {
  if (loaIds.length === 0) return;

  db.transaction(() => {
    const chunks = chunked(loaIds);

    const childIds: number[] = [];
    for (const chunk of chunks) {
      const rows = db.prepare(`
        SELECT id FROM loa_entries WHERE parent_loa_id IN (${chunk.map(() => '?').join(',')})
      `).all(...chunk) as Array<{ id: number }>;
      for (const row of rows) childIds.push(row.id);
    }

    if (childIds.length > 0) {
      deleteLoaEntriesRecursive(db, childIds);
    }

    for (const chunk of chunks) {
      db.prepare(`
        DELETE FROM loa_entries WHERE id IN (${chunk.map(() => '?').join(',')})
      `).run(...chunk);
    }
  })();
}

function clearSessionMessages(sessionId: string): number {
  const db = getDb();

  const deleteAll = db.transaction(() => {
    const countResult = db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?').get(sessionId) as { count: number };
    const count = countResult?.count || 0;

    const rangeResult = db.prepare('SELECT MIN(id) as minId, MAX(id) as maxId FROM messages WHERE session_id = ?').get(sessionId) as { minId: number | null; maxId: number | null };

    if (rangeResult && rangeResult.minId !== null && rangeResult.maxId !== null) {
      const affectedLoaIds = db.prepare(`
        SELECT id FROM loa_entries
        WHERE message_range_start >= ? AND message_range_end <= ?
      `).all(rangeResult.minId, rangeResult.maxId) as Array<{ id: number }>;

      if (affectedLoaIds.length > 0) {
        deleteLoaEntriesRecursive(db, affectedLoaIds.map(e => e.id));
      }
    }

    db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);

    return count;
  });

  return deleteAll();
}

function lifecycleSessionSource(sessionId: string): string | undefined {
  const row = getDb()
    .prepare('SELECT source FROM host_ingest_state WHERE session_id = ? LIMIT 1')
    .get(sessionId) as { source: string } | undefined;
  return row?.source;
}

function explicitSnapshotKey(message: Pick<DumpMessageRow, 'role' | 'content' | 'project'>): string {
  return JSON.stringify([message.role, message.content, message.project]);
}

function findExplicitSnapshot(session: ParsedSession): DumpMessageRow[] | undefined {
  const rows = getDb()
    .prepare(`
      SELECT m.id, m.content, m.role, m.timestamp, m.project
      FROM messages m
      WHERE m.session_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM host_ingest_messages h WHERE h.message_id = m.id
        )
      ORDER BY m.id
    `)
    .all(session.sessionId) as DumpMessageRow[];
  const expectedKeys = session.messages.map(message =>
    explicitSnapshotKey({
      role: message.role,
      content: message.content,
      project: message.project ?? session.project ?? null,
    })
  );

  for (let start = rows.length - expectedKeys.length; start >= 0; start--) {
    const snapshot = rows.slice(start, start + expectedKeys.length);
    const contiguous = snapshot.every((message, index) =>
      index === 0 || message.id === snapshot[index - 1].id + 1
    );
    if (
      contiguous &&
      snapshot.every((message, index) => explicitSnapshotKey(message) === expectedKeys[index])
    ) {
      return snapshot;
    }
  }

  return undefined;
}

function clearExplicitDumpLoa(sessionId: string): void {
  const ids = getDb()
    .prepare('SELECT id FROM loa_entries WHERE session_id = ? AND description = ?')
    .all(sessionId, EXPLICIT_DUMP_DESCRIPTION) as Array<{ id: number }>;
  deleteLoaEntriesRecursive(getDb(), ids.map(row => row.id));
}

// ============ Core Dump Logic (shared by CLI and MCP) ============

/**
 * Core dump logic — imports session to SQLite and optionally runs Fabric.
 * Used by both the `recall dump` CLI command and the `memory_dump` MCP tool.
 */
export async function coreDump(title: string, options: DumpOptions & { session?: ParsedSession }): Promise<{
  success: boolean;
  sessionId: string;
  messageCount: number;
  loaId?: number;
  source: SessionSource;
  error?: string;
}> {
  const session = options.session || discoverCurrentSession();

  if (!session) {
    return { success: false, sessionId: '', messageCount: 0, source: 'mcp', error: 'No session input or supported host session files found' };
  }

  if (options.project) {
    for (const msg of session.messages) {
      msg.project = options.project;
    }
  }

  const replacingSession = sessionExists(session.sessionId);
  const lifecycleSource = replacingSession
    ? lifecycleSessionSource(session.sessionId)
    : undefined;
  if (lifecycleSource && lifecycleSource !== session.source) {
    return {
      success: false,
      sessionId: session.sessionId,
      messageCount: 0,
      source: session.source,
      error: `Session ${session.sessionId} is owned by ${lifecycleSource}, not ${session.source}`,
    };
  }
  const lifecycleOwned = Boolean(lifecycleSource);
  if (replacingSession && !lifecycleOwned) clearSessionMessages(session.sessionId);
  const existingSnapshot = lifecycleOwned ? findExplicitSnapshot(session) : undefined;
  if (lifecycleOwned) clearExplicitDumpLoa(session.sessionId);

  // Import messages to SQLite FIRST (fast, always succeeds)
  const timestamps = session.messages.map(m => m.timestamp).sort();
  const project = options.project || session.project;
  if (replacingSession && !lifecycleOwned) {
    getDb().prepare(`
      UPDATE sessions SET
        started_at = ?, ended_at = ?, summary = ?, project = ?,
        cwd = NULL, git_branch = NULL, model = NULL, source = ?
      WHERE session_id = ?
    `).run(
      timestamps[0],
      timestamps[timestamps.length - 1],
      `Dumped: ${title}`,
      project ?? null,
      session.source,
      session.sessionId
    );
  } else if (!replacingSession) {
    createSession({
      session_id: session.sessionId,
      started_at: timestamps[0],
      ended_at: timestamps[timestamps.length - 1],
      project,
      summary: `Dumped: ${title}`,
      source: session.source,
    });
  }

  // Raw conversation capture is verbatim (ADR-0001).
  const messagesToImport = existingSnapshot ? [] : session.messages;
  const importedCount = addMessagesBatch(
    messagesToImport.map(message => ({ ...message, provenance: 'verbatim' as const }))
  );

  const db = getDb();
  const snapshotMessages = lifecycleOwned
    ? (existingSnapshot ?? findExplicitSnapshot(session) ?? [])
    : db.prepare(`
        SELECT id, content, role, timestamp, project
        FROM messages
        WHERE session_id = ?
        ORDER BY timestamp
      `).all(session.sessionId) as DumpMessageRow[];
  const importedMessages = options.limit
    ? snapshotMessages.slice(0, options.limit)
    : snapshotMessages;

  if (importedMessages.length === 0) {
    return { success: true, sessionId: session.sessionId, messageCount: importedCount, source: session.source };
  }

  const startId = importedMessages[0].id;
  const endId = importedMessages[importedMessages.length - 1].id;

  // Try Fabric, fall back to basic summary
  let fabricExtract: string;
  if (options.skipFabric) {
    fabricExtract = generateBasicSummary(importedMessages);
  } else {
    try {
      const conversationText = formatMessagesForExtraction(importedMessages);
      fabricExtract = runFabricExtract(conversationText);
    } catch {
      fabricExtract = generateBasicSummary(importedMessages);
    }
  }

  const loaId = createLoaEntry({
    title,
    description: lifecycleOwned ? EXPLICIT_DUMP_DESCRIPTION : undefined,
    fabric_extract: fabricExtract,
    message_range_start: startId,
    message_range_end: endId,
    parent_loa_id: options.continues,
    session_id: lifecycleOwned ? session.sessionId : undefined,
    project: options.project || session.project,
    tags: options.tags,
    message_count: importedMessages.length,
    source_ids: JSON.stringify(importedMessages.map(message => ({ table: 'messages', id: message.id }))),
    // Fabric output and the basic-summary fallback are both generated from
    // the session messages — extracted either way (ADR-0001).
    provenance: 'extracted'
  });

  if (!options.skipEmbed) await autoEmbedLoaEntry(loaId, title, fabricExtract);

  return {
    success: true,
    sessionId: session.sessionId,
    messageCount: importedCount,
    loaId,
    source: session.source
  };
}

// ============ CLI Entry Point ============

export async function runDump(title: string, options: DumpOptions): Promise<void> {
  console.log('Memory Dump');
  console.log('===========\n');

  const result = await coreDump(title, options);

  if (!result.success) {
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }

  console.log(`Source: ${result.source}`);
  console.log(`Session: ${result.sessionId}`);
  console.log(`✓ Imported ${result.messageCount} messages`);

  if (result.loaId) {
    console.log(`✓ LoA #${result.loaId} captured: "${title}"`);
  }
}
