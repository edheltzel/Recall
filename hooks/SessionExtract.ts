#!/usr/bin/env bun
/**
 * SessionExtract.ts - Extract Context for Future Sessions (LMF3)
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

import { existsSync, readFileSync, appendFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync, spawn } from 'child_process';

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

// Claude CLI extraction (uses Claude Code's existing auth — no API key needed)
const CLAUDE_CLI_MODEL = "haiku";
const EXTRACT_PATTERN_PATH = join(MEMORY_DIR, 'extract_prompt.md');

// Local Ollama LLM fallback (configure OLLAMA_URL env var or defaults to localhost)
const LOCAL_OLLAMA_URL = `${process.env.OLLAMA_URL || "http://localhost:11434"}/api/generate`;
const LOCAL_OLLAMA_MODEL = process.env.LMF3_OLLAMA_MODEL || "qwen2.5:3b";

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
  // Encode the path like Claude Code does (slashes AND underscores become hyphens)
  const encodedPath = '-' + cwd.replace(/^\//, '').replace(/[\/\_]/g, '-');
  const projectDir = join(PROJECTS_DIR, encodedPath);

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
 * Per-file dedup tracking — stores {filepath: {size, extractedAt}} in JSON
 * Re-extracts when file size grows by >50% since last extraction
 */
const DEDUP_DB_PATH = join(MEMORY_DIR, '.extraction_tracker.json');

interface ExtractionRecord {
  size: number;
  extractedAt?: string;
  failedAt?: string;
  retryAfter?: string;
}

function loadExtractionTracker(): Record<string, ExtractionRecord> {
  try {
    if (existsSync(DEDUP_DB_PATH)) {
      return JSON.parse(readFileSync(DEDUP_DB_PATH, 'utf-8'));
    }
  } catch {}
  // Migrate from old single-hash format
  try {
    if (existsSync(DEDUP_PATH)) {
      const oldPath = readFileSync(DEDUP_PATH, 'utf-8').trim();
      if (oldPath && existsSync(oldPath)) {
        const size = statSync(oldPath).size;
        return { [oldPath]: { size, extractedAt: new Date().toISOString() } };
      }
    }
  } catch {}
  return {};
}

function saveExtractionTracker(tracker: Record<string, ExtractionRecord>): void {
  try {
    writeFileSync(DEDUP_DB_PATH, JSON.stringify(tracker, null, 2), 'utf-8');
  } catch {}
}

/**
 * Check if this conversation needs (re-)extraction
 * Returns true if: never extracted, OR file grew >50% since last extraction
 */
function wasAlreadyExtracted(convPath: string): boolean {
  const tracker = loadExtractionTracker();
  const record = tracker[convPath];
  if (!record) return false;

  try {
    const currentSize = statSync(convPath).size;
    const growth = (currentSize - record.size) / record.size;

    // Re-extract if file grew by >50%
    if (growth > 0.5) {
      logExtract(`REGROWTH: ${convPath} grew ${Math.round(growth * 100)}% (${record.size} -> ${currentSize}), re-extracting`);
      return false;
    }

    // If this was a failed extraction, retry after 24 hours
    if (record.failedAt && !record.extractedAt) {
      const failedTime = new Date(record.failedAt).getTime();
      const retryTime = record.retryAfter ? new Date(record.retryAfter).getTime() : failedTime + 86400000;
      if (Date.now() >= retryTime) {
        logExtract(`RETRY: ${convPath} failed at ${record.failedAt}, retry window reached, re-extracting`);
        return false;
      }
      return true; // Still within retry cooldown
    }

    return true;
  } catch {
    return true;
  }
}

/**
 * Mark conversation as extracted with current size
 */
function markAsExtracted(convPath: string): void {
  try {
    const tracker = loadExtractionTracker();
    tracker[convPath] = {
      size: statSync(convPath).size,
      extractedAt: new Date().toISOString()
    };
    saveExtractionTracker(tracker);
  } catch {}
}

/**
 * Mark conversation as failed extraction with 24-hour retry window
 */
function markAsFailed(convPath: string): void {
  try {
    const tracker = loadExtractionTracker();
    const now = new Date();
    const retryAfter = new Date(now.getTime() + 86400000); // 24 hours
    tracker[convPath] = {
      size: statSync(convPath).size,
      failedAt: now.toISOString(),
      retryAfter: retryAfter.toISOString()
    };
    saveExtractionTracker(tracker);
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
 * Extract topics from fabric output
 * Matches both "## HEADING" markdown format and "HEADING:" legacy format
 */
function extractTopics(fabricOutput: string): string[] {
  const topics: string[] = [];

  // Extract from DECISIONS MADE, MAIN IDEAS, and INSIGHTS sections
  const patterns = [
    /(?:##\s*DECISIONS\s*MADE|DECISIONS:)\s*([\s\S]*?)(?=\n##\s|$)/,
    /(?:##\s*MAIN\s*IDEAS|MAIN_IDEAS:)\s*([\s\S]*?)(?=\n##\s|$)/,
    /(?:##\s*INSIGHTS|INSIGHTS:)\s*([\s\S]*?)(?=\n##\s|$)/
  ];

  for (const pattern of patterns) {
    const match = fabricOutput.match(pattern);
    if (match) {
      const lines = match[1].split('\n').filter(l => l.trim().startsWith('-'));
      for (const line of lines.slice(0, 3)) { // Max 3 per section
        // Strip markdown bold markers and leading bullet
        const topic = line.replace(/^-\s*/, '').replace(/\*\*/g, '').split(':')[0].trim();
        if (topic && topic.length < 50) {
          topics.push(topic);
        }
      }
    }
  }

  return [...new Set(topics)].slice(0, 5); // Dedupe, max 5
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
      if (parts.length >= 3) {
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
    newEntries.push(`${timestamp}|${sessionLabel}|${line.replace(/\|/g, '/')}`);
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

/**
 * Extract using local Ollama LLM as fallback
 * Returns extracted text or null if failed
 */
function extractWithOllama(messages: string): string | null {
  const systemPrompt = `You are an expert at extracting meaningful information from conversations. Extract in this exact format:

## ONE SENTENCE SUMMARY
[Single sentence capturing the essence]

## MAIN IDEAS
- [Key idea 1]
- [Key idea 2]
- [Key idea 3]

## INSIGHTS
- [Non-obvious insight 1]
- [Non-obvious insight 2]

## DECISIONS MADE
- [Important decision and why]

## THINGS TO REJECT / AVOID
- [Thing to reject or avoid]

## ERRORS FIXED
- [error message or pattern]: [what fixed it]

## ACTIONABLE ITEMS
- [Concrete action]

## SESSION CONTEXT
[One sentence about overall impact on the project or infrastructure]`;

  try {
    // Truncate messages to fit 3B model context (keep last ~8000 chars)
    const truncated = messages.length > 8000 ? messages.slice(-8000) : messages;

    const payload = JSON.stringify({
      model: LOCAL_OLLAMA_MODEL,
      prompt: systemPrompt + "\n\n---\nCONVERSATION:\n" + truncated,
      stream: false
    });

    const result = execSync(
      `curl -s --connect-timeout 10 --max-time 180 -X POST ${LOCAL_OLLAMA_URL} -H "Content-Type: application/json" -d @-`,
      {
        input: payload,
        encoding: "utf-8",
        timeout: 200000,
        maxBuffer: 10 * 1024 * 1024
      }
    );

    const parsed = JSON.parse(result);
    if (parsed.response && parsed.response.trim().length > 50) {
      console.error("[FabricExtract] Ollama extraction successful");
      return parsed.response.trim();
    }
    return null;
  } catch (error: any) {
    console.error(`[FabricExtract] Ollama extraction failed: ${error.message}`);
    return null;
  }
}

/**
 * Find the claude CLI binary
 */
function findClaudeCli(): string | null {
  const candidates = [
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    join(process.env.HOME!, '.npm-global', 'bin', 'claude'),
    join(process.env.HOME!, '.local', 'bin', 'claude'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Try PATH lookup
  try {
    const which = execSync('which claude 2>/dev/null', { encoding: 'utf-8' }).trim();
    if (which) return which;
  } catch {}
  return null;
}

/**
 * Get the extraction system prompt from the fabric pattern file
 */
function getExtractionPrompt(): string {
  try {
    if (existsSync(EXTRACT_PATTERN_PATH)) {
      return readFileSync(EXTRACT_PATTERN_PATH, 'utf-8').trim();
    }
  } catch {}
  // Inline fallback if pattern file missing
  return `You are an expert at extracting meaningful, factual information from AI coding session transcripts.
Extract ONLY what actually happened. Follow this format EXACTLY:

## ONE SENTENCE SUMMARY
[Single factual sentence]

## MAIN IDEAS
- [Concrete thing 1]
- [Concrete thing 2]

## DECISIONS MADE
- [Decision]: [reason]

## THINGS TO REJECT / AVOID
- [Thing to avoid]: [why]

## ERRORS FIXED
- [Error]: [fix]

## SESSION CONTEXT
[One sentence about impact on infrastructure]`;
}

/**
 * Extract using the claude CLI (primary method)
 * Uses Claude Code's existing authentication — no separate API key needed.
 * Calls `claude -p --model haiku` with the extraction prompt piped via stdin.
 */
async function extractWithClaude(messages: string): Promise<string | null> {
  const claudePath = findClaudeCli();
  if (!claudePath) {
    console.error("[FabricExtract] claude CLI not found in PATH");
    return null;
  }

  const systemPrompt = getExtractionPrompt();

  // Truncate to fit context window (~180K chars ≈ ~45K tokens, well within haiku's 200K)
  // But keep it reasonable to control cost
  const maxChars = 120000;
  const truncated = messages.length > maxChars
    ? messages.slice(-maxChars)
    : messages;

  const userMessage = `${systemPrompt}\n\n---\n\nExtract the key information from this AI coding session transcript:\n\n${truncated}`;

  try {
    const result = execSync(
      `"${claudePath}" -p --model ${CLAUDE_CLI_MODEL} --output-format text`,
      {
        input: userMessage,
        encoding: 'utf-8',
        timeout: 300000, // 5 minute timeout
        maxBuffer: 10 * 1024 * 1024,
      }
    );

    const text = result?.trim();
    if (text && text.length > 50) {
      console.error(`[FabricExtract] Claude CLI extraction successful (model=${CLAUDE_CLI_MODEL}, ${text.length} chars)`);
      logExtract(`Claude CLI extraction successful: model=${CLAUDE_CLI_MODEL}, output_chars=${text.length}`);
      return text;
    }
    console.error("[FabricExtract] Claude CLI returned empty/short response");
    return null;
  } catch (error: any) {
    console.error(`[FabricExtract] Claude CLI extraction failed: ${error.message}`);
    return null;
  }
}

/**
 * Chunked extraction for large files (>120K chars of messages)
 * Splits messages into chunks, extracts each, then meta-extracts a final summary
 */
async function extractWithClaudeChunked(messages: string): Promise<string | null> {
  const claudePath = findClaudeCli();
  if (!claudePath) return null;

  const CHUNK_SIZE = 80000; // ~20K tokens per chunk, well within limits
  const chunks: string[] = [];

  // Split by lines to avoid breaking mid-message
  const lines = messages.split('\n');
  let currentChunk = '';
  for (const line of lines) {
    if (currentChunk.length + line.length > CHUNK_SIZE && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = '';
    }
    currentChunk += line + '\n';
  }
  if (currentChunk.trim()) chunks.push(currentChunk);

  console.error(`[FabricExtract] CHUNKED: Splitting ${messages.length} chars into ${chunks.length} chunks`);
  logExtract(`CHUNKED: ${messages.length} chars -> ${chunks.length} chunks`);

  // Extract each chunk
  const partials: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    console.error(`[FabricExtract] CHUNKED: Extracting chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)`);
    const result = await extractWithClaude(chunks[i]);
    if (result) {
      partials.push(`--- Chunk ${i + 1}/${chunks.length} ---\n${result}`);
    }
    // Rate limit between chunks
    if (i < chunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  if (partials.length === 0) return null;

  // If only one chunk succeeded, use it directly
  if (partials.length === 1) return partials[0].replace(/^--- Chunk \d+\/\d+ ---\n/, '');

  // Meta-extract: merge partial extractions into final summary
  console.error(`[FabricExtract] CHUNKED: Meta-extracting ${partials.length} partial results`);
  const mergePrompt = partials.join('\n\n');

  const systemPrompt = `You are merging multiple partial session extractions into one coherent summary. Combine all findings, deduplicate, and output in this exact format:

## ONE SENTENCE SUMMARY
[Single comprehensive sentence covering the full session]

## MAIN IDEAS
- [Key ideas from ALL chunks combined]

## DECISIONS MADE
- [All decisions from all chunks]

## THINGS TO REJECT / AVOID
- [All rejections from all chunks]

## ERRORS FIXED
- [All errors from all chunks]

## SESSION CONTEXT
[One comprehensive sentence about the full session's impact]`;

  const userMessage = `${systemPrompt}\n\n---\n\nMerge these ${partials.length} partial extractions into one comprehensive summary:\n\n${mergePrompt}`;

  try {
    const result = execSync(
      `"${claudePath}" -p --model ${CLAUDE_CLI_MODEL} --output-format text`,
      {
        input: userMessage,
        encoding: 'utf-8',
        timeout: 300000,
        maxBuffer: 10 * 1024 * 1024,
      }
    );

    const text = result?.trim();
    if (text && text.length > 50) {
      console.error(`[FabricExtract] CHUNKED: Meta-extraction successful`);
      logExtract(`CHUNKED: Meta-extraction successful, output_chars=${text.length}`);
      return text;
    }
  } catch (err: any) {
    console.error(`[FabricExtract] CHUNKED: Meta-extraction failed: ${err.message}`);
  }

  // Fallback: concatenate partials
  return partials.map(p => p.replace(/^--- Chunk \d+\/\d+ ---\n/, '')).join('\n\n');
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
      return;
    }

    // Extract messages from conversation
    const messages = extractMessages(conversationPath);

    if (messages.length < 500) {
      console.error('[FabricExtract] Conversation too short, skipping extraction');
      return;
    }

    let extracted: string = "";

    // Attempt 1: Claude CLI (uses Claude Code's existing auth — no API key needed)
    // Use chunked extraction for large files (>120K chars)
    if (messages.length > 120000) {
      console.error(`[FabricExtract] Large file (${messages.length} chars), using chunked extraction...`);
      const chunkedResult = await extractWithClaudeChunked(messages);
      if (chunkedResult) {
        extracted = chunkedResult;
      }
    } else {
      console.error("[FabricExtract] Trying Claude CLI extraction...");
      const claudeResult = await extractWithClaude(messages);
      if (claudeResult) {
        extracted = claudeResult;
      }
    }

    // Attempt 2: Local Ollama LLM fallback (free, lower quality)
    if (!extracted) {
      console.error("[FabricExtract] Claude CLI failed, trying local Ollama LLM fallback...");
      const ollamaResult = extractWithOllama(messages);
      if (ollamaResult) {
        extracted = ollamaResult;
      }
    }

    if (!extracted) {
      console.error("[FabricExtract] All extraction methods failed, no extraction");
      logExtract("FAILURE: All extraction methods failed");
      markAsFailed(convHash);
      return;
    }

    // Quality gate: reject extractions that don't follow the structured format
    if (!extracted.includes('ONE SENTENCE SUMMARY') && !extracted.includes('MAIN IDEAS')) {
      console.error("[FabricExtract] QUALITY GATE FAILED: extraction missing required sections. Discarding.");
      logExtract("QUALITY GATE FAILED: extraction missing required sections (ONE SENTENCE SUMMARY, MAIN IDEAS)");
      markAsFailed(convHash);
      return;
    }
    logExtract("QUALITY GATE PASSED: extraction contains required sections");

    // Metadata
    const timestamp = new Date().toISOString().split('T')[0];
    const dirName = cwd.split('/').pop() || 'unknown';
    const loaName = getLoaSessionName();
    // Use LoA session name if available, otherwise fall back to directory name
    const sessionLabel = loaName || dirName;
    const sessionId = conversationPath.split('/').pop()?.replace('.jsonl', '') || 'unknown';

    // 1. Append to DISTILLED.md (full archive)
    const header = `\n---\n## Extracted: ${timestamp} | ${sessionLabel}\n\n`;
    appendFileSync(DISTILLED_PATH, header + extracted.trim() + '\n', 'utf-8');
    console.error(`[FabricExtract] Appended to DISTILLED.md`);

    // 2. Update HOT_RECALL.md (rotating recent sessions)
    updateHotRecall(extracted, sessionLabel, timestamp);
    console.error(`[FabricExtract] Updated HOT_RECALL.md`);

    // 3. Update SESSION_INDEX.json (searchable lookup)
    const topics = extractTopics(extracted);
    // Extract summary from "## ONE SENTENCE SUMMARY" section
    const summaryMatch = extracted.match(/##\s*ONE\s*SENTENCE\s*SUMMARY\s*\n+(.+)/);
    const summary = summaryMatch ? summaryMatch[1].trim() : `${sessionLabel} session`;

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

// If called with --reextract flag, force re-extraction bypassing dedup
if (process.argv.includes('--reextract')) {
  const idx = process.argv.indexOf('--reextract');
  const convPath = process.argv[idx + 1];
  const cwd = process.argv[idx + 2] || process.cwd();
  if (convPath) {
    logExtract(`REEXTRACT: Forcing re-extraction of ${convPath}`);
    // Clear both old and new dedup so extraction proceeds
    try { writeFileSync(DEDUP_PATH, '', 'utf-8'); } catch {}
    try {
      const tracker = loadExtractionTracker();
      delete tracker[convPath];
      saveExtractionTracker(tracker);
    } catch {}
    extractAndAppend(convPath, cwd).then(() => {
      logExtract(`REEXTRACT: Complete`);
      process.exit(0);
    }).catch((err) => {
      logExtract(`REEXTRACT: Failed: ${err}`);
      process.exit(1);
    });
  } else {
    console.error('Usage: bun run FabricExtract.hook.ts --reextract <conversation.jsonl> [cwd]');
    process.exit(1);
  }
// If called with --extract flag, run extraction directly (background mode)
} else if (process.argv.includes('--extract')) {
  const idx = process.argv.indexOf('--extract');
  const convPath = process.argv[idx + 1];
  const cwd = process.argv[idx + 2];
  if (convPath && cwd) {
    logExtract(`BACKGROUND: Starting extraction for ${convPath}`);
    extractAndAppend(convPath, cwd).then(() => {
      logExtract(`BACKGROUND: Extraction complete`);
      process.exit(0);
    }).catch((err) => {
      logExtract(`BACKGROUND: Extraction failed: ${err}`);
      process.exit(1);
    });
  } else {
    process.exit(0);
  }
  // Don't fall through to main() - we're in extract mode
} else {

async function main() {
  try {
    // Read input from stdin with timeout (200ms max to prevent hanging)
    let input = '';
    const decoder = new TextDecoder();
    const reader = Bun.stdin.stream().getReader();

    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 200);
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

    // Spawn self in background with --extract flag.
    // This way: session exits immediately AND all memory files get updated.
    const bunPath = `${process.env.HOME}/.bun/bin/bun`;
    const child = spawn(bunPath, ['run', import.meta.path, '--extract', conversationPath, cwd], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    logExtract(`SPAWNED: Self-extract PID ${child.pid} for ${conversationPath}`);
    process.exit(0);
  } catch (error) {
    logExtract(`ERROR: ${error}`);
    process.exit(0);
  }
}

main();
} // end else (not --extract mode)
