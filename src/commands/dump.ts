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

function deleteSession(sessionId: string): number {
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
    db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);

    return count;
  });

  return deleteAll();
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

  // Delete existing session if re-importing
  if (sessionExists(session.sessionId)) {
    deleteSession(session.sessionId);
  }

  // Import messages to SQLite FIRST (fast, always succeeds)
  const timestamps = session.messages.map(m => m.timestamp).sort();
  createSession({
    session_id: session.sessionId,
    started_at: timestamps[0],
    ended_at: timestamps[timestamps.length - 1],
    project: options.project || session.project,
    summary: `Dumped: ${title}`,
    source: session.source,
  });

  // Raw conversation capture is verbatim (ADR-0001).
  const importedCount = addMessagesBatch(session.messages.map(m => ({ ...m, provenance: 'verbatim' as const })));

  // Get imported message IDs for LoA
  const db = getDb();
  const importedMessages = db.prepare(`
    SELECT id, content, role, timestamp
    FROM messages
    WHERE session_id = ?
    ORDER BY timestamp
    ${options.limit ? 'LIMIT ?' : ''}
  `).all(session.sessionId, ...(options.limit ? [options.limit] : [])) as Array<{
    id: number; content: string; role: 'user' | 'assistant' | 'system'; timestamp: string;
  }>;

  if (importedMessages.length === 0) {
    return { success: true, sessionId: session.sessionId, messageCount: importedCount, source: session.source };
  }

  const startId = importedMessages[0].id;
  const endId = importedMessages[importedMessages.length - 1].id;

  // Try Fabric, fall back to basic summary
  let fabricExtract: string;
  if (options.skipFabric) {
    fabricExtract = generateBasicSummary(session.messages);
  } else {
    try {
      const conversationText = formatMessagesForExtraction(importedMessages);
      fabricExtract = runFabricExtract(conversationText);
    } catch {
      fabricExtract = generateBasicSummary(session.messages);
    }
  }

  const loaId = createLoaEntry({
    title,
    fabric_extract: fabricExtract,
    message_range_start: startId,
    message_range_end: endId,
    parent_loa_id: options.continues,
    project: options.project || session.project,
    tags: options.tags,
    message_count: importedMessages.length,
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
