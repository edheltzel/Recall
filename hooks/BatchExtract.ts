#!/usr/bin/env bun
/**
 * BatchExtract.ts — Cron-friendly batch extraction of un-extracted JSONL sessions
 *
 * Scans all ~/.claude/projects/ directories for JSONL conversation files,
 * identifies those not yet extracted (or significantly grown), and runs
 * the SessionExtract pipeline on each.
 *
 * Tracker storage: SQLite `extraction_tracker` table (system of record).
 * The legacy JSON tracker file is no longer read or written here —
 * SessionExtract.ts handles the one-time JSON-to-SQLite migration + quarantine
 * on first invocation. See .atlas/specs/sqlite-native-extraction-ISA.md.
 *
 * Usage:
 *   bun run BatchExtract.ts              # Extract up to 10 un-extracted sessions
 *   bun run BatchExtract.ts --dry-run    # Show what would be extracted
 *   bun run BatchExtract.ts --limit 5    # Extract up to 5 sessions
 *   bun run BatchExtract.ts --all        # No limit (use with caution)
 *
 * Designed to run via cron every 30 minutes.
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { Database } from 'bun:sqlite';
import {
  getAllTrackerRecords,
  markAsExtracted as trackerMarkAsExtracted,
  markAsFailed as trackerMarkAsFailed,
} from './lib/extraction-tracker';
import { getDbPath } from './lib/sqlite-writers';

const CLAUDE_DIR = join(process.env.HOME!, '.claude');
const PROJECTS_DIR = join(CLAUDE_DIR, 'projects');
const MEMORY_DIR = join(CLAUDE_DIR, 'MEMORY');
const SESSION_EXTRACT = join(CLAUDE_DIR, 'hooks', 'SessionExtract.ts');

// OpenCode drop directory — plugin exports markdown sessions here
const OPENCODE_DROP_DIR = join(MEMORY_DIR, 'opencode-sessions');

// Pi drop directory — extension exports linearized markdown sessions here
const PI_DROP_DIR = join(MEMORY_DIR, 'pi-sessions');

/**
 * Resolve bun path dynamically — don't assume ~/.bun/bin
 * Cached at module level so we don't re-stat on every extraction.
 */
const BUN_PATH = (() => {
  const candidates = [
    process.argv[0],
    join(process.env.HOME!, '.bun', 'bin', 'bun'),
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
  ];
  for (const c of candidates) {
    try { if (existsSync(c)) return c; } catch {}
  }
  return 'bun';
})();

const MIN_FILE_SIZE = 2000;  // Skip tiny sessions (<2KB = likely just greetings)
const GROWTH_THRESHOLD = 0.5; // Re-extract if file grew >50%
const DEFAULT_LIMIT = 10;     // Max extractions per run (cost control)
const COOLDOWN_MS = 5000;     // 5 seconds between extractions (rate limiting)

export interface TrackerEntry {
  size: number;
  extractedAt?: string;
  failedAt?: string;
  retryAfter?: string;
}

export type Tracker = Record<string, TrackerEntry>;

// Parse args (top-level so main() and re-entrant tests share)
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const allMode = args.includes('--all');
const limitIdx = args.indexOf('--limit');
const limit = allMode ? Infinity : (limitIdx >= 0 ? parseInt(args[limitIdx + 1]) || DEFAULT_LIMIT : DEFAULT_LIMIT);

export function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

/**
 * Returns true if the SQLite DB exists and has the extraction_tracker table.
 * Used as a precondition gate — if missing, BatchExtract degrades to a
 * "nothing to do" run rather than throwing.
 */
export function hasExtractionTracker(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false;
  let db: Database | null = null;
  try {
    db = new Database(dbPath);
    const row = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='extraction_tracker'")
      .get();
    return !!row;
  } catch {
    return false;
  } finally {
    try { db?.close(); } catch {}
  }
}

/**
 * Load the SQLite-backed tracker into a path-keyed map.
 * Returns {} (with a log line) if the DB is missing or the
 * extraction_tracker table doesn't exist (pre-migration install).
 */
export function loadTracker(dbPath: string = getDbPath()): Tracker {
  const tracker: Tracker = {};
  if (!existsSync(dbPath)) {
    log(`SQLite DB not found at ${dbPath}; treating tracker as empty`);
    return tracker;
  }
  if (!hasExtractionTracker(dbPath)) {
    log(`extraction_tracker table missing in ${dbPath}; treating tracker as empty (pre-migration install?)`);
    return tracker;
  }
  try {
    const rows = getAllTrackerRecords(dbPath);
    for (const r of rows) {
      tracker[r.conversation_path] = {
        size: r.size,
        extractedAt: r.extracted_at ?? undefined,
        failedAt: r.failed_at ?? undefined,
        retryAfter: r.retry_after ?? undefined,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`WARN: failed to read extraction_tracker (${msg.slice(0, 160)}); treating tracker as empty`);
  }
  return tracker;
}

/**
 * Persist a successful extraction. Best-effort: never throws.
 */
export function recordSuccess(dbPath: string, convPath: string, size: number): boolean {
  try {
    trackerMarkAsExtracted(dbPath, convPath, size);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`WARN: failed to mark extracted in SQLite for ${convPath}: ${msg.slice(0, 160)}`);
    return false;
  }
}

/**
 * Persist a failed extraction with a 24h retry window. Best-effort: never throws.
 */
export function recordFailure(dbPath: string, convPath: string, size: number, error?: string): boolean {
  try {
    trackerMarkAsFailed(dbPath, convPath, size, error);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`WARN: failed to mark failed in SQLite for ${convPath}: ${msg.slice(0, 160)}`);
    return false;
  }
}

/**
 * Find all JSONL conversation files across all project directories
 */
export function findAllConversations(): { path: string; size: number; project: string; mtime: number }[] {
  const conversations: { path: string; size: number; project: string; mtime: number }[] = [];

  if (!existsSync(PROJECTS_DIR)) {
    log('ERROR: Projects directory not found');
    return conversations;
  }

  const projectDirs = readdirSync(PROJECTS_DIR).filter(d => {
    const fullPath = join(PROJECTS_DIR, d);
    try { return statSync(fullPath).isDirectory(); } catch { return false; }
  });

  for (const dir of projectDirs) {
    const projectPath = join(PROJECTS_DIR, dir);
    try {
      const files = readdirSync(projectPath)
        .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));

      for (const file of files) {
        const fullPath = join(projectPath, file);
        try {
          const stat = statSync(fullPath);
          conversations.push({
            path: fullPath,
            size: stat.size,
            project: dir,
            mtime: stat.mtimeMs
          });
        } catch {}
      }
    } catch {}
  }

  return conversations;
}

/**
 * Find markdown session files in a drop directory for a given platform
 */
export function findMarkdownSessions(dir: string, project: string): { path: string; size: number; project: string; mtime: number }[] {
  const sessions: { path: string; size: number; project: string; mtime: number }[] = [];

  if (!existsSync(dir)) return sessions;

  try {
    const files = readdirSync(dir)
      .filter(f => f.endsWith('.md') && !f.startsWith('.'));

    for (const file of files) {
      const fullPath = join(dir, file);
      try {
        const stat = statSync(fullPath);
        sessions.push({ path: fullPath, size: stat.size, project, mtime: stat.mtimeMs });
      } catch {}
    }
  } catch {}

  return sessions;
}

/**
 * Determine which conversations need extraction
 */
export function findCandidates(
  conversations: { path: string; size: number; project: string; mtime: number }[],
  tracker: Tracker
): { path: string; size: number; project: string; reason: string }[] {
  const candidates: { path: string; size: number; project: string; reason: string }[] = [];

  for (const conv of conversations) {
    // Skip tiny files
    if (conv.size < MIN_FILE_SIZE) continue;

    const record = tracker[conv.path];
    if (!record) {
      candidates.push({ ...conv, reason: 'never extracted' });
      continue;
    }

    // If previously failed, check if retry window has passed (24 hours)
    if (record.failedAt && !record.extractedAt) {
      const retryTime = record.retryAfter ? new Date(record.retryAfter).getTime() : new Date(record.failedAt).getTime() + 86400000;
      if (Date.now() >= retryTime) {
        candidates.push({ ...conv, reason: `retry after previous failure at ${record.failedAt}` });
      }
      continue;
    }

    // Check for significant growth
    const growth = record.size > 0 ? (conv.size - record.size) / record.size : Infinity;
    if (growth > GROWTH_THRESHOLD) {
      candidates.push({
        ...conv,
        reason: `grew ${Math.round(growth * 100)}% (${record.size} -> ${conv.size})`
      });
    }
  }

  // Sort by size: prioritize medium files (2KB-500KB) where extraction works best
  // Very large files (>1MB) tend to fail quality gate, so process them last
  return candidates.sort((a, b) => {
    const aMed = a.size > 2000 && a.size < 500000 ? 0 : 1;
    const bMed = b.size > 2000 && b.size < 500000 ? 0 : 1;
    if (aMed !== bMed) return aMed - bMed;
    return b.size - a.size; // Within same tier, bigger first
  });
}

/**
 * Derive a CWD from the project directory name
 * Reverses the encoding: -home-user-Projects-my-project -> /home/user/Projects/my_project
 */
function projectDirToCwd(projectDir: string): string {
  // Reverse Claude Code's path encoding: -home-user-Projects-foo → /home/user/Projects/foo
  // The encoding converts / and _ to -, with a leading -
  const decoded = '/' + projectDir.replace(/^-/, '').replace(/-/g, '/');
  if (existsSync(decoded)) {
    return decoded;
  }
  // Fallback if decoded path doesn't exist
  return process.env.HOME || '/tmp';
}

/**
 * Run extraction on a single file using SessionExtract's --reextract mode
 * Returns true only if extraction actually succeeded (quality gate passed)
 *
 * Handles both JSONL (Claude Code) and markdown (OpenCode/Pi) files.
 * For markdown files, passes the content directly as a
 * pre-formatted transcript using --reextract-md flag.
 */
function extractFile(convPath: string, cwd: string): boolean {
  const isMarkdown = convPath.endsWith('.md');
  // OpenCode/Pi markdown files: pass directly with --reextract-md flag
  // Claude Code JSONL files: use existing --reextract flag
  const flag = isMarkdown ? '--reextract-md' : '--reextract';

  try {
    const result = execSync(
      `${BUN_PATH} run ${SESSION_EXTRACT} ${flag} "${convPath}" "${cwd}" 2>&1`,
      {
        encoding: 'utf-8',
        timeout: 120000, // 2 minute timeout per extraction
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env }
      }
    );
    // Check if quality gate failed
    if (result.includes('QUALITY GATE FAILED') || result.includes('All extraction methods failed')) {
      log(`  QUALITY GATE FAILED or extraction failed for ${convPath}`);
      return false;
    }
    return true;
  } catch (err: any) {
    // execSync throws on non-zero exit, but SessionExtract exits 0 even on failure
    // Check stderr/stdout for quality gate failure
    const output = err.stdout || err.stderr || err.message || '';
    if (output.includes('QUALITY GATE FAILED') || output.includes('All extraction methods failed')) {
      log(`  QUALITY GATE FAILED for ${convPath}`);
      return false;
    }
    log(`ERROR extracting ${convPath}: ${(err.message || '').slice(0, 200)}`);
    return false;
  }
}

// Main
async function main() {
  log(`=== BatchExtract starting (limit=${limit === Infinity ? 'unlimited' : limit}, dry-run=${dryRun}) ===`);

  const dbPath = getDbPath();
  const tracker = loadTracker(dbPath);
  const claudeConversations = findAllConversations();
  const opencodeConversations = findMarkdownSessions(OPENCODE_DROP_DIR, 'opencode');
  const piConversations = findMarkdownSessions(PI_DROP_DIR, 'pi');
  const conversations = [...claudeConversations, ...opencodeConversations, ...piConversations];
  log(`Found ${claudeConversations.length} Claude Code JSONL + ${opencodeConversations.length} OpenCode + ${piConversations.length} Pi markdown files`);

  const candidates = findCandidates(conversations, tracker);
  log(`${candidates.length} files need extraction (${conversations.length - candidates.length} already up-to-date)`);

  if (candidates.length === 0) {
    log('Nothing to extract. All sessions up-to-date.');
    return;
  }

  const toProcess = candidates.slice(0, limit);
  log(`Processing ${toProcess.length} of ${candidates.length} candidates (limit=${limit === Infinity ? 'unlimited' : limit})`);

  if (dryRun) {
    log('DRY RUN — would extract:');
    for (const c of toProcess) {
      const sizeKB = Math.round(c.size / 1024);
      log(`  ${c.project} | ${sizeKB}KB | ${c.reason}`);
    }
    log(`Remaining: ${candidates.length - toProcess.length} would be extracted in future runs`);
    return;
  }

  let extracted = 0;
  let failed = 0;

  for (const candidate of toProcess) {
    const sizeKB = Math.round(candidate.size / 1024);
    log(`Extracting: ${candidate.project} | ${sizeKB}KB | ${candidate.reason}`);

    // For markdown sessions (OpenCode/Pi), project is a platform name ('opencode', 'pi').
    // projectDirToCwd only works for Claude Code's encoded paths — skip it for platforms.
    const isMarkdown = candidate.path.endsWith('.md');
    const cwd = isMarkdown ? candidate.project : projectDirToCwd(candidate.project);
    const success = extractFile(candidate.path, cwd);

    if (success) {
      extracted++;
      // SessionExtract's own markAsExtracted already updates the tracker.
      // Belt-and-suspenders: stamp it again here so dedup stays consistent
      // even if the child process exited before reaching its own writer.
      recordSuccess(dbPath, candidate.path, candidate.size);
      log(`  SUCCESS: Extracted and tracked`);
    } else {
      failed++;
      recordFailure(dbPath, candidate.path, candidate.size, 'BatchExtract: quality gate or runtime failure');
      log(`  FAILED: Will retry after 24h cooldown`);
    }

    // Rate limiting cooldown between extractions
    if (extracted + failed < toProcess.length) {
      await new Promise(resolve => setTimeout(resolve, COOLDOWN_MS));
    }
  }

  log(`=== BatchExtract complete: ${extracted} extracted, ${failed} failed, ${candidates.length - toProcess.length} remaining ===`);
}

// Only auto-run when invoked as a script, not when imported as a module
// (tests import individual functions and shouldn't kick off a real scan).
if (import.meta.main) {
  main().catch(err => {
    log(`FATAL: ${err.message}`);
    process.exit(1);
  });
}
