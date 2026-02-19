#!/usr/bin/env bun
/**
 * BatchExtract.ts — Cron-friendly batch extraction of un-extracted JSONL sessions
 *
 * Scans all ~/.claude/projects/ directories for JSONL conversation files,
 * identifies those not yet extracted (or significantly grown), and runs
 * the FabricExtract pipeline on each.
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

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const CLAUDE_DIR = join(process.env.HOME!, '.claude');
const PROJECTS_DIR = join(CLAUDE_DIR, 'projects');
const MEMORY_DIR = join(CLAUDE_DIR, 'MEMORY');
const TRACKER_PATH = join(MEMORY_DIR, '.extraction_tracker.json');
const FABRIC_EXTRACT = join(CLAUDE_DIR, 'hooks', 'FabricExtract.hook.ts');
const LOG_PATH = join(MEMORY_DIR, 'batch_extract.log');

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
  // Remove leading dash, replace dashes with slashes
  // But we need to be careful: double dashes in the original become single dashes
  // The encoding is: path separators (/) become dashes, dots become dashes
  // We'll use a simpler approach: just use the home directory as fallback
  return process.env.HOME || '/tmp';
}

/**
 * Run extraction on a single file using FabricExtract's --reextract mode
 * Returns true only if extraction actually succeeded (quality gate passed)
 */
function extractFile(convPath: string, cwd: string): boolean {
  try {
    const result = execSync(
      `${process.env.HOME}/.bun/bin/bun run ${FABRIC_EXTRACT} --reextract "${convPath}" "${cwd}" 2>&1`,
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
    // execSync throws on non-zero exit, but FabricExtract exits 0 even on failure
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
  const conversations = findAllConversations();
  log(`Found ${conversations.length} total JSONL files across ${new Set(conversations.map(c => c.project)).size} projects`);

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

    const cwd = projectDirToCwd(candidate.project);
    const success = extractFile(candidate.path, cwd);

    if (success) {
      extracted++;
      // FabricExtract's markAsExtracted already updates the tracker on success
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
