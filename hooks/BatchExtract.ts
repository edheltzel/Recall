#!/usr/bin/env bun
/**
 * BatchExtract.ts — Cron-friendly batch extraction of un-extracted JSONL sessions
 *
 * Scans all ~/.claude/projects/ directories for JSONL conversation files,
 * identifies those not yet extracted (or significantly grown), and runs
 * the SessionExtract pipeline on each.
 *
 * Usage:
 *   bun run BatchExtract.ts              # Extract up to 10 un-extracted sessions
 *   bun run BatchExtract.ts --dry-run    # Show what would be extracted
 *   bun run BatchExtract.ts --limit 5    # Extract up to 5 sessions
 *   bun run BatchExtract.ts --all        # No limit (use with caution)
 *
 * Designed to run via cron every 30 minutes.
 * See install instructions in the cron setup section below.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const CLAUDE_DIR = join(process.env.HOME!, '.claude');
const PROJECTS_DIR = join(CLAUDE_DIR, 'projects');
const MEMORY_DIR = join(CLAUDE_DIR, 'MEMORY');
mkdirSync(MEMORY_DIR, { recursive: true });
const TRACKER_PATH = join(MEMORY_DIR, '.extraction_tracker.json');
const SESSION_EXTRACT = join(CLAUDE_DIR, 'hooks', 'SessionExtract.ts');
const LOG_PATH = join(MEMORY_DIR, 'batch_extract.log');

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

interface ExtractionRecord {
  size: number;
  extractedAt?: string;
  failedAt?: string;
  retryAfter?: string;
}

// Parse args
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const allMode = args.includes('--all');
const limitIdx = args.indexOf('--limit');
const limit = allMode ? Infinity : (limitIdx >= 0 ? parseInt(args[limitIdx + 1]) || DEFAULT_LIMIT : DEFAULT_LIMIT);

function log(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
}

function loadTracker(): Record<string, ExtractionRecord> {
  try {
    if (existsSync(TRACKER_PATH)) {
      return JSON.parse(readFileSync(TRACKER_PATH, 'utf-8'));
    }
  } catch {}
  return {};
}

function saveTracker(tracker: Record<string, ExtractionRecord>): void {
  writeFileSync(TRACKER_PATH, JSON.stringify(tracker, null, 2), 'utf-8');
}

/**
 * Find all JSONL conversation files across all project directories
 */
function findAllConversations(): { path: string; size: number; project: string; mtime: number }[] {
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
 * Find OpenCode session markdown files dropped by the recall-extract plugin
 */
function findOpenCodeSessions(): { path: string; size: number; project: string; mtime: number }[] {
  const sessions: { path: string; size: number; project: string; mtime: number }[] = [];

  if (!existsSync(OPENCODE_DROP_DIR)) return sessions;

  try {
    const files = readdirSync(OPENCODE_DROP_DIR)
      .filter(f => f.endsWith('.md') && !f.startsWith('.'));

    for (const file of files) {
      const fullPath = join(OPENCODE_DROP_DIR, file);
      try {
        const stat = statSync(fullPath);
        sessions.push({
          path: fullPath,
          size: stat.size,
          project: 'opencode',
          mtime: stat.mtimeMs
        });
      } catch {}
    }
  } catch {}

  return sessions;
}

/**
 * Find Pi session markdown files dropped by the recall-extract extension
 */
function findPiSessions(): { path: string; size: number; project: string; mtime: number }[] {
  const sessions: { path: string; size: number; project: string; mtime: number }[] = [];

  if (!existsSync(PI_DROP_DIR)) return sessions;

  try {
    const files = readdirSync(PI_DROP_DIR)
      .filter(f => f.endsWith('.md') && !f.startsWith('.'));

    for (const file of files) {
      const fullPath = join(PI_DROP_DIR, file);
      try {
        const stat = statSync(fullPath);
        sessions.push({
          path: fullPath,
          size: stat.size,
          project: 'pi',
          mtime: stat.mtimeMs
        });
      } catch {}
    }
  } catch {}

  return sessions;
}

/**
 * Determine which conversations need extraction
 */
function findCandidates(
  conversations: { path: string; size: number; project: string; mtime: number }[],
  tracker: Record<string, ExtractionRecord>
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
    const growth = (conv.size - record.size) / record.size;
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
 * Handles both JSONL (Claude Code) and markdown (OpenCode) files.
 * For markdown files from OpenCode, passes the content directly as a
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

  const tracker = loadTracker();
  const claudeConversations = findAllConversations();
  const opencodeConversations = findOpenCodeSessions();
  const piConversations = findPiSessions();
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
      // SessionExtract's markAsExtracted already updates the tracker on success
      // But we also update here in case it didn't (belt and suspenders)
      tracker[candidate.path] = {
        size: candidate.size,
        extractedAt: new Date().toISOString()
      };
      saveTracker(tracker);
      log(`  SUCCESS: Extracted and tracked`);
    } else {
      failed++;
      // Mark as failed with 24-hour retry window
      const now = new Date();
      const retryAfter = new Date(now.getTime() + 86400000);
      tracker[candidate.path] = {
        size: candidate.size,
        failedAt: now.toISOString(),
        retryAfter: retryAfter.toISOString()
      };
      saveTracker(tracker);
      log(`  FAILED: Will retry after ${retryAfter.toISOString()}`);
    }

    // Rate limiting cooldown between extractions
    if (extracted + failed < toProcess.length) {
      await new Promise(resolve => setTimeout(resolve, COOLDOWN_MS));
    }
  }

  log(`=== BatchExtract complete: ${extracted} extracted, ${failed} failed, ${candidates.length - toProcess.length} remaining ===`);
}

main().catch(err => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
