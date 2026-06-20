#!/usr/bin/env bun
/**
 * RecallInSession.ts — mid-session learning loop (issue #51 P3)
 *
 * PURPOSE
 * Captures memory DURING a session, not just at the end. Fires on every
 * PostToolUse + UserPromptSubmit, counts turns/tools in the durable
 * session_progress table, and — on a turn/tool cadence — extracts ONLY the
 * incremental transcript window since the last run into SQLite (reusing the
 * shared extract-core: extract → quality-gate → scrub → dualWriteToSqlite).
 *
 * OFF BY DEFAULT. The hook fires on EVERY tool call, so the disabled path must
 * be ~free: main() reads ONE env var (RECALL_INSESSION_ENABLED) and exits before
 * touching stdin, the DB, or any model. Enable with RECALL_INSESSION_ENABLED=1.
 *
 * TRIGGERS: PostToolUse (→ tool counter), UserPromptSubmit (→ turn counter)
 * INPUT (stdin JSON): { hook_event_name, session_id, transcript_path, cwd }
 * OUTPUT: nothing — non-blocking. The cheap counter+cadence check runs inline;
 * the expensive extraction is spawned as a detached child (mirrors RecallExtract).
 *
 * Self-contained per the Key Conventions: no imports from src/. The decision
 * logic lives in hooks/lib/insession.ts; the model call is reused from
 * hooks/lib/extract-model.ts (shared with the Stop hook).
 */

import { existsSync, readFileSync } from 'fs';
import { spawn } from 'child_process';
import {
  readInSessionConfig,
  eventFromHookInput,
  decideInSession,
  runInSessionExtraction,
  sessionIdFromArgs,
} from './lib/insession';
import { runExtractionCascade, extractTopics, deriveSummary } from './lib/extract-model';
import { resolveDbPath } from './lib/db-path';

const STDIN_TIMEOUT_MS = 5000;

interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: unknown;
  tool_name?: unknown;
}

/** Read stdin with a hard timeout so the hook never hangs the turn. */
async function readStdin(): Promise<string> {
  let input = '';
  try {
    const decoder = new TextDecoder();
    const reader = Bun.stdin.stream().getReader();
    const timeoutPromise = new Promise<void>((resolve) => setTimeout(() => resolve(), STDIN_TIMEOUT_MS));
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

/** Resolve the bun binary for the self-spawn (don't assume ~/.bun/bin). */
function resolveBun(): string {
  const candidates = [
    process.argv[0], // the bun running us now
    `${process.env.HOME}/.bun/bin/bun`,
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
  ];
  for (const c of candidates) {
    try {
      if (c && existsSync(c)) return c;
    } catch {}
  }
  return 'bun';
}

/** Spawn the detached extraction child so the turn is never blocked. */
function spawnChild(convPath: string, sessionId: string, cwd: string): void {
  try {
    const child = spawn(resolveBun(), ['run', import.meta.path, '--run', convPath, sessionId, cwd], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, CLAUDECODE: '' },
    });
    child.unref();
  } catch {
    // Spawn failure is non-fatal — the Stop hook still extracts at session end.
  }
}

/** Parent: OFF fast-path, then the cheap counter + cadence check; spawn on threshold. */
async function main(): Promise<void> {
  // OFF-by-default fast-path — the cheapest possible exit. Read ONE env var and
  // bail before stdin, the DB, or the model. This fires on EVERY tool call.
  const config = readInSessionConfig(process.env);
  if (!config.enabled) process.exit(0);

  const raw = await readStdin();
  if (!raw.trim()) process.exit(0);

  let input: HookInput;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const event = eventFromHookInput(input);
  if (!event) process.exit(0);

  const convPath = input.transcript_path;
  if (!convPath) process.exit(0);

  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) process.exit(0); // DB not initialized — nothing to do

  const sessionId = sessionIdFromArgs(input.session_id, convPath);

  // Cheap path: increment the counter + evaluate cadence inline (fast SQLite).
  const { run } = decideInSession(dbPath, sessionId, convPath, event, config);
  if (!run) process.exit(0);

  // At/above threshold — spawn the heavy extraction async (never blocks the turn).
  const cwd = input.cwd || process.cwd();
  spawnChild(convPath, sessionId, cwd);
  process.exit(0);
}

/** Child (--run): run the incremental extraction over the window. */
async function runChild(): Promise<void> {
  const config = readInSessionConfig(process.env);
  if (!config.enabled) process.exit(0); // defensive — flag could flip between fires

  const idx = process.argv.indexOf('--run');
  const convPath = process.argv[idx + 1];
  const sessionId = process.argv[idx + 2];
  const cwd = process.argv[idx + 3] || process.cwd();
  if (!convPath || !sessionId) process.exit(0);

  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) process.exit(0);

  const sessionLabel = cwd.split('/').pop() || 'unknown';

  await runInSessionExtraction(
    dbPath,
    { sessionId, convPath, sessionLabel, project: sessionLabel },
    {
      pid: process.pid,
      readTranscript: (p) => {
        try {
          return readFileSync(p, 'utf-8');
        } catch {
          return null;
        }
      },
      extract: runExtractionCascade,
      deriveMeta: (text) => ({
        topics: extractTopics(text),
        summary: deriveSummary(text, sessionLabel),
      }),
      timestamp: new Date().toISOString().split('T')[0],
    }
  );
  process.exit(0);
}

// Dispatch: `--run` is the detached extraction child; any other invocation is
// the hook parent. main() runs UNCONDITIONALLY in the else branch — no
// `argv[1].endsWith('RecallInSession.ts')` guard — so a symlinked or
// canonical-path invocation (the hook is installed as a symlink) can't silently
// turn the hook into a no-op. Mirrors RecallExtract.ts's self-identification.
if (process.argv.includes('--run')) {
  runChild().catch(() => process.exit(0));
} else {
  main().catch(() => process.exit(0));
}
