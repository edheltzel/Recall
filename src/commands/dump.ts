// mem dump command - Flush current session to DB + capture LoA
// Core functions are exported for use by the MCP server's memory_dump tool.

import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join, basename, dirname } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { getDb } from '../db/connection.js';
import { createSession, sessionExists, addMessagesBatch, createLoaEntry } from '../lib/memory.js';
import { extractProjectFromPath } from '../lib/project.js';
import { chunked } from '../lib/chunk.js';
import { embed, embeddingToBlob, checkEmbeddingService } from '../lib/embeddings.js';
import type { Message } from '../types/index.js';

// ============ Constants ============

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const OPENCODE_DROP_DIR = join(homedir(), '.claude', 'MEMORY', 'opencode-sessions');
const PI_DROP_DIR = join(homedir(), '.claude', 'MEMORY', 'pi-sessions');
const MAX_FABRIC_INPUT_BYTES = 50 * 1024 * 1024;

// ============ Types ============

export type SessionSource = 'claude' | 'opencode' | 'pi';

export interface ParsedSession {
  source: SessionSource;
  sessionId: string;
  project: string;
  messages: Omit<Message, 'id'>[];
  filePath: string;
}

interface DumpOptions {
  project?: string;
  continues?: number;
  tags?: string;
  limit?: number;
  skipFabric?: boolean;
}

// ============ Session Finding ============

/**
 * Find the most recently modified JSONL file (Claude Code sessions)
 */
function findCurrentSessionFile(): string | null {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return null;

  let mostRecentFile: string | null = null;
  let mostRecentTime = 0;

  const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const projectDir of projectDirs) {
    const projectPath = join(CLAUDE_PROJECTS_DIR, projectDir);
    const jsonlFiles = readdirSync(projectPath, { withFileTypes: true })
      .filter(f => f.isFile() && f.name.endsWith('.jsonl'))
      .map(f => join(projectPath, f.name));

    for (const file of jsonlFiles) {
      const stat = statSync(file);
      if (stat.mtimeMs > mostRecentTime) {
        mostRecentTime = stat.mtimeMs;
        mostRecentFile = file;
      }
    }
  }

  return mostRecentFile;
}

/**
 * Find the most recently modified markdown drop file in a directory
 */
function findLatestDropFile(dropDir: string): string | null {
  if (!existsSync(dropDir)) return null;

  let latest: string | null = null;
  let latestTime = 0;

  for (const f of readdirSync(dropDir)) {
    if (!f.endsWith('.md') || f.startsWith('.')) continue;
    const full = join(dropDir, f);
    const mt = statSync(full).mtimeMs;
    if (mt > latestTime) {
      latestTime = mt;
      latest = full;
    }
  }

  return latest;
}

// ============ Session Parsing ============

/**
 * Parse a Claude Code JSONL session file
 */
function parseSessionFile(filePath: string): { sessionId: string; project: string; messages: Omit<Message, 'id'>[] } | null {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length === 0) return null;

  const messages: Omit<Message, 'id'>[] = [];
  let sessionId: string | null = null;
  let project: string | null = null;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type !== 'user' && parsed.type !== 'assistant') continue;
      if (!sessionId && parsed.sessionId) sessionId = parsed.sessionId;

      if (parsed.message?.content) {
        let msgContent: string;
        if (typeof parsed.message.content === 'string') {
          msgContent = parsed.message.content;
        } else if (Array.isArray(parsed.message.content)) {
          msgContent = parsed.message.content
            .filter((block: any) => block.type === 'text' && block.text)
            .map((block: any) => block.text)
            .join('\n');
        } else {
          continue;
        }

        if (msgContent.trim()) {
          messages.push({
            session_id: parsed.sessionId || sessionId || 'unknown',
            timestamp: parsed.timestamp || new Date().toISOString(),
            role: parsed.type as 'user' | 'assistant',
            content: msgContent,
            project: project || undefined
          });
        }
      }
    } catch {
      continue;
    }
  }

  const projectDir = basename(dirname(filePath));
  project = extractProjectFromPath(projectDir);
  for (const msg of messages) {
    msg.project = project;
  }

  if (!sessionId) sessionId = basename(filePath, '.jsonl');

  return { sessionId, project, messages };
}

/**
 * Parse a markdown drop file (OpenCode or Pi format) into messages.
 * Supports [ROLE]: content and ## Role heading formats.
 */
export function parseMarkdownDrop(filePath: string): { sessionId: string; messages: Omit<Message, 'id'>[] } | null {
  const content = readFileSync(filePath, 'utf-8');
  if (!content.trim()) return null;

  const sessionId = basename(filePath, '.md');
  const messages: Omit<Message, 'id'>[] = [];

  // Split on role markers: [USER]: or [ASSISTANT]:, optionally with timestamps
  const rolePattern = /\[(USER|ASSISTANT)(?:\s+[\d:]+)?\]:\s*/gi;
  const parts: Array<{ role: 'user' | 'assistant'; startIdx: number }> = [];

  let match: RegExpExecArray | null;
  while ((match = rolePattern.exec(content)) !== null) {
    parts.push({
      role: match[1].toLowerCase() as 'user' | 'assistant',
      startIdx: match.index + match[0].length
    });
  }

  // Fallback: try markdown heading format (## User / ## Assistant)
  if (parts.length === 0) {
    const headingPattern = /^##?\s*(User|Assistant|Human)\s*$/gim;
    while ((match = headingPattern.exec(content)) !== null) {
      const rawRole = match[1].toLowerCase();
      parts.push({
        role: (rawRole === 'human' ? 'user' : rawRole) as 'user' | 'assistant',
        startIdx: match.index + match[0].length
      });
    }
  }

  if (parts.length === 0) return null;

  const now = new Date().toISOString();
  for (let i = 0; i < parts.length; i++) {
    const start = parts[i].startIdx;
    // End at next role marker (search backward a bit to exclude the marker prefix)
    const end = i + 1 < parts.length
      ? content.lastIndexOf('\n', content.indexOf('[', parts[i + 1].startIdx - 80))
      : content.length;
    const text = content.slice(start, end > start ? end : content.length).trim();

    if (text.length > 10) {
      messages.push({
        session_id: sessionId,
        timestamp: now,
        role: parts[i].role,
        content: text
      });
    }
  }

  return messages.length > 0 ? { sessionId, messages } : null;
}

/**
 * Find the current session across all supported agent types.
 * Priority: Claude Code JSONL > OpenCode drops > Pi drops
 */
export function findCurrentSessionAcrossAgents(): ParsedSession | null {
  // Try Claude Code first (most common)
  const claudeFile = findCurrentSessionFile();
  if (claudeFile) {
    const parsed = parseSessionFile(claudeFile);
    if (parsed && parsed.messages.length > 0) {
      return {
        source: 'claude',
        sessionId: parsed.sessionId,
        project: parsed.project,
        messages: parsed.messages,
        filePath: claudeFile
      };
    }
  }

  // Try OpenCode drops
  const openCodeFile = findLatestDropFile(OPENCODE_DROP_DIR);
  if (openCodeFile) {
    const parsed = parseMarkdownDrop(openCodeFile);
    if (parsed && parsed.messages.length > 0) {
      return {
        source: 'opencode',
        sessionId: parsed.sessionId,
        project: 'opencode',
        messages: parsed.messages.map(m => ({ ...m, project: 'opencode' })),
        filePath: openCodeFile
      };
    }
  }

  // Try Pi drops
  const piFile = findLatestDropFile(PI_DROP_DIR);
  if (piFile) {
    const parsed = parseMarkdownDrop(piFile);
    if (parsed && parsed.messages.length > 0) {
      return {
        source: 'pi',
        sessionId: parsed.sessionId,
        project: 'pi',
        messages: parsed.messages.map(m => ({ ...m, project: 'pi' })),
        filePath: piFile
      };
    }
  }

  return null;
}

// ============ Summary Generation ============

/**
 * Generate a basic summary from messages when Fabric is unavailable.
 */
export function generateBasicSummary(messages: Omit<Message, 'id'>[]): string {
  const userMessages = messages.filter(m => m.role === 'user');
  const assistantMessages = messages.filter(m => m.role === 'assistant');

  const firstUser = userMessages[0]?.content.slice(0, 200) || 'No user messages';
  const lastAssistant = assistantMessages[assistantMessages.length - 1]?.content.slice(0, 200) || 'No assistant messages';

  return `## ONE SENTENCE SUMMARY

Session with ${messages.length} messages.

## MAIN IDEAS

- User started with: ${firstUser}${firstUser.length >= 200 ? '...' : ''}
- Final response covered: ${lastAssistant}${lastAssistant.length >= 200 ? '...' : ''}

## TOPICS

- ${messages.length} total messages (${userMessages.length} user, ${assistantMessages.length} assistant)
`;
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
// Not atomic on its own: deletes run statement-by-statement per chunk, so
// callers that need all-or-nothing semantics must wrap the call in
// db.transaction() (as deleteSession does).
export function deleteLoaEntriesRecursive(db: ReturnType<typeof getDb>, loaIds: number[]): void {
  if (loaIds.length === 0) return;

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

function runFabricExtract(content: string): string {
  const inputBytes = Buffer.byteLength(content, 'utf-8');
  if (inputBytes > MAX_FABRIC_INPUT_BYTES) {
    throw new Error(`Input too large for Fabric (${(inputBytes / 1024 / 1024).toFixed(1)}MB > 50MB limit). Use --limit to reduce message count.`);
  }

  const result = execSync('fabric --pattern extract_wisdom --stream -m claude-haiku-4-5', {
    input: content,
    encoding: 'utf-8',
    maxBuffer: MAX_FABRIC_INPUT_BYTES,
    timeout: 600000
  });
  return result.trim();
}

// ============ Core Dump Logic (shared by CLI and MCP) ============

/**
 * Core dump logic — imports session to SQLite and optionally runs Fabric.
 * Used by both the `mem dump` CLI command and the `memory_dump` MCP tool.
 */
export async function coreDump(title: string, options: DumpOptions & { session?: ParsedSession }): Promise<{
  success: boolean;
  sessionId: string;
  messageCount: number;
  loaId?: number;
  source: SessionSource;
  error?: string;
}> {
  const session = options.session || findCurrentSessionAcrossAgents();

  if (!session) {
    return { success: false, sessionId: '', messageCount: 0, source: 'claude', error: 'No session files found' };
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
    summary: `Dumped: ${title}`
  });

  const importedCount = addMessagesBatch(session.messages);

  // Get imported message IDs for LoA
  const db = getDb();
  const importedMessages = db.prepare(`
    SELECT id, content, role, timestamp
    FROM messages
    WHERE session_id = ?
    ORDER BY timestamp
    ${options.limit ? 'LIMIT ?' : ''}
  `).all(session.sessionId, ...(options.limit ? [options.limit] : [])) as Array<{
    id: number; content: string; role: string; timestamp: string;
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
      const conversationText = importedMessages.map(m => {
        const role = m.role.toUpperCase();
        const time = m.timestamp.split('T')[1]?.split('.')[0] || '';
        return `[${role} ${time}]\n${m.content}`;
      }).join('\n\n---\n\n');
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
    message_count: importedMessages.length
  });

  await autoEmbedLoaEntry(loaId, title, fabricExtract);

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
