// Subprocess coverage for the RecallInSession hook ENTRY (issue #51 P3 rework).
//
// The pure decision / extraction logic is unit-tested in insession.test.ts.
// This file exercises the previously-uncovered hook WRAPPER — the dispatch
// selection (parent main() vs `--run` child), argv parsing, and the
// parent → DB write seam — by spawning the real hook as a subprocess (mirrors
// tests/hooks/RecallStart.test.ts). The model-backed full child extraction
// (parent → cadence → spawn → child → model → extraction_sessions row) is
// covered at the bottom (issue #135) with the model replaced by a deterministic
// file-backed stub (RECALL_INSESSION_EXTRACT_STUB) so it runs in CI with no live
// backend.

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

// ─── Model-backed child extraction e2e (issue #135) ──────────────────────────
//
// The path the rest of this suite deliberately routes around: parent past
// cadence → detached spawn → the child runs the REAL runInSessionExtraction →
// a row lands in extraction_sessions. The model is replaced by a deterministic
// file-backed stub via RECALL_INSESSION_EXTRACT_STUB (production seam, #135), so
// this runs in CI with no live model and is NOT vacuous: without the stub (or a
// real backend) the child returns extraction_failed and writes no row.

const STUB_SUMMARY = 'Migrated the auth module to JWT tokens and added regression tests.';
const STUB_MARKDOWN = `## ONE SENTENCE SUMMARY
${STUB_SUMMARY}

## MAIN IDEAS
- Replaced session cookies with signed JWT access tokens
- Added a refresh-token rotation endpoint behind the auth middleware
- Covered the new token paths with regression tests in the auth suite

## DECISIONS MADE
- Use JWT over opaque tokens: stateless verification across services
`;

function getExtractionSessionRow(sessionId: string): { summary: string } | null {
  const db = new Database(dbPath);
  try {
    const row = db
      .prepare('SELECT summary FROM extraction_sessions WHERE session_id = ?')
      .get(sessionId) as { summary: string } | undefined;
    return row ?? null;
  } finally {
    db.close();
  }
}

describe('RecallInSession entry — model-backed child extraction (issue #135)', () => {
  test('parent past cadence spawns the child which extracts (stubbed model) and writes an extraction_sessions row', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'recall-insession-e2e-'));
    const stubPath = join(tmp, 'stub-extract.md');
    const convPath = join(tmp, 'e2e-child.jsonl');
    writeFileSync(stubPath, STUB_MARKDOWN);
    // Conversational content so the child's window slice is non-empty and it
    // reaches the (stubbed) model rather than short-circuiting on empty_slice.
    const transcript =
      JSON.stringify({ message: { role: 'user', content: 'Please migrate the auth module to JWT tokens.' } }) +
      '\n' +
      JSON.stringify({
        message: { role: 'assistant', content: 'Done — swapped cookies for signed JWTs and added refresh rotation plus tests.' },
      }) +
      '\n';
    writeFileSync(convPath, transcript);

    const sessionId = 'e2e-child';
    const env = {
      RECALL_INSESSION_ENABLED: '1',
      RECALL_INSESSION_TURN_CADENCE: '3',
      RECALL_INSESSION_MIN_TURNS: '3',
      RECALL_INSESSION_EXTRACT_STUB: stubPath,
    };
    const payload = JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      transcript_path: convPath,
      cwd: '/tmp/recall',
    });

    try {
      // Drive the parent past the turn cadence — the 3rd fire meets cadence and
      // spawns the detached extraction child (which inherits the stub env var).
      for (let i = 0; i < 3; i++) {
        expect(await runHook([], payload, env)).toBe(0);
      }

      // The child is detached; poll (bounded) for the row it writes (mirrors the
      // detached-spawn poll in RecallClearExtract.test.ts). The stub is instant
      // (~0.5s observed); the 3s budget stays under bun's 5s per-test timeout so
      // a genuine miss fails cleanly on the row assertion, not a timeout.
      let row = getExtractionSessionRow(sessionId);
      for (let attempts = 0; attempts < 30 && !row; attempts++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        row = getExtractionSessionRow(sessionId);
      }

      // Non-vacuous: this row exists ONLY because the stubbed model returned
      // quality-passing markdown through the full real child pipeline. Break the
      // stub seam → child falls back to the cascade → no backend in CI →
      // extraction_failed → no row → RED. Pinning summary to the stub's exact
      // sentence also fails if a real model ran instead of the stub.
      expect(row).not.toBeNull();
      expect(row!.summary).toBe(STUB_SUMMARY);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
