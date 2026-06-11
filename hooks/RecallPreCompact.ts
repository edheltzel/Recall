#!/usr/bin/env bun
/**
 * RecallPreCompact.ts — Flush in-flight messages to SQLite before compaction
 *
 * PURPOSE
 * Claude Code compacts the conversation context when it grows large. Without
 * this hook, messages exchanged since the last Stop event would only land in
 * memory when the session ends — which means a long, never-ending session
 * loses its in-flight memory if you exit between compactions.
 *
 * This hook fires on PreCompact and FLUSHES NEW MESSAGES TO SQLITE ONLY.
 * It does NOT call Haiku, does NOT generate LoA entries, does NOT touch any
 * legacy file-based store. The Stop hook still does the full extraction at
 * session end. PreCompact's job is "don't let messages die in the compaction
 * window."
 *
 * DESIGN (per architect + red team review)
 * - Flush-only. No LLM calls. Avoids duplicate / fragmented LoA records.
 * - Delta-only. Reads JSONL from the last byte offset to current EOF.
 * - Cooperates with the Stop hook's extract lock — if Stop is in flight,
 *   skip this PreCompact (Stop will pick up our messages on its full pass).
 * - Self-contained per repo convention. No imports from src/.
 * - Bounded time budget. Synchronous insert, no spawn.
 * - Graceful degrade. Missing transcript / corrupt JSONL / no DB — exit 0.
 *
 * TRIGGER: Claude Code PreCompact event
 * INPUT (stdin JSON): { trigger: "manual" | "auto", cwd?, session_id?, transcript_path? }
 *   The documented PreCompact payload is just { trigger }; cwd is supplied
 *   alongside other hook events and is the discriminator we need.
 * OUTPUT: nothing — PreCompact cannot block, exit code is informational only.
 */

import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, appendFileSync } from 'fs';
import { join } from 'path';
import { Database } from 'bun:sqlite';
import { encodeProjectDir } from './lib/path-encoding';
import { resolveDbPath as getDbPath } from './lib/db-path';

// ─── Path resolution (call-time, not load-time) ─────────────────────
// Paths are resolved on every call rather than at module load so tests can
// rebind $HOME between cases without reimporting the module. All callers go
// through these helpers; never cache the result across calls.

function getHome(): string {
  return process.env.HOME || process.env.USERPROFILE || '';
}

function getMemoryDir(): string {
  return join(getHome(), '.claude', 'MEMORY');
}

function getProjectsDir(): string {
  return join(getHome(), '.claude', 'projects');
}

// Same lock directory the Stop hook uses — this is intentional. We try to
// acquire the same lock; if Stop holds it, we skip.
function getExtractLockDir(): string {
  return join(getMemoryDir(), '.extract_locks');
}

// PreCompact's own watermark file — separate from the Stop hook's
// .extraction_tracker.json. Stop tracks "have I extracted this conversation
// to LoA?" by file size; PreCompact tracks "what byte offset have I
// imported into messages?" by exact byte count. Different concerns,
// different state.
function getPrecompactTracker(): string {
  return join(getMemoryDir(), '.precompact_tracker.json');
}

function getPrecompactLog(): string {
  return join(getMemoryDir(), 'PRECOMPACT_LOG.txt');
}

// DB-path resolution lives in hooks/lib/db-path.ts; resolveDbPath is imported
// at the top of this file (see imports). Local alias kept for call-site clarity.

function ensureDirs(): void {
  mkdirSync(getMemoryDir(), { recursive: true });
  mkdirSync(getExtractLockDir(), { recursive: true });
}

// Hard time budget — PreCompact cannot block, but a hung hook still wastes
// session time. 5s is enough for a normal flush; slow systems get cut off.
const STDIN_TIMEOUT_MS = 5000;

// ─── Logging ────────────────────────────────────────────────────────
function log(message: string): void {
  try {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    appendFileSync(getPrecompactLog(), line, 'utf-8');
  } catch {
    // Logging is best-effort
  }
}

// ─── Watermark tracker ──────────────────────────────────────────────
interface WatermarkEntry {
  byte_offset: number;
  flushed_at: string;
  message_count: number;
}

function loadWatermarks(): Record<string, WatermarkEntry> {
  try {
    const path = getPrecompactTracker();
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch {
    // Corrupt file — start fresh
  }
  return {};
}

function saveWatermarks(watermarks: Record<string, WatermarkEntry>): void {
  try {
    writeFileSync(getPrecompactTracker(), JSON.stringify(watermarks, null, 2), 'utf-8');
  } catch {
    // Non-fatal — next run will redo the work
  }
}

// ─── Lock cooperation with Stop hook ────────────────────────────────
// Identical encoding to RecallExtract.tryAcquireExtractLock so both hooks
// fight over the same lock file. PreCompact loses gracefully — if Stop is
// extracting, we skip this round and Stop's full pass picks up everything.
function tryAcquireExtractLock(convPath: string): boolean {
  const lockName = convPath.replace(/[^a-zA-Z0-9]/g, '_') + '.lock';
  const lockPath = join(getExtractLockDir(), lockName);
  try {
    const fd = openSync(lockPath, 'wx');
    closeSync(fd);
    writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}\nprecompact:${convPath}`);
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'EEXIST') {
      // Stale lock check — match the 10-minute window RecallExtract uses.
      try {
        const lockAge = Date.now() - statSync(lockPath).mtimeMs;
        if (lockAge > 600_000) {
          unlinkSync(lockPath);
          try {
            const fd = openSync(lockPath, 'wx');
            closeSync(fd);
            writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}\nprecompact:${convPath}`);
            return true;
          } catch {
            return false;
          }
        }
      } catch {
        // Lock file vanished between EEXIST and stat — treat as busy
      }
      return false;
    }
    return false;
  }
}

function releaseExtractLock(convPath: string): void {
  const lockName = convPath.replace(/[^a-zA-Z0-9]/g, '_') + '.lock';
  const lockPath = join(getExtractLockDir(), lockName);
  try { unlinkSync(lockPath); } catch { /* already gone */ }
}

// ─── Conversation finder ────────────────────────────────────────────
export function findCurrentConversation(cwd: string): string | null {
  const projectDir = join(getProjectsDir(), encodeProjectDir(cwd));
  if (!existsSync(projectDir)) return null;

  try {
    const files = readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'))
      .map(f => ({
        path: join(projectDir, f),
        mtime: statSync(join(projectDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    return files.length > 0 ? files[0].path : null;
  } catch {
    return null;
  }
}

// ─── JSONL parsing ──────────────────────────────────────────────────
interface ParsedMessage {
  session_id: string;
  timestamp: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  project: string | null;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
        const text = (block as { text?: string }).text;
        if (text) parts.push(text);
      }
    }
    return parts.join('\n');
  }
  if (content && typeof content === 'object' && typeof (content as { text?: string }).text === 'string') {
    return (content as { text: string }).text;
  }
  return '';
}

// Parse a JSONL slice (already-decoded text starting at a clean line boundary)
// into structured message rows. Drops noise (tool results, empty content,
// short fragments) using the same filters RecallExtract uses.
export function parseMessagesFromSlice(jsonlSlice: string, fallbackSessionId: string, project: string | null): ParsedMessage[] {
  const out: ParsedMessage[] = [];
  if (!jsonlSlice.trim()) return out;

  for (const line of jsonlSlice.split('\n')) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // partial / corrupt line — skip
    }

    const message = entry.message as { role?: string; content?: unknown } | undefined;
    if (!message?.content) continue;

    const role = message.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;

    const text = extractTextFromContent(message.content).trim();
    if (text.length < 10) continue;
    if (text.startsWith('[{') || text.startsWith('{"tool_use_id"')) continue;

    const sessionId = (entry.sessionId as string | undefined) || fallbackSessionId;
    const timestamp = (entry.timestamp as string | undefined) || new Date().toISOString();

    // Truncate long content same as RecallExtract — keeps DB row sizes sane.
    const truncated = text.length > 4000 ? text.slice(0, 4000) + '...[truncated]' : text;

    out.push({
      session_id: sessionId,
      timestamp,
      role: role as ParsedMessage['role'],
      content: truncated,
      project,
    });
  }

  return out;
}

// ─── Project detection ──────────────────────────────────────────────
// Lightweight project tag — we don't run git here. Use the basename of cwd.
// Stop hook will overwrite richer metadata when it runs.
function projectFromCwd(cwd: string): string | null {
  const parts = cwd.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

// ─── SQLite flush ───────────────────────────────────────────────────
interface FlushResult {
  imported: number;
  bytes_read: number;
  skipped_lock_busy: boolean;
  skipped_no_new_data: boolean;
}

export function flushConversation(convPath: string, cwd: string): FlushResult {
  const result: FlushResult = {
    imported: 0,
    bytes_read: 0,
    skipped_lock_busy: false,
    skipped_no_new_data: false,
  };

  // Ensure directories exist on every flush — paths are now call-time so we
  // need to (re-)create them under the current $HOME each time.
  ensureDirs();

  const dbPath = getDbPath();
  if (!existsSync(dbPath)) {
    log(`NO_DB: ${dbPath} — skipping flush`);
    return result;
  }
  if (!existsSync(convPath)) {
    log(`NO_TRANSCRIPT: ${convPath}`);
    return result;
  }

  // Cooperate with Stop hook — if Stop holds the lock for this conversation,
  // skip. Stop's full extraction will read everything we would have written.
  if (!tryAcquireExtractLock(convPath)) {
    log(`LOCK_BUSY: ${convPath} — Stop hook in flight, skipping flush`);
    result.skipped_lock_busy = true;
    return result;
  }

  try {
    const watermarks = loadWatermarks();
    const lastOffset = watermarks[convPath]?.byte_offset ?? 0;
    const currentSize = statSync(convPath).size;

    if (currentSize <= lastOffset) {
      log(`NO_NEW_DATA: ${convPath} (size=${currentSize}, watermark=${lastOffset})`);
      result.skipped_no_new_data = true;
      return result;
    }

    // Read only the delta. We slice from lastOffset to EOF; if we landed
    // mid-line (rare but possible if a write was atomic), the parse will
    // skip the malformed first line — acceptable.
    const fullContent = readFileSync(convPath, 'utf-8');
    const delta = fullContent.slice(lastOffset);
    result.bytes_read = delta.length;

    // Use the conversation file basename as a fallback session_id so messages
    // are at least groupable even if the JSONL doesn't carry one per line.
    const fallbackSessionId = (convPath.split('/').pop() || 'unknown').replace('.jsonl', '');
    const project = projectFromCwd(cwd);
    const messages = parseMessagesFromSlice(delta, fallbackSessionId, project);

    if (messages.length === 0) {
      // Watermark advances anyway — we processed the bytes, just had no content.
      watermarks[convPath] = {
        byte_offset: currentSize,
        flushed_at: new Date().toISOString(),
        message_count: watermarks[convPath]?.message_count ?? 0,
      };
      saveWatermarks(watermarks);
      log(`EMPTY_DELTA: ${convPath} (read ${delta.length} bytes, parsed 0 messages)`);
      return result;
    }

    // Direct SQLite — self-contained, no src/ imports. We open a writable
    // connection (not readonly) and use a transaction for atomicity.
    const db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');

    try {
      // Group messages by session_id and ensure each session row exists. The
      // messages.session_id FK references sessions.session_id; without a
      // matching row, the insert fails when foreign_keys=ON.
      const uniqueSessions = new Set(messages.map(m => m.session_id));
      const ensureSession = db.prepare(`
        INSERT OR IGNORE INTO sessions (session_id, started_at, project, source)
        VALUES (?, CURRENT_TIMESTAMP, ?, 'claude-code')
      `);
      for (const sid of uniqueSessions) {
        ensureSession.run(sid, project);
      }

      // Insert messages. importance defaults to 5 — these are mid-session
      // captures, not curated, and the Stop hook may later promote a subset
      // to LoA at importance 8. Raw transcript capture is verbatim
      // (ADR-0001); the column guard keeps pre-provenance DBs working.
      const hasProvenance = (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>)
        .some((c) => c.name === 'provenance');
      const insertMessage = db.prepare(`
        INSERT INTO messages (session_id, timestamp, role, content, project, importance${hasProvenance ? ', provenance' : ''})
        VALUES (?, ?, ?, ?, ?, 5${hasProvenance ? ", 'verbatim'" : ''})
      `);

      const tx = db.transaction((rows: ParsedMessage[]) => {
        for (const m of rows) {
          insertMessage.run(m.session_id, m.timestamp, m.role, m.content, m.project);
        }
      });

      tx(messages);
      result.imported = messages.length;

      // Advance watermark only after a successful insert — partial flush on
      // crash is preferable to advancing past unwritten data.
      watermarks[convPath] = {
        byte_offset: currentSize,
        flushed_at: new Date().toISOString(),
        message_count: (watermarks[convPath]?.message_count ?? 0) + messages.length,
      };
      saveWatermarks(watermarks);

      log(`FLUSHED: ${convPath} +${messages.length} messages (${delta.length} bytes, watermark ${lastOffset} → ${currentSize})`);
    } finally {
      db.close();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`FLUSH_ERROR: ${convPath}: ${msg}`);
  } finally {
    releaseExtractLock(convPath);
  }

  return result;
}

// ─── Stdin reader ───────────────────────────────────────────────────
async function readStdin(): Promise<string> {
  let input = '';
  try {
    const decoder = new TextDecoder();
    const reader = Bun.stdin.stream().getReader();
    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => resolve(), STDIN_TIMEOUT_MS);
    });
    const readPromise = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        input += decoder.decode(value, { stream: true });
      }
    })();
    await Promise.race([readPromise, timeoutPromise]);
  } catch {
    // ignore — return whatever we got
  }
  return input;
}

interface PreCompactInput {
  trigger?: 'manual' | 'auto';
  cwd?: string;
  session_id?: string;
  transcript_path?: string;
}

// ─── Main ────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const input = await readStdin();
  let parsed: PreCompactInput = {};
  if (input && input.trim()) {
    try {
      parsed = JSON.parse(input) as PreCompactInput;
    } catch {
      // Bad input — try to flush anyway based on cwd
    }
  }

  const cwd = parsed.cwd || process.cwd();
  const convPath = parsed.transcript_path || findCurrentConversation(cwd);

  if (!convPath) {
    log(`NO_CONVERSATION: cwd=${cwd}`);
    process.exit(0);
  }

  log(`PRECOMPACT_FIRED: trigger=${parsed.trigger ?? 'unknown'} conv=${convPath}`);
  flushConversation(convPath, cwd);
  process.exit(0);
}

const runsAsScript = process.argv[1]?.endsWith('RecallPreCompact.ts');
if (runsAsScript) {
  main().catch((err) => {
    log(`MAIN_ERROR: ${err}`);
    process.exit(0);
  });
}
