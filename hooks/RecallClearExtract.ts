#!/usr/bin/env bun
/**
 * RecallClearExtract.ts — SessionStart(clear) hook for Recall
 *
 * PURPOSE:
 * When the user runs `/clear` in Claude Code, the prior session ends without
 * firing `Stop`. The old session's JSONL sits on disk un-extracted until
 * RecallBatchExtract cron runs (~30 min later). RecallClearExtract closes that gap by
 * delegating the previous session's JSONL to the existing RecallExtract
 * `--extract` child path immediately.
 *
 * TRIGGER: SessionStart (matcher: "clear")
 *
 * INPUT:  stdin JSON with { session_id, transcript_path, cwd, source }
 * OUTPUT: spawns detached `RecallExtract.ts --extract <prevJsonl> <cwd>`;
 *         parent always exits 0.
 *
 * FLOW (mimics the Stop parent at RecallExtract.ts:1322-1377):
 *   1. Read SessionStart stdin (5s timeout).
 *   2. Resolve previous JSONL via pickPreviousJsonl(PROJECTS_DIR, cwd).
 *   3. Dedup against SQLite extraction_tracker.
 *   4. Acquire extraction_locks semaphore (try/catch — degrade on
 *      pre-migration DB).
 *   5. Spawn RecallExtract --extract detached with CLAUDECODE=''.
 *   6. Parent exits 0.
 *
 * The spawned child does ALL the work (LLM, dual-write, tracker mark, lock
 * release). RecallClearExtract owns only the "find prev JSONL + capacity gate"
 * decision.
 */

import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { appendFileSync } from 'fs';
import { pickPreviousJsonl } from './lib/pick-previous-jsonl';
import { getDbPath } from './lib/sqlite-writers';
import { wasAlreadyExtracted as trackerWasAlreadyExtracted } from './lib/extraction-tracker';
import { acquireSemaphore, releaseSemaphore } from './lib/extraction-semaphore';

const PROJECTS_DIR = join(process.env.HOME!, '.claude', 'projects');
const EXTRACT_LOG = join(process.env.HOME!, '.claude', 'MEMORY', 'EXTRACT_LOG.txt');
const HOOKS_DIR = join(process.env.HOME!, '.claude', 'hooks');
const SESSION_EXTRACT_PATH = join(HOOKS_DIR, 'RecallExtract.ts');

const EXTRACTION_MAX_CONCURRENT = parseInt(
  process.env.EXTRACTION_MAX_CONCURRENT || '3',
  10
);

const STDIN_TIMEOUT_MS = 5000;

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  source?: string;
  hook_event_name?: string;
}

function logExtract(message: string): void {
  const timestamp = new Date().toISOString();
  try {
    appendFileSync(EXTRACT_LOG, `[${timestamp}] [RecallClearExtract] ${message}\n`, 'utf-8');
  } catch {
    // ignore logging errors
  }
}

function resolveBunPath(): string {
  const candidates = [
    process.argv[0], // the bun running us right now
    `${process.env.HOME}/.bun/bin/bun`,
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
  ];
  for (const c of candidates) {
    try { if (existsSync(c)) return c; } catch {}
  }
  return 'bun'; // fallback to PATH lookup
}

/**
 * Best-effort tracker check. Returns true if already extracted (skip),
 * false if extraction should proceed. On any failure (missing DB, missing
 * table) returns false — let the child path discover and degrade.
 */
function isAlreadyExtracted(convPath: string): boolean {
  try {
    const dbPath = getDbPath();
    if (!existsSync(dbPath)) return false;
    const size = statSync(convPath).size;
    return trackerWasAlreadyExtracted(dbPath, convPath, size);
  } catch {
    return false;
  }
}

async function readStdinWithTimeout(timeoutMs: number): Promise<string> {
  let input = '';
  const decoder = new TextDecoder();
  const reader = Bun.stdin.stream().getReader();
  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(() => resolve(), timeoutMs);
  });
  const readPromise = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      input += decoder.decode(value, { stream: true });
    }
  })();
  await Promise.race([readPromise, timeoutPromise]);
  return input;
}

async function main(): Promise<void> {
  let hookInput: HookInput = {};
  try {
    const raw = await readStdinWithTimeout(STDIN_TIMEOUT_MS);
    if (raw && raw.trim() !== '') {
      try {
        hookInput = JSON.parse(raw);
      } catch {
        // Malformed JSON — continue with empty input; fall through to cwd default.
      }
    }
  } catch {
    // stdin read error — continue with empty input.
  }

  const cwd = hookInput.cwd || process.cwd();

  // Resolve the previous JSONL.
  const prevPath = pickPreviousJsonl(PROJECTS_DIR, cwd);
  if (!prevPath) {
    logExtract(`NO_PREVIOUS_JSONL: cwd=${cwd}`);
    process.exit(0);
  }

  // Dedup against SQLite tracker.
  if (isAlreadyExtracted(prevPath)) {
    logExtract(`DEDUP_PARENT: ${prevPath} already extracted, skipping`);
    process.exit(0);
  }

  // Capacity gate via semaphore (also serves as per-conv lock since
  // extraction_locks PK is conversation_path). Wrap in try/catch — a
  // pre-migration DB without extraction_locks table must degrade silently.
  const dbPath = getDbPath();
  let semHeld = false;
  if (existsSync(dbPath)) {
    try {
      const got = acquireSemaphore(dbPath, prevPath, process.pid, EXTRACTION_MAX_CONCURRENT);
      if (!got) {
        logExtract(
          `SEMAPHORE_FULL: ${EXTRACTION_MAX_CONCURRENT} extractors running, skipping ${prevPath}`
        );
        process.exit(0);
      }
      semHeld = true;
    } catch (err: any) {
      logExtract(
        `SEMAPHORE_UNAVAILABLE: ${err?.message || err} — cannot safely spawn, RecallBatchExtract will catch up`
      );
      process.exit(0);
    }
  } else {
    logExtract(`NO_DB: ${dbPath} missing — skip spawn (RecallBatchExtract will catch up later)`);
    process.exit(0);
  }

  // RecallExtract.ts must exist where the installer put it.
  if (!existsSync(SESSION_EXTRACT_PATH)) {
    if (semHeld) releaseSemaphore(dbPath, prevPath);
    logExtract(`SESSION_EXTRACT_MISSING: expected ${SESSION_EXTRACT_PATH} — release slot, exit`);
    process.exit(0);
  }

  // Spawn the existing child path detached. CLAUDECODE='' so the child's
  // nested `claude -p` call doesn't recursively fire Stop hooks.
  const bunPath = resolveBunPath();
  try {
    const child = spawn(
      bunPath,
      ['run', SESSION_EXTRACT_PATH, '--extract', prevPath, cwd],
      {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, CLAUDECODE: '' },
      }
    );
    child.unref();
    logExtract(`SPAWNED: pid=${child.pid} previous=${prevPath}`);
  } catch (spawnErr: any) {
    if (semHeld) releaseSemaphore(dbPath, prevPath);
    logExtract(`SPAWN_FAILED: ${spawnErr?.message || spawnErr} — released slot`);
  }

  process.exit(0);
}

// Only auto-run when executed as a script, not when imported for testing.
// `bun run hooks/RecallClearExtract.ts` → import.meta.main === true.
if (import.meta.main) {
  main().catch((err) => {
    // Never throw past main — SessionStart hooks must not crash session start.
    try { logExtract(`UNCAUGHT: ${err?.message || err}`); } catch {}
    process.exit(0);
  });
}

// Exports for testability — these are stable surfaces tests can probe.
export {
  main as _mainForTest,
  resolveBunPath as _resolveBunPath,
  isAlreadyExtracted as _isAlreadyExtracted,
  EXTRACTION_MAX_CONCURRENT as _EXTRACTION_MAX_CONCURRENT,
};
