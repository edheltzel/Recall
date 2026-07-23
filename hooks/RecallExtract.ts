#!/usr/bin/env bun
/**
 * RecallExtract.ts - Extract Context for Future Sessions (Recall)
 *
 * PURPOSE:
 * Extracts structured context from Claude Code session transcripts using
 * Anthropic's Haiku API. Gives your AI persistent memory across sessions.
 *
 * TRIGGER: Stop (SessionEnd)
 *
 * INPUT:
 * - stdin: Hook input JSON with transcript_path
 *
 * OUTPUT:
 * - Appends extracted context to ~/.claude/MEMORY/DISTILLED.md
 * - Updates HOT_RECALL.md (last N sessions)
 * - Updates SESSION_INDEX.json (searchable lookup)
 * - Appends to DECISIONS.log, REJECTIONS.log, ERROR_PATTERNS.json
 *
 * FLOW:
 * 1. Get current session's conversation JSONL
 * 2. Extract just the message content (skip metadata)
 * 3. Extract via claude CLI using Claude Code's auth (fallback: Ollama local LLM)
 * 4. Parse output and update all 6 memory files
 *
 * PERFORMANCE:
 * - Runs asynchronously via self-spawn, non-blocking
 */

import { existsSync, readFileSync, appendFileSync, writeFileSync, readdirSync, statSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { shouldSkipExtraction } from './lib/extraction-quality';
import { runExtractionCascade, extractTopics, deriveSummary } from './lib/extract-model';
import { encodeProjectDir } from './lib/hosts/claude/path-encoding';
import {
  wasAlreadyExtracted as trackerWasAlreadyExtracted,
  markAsExtracted as trackerMarkAsExtracted,
  markAsFailed as trackerMarkAsFailed,
} from './lib/extraction-tracker';
import { childAcquireLock, childReleaseLock } from './lib/extraction-lock';
import { acquireSemaphore, releaseSemaphore } from './lib/extraction-semaphore';
import { migrateTrackerJson } from './lib/extraction-migration';
import { getDbPath } from './lib/sqlite-writers';
import type { DualWriteResult } from './lib/extraction-parsers';
import { runExtractCore } from './lib/extract-core';
import { scrub } from './lib/write-safety';

const EXTRACT_LOG = join(process.env.HOME!, '.claude', 'MEMORY', 'EXTRACT_LOG.txt');

const MEMORY_DIR = join(process.env.HOME!, '.claude', 'MEMORY');
mkdirSync(MEMORY_DIR, { recursive: true });
const DISTILLED_PATH = join(MEMORY_DIR, 'DISTILLED.md');
const HOT_RECALL_PATH = join(MEMORY_DIR, 'HOT_RECALL.md');
const SESSION_INDEX_PATH = join(MEMORY_DIR, 'SESSION_INDEX.json');
const DECISIONS_PATH = join(MEMORY_DIR, 'DECISIONS.log');
const REJECTIONS_PATH = join(MEMORY_DIR, 'REJECTIONS.log');
const ERRORS_PATH = join(MEMORY_DIR, 'ERROR_PATTERNS.json');
const PROJECTS_DIR = join(process.env.HOME!, '.claude', 'projects');
const SESSION_FOLDERS_DIR = join(process.env.HOME!, '.claude', 'sessions');
const DEDUP_PATH = join(MEMORY_DIR, '.last_extracted_hash');
const HOT_RECALL_MAX_SESSIONS = 10;

// Legacy JSON tracker — read once for one-shot migration into SQLite, then never again.
const LEGACY_TRACKER_PATH = join(MEMORY_DIR, '.extraction_tracker.json');

// Maximum concurrent extractors (counting semaphore in extraction_locks).
const EXTRACTION_MAX_CONCURRENT = parseInt(
  process.env.EXTRACTION_MAX_CONCURRENT || '3',
  10
);

/**
 * One-shot import of legacy `.extraction_tracker.json` into the SQLite
 * `extraction_tracker` table. Idempotent: after a successful import the JSON
 * file is renamed `.extraction_tracker.json.imported-<ts>` so subsequent runs
 * skip the import.
 */
function migrateLegacyTrackerOnce(dbPath: string): void {
  if (!existsSync(LEGACY_TRACKER_PATH)) return;
  if (!existsSync(dbPath)) return; // DB not initialized yet — nothing to import into
  try {
    const { imported } = migrateTrackerJson(LEGACY_TRACKER_PATH, dbPath);
    const renamed = `${LEGACY_TRACKER_PATH}.imported-${Date.now()}`;
    try {
      renameSync(LEGACY_TRACKER_PATH, renamed);
    } catch {
      // Rename can fail if the file vanished between the existsSync and the
      // rename (concurrent hook). Non-fatal — the migration is idempotent.
    }
    logExtract(`TRACKER_MIGRATE: imported ${imported} rows from JSON tracker into SQLite`);
  } catch (err: any) {
    // Quarantine the file so we don't retry the same failing parse every run
    // (Forge Finding 6). Common cause: malformed JSON.
    try {
      const quarantine = `${LEGACY_TRACKER_PATH}.corrupt-${Date.now()}`;
      renameSync(LEGACY_TRACKER_PATH, quarantine);
      logExtract(
        `TRACKER_MIGRATE: corrupt JSON quarantined to ${quarantine} (${err?.message || err})`
      );
    } catch {
      logExtract(`TRACKER_MIGRATE: skipped (${err?.message || err})`);
    }
  }
}

// The extraction-model cascade (Claude CLI + Ollama fallback) and the
// topic/summary derivation helpers live in hooks/lib/extract-model.ts so the
// in-session hook (RecallInSession.ts) reuses the same model call (#51 P3).

interface SessionIndexEntry {
  sessionId: string;
  project: string;
  date: string;
  timestamp: number;
  topics: string[];
  summary: string;
  file: string;
}

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
}

/**
 * Find the most recent conversation file for the current working directory
 */
function findCurrentConversation(cwd: string): string | null {
  const projectDir = join(PROJECTS_DIR, encodeProjectDir(cwd));

  if (!existsSync(projectDir)) {
    return null;
  }

  // Find most recent .jsonl file (not agent files)
  const files = readdirSync(projectDir)
    .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'))
    .map(f => ({
      name: f,
      path: join(projectDir, f),
      mtime: statSync(join(projectDir, f)).mtimeMs
    }))
    .sort((a, b) => b.mtime - a.mtime);

  return files.length > 0 ? files[0].path : null;
}

/**
 * Extract actual text from content blocks (handles arrays and nested structures)
 */
function extractTextFromContent(content: any): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      // Extract text blocks
      if (block.type === 'text' && block.text) {
        textParts.push(block.text);
      }
      // Skip thinking blocks, tool_use, tool_result - noise for memory
    }
    return textParts.join('\n');
  }

  // Object with text property
  if (content?.text) {
    return content.text;
  }

  return '';
}

/**
 * Extract message content from JSONL conversation
 * Filters noise: tool results, thinking blocks, system messages
 */
function extractMessages(jsonlPath: string): string {
  const content = readFileSync(jsonlPath, 'utf-8');
  const lines = content.trim().split('\n');

  const messages: string[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      // Skip non-message entries (summaries, file-history, etc.)
      if (!entry.message?.content) continue;

      const role = entry.message.role;

      // Only include user and assistant messages
      if (role !== 'user' && role !== 'assistant') continue;

      // Extract actual text (handles arrays properly)
      const text = extractTextFromContent(entry.message.content);

      // Skip empty or tool-only messages
      if (!text || text.trim().length < 10) continue;

      // Skip messages that look like tool results (often start with [ or {)
      if (text.trim().startsWith('[{') || text.trim().startsWith('{"tool_use_id"')) continue;

      // Truncate very long messages but keep more context
      const truncated = text.length > 4000 ? text.slice(0, 4000) + '...[truncated]' : text;
      messages.push(`[${role.toUpperCase()}]: ${truncated}`);

    } catch {
      // Skip malformed lines
    }
  }

  return messages.join('\n\n');
}

/**
 * Per-conversation dedup tracking — backed by SQLite `extraction_tracker` table
 * (replaces the legacy `.extraction_tracker.json` file).
 *
 * Re-extract policy (preserved from the JSON-era code):
 *   - Never extracted   → true (needs extraction)
 *   - Extracted, grew ≤50% → false (skip)
 *   - Extracted, grew >50% → true (re-extract)
 *   - Failed within 24h → false (cooldown)
 *   - Failed >24h ago   → true (retry)
 */
function wasAlreadyExtracted(convPath: string): boolean {
  const dbPath = getDbPath();
  if (!existsSync(dbPath)) {
    // DB hasn't been initialized (`recall init` not run). Without the tracker
    // table we can't dedup — return false so the caller proceeds. The lock
    // primitive still prevents duplicate concurrent extractions.
    return false;
  }
  try {
    const currentSize = statSync(convPath).size;
    return trackerWasAlreadyExtracted(dbPath, convPath, currentSize);
  } catch {
    return false;
  }
}

/**
 * Mark conversation as extracted at current size.
 * Releases any held per-conversation lock + semaphore slot.
 */
function markAsExtracted(convPath: string): void {
  const dbPath = getDbPath();
  try {
    if (existsSync(dbPath)) {
      const size = statSync(convPath).size;
      trackerMarkAsExtracted(dbPath, convPath, size);
    }
  } catch {}
  releaseChildLockSafe(convPath);
}

/**
 * Mark conversation as failed extraction with 24-hour retry window.
 * Releases any held per-conversation lock + semaphore slot.
 */
function markAsFailed(convPath: string, error?: string): void {
  const dbPath = getDbPath();
  try {
    if (existsSync(dbPath)) {
      let size = 0;
      try { size = statSync(convPath).size; } catch {}
      trackerMarkAsFailed(dbPath, convPath, size, error);
    }
  } catch {}
  releaseChildLockSafe(convPath);
}

/**
 * Release the per-conversation lock + semaphore slot.
 *
 * The semaphore row (extraction_locks PK on conversation_path) doubles as
 * the per-conv lock, so releasing the semaphore is sufficient regardless of
 * whether the parent or the child inserted the row. We also call the
 * pid-checked childReleaseLock as a defense — no-op if PIDs don't match,
 * useful when --reextract* acquired the row under the current PID.
 */
function releaseChildLockSafe(convPath: string): void {
  try {
    const dbPath = getDbPath();
    if (!existsSync(dbPath)) return;
    childReleaseLock(dbPath, convPath, process.pid);
    releaseSemaphore(dbPath, convPath);
  } catch {}
}

// Legacy compat — getConversationHash now just returns path (used by --reextract)
function getConversationHash(convPath: string): string {
  return convPath;
}

/**
 * Get the LoA session name for better labeling
 * Looks at today's session folders and finds the most recently modified one
 */
function getLoaSessionName(): string {
  try {
    // Use local date (not UTC) since LoA session folders use local time
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const todayDir = join(SESSION_FOLDERS_DIR, today);
    if (!existsSync(todayDir)) return '';

    const sessions = readdirSync(todayDir)
      .map(name => ({
        name,
        mtime: statSync(join(todayDir, name)).mtimeMs
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (sessions.length > 0) {
      // Strip time prefix (e.g., "1145pm-memory-system" -> "memory-system")
      const fullName = sessions[0].name;
      const match = fullName.match(/^\d{3,4}[ap]m-(.+)$/);
      return match ? match[1] : fullName;
    }
  } catch {
    // Non-critical
  }
  return '';
}

/**
 * Update session index with new entry
 */
function updateSessionIndex(entry: SessionIndexEntry): void {
  let index: SessionIndexEntry[] = [];

  if (existsSync(SESSION_INDEX_PATH)) {
    try {
      index = JSON.parse(readFileSync(SESSION_INDEX_PATH, 'utf-8'));
    } catch {
      index = [];
    }
  }

  // Remove existing entry for same session if exists
  index = index.filter(e => e.sessionId !== entry.sessionId);

  // Add new entry
  index.push(entry);

  // Sort by timestamp descending
  index.sort((a, b) => b.timestamp - a.timestamp);

  // Keep last 500 entries
  index = index.slice(0, 500);

  writeFileSync(SESSION_INDEX_PATH, JSON.stringify(index, null, 2), 'utf-8');
}

/**
 * Maintain HOT_RECALL.md with last N sessions
 */
function updateHotRecall(extracted: string, sessionLabel: string, timestamp: string): void {
  const header = `# Hot Recall (Last ${HOT_RECALL_MAX_SESSIONS} Sessions)

This file contains the most recent session extractions for fast context loading.
Full archive: DISTILLED.md

---
`;

  let sections: string[] = [];

  if (existsSync(HOT_RECALL_PATH)) {
    const content = readFileSync(HOT_RECALL_PATH, 'utf-8');
    // Parse existing sections (handle both space and no-space after "Extracted:")
    const sectionMatches = content.split(/\n+---\n+## Extracted:\s*/);
    for (let i = 1; i < sectionMatches.length; i++) {
      sections.push('## Extracted: ' + sectionMatches[i]);
    }
  }

  // Add new section at front
  const newSection = `## Extracted: ${timestamp} | ${sessionLabel}\n\n${extracted.trim()}\n`;
  sections.unshift(newSection);

  // Keep only last N
  sections = sections.slice(0, HOT_RECALL_MAX_SESSIONS);

  // Write back
  const output = header + '\n' + sections.join('\n\n---\n\n');
  writeFileSync(HOT_RECALL_PATH, output, 'utf-8');
}

/**
 * Extract and append decisions from fabric output to DECISIONS.log
 * Matches both "## DECISIONS MADE" (fabric) and "DECISIONS:" (legacy) formats
 * Deduplicates against existing decisions using normalized text comparison
 */
function appendDecisions(fabricOutput: string, sessionLabel: string, timestamp: string): void {
  const decisionsMatch = fabricOutput.match(/(?:##\s*DECISIONS\s*MADE|DECISIONS:)\s*([\s\S]*?)(?=\n##\s|$)/);
  if (!decisionsMatch) return;

  const lines = decisionsMatch[1]
    .split('\n')
    .filter(l => l.trim().startsWith('-'))
    .map(l => l.replace(/^-\s*/, '').replace(/\*\*/g, '').trim())
    .filter(l => l.length > 5);

  if (lines.length === 0) return;

  // Load existing decisions for deduplication
  const normalize = (s: string) => s.toLowerCase().replace(/['"]/g, '').replace(/\s+/g, ' ').trim();
  const existingDecisions = new Set<string>();

  if (existsSync(DECISIONS_PATH)) {
    const content = readFileSync(DECISIONS_PATH, 'utf-8');
    for (const line of content.split('\n')) {
      if (line.startsWith('#') || line.trim() === '') continue;
      const parts = line.split('|');
      if (parts.length >= 4) {
        // New format: timestamp|session|confidence|decision
        const decision = parts.slice(3).join('|');
        existingDecisions.add(normalize(decision));
      } else if (parts.length >= 3) {
        // Legacy format: timestamp|session|decision
        const decision = parts.slice(2).join('|');
        existingDecisions.add(normalize(decision));
      }
    }
  }

  // Filter out duplicates
  const newEntries: string[] = [];
  let skipped = 0;

  for (const line of lines) {
    const normalized = normalize(line);
    if (existingDecisions.has(normalized)) {
      skipped++;
      continue;
    }
    existingDecisions.add(normalized);
    // Parse confidence suffix: (confidence: HIGH|MEDIUM|LOW)
    const confidenceMatch = line.match(/\(confidence:\s*(HIGH|MEDIUM|LOW)\)/i);
    const confidence = confidenceMatch ? confidenceMatch[1].toLowerCase() : 'medium';
    const cleanLine = line.replace(/\s*\(confidence:\s*(?:HIGH|MEDIUM|LOW)\)/i, '').replace(/\|/g, '/');
    newEntries.push(`${timestamp}|${sessionLabel}|${confidence}|${cleanLine}`);
  }

  if (newEntries.length > 0) {
    appendFileSync(DECISIONS_PATH, newEntries.join('\n') + '\n', 'utf-8');
    console.error(`[FabricExtract] Appended ${newEntries.length} decisions to DECISIONS.log${skipped > 0 ? ` (${skipped} skipped as duplicates)` : ''}`);
  } else if (skipped > 0) {
    console.error(`[FabricExtract] Skipped ${skipped} duplicate decisions`);
  }
}

/**
 * Extract and append rejections from fabric output to REJECTIONS.log
 * Matches both "## THINGS TO REJECT / AVOID" and "REJECTED:" formats
 */
function appendRejections(fabricOutput: string, sessionLabel: string, timestamp: string): void {
  const rejectionsMatch = fabricOutput.match(/(?:##\s*THINGS\s*TO\s*REJECT\s*\/?\s*AVOID|REJECTED:)\s*([\s\S]*?)(?=\n##\s|$)/);
  if (!rejectionsMatch) return;

  const lines = rejectionsMatch[1]
    .split('\n')
    .filter(l => l.trim().startsWith('-'))
    .map(l => l.replace(/^-\s*/, '').replace(/\*\*/g, '').trim())
    .filter(l => l.length > 5);

  if (lines.length === 0) return;

  const entries = lines.map(l => `${timestamp}|${sessionLabel}|${l.replace(/\|/g, '/')}`);
  appendFileSync(REJECTIONS_PATH, entries.join('\n') + '\n', 'utf-8');
  console.error(`[FabricExtract] Appended ${entries.length} rejections to REJECTIONS.log`);
}

/**
 * Extract and append errors from fabric output to ERROR_PATTERNS.json
 * Matches both "## ERRORS FIXED" and "ERRORS_FIXED:" formats
 */
function appendErrors(fabricOutput: string, sessionLabel: string, timestamp: string): void {
  const errorsMatch = fabricOutput.match(/(?:##\s*ERRORS?\s*FIXED|ERRORS_FIXED:)\s*([\s\S]*?)(?=\n##\s|$)/);
  if (!errorsMatch) return;

  const lines = errorsMatch[1]
    .split('\n')
    .filter(l => l.trim().startsWith('-'))
    .map(l => l.replace(/^-\s*/, '').replace(/\*\*/g, '').trim())
    .filter(l => l.includes(':'));

  if (lines.length === 0) return;

  // Load existing patterns
  let data: { patterns: any[]; meta: any } = { patterns: [], meta: {} };
  if (existsSync(ERRORS_PATH)) {
    try {
      data = JSON.parse(readFileSync(ERRORS_PATH, 'utf-8'));
    } catch {
      data = { patterns: [], meta: {} };
    }
  }

  // Build set of existing error keys for dedup (normalized: lowercase, no quotes, trimmed)
  const normalize = (s: string) => s.toLowerCase().replace(/['"]/g, '').replace(/\s+/g, ' ').trim();
  const existingKeys = new Set(data.patterns.map((p: any) => normalize(p.error || '')));

  // Add new patterns (skip duplicates)
  let added = 0;
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const error = line.slice(0, colonIdx).trim();
      const fix = line.slice(colonIdx + 1).trim();
      const key = normalize(error);
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      data.patterns.push({
        error,
        cause: 'auto-extracted',
        fix,
        file: sessionLabel,
        date: timestamp
      });
      added++;
    }
  }

  if (added === 0) {
    console.error(`[FabricExtract] No new error patterns (all ${lines.length} already exist)`);
    return;
  }

  data.meta = { purpose: 'Pattern match errors for instant recall', updated: timestamp };
  writeFileSync(ERRORS_PATH, JSON.stringify(data, null, 2), 'utf-8');
  console.error(`[FabricExtract] Appended ${added} new error patterns (${lines.length - added} skipped as duplicates)`);
}

/** Log the SQLite dual-write outcome (per-writer failures + per-table summary). */
function logDualWrite(result: DualWriteResult): void {
  if (Object.keys(result.failures).length > 0) {
    for (const [where, msg] of Object.entries(result.failures)) {
      logExtract(`SQLITE_WRITE_FAIL[${where}]: ${msg}`);
    }
  }
  logExtract(
    `SQLITE_WRITE: sessions=${result.sessions} decisions=${result.decisions} ` +
      `learnings=${result.learnings} breadcrumbs=${result.breadcrumbs} ` +
      `errors=${result.errors} loa=${result.loa}`
  );
}

/**
 * Run extraction and update all memory files
 * Priority: Anthropic API > Nano local LLM
 */
async function extractAndAppend(conversationPath: string, cwd: string): Promise<void> {
  try {
    // Deduplication check - skip if same conversation already extracted
    const convHash = getConversationHash(conversationPath);
    if (wasAlreadyExtracted(convHash)) {
      console.error('[FabricExtract] Already extracted this conversation, skipping');
      releaseChildLockSafe(conversationPath);
      return;
    }

    // Extract messages from conversation
    const messages = extractMessages(conversationPath);

    if (shouldSkipExtraction(messages.length)) {
      console.error('[FabricExtract] Conversation too short, skipping extraction');
      releaseChildLockSafe(conversationPath);
      return;
    }

    // Metadata (independent of the extracted text) — supplied up-front so the
    // core can build the SQLite dual-write context.
    const timestamp = new Date().toISOString().split('T')[0];
    const dirName = cwd.split('/').pop() || 'unknown';
    const loaName = getLoaSessionName();
    // Use LoA session name if available, otherwise fall back to directory name
    const sessionLabel = loaName || dirName;
    const sessionId = conversationPath.split('/').pop()?.replace('.jsonl', '') || 'unknown';

    // Shared extract-core: extract → quality-gate → scrub → dual-write (SQLite only).
    // The scrub guard redacts secrets / strips invisible unicode from every
    // persisted text field before it reaches a writer. Markdown side-effects below
    // are unchanged and operate on the RAW extracted text the core returns.
    const core = await runExtractCore(
      getDbPath(),
      messages,
      { sessionId, sessionLabel, project: sessionLabel, timestamp, conversationPath },
      {
        extract: runExtractionCascade,
        deriveMeta: (text) => ({
          topics: extractTopics(text),
          summary: deriveSummary(text, sessionLabel),
        }),
      },
    );

    if (core.outcome === 'extraction_failed') {
      console.error("[FabricExtract] All extraction methods failed, no extraction");
      logExtract("FAILURE: All extraction methods failed");
      markAsFailed(convHash, 'all extraction methods failed');
      return;
    }
    if (core.outcome === 'quality_failed') {
      console.error(`[FabricExtract] QUALITY GATE FAILED: ${core.quality?.reason}. Discarding.`);
      logExtract(`QUALITY GATE FAILED: ${core.quality?.reason}`);
      markAsFailed(convHash, `quality gate failed: ${core.quality?.reason}`);
      return;
    }
    if (core.outcome === 'persistence_failed') {
      const failures = JSON.stringify(core.dualWrite?.failures ?? {});
      console.error(`[FabricExtract] SQLite write failed: ${failures}`);
      logExtract(`FAILURE: SQLite write failed: ${failures}`);
      markAsFailed(convHash, `SQLite write failed: ${failures}`);
      return;
    }
    logExtract("QUALITY GATE PASSED: extraction contains required sections");

    // Scrub the extracted text BEFORE it reaches any on-disk archive writer
    // (#132): the SQLite path already scrubs inside runExtractCore, but the
    // legacy markdown side-effects below all read these locals — so scrub them
    // here, at the single markdown-write seam, to redact secrets and strip
    // invisible unicode from all seven archive surfaces (DISTILLED.md,
    // HOT_RECALL.md, SESSION_INDEX.json, the LoA transcript, DECISIONS.log,
    // REJECTIONS.log, ERROR_PATTERNS.json). Reuses the same scrub() the SQLite
    // path calls — no duplicated redaction logic.
    const extracted = scrub(core.extracted!).text;
    const topics = core.topics!.map((t) => scrub(t).text);
    const summary = scrub(core.summary!).text;

    // SQLite dual-write already ran inside the core (with scrubbed text).
    logDualWrite(core.dualWrite!);
    logExtract(`SCRUB: redacted ${core.redactions!.length} secret kind(s) before SQLite write`);

    // 1. Append to DISTILLED.md (full archive)
    const header = `\n---\n## Extracted: ${timestamp} | ${sessionLabel}\n\n`;
    appendFileSync(DISTILLED_PATH, header + extracted.trim() + '\n', 'utf-8');
    console.error(`[FabricExtract] Appended to DISTILLED.md`);

    // 2. Update HOT_RECALL.md (rotating recent sessions)
    updateHotRecall(extracted, sessionLabel, timestamp);
    console.error(`[FabricExtract] Updated HOT_RECALL.md`);

    // 3. Update SESSION_INDEX.json (searchable lookup)
    updateSessionIndex({
      sessionId,
      project: sessionLabel,
      date: timestamp,
      timestamp: Date.now(),
      topics,
      summary,
      file: conversationPath
    });
    console.error(`[FabricExtract] Updated SESSION_INDEX.json`);

    // 4. Write extraction to LoA session transcript.md (if session folder exists)
    try {
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const todayDir = join(SESSION_FOLDERS_DIR, today);
      if (existsSync(todayDir)) {
        const sessions = readdirSync(todayDir).sort().reverse();
        if (sessions.length > 0) {
          const transcriptPath = join(todayDir, sessions[0], 'transcript.md');
          const transcriptContent = `# Session Transcript: ${sessionLabel}\n\n**Date**: ${timestamp}\n**Source**: ${conversationPath}\n\n---\n\n${extracted.trim()}\n`;
          writeFileSync(transcriptPath, transcriptContent, 'utf-8');
          console.error(`[FabricExtract] Wrote extraction to LoA transcript: ${transcriptPath}`);
        }
      }
    } catch (err: any) {
      console.error(`[FabricExtract] Failed to write LoA transcript: ${err.message}`);
    }

    // 5. Append to DECISIONS.log, REJECTIONS.log, ERROR_PATTERNS.json
    appendDecisions(extracted, sessionLabel, timestamp);
    appendRejections(extracted, sessionLabel, timestamp);
    appendErrors(extracted, sessionLabel, timestamp);

    // 6. Mark as extracted (dedup)
    markAsExtracted(convHash);

    logExtract(`SUCCESS: All memory files updated for session=${sessionLabel}`);

  } catch (error: any) {
    console.error(`[FabricExtract] Extraction failed: ${error.message}`);
    logExtract(`FAILURE: Extraction crashed: ${error.message}`);
    // Release the child lock + semaphore slot even on uncaught failure.
    releaseChildLockSafe(conversationPath);
  }
}

/**
 * Log to the extract log file with timestamp
 */
function logExtract(message: string): void {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n`;
  try {
    appendFileSync(EXTRACT_LOG, logLine, 'utf-8');
  } catch {
    // Ignore logging errors
  }
}

/**
 * Extract and append from a pre-formatted markdown transcript (OpenCode sessions).
 * Skips JSONL parsing — reads markdown content directly and feeds it to the LLM.
 */
async function extractAndAppendMarkdown(mdPath: string, cwd: string): Promise<void> {
  try {
    if (!existsSync(mdPath)) {
      logExtract(`REEXTRACT-MD: File not found: ${mdPath}`);
      releaseChildLockSafe(mdPath);
      return;
    }

    const convHash = mdPath;
    if (wasAlreadyExtracted(convHash)) {
      console.error('[FabricExtract] Already extracted this markdown, skipping');
      releaseChildLockSafe(mdPath);
      return;
    }

    const messages = readFileSync(mdPath, 'utf-8');

    if (shouldSkipExtraction(messages.length)) {
      console.error('[FabricExtract] Markdown too short, skipping extraction');
      releaseChildLockSafe(mdPath);
      return;
    }

    // Metadata — use filename as session ID, platform as project label. Supplied
    // up-front so the core can build the SQLite dual-write context.
    const timestamp = new Date().toISOString().split('T')[0];
    const fileName = mdPath.split('/').pop() || 'unknown';
    const sessionId = fileName.replace('.md', '');
    // cwd is either a platform name ('opencode', 'pi') from RecallBatchExtract,
    // or a real path from --reextract-md CLI usage.
    const isRealPath = cwd.includes('/');
    const platform = isRealPath ? cwd.split('/').pop() || 'unknown' : cwd;
    const sessionLabel = `${platform}/${sessionId}`;

    // Shared extract-core: extract → quality-gate → scrub → dual-write (SQLite only).
    // Same scrub guard as the Stop path; markdown side-effects below are unchanged
    // and operate on the RAW extracted text the core returns.
    const core = await runExtractCore(
      getDbPath(),
      messages,
      { sessionId, sessionLabel, project: sessionLabel, timestamp, conversationPath: mdPath },
      {
        extract: runExtractionCascade,
        deriveMeta: (text) => ({
          topics: extractTopics(text),
          summary: deriveSummary(text, sessionLabel),
        }),
      },
    );

    if (core.outcome === 'extraction_failed') {
      console.error("[FabricExtract] All extraction methods failed for markdown");
      logExtract("FAILURE: All extraction methods failed (markdown)");
      markAsFailed(convHash, 'all extraction methods failed (markdown)');
      return;
    }
    if (core.outcome === 'quality_failed') {
      console.error(`[FabricExtract] QUALITY GATE FAILED: ${core.quality?.reason}.`);
      logExtract(`QUALITY GATE FAILED (markdown): ${core.quality?.reason}`);
      markAsFailed(convHash, `quality gate failed (markdown): ${core.quality?.reason}`);
      return;
    }
    if (core.outcome === 'persistence_failed') {
      const failures = JSON.stringify(core.dualWrite?.failures ?? {});
      console.error(`[FabricExtract] SQLite write failed (markdown): ${failures}`);
      logExtract(`FAILURE (markdown): SQLite write failed: ${failures}`);
      markAsFailed(convHash, `SQLite write failed (markdown): ${failures}`);
      return;
    }
    logExtract("QUALITY GATE PASSED (markdown)");

    // Scrub the extracted text BEFORE it reaches any on-disk archive writer
    // (#132) — same single markdown-write seam as the Stop path. Redacts
    // secrets and strips invisible unicode from every archive surface below.
    // Reuses the same scrub() the SQLite path calls — no duplicated redaction.
    const extracted = scrub(core.extracted!).text;
    const topics = core.topics!.map((t) => scrub(t).text);
    const summary = scrub(core.summary!).text;

    // SQLite dual-write already ran inside the core (with scrubbed text).
    logDualWrite(core.dualWrite!);
    logExtract(`SCRUB: redacted ${core.redactions!.length} secret kind(s) before SQLite write (markdown)`);

    // 1. Append to DISTILLED.md
    const header = `\n---\n## Extracted: ${timestamp} | ${sessionLabel} (${sessionId})\n\n`;
    appendFileSync(DISTILLED_PATH, header + extracted.trim() + '\n', 'utf-8');
    console.error(`[FabricExtract] Appended markdown extraction to DISTILLED.md`);

    // 2. Update HOT_RECALL.md
    updateHotRecall(extracted, sessionLabel, timestamp);

    // 3. Update SESSION_INDEX.json
    updateSessionIndex({
      sessionId,
      project: sessionLabel,
      date: timestamp,
      timestamp: Date.now(),
      topics,
      summary,
      file: mdPath
    });

    // 4. Append to DECISIONS.log, REJECTIONS.log, ERROR_PATTERNS.json
    appendDecisions(extracted, sessionLabel, timestamp);
    appendRejections(extracted, sessionLabel, timestamp);
    appendErrors(extracted, sessionLabel, timestamp);

    // 5. Mark as extracted
    markAsExtracted(convHash);

    logExtract(`SUCCESS (markdown): All memory files updated for ${sessionLabel} (${sessionId})`);

  } catch (error: any) {
    console.error(`[FabricExtract] Markdown extraction failed: ${error.message}`);
    logExtract(`FAILURE (markdown): ${error.message}`);
    releaseChildLockSafe(mdPath);
  }
}

/**
 * Clear any prior tracker row for a conversation path so that a forced
 * re-extraction (--reextract*) proceeds. Best-effort.
 */
function clearTrackerRow(convPath: string): void {
  try {
    const dbPath = getDbPath();
    if (!existsSync(dbPath)) return;
    const { Database } = require('bun:sqlite');
    const db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    // Match getDb()'s busy_timeout so a held lock waits instead of failing
    // immediately. Value mirrored inline — hooks must not import from src/. (#72/#96)
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare('DELETE FROM extraction_tracker WHERE conversation_path = ?').run(convPath);
    db.close();
  } catch {}
}

/**
 * Acquire the per-conversation slot for a child running standalone (i.e.
 * --reextract / --reextract-md, where no parent has already taken a
 * semaphore slot for this conv). Returns true on success.
 *
 * NOTE: NOT called from --extract mode — in that mode the parent's
 * acquireSemaphore() already owns the row keyed on conversation_path.
 */
function standaloneChildAcquire(convPath: string): boolean {
  try {
    const dbPath = getDbPath();
    if (!existsSync(dbPath)) return true; // No DB — nothing to lock against
    return childAcquireLock(dbPath, convPath, process.pid);
  } catch {
    return true; // On lock-system failure, prefer running over silent skip
  }
}

// If called with --reextract-md flag, extract from a markdown file (OpenCode sessions)
if (process.argv.includes('--reextract-md')) {
  const idx = process.argv.indexOf('--reextract-md');
  const mdPath = process.argv[idx + 1];
  const cwd = process.argv[idx + 2] || process.cwd();
  if (mdPath) {
    logExtract(`REEXTRACT-MD: Forcing re-extraction of markdown ${mdPath}`);
    clearTrackerRow(mdPath);
    if (!standaloneChildAcquire(mdPath)) {
      logExtract(`REEXTRACT-MD: LOCK_BUSY ${mdPath} — extraction already in progress`);
      process.exit(0);
    }
    extractAndAppendMarkdown(mdPath, cwd).then(() => {
      logExtract(`REEXTRACT-MD: Complete`);
      process.exit(0);
    }).catch((err) => {
      logExtract(`REEXTRACT-MD: Failed: ${err}`);
      releaseChildLockSafe(mdPath);
      process.exit(1);
    });
  } else {
    console.error('Usage: bun run RecallExtract.ts --reextract-md <session.md> [cwd]');
    process.exit(1);
  }
// If called with --reextract flag, force re-extraction bypassing dedup
} else if (process.argv.includes('--reextract')) {
  const idx = process.argv.indexOf('--reextract');
  const convPath = process.argv[idx + 1];
  const cwd = process.argv[idx + 2] || process.cwd();
  if (convPath) {
    logExtract(`REEXTRACT: Forcing re-extraction of ${convPath}`);
    try { writeFileSync(DEDUP_PATH, '', 'utf-8'); } catch {}
    clearTrackerRow(convPath);
    if (!standaloneChildAcquire(convPath)) {
      logExtract(`REEXTRACT: LOCK_BUSY ${convPath} — extraction already in progress`);
      process.exit(0);
    }
    extractAndAppend(convPath, cwd).then(() => {
      logExtract(`REEXTRACT: Complete`);
      process.exit(0);
    }).catch((err) => {
      logExtract(`REEXTRACT: Failed: ${err}`);
      releaseChildLockSafe(convPath);
      process.exit(1);
    });
  } else {
    console.error('Usage: bun run RecallExtract.ts --reextract <conversation.jsonl> [cwd]');
    process.exit(1);
  }
// If called with --extract flag, run extraction directly (background mode)
} else if (process.argv.includes('--extract')) {
  const idx = process.argv.indexOf('--extract');
  const convPath = process.argv[idx + 1];
  const cwd = process.argv[idx + 2];
  if (convPath && cwd) {
    logExtract(`BACKGROUND: Starting extraction for ${convPath}`);
    // Parent (main()) already acquired the semaphore slot keyed on convPath.
    // The semaphore row IS the per-conv lock (extraction_locks PK is
    // conversation_path), so no additional child-side acquire is needed.
    extractAndAppend(convPath, cwd).then(() => {
      logExtract(`BACKGROUND: Extraction complete`);
      process.exit(0);
    }).catch((err) => {
      logExtract(`BACKGROUND: Extraction failed: ${err}`);
      releaseChildLockSafe(convPath);
      process.exit(1);
    });
  } else {
    process.exit(0);
  }
  // Don't fall through to main() - we're in extract mode
} else {

async function main() {
  try {
    // Read input from stdin with timeout (5s max to prevent hanging)
    // 200ms was too aggressive — bun startup on slow systems (CI, Docker, Rosetta) can exceed it
    let input = '';
    const decoder = new TextDecoder();
    const reader = Bun.stdin.stream().getReader();

    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 5000);
    });

    const readPromise = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        input += decoder.decode(value, { stream: true });
      }
    })();

    await Promise.race([readPromise, timeoutPromise]);

    if (!input || input.trim() === '') {
      process.exit(0);
    }

    let hookInput: HookInput;
    try {
      hookInput = JSON.parse(input);
    } catch {
      process.exit(0);
    }

    const cwd = hookInput.cwd || process.cwd();

    // Find conversation file
    const conversationPath = findCurrentConversation(cwd);
    if (!conversationPath) {
      logExtract(`NO_CONVERSATION: ${cwd}`);
      process.exit(0);
    }

    // One-shot legacy JSON tracker → SQLite migration (no-op after first run).
    const parentDbPath = getDbPath();
    migrateLegacyTrackerOnce(parentDbPath);

    // Early dedup check in parent — prevents spawning duplicate children
    if (wasAlreadyExtracted(conversationPath)) {
      logExtract(`DEDUP_PARENT: ${conversationPath} already extracted, skipping spawn`);
      process.exit(0);
    }

    // Counting semaphore — global cap on concurrent extractors. The row PK
    // is conversation_path so this also serves as the per-conv lock.
    //
    // Degrade gracefully on pre-migration databases: if the DB exists but
    // the extraction_locks table is missing (DB older than migration 4/5),
    // skip the semaphore and proceed with legacy extraction. Without this
    // guard the throw would bypass legacy markdown/JSON writes entirely.
    let parentHoldsSlot = false;
    if (existsSync(parentDbPath)) {
      try {
        const got = acquireSemaphore(
          parentDbPath,
          conversationPath,
          process.pid,
          EXTRACTION_MAX_CONCURRENT
        );
        if (!got) {
          logExtract(
            `SEMAPHORE_FULL: ${EXTRACTION_MAX_CONCURRENT} extractors already running, skipping spawn for ${conversationPath}`
          );
          process.exit(0);
        }
        parentHoldsSlot = true;
      } catch (err: any) {
        // extraction_locks table missing or DB unwritable — degrade silently.
        logExtract(
          `SEMAPHORE_UNAVAILABLE: ${err?.message || err} — proceeding without SQLite lock`
        );
      }
    }

    // Spawn self in background with --extract flag.
    // This way: session exits immediately AND all memory files get updated.
    // Resolve bun dynamically — don't assume ~/.bun/bin (could be Homebrew, nix, etc.)
    const bunPath = (() => {
      const candidates = [
        process.argv[0], // the bun that's running us right now
        `${process.env.HOME}/.bun/bin/bun`,
        '/opt/homebrew/bin/bun',
        '/usr/local/bin/bun',
      ];
      for (const c of candidates) {
        try { if (require('fs').existsSync(c)) return c; } catch {}
      }
      return 'bun'; // fallback to PATH lookup
    })();
    let child;
    try {
      child = spawn(bunPath, ['run', import.meta.path, '--extract', conversationPath, cwd], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, CLAUDECODE: '' },
      });
      child.unref();
    } catch (spawnErr: any) {
      // Spawn failed AFTER we acquired the slot — release so capacity isn't
      // wasted until TTL expiry (Forge Finding 4).
      if (parentHoldsSlot) releaseChildLockSafe(conversationPath);
      logExtract(`SPAWN_FAILED: ${spawnErr?.message || spawnErr}`);
      process.exit(0);
    }

    logExtract(`SPAWNED: Self-extract PID ${child.pid} for ${conversationPath}`);
    process.exit(0);
  } catch (error) {
    logExtract(`ERROR: ${error}`);
    process.exit(0);
  }
}

main();
} // end else (not --extract mode)
