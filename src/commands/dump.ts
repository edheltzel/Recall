// recall dump command - Flush current session to DB + capture LoA
// Core functions are exported for use by the MCP server's memory_dump tool.

import { getDb } from '../db/connection.js';
import {
  createSession,
  sessionExists,
  addMessagesBatch,
  createLoaEntry,
  invalidateRecordEmbedding,
} from '../lib/memory.js';
import { chunked } from '../lib/chunk.js';
import {
  deleteRecordEmbeddingsByIdsInTransaction,
  deleteRecordEmbeddingsBySelectionInTransaction,
} from '../lib/embedding-store.js';
import { embed, embeddingToBlob, checkEmbeddingService } from '../lib/embeddings.js';
import { formatMessagesForExtraction, generateBasicSummary, runFabricExtract, ExtractorConfigError } from '../lib/extraction.js';
import { discoverCurrentSession } from '../hosts/session-sources.js';
import type { ParsedSession, SessionSource } from '../hosts/session-source.js';
import { HARNESS_ID, readStdin } from './capture.js';
import { detectProject } from '../lib/project.js';
import { scrub } from '../lib/write-safety.js';
import { basename } from 'path';

export type { ParsedSession, SessionSource } from '../hosts/session-source.js';
export { parseMarkdownDrop } from '../hosts/markdown-session-source.js';

interface DumpOptions {
  project?: string;
  continues?: number;
  tags?: string;
  limit?: number;
  skipFabric?: boolean;
  /** Read a host-supplied session (contract 1 JSON) from stdin instead of discovering one. */
  stdin?: boolean;
  /** Test/internal seam; normal CLI and MCP behavior still attempts LoA embedding. */
  skipEmbed?: boolean;
  /** Test/internal seam; production uses runFabricExtract. */
  extract?: (content: string) => string;
}

const EXPLICIT_DUMP_DESCRIPTION = 'Explicit memory dump.';

interface DumpMessageRow {
  id: number;
  content: string;
  role: 'user' | 'assistant' | 'system';
  timestamp: string;
  project: string | null;
}

/**
 * Host-supplied session (contract 1) for hosts whose live transcript only their own
 * extension can read, e.g. omp's `recall_dump` tool. Malformed input is rejected whole.
 */
export function parseDumpSessionJson(raw: string): ParsedSession {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('dump --stdin expects contract 1 JSON');
  }
  const payload = value as Record<string, unknown> | null;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.contract !== 1) {
    throw new Error('dump --stdin expects contract 1 JSON');
  }
  const { harness, session_id: sessionId, messages, cwd, project } = payload;
  if (typeof harness !== 'string' || !HARNESS_ID.test(harness)) throw new Error('invalid harness');
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 512 || /[\u0000-\u001f\u007f]/.test(sessionId)) {
    throw new Error('invalid session_id');
  }
  if (!Array.isArray(messages)) throw new Error('messages must be an array');
  const sessionProject = typeof project === 'string' && project
    ? project
    : typeof cwd === 'string' && cwd ? detectProject(cwd) || basename(cwd) : harness;
  return {
    source: harness,
    sessionId,
    project: sessionProject,
    filePath: '',
    messages: messages.map(message => {
      const row = message as Record<string, unknown> | null;
      if (!row || (row.role !== 'user' && row.role !== 'assistant') || typeof row.content !== 'string' || !row.content.trim()) {
        throw new Error('messages must be user/assistant rows with text content');
      }
      return {
        session_id: sessionId,
        timestamp: typeof row.timestamp === 'string' && row.timestamp ? row.timestamp : new Date().toISOString(),
        role: row.role,
        content: row.content,
        project: sessionProject,
      };
    }),
  };
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
      deleteRecordEmbeddingsByIdsInTransaction(db, 'loa_entries', chunk);
      db.prepare(`
        DELETE FROM loa_entries WHERE id IN (${chunk.map(() => '?').join(',')})
      `).run(...chunk);
    }
  })();
}

function clearSessionMessages(sessionId: string): number {
  const db = getDb();

  const deleteAll = db.transaction(() => {
    const countResult = db.prepare('SELECT COUNT(*) as count FROM published_messages WHERE session_id = ?').get(sessionId) as { count: number };
    const count = countResult?.count || 0;

    const rangeResult = db.prepare('SELECT MIN(id) as minId, MAX(id) as maxId FROM published_messages WHERE session_id = ?').get(sessionId) as { minId: number | null; maxId: number | null };

    if (rangeResult && rangeResult.minId !== null && rangeResult.maxId !== null) {
      const affectedLoaIds = db.prepare(`
        SELECT id FROM loa_entries
        WHERE message_range_start >= ? AND message_range_end <= ?
      `).all(rangeResult.minId, rangeResult.maxId) as Array<{ id: number }>;

      if (affectedLoaIds.length > 0) {
        deleteLoaEntriesRecursive(db, affectedLoaIds.map(e => e.id));
      }
    }

    deleteRecordEmbeddingsBySelectionInTransaction(
      db,
      'messages',
      'SELECT id FROM messages WHERE session_id = ?',
      [sessionId]
    );
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

/**
 * Old dumps stored unscrubbed text: compare scrubbed, then rewrite the matched span in place.
 * Rows that scrub to blank are dropped from incoming dumps, so they are skipped when matching
 * but kept on disk (rewritten) and returned, so the span's ids stay contiguous for the next
 * re-dump and the existing LoA's source_ids still match (its extract is then regenerated).
 */
function findExplicitSnapshot(session: ParsedSession): DumpMessageRow[] | undefined {
  const db = getDb();
  const rows = (db
    .prepare(`
      SELECT m.id, m.content, m.role, m.timestamp, m.project
      FROM published_messages m
      WHERE m.session_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM active_host_ingest_messages h WHERE h.message_id = m.id
        )
      ORDER BY m.id
    `)
    .all(session.sessionId) as DumpMessageRow[])
    .map((row, index) => ({ row, index, content: scrub(row.content).text }));
  const kept = rows.filter(({ content }) => content.trim());
  const expectedKeys = session.messages.map(message =>
    explicitSnapshotKey({
      role: message.role,
      content: message.content,
      project: message.project ?? session.project ?? null,
    })
  );
  if (expectedKeys.length === 0) return undefined;

  for (let start = kept.length - expectedKeys.length; start >= 0; start--) {
    const snapshot = kept.slice(start, start + expectedKeys.length);
    const span = rows.slice(snapshot[0].index, snapshot[snapshot.length - 1].index + 1);
    const contiguous = span.every(({ row }, index) =>
      index === 0 || row.id === span[index - 1].row.id + 1
    );
    if (
      contiguous &&
      snapshot.every(({ row, content }, index) => explicitSnapshotKey({ ...row, content }) === expectedKeys[index])
    ) {
      const stale = span.filter(({ row, content }) => row.content !== content);
      if (stale.length > 0) {
        const rewrite = db.prepare('UPDATE messages SET content = ? WHERE id = ?');
        db.transaction(() => {
          for (const { row, content } of stale) rewrite.run(content, row.id);
          deleteRecordEmbeddingsByIdsInTransaction(db, 'messages', stale.map(({ row }) => row.id));
        })();
      }
      return span.map(({ row, content }) => ({ ...row, content }));
    }
  }

  return undefined;
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
  source: string;
  error?: string;
}> {
  const inputSession = options.session || discoverCurrentSession();

  if (!inputSession) {
    const error = process.env.OMPCODE === '1'
      ? 'Inside omp, use the recall_dump tool: the omp extension supplies the live session'
      : 'No session input or supported host session files found';
    return { success: false, sessionId: '', messageCount: 0, source: 'mcp', error };
  }

  const session = {
    ...inputSession,
    messages: inputSession.messages.flatMap(message => {
      const content = scrub(message.content).text;
      return content.trim() ? [{ ...message, content }] : [];
    }),
  };

  if (options.project) {
    for (const msg of session.messages) {
      msg.project = options.project;
    }
  }

  // Checked before any write: replacing a session with nothing would clear its messages.
  if (session.messages.length === 0) {
    return { success: false, sessionId: session.sessionId, messageCount: 0, source: session.source, error: 'Session has no user or assistant text to dump' };
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

  const messagesToImport = existingSnapshot ? [] : session.messages;
  const importedCount = addMessagesBatch(
    messagesToImport.map(message => ({ ...message, provenance: 'verbatim' as const }))
  );

  const db = getDb();
  const snapshotMessages = lifecycleOwned
    ? (existingSnapshot ?? findExplicitSnapshot(session) ?? [])
    : db.prepare(`
        SELECT id, content, role, timestamp, project
        FROM published_messages
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
      fabricExtract = (options.extract ?? runFabricExtract)(conversationText);
    } catch (error) {
      if (error instanceof ExtractorConfigError) {
        return {
          success: false,
          sessionId: session.sessionId,
          messageCount: importedCount,
          source: session.source,
          error: error.message,
        };
      }
      fabricExtract = generateBasicSummary(importedMessages);
    }
  }

  const sourceIds = JSON.stringify(
    importedMessages.map(message => ({ table: 'messages', id: message.id }))
  );
  const existingLoa = lifecycleOwned
    ? db.prepare(`
        SELECT id, title, fabric_extract FROM loa_entries
        WHERE session_id = ? AND description = ? AND source_ids = ?
        ORDER BY id DESC LIMIT 1
      `).get(session.sessionId, EXPLICIT_DUMP_DESCRIPTION, sourceIds) as
        { id: number; title: string; fabric_extract: string } | undefined
    : undefined;
  let loaId: number;
  if (existingLoa) {
    db.transaction(() => {
      db.prepare(`
        UPDATE loa_entries SET
          title = ?, fabric_extract = ?, message_range_start = ?, message_range_end = ?,
          snapshot_max_message_id = ?, project = ?, tags = ?, message_count = ?,
          created_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        title,
        fabricExtract,
        startId,
        endId,
        endId,
        options.project || session.project,
        options.tags ?? null,
        importedMessages.length,
        existingLoa.id
      );
      if (existingLoa.title !== title || existingLoa.fabric_extract !== fabricExtract) {
        invalidateRecordEmbedding(db, 'loa_entries', existingLoa.id);
      }
    })();
    loaId = existingLoa.id;
  } else {
    loaId = createLoaEntry({
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
      source_ids: sourceIds,
      provenance: 'extracted'
    });
  }

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

  let session: ParsedSession | undefined;
  try {
    session = options.stdin ? parseDumpSessionJson(await readStdin()) : undefined;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  const result = await coreDump(title, { ...options, session });

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
