// Tests for the in-session learning loop decision logic (hooks/lib/insession.ts,
// issue #51 P3). All logic is pure or dbPath-injectable, so these run against a
// temp DB without spawning the real hook or the claude CLI (the model call is
// injected via deps). Each test is MUTATION-GUARDED — the comment names the
// neutering mutation that turns it RED (verified during development).

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import {
  readInSessionConfig,
  shouldRun,
  sliceTranscript,
  eventFromHookInput,
  decideInSession,
  runInSessionExtraction,
  type InSessionConfig,
} from '../../hooks/lib/insession';
import {
  ensureSession,
  getSessionProgress,
  incrementRuns,
} from '../../hooks/lib/session-progress';
import { childAcquireLock } from '../../hooks/lib/extraction-lock';

// A clearly-fake Anthropic key matching P0's `anthropic-key` pattern. Not real.
const SECRET = 'sk-ant-FAKEKEYFORTESTINGONLY0000000000000000';

// Default config knobs used across the cadence tests.
const CFG: InSessionConfig = {
  enabled: true,
  turnCadence: 10,
  toolCadence: 15,
  maxRuns: 20,
  minTurns: 3,
};

// An extraction-model output that clears the quality gate (mirrors the
// extract-core fixtures). deps.extract returns this regardless of the slice.
const CLEAN_FIXTURE = `## ONE SENTENCE SUMMARY
We wired the in-session learning loop to the shared extract-core pipeline.

## MAIN IDEAS
- Hooks fire as stateless processes so counters live in session_progress
- The incremental cursor only advances so windows never overlap
- The disabled fast-path exits before touching the database

## DECISIONS MADE
- Reuse runExtractCore for the slice (confidence: HIGH)
- Cooperate with the Stop lock to avoid double extraction (confidence: HIGH)

## ERRORS FIXED
- Double extraction risk: cooperate with the per-conversation lock

## SESSION CONTEXT
A mid-session capture wired onto the shared SQLite write path.`;

// Build a Claude Code transcript JSONL line.
function line(role: 'user' | 'assistant', body: string): string {
  return JSON.stringify({ message: { role, content: body } });
}

let dbPath: string;

beforeEach(() => {
  dbPath = setupTestDb();
});

afterEach(() => {
  teardownTestDb();
});

// ─── readInSessionConfig ─────────────────────────────────────────────────────

describe('readInSessionConfig', () => {
  test('OFF by default, with the design defaults', () => {
    const c = readInSessionConfig({});
    // Mutation — default `enabled` to true → RED.
    expect(c.enabled).toBe(false);
    expect(c.turnCadence).toBe(10);
    expect(c.toolCadence).toBe(15);
    expect(c.maxRuns).toBe(20);
    expect(c.minTurns).toBe(3);
  });

  test('enabled only when the flag is exactly "1"; overrides parse', () => {
    expect(readInSessionConfig({ RECALL_INSESSION_ENABLED: '1' }).enabled).toBe(true);
    expect(readInSessionConfig({ RECALL_INSESSION_ENABLED: 'true' }).enabled).toBe(false);
    expect(readInSessionConfig({ RECALL_INSESSION_ENABLED: '0' }).enabled).toBe(false);
    const c = readInSessionConfig({
      RECALL_INSESSION_TURN_CADENCE: '4',
      RECALL_INSESSION_TOOL_CADENCE: '7',
      RECALL_INSESSION_MAX_RUNS: '2',
      RECALL_INSESSION_MIN_TURNS: '1',
    });
    expect([c.turnCadence, c.toolCadence, c.maxRuns, c.minTurns]).toEqual([4, 7, 2, 1]);
  });
});

// ─── shouldRun (cadence + floor + budget, design §3.1) ───────────────────────

describe('shouldRun — cadence / floor / budget', () => {
  test('below both cadences → no run', () => {
    expect(shouldRun({ turns_seen: 9, tools_seen: 14, runs_this_session: 0 }, CFG)).toBe(false);
  });

  test('turn cadence alone fires (OR — turn arm)', () => {
    // turns hit cadence, tools at 0. Mutation — flip OR to AND → false → RED.
    expect(shouldRun({ turns_seen: 10, tools_seen: 0, runs_this_session: 0 }, CFG)).toBe(true);
  });

  test('tool cadence alone fires when the floor is met (OR — tool arm)', () => {
    // tools hit cadence, turns >= minTurns. Mutation — flip OR to AND → false → RED.
    expect(shouldRun({ turns_seen: 3, tools_seen: 15, runs_this_session: 0 }, CFG)).toBe(true);
  });

  test('MIN_TURNS floor blocks a tool-only burst with too few turns', () => {
    // tools cadence met but turns (2) below the floor (3).
    // Mutation — drop the floor check → true → RED.
    expect(shouldRun({ turns_seen: 2, tools_seen: 15, runs_this_session: 0 }, CFG)).toBe(false);
  });

  test('MAX_RUNS budget caps further runs', () => {
    // cadence + floor met, but the budget is spent.
    // Mutation — drop the budget check → true → RED.
    expect(shouldRun({ turns_seen: 10, tools_seen: 0, runs_this_session: 20 }, CFG)).toBe(false);
    expect(shouldRun({ turns_seen: 10, tools_seen: 0, runs_this_session: 19 }, CFG)).toBe(true);
  });
});

// ─── eventFromHookInput ──────────────────────────────────────────────────────

describe('eventFromHookInput', () => {
  test('maps the two registered events to the right counter', () => {
    // Mutation — swap the turn/tool mapping → RED.
    expect(eventFromHookInput({ hook_event_name: 'UserPromptSubmit' })).toBe('turn');
    expect(eventFromHookInput({ hook_event_name: 'PostToolUse' })).toBe('tool');
  });

  test('falls back to payload shape, and rejects unknown events', () => {
    expect(eventFromHookInput({ prompt: 'hi' })).toBe('turn');
    expect(eventFromHookInput({ tool_name: 'Bash' })).toBe('tool');
    expect(eventFromHookInput({ hook_event_name: 'Stop' })).toBeNull();
    expect(eventFromHookInput({})).toBeNull();
  });
});

// ─── decideInSession — OFF default + counter increment (temp DB) ──────────────

describe('decideInSession — OFF by default', () => {
  test('disabled → no run, and NO DB row is created', () => {
    const off: InSessionConfig = { ...CFG, enabled: false };
    const result = decideInSession(dbPath, 'sess-off', '/tmp/c.jsonl', 'turn', off);
    expect(result.run).toBe(false);
    // The load-bearing OFF guarantee: nothing touched the DB.
    // Mutation — remove the `if (!config.enabled)` guard → a row is created and
    // the counter increments → this assertion goes RED.
    expect(getSessionProgress(dbPath, 'sess-off')).toBeNull();
  });
});

describe('decideInSession — counter increment + threshold', () => {
  test('UserPromptSubmit increments turns; PostToolUse increments tools', () => {
    decideInSession(dbPath, 'sess-c', '/tmp/c.jsonl', 'turn', CFG);
    let p = getSessionProgress(dbPath, 'sess-c')!;
    // Mutation — increment the wrong counter → RED.
    expect(p.turns_seen).toBe(1);
    expect(p.tools_seen).toBe(0);

    decideInSession(dbPath, 'sess-c', '/tmp/c.jsonl', 'tool', CFG);
    p = getSessionProgress(dbPath, 'sess-c')!;
    expect(p.turns_seen).toBe(1);
    expect(p.tools_seen).toBe(1);
  });

  test('crossing the turn cadence flips run=true exactly at the threshold', () => {
    let result = { run: false } as { run: boolean };
    for (let i = 0; i < 9; i++) {
      result = decideInSession(dbPath, 'sess-t', '/tmp/c.jsonl', 'turn', CFG);
    }
    expect(result.run).toBe(false); // 9 turns < cadence 10
    result = decideInSession(dbPath, 'sess-t', '/tmp/c.jsonl', 'turn', CFG);
    expect(result.run).toBe(true); // 10th turn meets cadence
  });
});

// ─── sliceTranscript — incremental window (design §3.2) ──────────────────────

describe('sliceTranscript — reads only the window since last_offset', () => {
  test('a non-zero offset returns ONLY the delta; the cursor is the full length', () => {
    const a = line('user', 'ALPHA first user message with plenty of length here');
    const b = line('assistant', 'BETA assistant reply also sufficiently long to keep');
    const full = a + '\n' + b + '\n';

    const whole = sliceTranscript(full, 0);
    expect(whole.text).toContain('ALPHA');
    expect(whole.text).toContain('BETA');
    expect(whole.newOffset).toBe(full.length);

    // Slice from just past the first line — only BETA should remain.
    // Mutation — read the whole file instead of slicing from lastOffset → the
    // delta contains ALPHA → RED.
    const delta = sliceTranscript(full, (a + '\n').length);
    expect(delta.text).toContain('BETA');
    expect(delta.text).not.toContain('ALPHA');
  });

  test('offset at/after EOF yields an empty slice (nothing new to extract)', () => {
    const a = line('user', 'only message here long enough to count as content');
    const full = a + '\n';
    expect(sliceTranscript(full, full.length).text).toBe('');
  });
});

// ─── runInSessionExtraction — lock cooperation, window advance, scrub ─────────

interface SpyDeps {
  calls: string[];
  pid?: number;
}

function makeDeps(spy: SpyDeps, fixture: string = CLEAN_FIXTURE, full: string = '') {
  return {
    pid: spy.pid ?? process.pid,
    readTranscript: () => full,
    extract: async (input: string) => {
      spy.calls.push(input);
      return fixture;
    },
    deriveMeta: (extracted: string) => {
      const m = extracted.match(/##\s*ONE\s*SENTENCE\s*SUMMARY\s*\n+(.+)/);
      return { topics: ['insession'], summary: m ? m[1].trim() : 'insession session' };
    },
    timestamp: '2026-06-20',
  };
}

function countRows(table: string): number {
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  try {
    return (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
  } finally {
    db.close();
  }
}

describe('runInSessionExtraction — lock cooperation with the Stop hook', () => {
  test('if the conversation lock is already held, the run skips (no extraction)', async () => {
    const convPath = '/tmp/locked.jsonl';
    ensureSession(dbPath, 'sess-lock', convPath);

    // Simulate the Stop hook holding the per-conversation lock.
    expect(childAcquireLock(dbPath, convPath, 999999)).toBe(true);

    const spy: SpyDeps = { calls: [] };
    const full = line('user', 'a message that would otherwise be extracted here') + '\n';
    const result = await runInSessionExtraction(
      dbPath,
      { sessionId: 'sess-lock', convPath, sessionLabel: 'demo', project: 'demo' },
      makeDeps(spy, CLEAN_FIXTURE, full)
    );

    // Mutation — ignore the lock and extract anyway → calls.length === 1 and
    // outcome 'extracted' → both assertions RED.
    expect(result.outcome).toBe('lock_busy');
    expect(spy.calls.length).toBe(0);
    expect(countRows('extraction_sessions')).toBe(0);
  });
});

describe('runInSessionExtraction — incremental window advances the cursor', () => {
  test('run 1 extracts the window and advances last_offset + runs_this_session', async () => {
    const convPath = '/tmp/win.jsonl';
    ensureSession(dbPath, 'sess-win', convPath);

    const a = line('user', 'ALPHA first message long enough to survive the filter');
    const b = line('assistant', 'BETA reply that is also nice and long for the gate');
    const full1 = a + '\n' + b + '\n';

    const spy: SpyDeps = { calls: [] };
    const r1 = await runInSessionExtraction(
      dbPath,
      { sessionId: 'sess-win', convPath, sessionLabel: 'demo', project: 'demo' },
      makeDeps(spy, CLEAN_FIXTURE, full1)
    );

    expect(r1.outcome).toBe('extracted');
    expect(spy.calls.length).toBe(1);
    const p = getSessionProgress(dbPath, 'sess-win')!;
    // Mutation — never advance the cursor → last_offset stays 0 → RED.
    expect(p.last_offset).toBe(full1.length);
    // Mutation — never count the run → runs_this_session stays 0 → RED.
    expect(p.runs_this_session).toBe(1);
    // Window counters reset after a run.
    expect(p.turns_seen).toBe(0);
    expect(p.tools_seen).toBe(0);
  });

  test('run 2 extracts ONLY the newly-appended window, never the prior slice', async () => {
    const convPath = '/tmp/win2.jsonl';
    ensureSession(dbPath, 'sess-win2', convPath);

    const a = line('user', 'ALPHA first message long enough to survive the filter');
    const full1 = a + '\n';

    const spy: SpyDeps = { calls: [] };
    await runInSessionExtraction(
      dbPath,
      { sessionId: 'sess-win2', convPath, sessionLabel: 'demo', project: 'demo' },
      makeDeps(spy, CLEAN_FIXTURE, full1)
    );

    // Append a new message; re-run over the GROWN transcript.
    const c = line('assistant', 'GAMMA brand new message appended after the first run');
    const full2 = full1 + c + '\n';
    const r2 = await runInSessionExtraction(
      dbPath,
      { sessionId: 'sess-win2', convPath, sessionLabel: 'demo', project: 'demo' },
      makeDeps(spy, CLEAN_FIXTURE, full2)
    );

    expect(r2.outcome).toBe('extracted');
    expect(spy.calls.length).toBe(2);
    // The second extraction saw only the delta. Mutation — read whole file /
    // don't advance the cursor → calls[1] contains ALPHA → RED.
    expect(spy.calls[1]).toContain('GAMMA');
    expect(spy.calls[1]).not.toContain('ALPHA');
  });

  test('no new content since the cursor → empty_slice, the model is not called', async () => {
    const convPath = '/tmp/win3.jsonl';
    ensureSession(dbPath, 'sess-win3', convPath);
    const a = line('user', 'ALPHA only message long enough to be counted as content');
    const full = a + '\n';

    const spy: SpyDeps = { calls: [] };
    await runInSessionExtraction(
      dbPath,
      { sessionId: 'sess-win3', convPath, sessionLabel: 'demo', project: 'demo' },
      makeDeps(spy, CLEAN_FIXTURE, full)
    );
    // Re-run with the SAME content — cursor is already at EOF.
    const r2 = await runInSessionExtraction(
      dbPath,
      { sessionId: 'sess-win3', convPath, sessionLabel: 'demo', project: 'demo' },
      makeDeps(spy, CLEAN_FIXTURE, full)
    );
    expect(r2.outcome).toBe('empty_slice');
    expect(spy.calls.length).toBe(1); // still just the first run
  });
});

describe('runInSessionExtraction — scrub is inherited from the shared core', () => {
  test('a planted secret in the sliced extract never persists as cleartext', async () => {
    const convPath = '/tmp/secret.jsonl';
    ensureSession(dbPath, 'sess-secret', convPath);

    // The model "extracts" a secret from the window; runExtractCore must scrub it.
    const fixture = `## ONE SENTENCE SUMMARY
During the in-session capture we noticed the key ${SECRET} had leaked into the working notes before rotation.

## MAIN IDEAS
- The token ${SECRET} was pasted into a debug log during local testing today
- Secrets pulled into a mid-session extract must be redacted before persistence
- Keep the in-session hook self-contained and never import from the source tree

## DECISIONS MADE
- Rotate ${SECRET} immediately and route writes through the scrub guard (confidence: HIGH)

## ERRORS FIXED
- Credential exposure during setup: replaced ${SECRET} with a vault reference`;

    const spy: SpyDeps = { calls: [] };
    const full = line('user', 'please capture the configuration discussion from this window') + '\n';
    const result = await runInSessionExtraction(
      dbPath,
      { sessionId: 'sess-secret', convPath, sessionLabel: 'demo', project: 'demo' },
      makeDeps(spy, fixture, full)
    );

    expect(result.outcome).toBe('extracted');
    expect(result.redactions).toContain('anthropic-key');

    // The load-bearing regression check: P3 did not bypass the core's scrub.
    // Mutation — route the slice around runExtractCore (skip scrub) → cleartext
    // persists → RED.
    const db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    const rows: string[] = [];
    const push = (sql: string) => {
      for (const r of db.prepare(sql).all() as Record<string, unknown>[]) {
        rows.push(Object.values(r).map((v) => (v == null ? '' : String(v))).join(' '));
      }
    };
    push('SELECT summary, topics FROM extraction_sessions');
    push('SELECT decision FROM decisions');
    push('SELECT problem, solution FROM learnings');
    push('SELECT title, description, fabric_extract, tags FROM loa_entries');
    db.close();
    const persisted = rows.join('\n');

    expect(persisted).not.toContain(SECRET);
    expect(persisted).toContain('[REDACTED:anthropic-key]');
  });
});

// ─── Budget guard end-to-end (counter + cadence agree) ───────────────────────

describe('decideInSession — budget guard stops runs once spent', () => {
  test('with the budget exhausted, a cadence-met window still returns run=false', () => {
    ensureSession(dbPath, 'sess-bud', '/tmp/c.jsonl');
    for (let i = 0; i < CFG.maxRuns; i++) incrementRuns(dbPath, 'sess-bud');
    // Drive turns over the cadence.
    let result = { run: false } as { run: boolean };
    for (let i = 0; i < CFG.turnCadence; i++) {
      result = decideInSession(dbPath, 'sess-bud', '/tmp/c.jsonl', 'turn', CFG);
    }
    // Cadence + floor met, but the budget is spent.
    // Mutation — drop the budget check in shouldRun → run flips true → RED.
    expect(result.run).toBe(false);
  });
});
