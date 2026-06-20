// Coverage for the #52 correction handler + rate-limit (issue #52 P5).
//
// handleCorrection is dbPath-injectable, so this exercises the real write path
// against a temp DB without spawning the hook. The brief's load-bearing guards
// are all here: scrub-before-write, the high-confidence write shape, the 1-per-3
// rate-limit that SURVIVES a resetWindow, off-by-default, and flag independence.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { resetWindow, getSessionProgress } from '../../hooks/lib/session-progress';
import {
  handleCorrection,
  correctionAllowed,
  readCorrectionsConfig,
} from '../../hooks/lib/insession';

let dbPath: string;
const SID = 'corr-session';
const CONV = '/tmp/corr.jsonl';
const PROJ = 'recall';

const ENABLED = readCorrectionsConfig({ RECALL_CORRECTIONS_ENABLED: '1' });
const DISABLED = readCorrectionsConfig({});

// A message that always classifies as a correction (strong pattern).
const CORRECTION = "that's wrong, use the cache instead";

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

function correctionRows(): any[] {
  const db = new Database(dbPath);
  try {
    return db
      .prepare("SELECT problem, confidence, importance, category, project, session_id FROM learnings WHERE category = 'correction'")
      .all() as any[];
  } finally {
    db.close();
  }
}

beforeEach(() => {
  dbPath = setupTestDb();
});

afterEach(() => {
  teardownTestDb();
});

describe('correctionAllowed (pure rate-limit predicate)', () => {
  test('first correction (no prior save) is always allowed', () => {
    expect(correctionAllowed({ prompts_seen: 5, last_correction_turn: 0 })).toBe(true);
  });

  test('blocks until the monotonic gap reaches minGap, then allows', () => {
    expect(correctionAllowed({ prompts_seen: 1, last_correction_turn: 1 })).toBe(false); // gap 0
    expect(correctionAllowed({ prompts_seen: 3, last_correction_turn: 1 })).toBe(false); // gap 2
    expect(correctionAllowed({ prompts_seen: 4, last_correction_turn: 1 })).toBe(true); // gap 3
  });
});

describe('handleCorrection — rate limit survives the window reset', () => {
  test('at most 1 save per 3 prompts, and a resetWindow never re-opens the gate', () => {
    // prompt 1 — first correction always saves.
    expect(handleCorrection(dbPath, SID, CONV, CORRECTION, PROJ, ENABLED).outcome).toBe('saved');
    expect(countCorrections()).toBe(1);

    // A cadence run zeroes the per-window counters MID-STREAM. The monotonic
    // prompts_seen / last_correction_turn are untouched, so the gap stands.
    resetWindow(dbPath, SID);

    // prompt 2 — only 1 prompt since the save → blocked even though turns_seen=0.
    // Mutation: gate on the resetting turns_seen → the reset re-opens the gate → RED.
    expect(handleCorrection(dbPath, SID, CONV, CORRECTION, PROJ, ENABLED).outcome).toBe('rate_limited');
    // prompt 3 — gap still 2 → blocked.
    expect(handleCorrection(dbPath, SID, CONV, CORRECTION, PROJ, ENABLED).outcome).toBe('rate_limited');
    expect(countCorrections()).toBe(1);

    // Another reset just before the gap completes — must not change the outcome.
    resetWindow(dbPath, SID);

    // prompt 4 — gap is now 3 → allowed again (this also catches an over-block
    // mutation that uses the zeroed turns_seen, which would keep blocking here).
    expect(handleCorrection(dbPath, SID, CONV, CORRECTION, PROJ, ENABLED).outcome).toBe('saved');
    expect(countCorrections()).toBe(2);

    // The marker advanced to the prompt at which we just saved (4).
    expect(getSessionProgress(dbPath, SID)!.last_correction_turn).toBe(4);
  });

  test('non-corrections still advance the monotonic prompt counter (the gap is real-prompts)', () => {
    handleCorrection(dbPath, SID, CONV, CORRECTION, PROJ, ENABLED); // save @1
    handleCorrection(dbPath, SID, CONV, 'please add a test for the parser', PROJ, ENABLED); // not a correction @2
    handleCorrection(dbPath, SID, CONV, 'thanks, looks good', PROJ, ENABLED); // not a correction @3
    // prompt 4 is a correction; gap = 4 - 1 = 3 → allowed.
    expect(handleCorrection(dbPath, SID, CONV, CORRECTION, PROJ, ENABLED).outcome).toBe('saved');
    expect(countCorrections()).toBe(2);
    expect(getSessionProgress(dbPath, SID)!.prompts_seen).toBe(4);
  });
});

describe('handleCorrection — scrub before write (load-bearing)', () => {
  test('a secret pasted into a correction never persists as cleartext', () => {
    const secret = 'sk-ant-api03-' + 'A'.repeat(40);
    const text = `no, use ${secret} instead`;
    const res = handleCorrection(dbPath, SID, CONV, text, PROJ, ENABLED);
    expect(res.saved).toBe(true);

    const rows = correctionRows();
    expect(rows.length).toBe(1);
    const stored = rows[0].problem as string;
    // Mutation: bypass scrub() (write the raw promptText) → the key persists → RED.
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain('A'.repeat(40));
    expect(stored).toContain('[REDACTED:anthropic-key]');
    expect(res.redactions).toContain('anthropic-key');
  });
});

describe('handleCorrection — write shape', () => {
  test('row is confidence:high, importance:8, category:correction, project-scoped', () => {
    handleCorrection(dbPath, SID, CONV, CORRECTION, PROJ, ENABLED);
    const row = correctionRows()[0];
    // Mutation: hardcode confidence:'medium' → RED. Drop importance:8 → RED.
    expect(row.confidence).toBe('high');
    expect(row.importance).toBe(8);
    expect(row.category).toBe('correction');
    expect(row.project).toBe(PROJ);
    expect(row.session_id).toBe(SID);
  });
});

describe('handleCorrection — off by default', () => {
  test('disabled config writes nothing and never touches session_progress', () => {
    const res = handleCorrection(dbPath, SID, CONV, CORRECTION, PROJ, DISABLED);
    // Mutation: run the handler when disabled → a row is written → RED.
    expect(res.outcome).toBe('disabled');
    expect(res.saved).toBe(false);
    expect(countCorrections()).toBe(0);
    expect(getSessionProgress(dbPath, SID)).toBeNull();
  });
});

describe('handleCorrection — config-overridable patterns', () => {
  test('an env-provided extra pattern captures a project-specific correction phrase', () => {
    const cfg = readCorrectionsConfig({
      RECALL_CORRECTIONS_ENABLED: '1',
      RECALL_CORRECTIONS_PATTERNS: '^scrap that',
    });
    expect(handleCorrection(dbPath, SID, CONV, 'scrap that, rebuild it', PROJ, cfg).outcome).toBe('saved');
    expect(countCorrections()).toBe(1);
  });
});
