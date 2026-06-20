// Subprocess coverage for the RecallInSession hook ENTRY (issue #51 P3 rework).
//
// The pure decision / extraction logic is unit-tested in insession.test.ts.
// This file exercises the previously-uncovered hook WRAPPER — the dispatch
// selection (parent main() vs `--run` child), argv parsing, and the
// parent → DB write seam — by spawning the real hook as a subprocess (mirrors
// tests/hooks/RecallStart.test.ts). The model-backed full child extraction
// (spawn → child → real model → row) needs a live model and is scoped to
// follow-up issue #135.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { ensureSession, getSessionProgress } from '../../hooks/lib/session-progress';

const HOOK = join(import.meta.dir, '..', '..', 'hooks', 'RecallInSession.ts');

let dbPath: string;

beforeEach(() => {
  dbPath = setupTestDb();
});

afterEach(() => {
  teardownTestDb();
});

/** Spawn the real hook script as a subprocess and await its exit. */
async function runHook(
  args: string[],
  stdin: string | null,
  env: Record<string, string>
): Promise<number> {
  const proc = Bun.spawn(['bun', 'run', HOOK, ...args], {
    env: { ...process.env, RECALL_DB_PATH: dbPath, ...env },
    stdin: stdin == null ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (stdin != null) {
    proc.stdin!.write(stdin);
    proc.stdin!.end();
  }
  return proc.exited;
}

// ─── Parent dispatch (M2 robustness + M1 parent seam) ────────────────────────

describe('RecallInSession entry — parent dispatch', () => {
  test('a plain `bun run <hook>` invocation runs main() and writes the counter', async () => {
    const payload = JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sub-parent',
      transcript_path: '/tmp/sub-parent.jsonl',
      cwd: '/tmp',
    });
    const code = await runHook([], payload, { RECALL_INSESSION_ENABLED: '1' });
    expect(code).toBe(0);
    // The real hook reached decideInSession and incremented the turn counter —
    // proving the dispatch is NOT a silent no-op (M2) and the parent seam works.
    const p = getSessionProgress(dbPath, 'sub-parent');
    expect(p?.turns_seen).toBe(1);
    expect(p?.tools_seen).toBe(0);
  });

  test('OFF by default — disabled hook writes nothing and exits 0', async () => {
    const payload = JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sub-off',
      transcript_path: '/tmp/sub-off.jsonl',
      cwd: '/tmp',
    });
    const code = await runHook([], payload, { RECALL_INSESSION_ENABLED: '0' });
    expect(code).toBe(0);
    expect(getSessionProgress(dbPath, 'sub-off')).toBeNull();
  });
});

// ─── Child dispatch (M1 — the seam H1 lives in) ──────────────────────────────

describe('RecallInSession entry — child (--run) dispatch', () => {
  test('--run selects the child path, parses argv, and runs the window over a real DB', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'recall-insession-'));
    const convPath = join(tmp, 'sub-child.jsonl');
    // New bytes, but every line is filtered (too short / non-conversational) so
    // the slice is empty → empty_slice → no model call, cursor advances. This
    // keeps the child path deterministic without a live model.
    const transcript = JSON.stringify({ message: { role: 'user', content: 'hi' } }) + '\n';
    writeFileSync(convPath, transcript);
    ensureSession(dbPath, 'sub-child', convPath);
    try {
      const code = await runHook(['--run', convPath, 'sub-child', '/tmp'], null, {
        RECALL_INSESSION_ENABLED: '1',
      });
      expect(code).toBe(0);
      // The child entry ran end-to-end (argv parse → runInSessionExtraction →
      // empty_slice → advanceOffset) without the model. Mutation — break the
      // `--run` dispatch or the argv parse → the cursor never advances → RED.
      expect(getSessionProgress(dbPath, 'sub-child')?.last_offset).toBe(transcript.length);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── #52 corrections wiring — flag independence + fast-path ──────────────────

function countCorrections(): number {
  const db = new Database(dbPath);
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM learnings WHERE category = 'correction'")
      .get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

describe('RecallInSession entry — corrections (issue #52)', () => {
  test('corrections capture with in-session DISABLED (the flags are independent)', async () => {
    const payload = JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sub-corr',
      transcript_path: '/tmp/sub-corr.jsonl',
      cwd: '/tmp/recall',
      prompt: "that's wrong, use the cache instead",
    });
    // in-session OFF, corrections ON — the fast-path must still proceed.
    const code = await runHook([], payload, {
      RECALL_INSESSION_ENABLED: '0',
      RECALL_CORRECTIONS_ENABLED: '1',
    });
    expect(code).toBe(0);
    // Mutation: gate corrections behind RECALL_INSESSION_ENABLED → no write → RED.
    expect(countCorrections()).toBe(1);
  });

  test('OFF by default — both flags off writes nothing', async () => {
    const payload = JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sub-corr-off',
      transcript_path: '/tmp/sub-corr-off.jsonl',
      cwd: '/tmp/recall',
      prompt: "that's wrong, use the cache instead",
    });
    const code = await runHook([], payload, {
      RECALL_INSESSION_ENABLED: '0',
      RECALL_CORRECTIONS_ENABLED: '0',
    });
    expect(code).toBe(0);
    expect(countCorrections()).toBe(0);
    expect(getSessionProgress(dbPath, 'sub-corr-off')).toBeNull();
  });

  test('a non-correction prompt with corrections ON writes nothing', async () => {
    const payload = JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sub-corr-plain',
      transcript_path: '/tmp/sub-corr-plain.jsonl',
      cwd: '/tmp/recall',
      prompt: 'please add a test for the parser',
    });
    const code = await runHook([], payload, {
      RECALL_INSESSION_ENABLED: '0',
      RECALL_CORRECTIONS_ENABLED: '1',
    });
    expect(code).toBe(0);
    expect(countCorrections()).toBe(0);
    // The prompt counter still advanced (so the rate-limit gap is real).
    expect(getSessionProgress(dbPath, 'sub-corr-plain')?.prompts_seen).toBe(1);
  });
});
