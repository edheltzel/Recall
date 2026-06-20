import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import {
  getSessionProgress,
  ensureSession,
  incrementTurns,
  incrementTools,
  incrementRuns,
  advanceOffset,
  resetWindow,
} from '../../hooks/lib/session-progress';

let dbPath: string;

beforeEach(() => {
  dbPath = setupTestDb();
});

afterEach(() => {
  teardownTestDb();
});

describe('getSessionProgress', () => {
  test('returns null for an unknown session', () => {
    expect(getSessionProgress(dbPath, 'missing')).toBeNull();
  });
});

describe('ensureSession', () => {
  test('creates a row with zeroed counters and the conversation path', () => {
    ensureSession(dbPath, 's1', '/tmp/conv.jsonl');
    const row = getSessionProgress(dbPath, 's1');
    expect(row).not.toBeNull();
    expect(row!.conversation_path).toBe('/tmp/conv.jsonl');
    expect(row!.turns_seen).toBe(0);
    expect(row!.tools_seen).toBe(0);
    expect(row!.last_offset).toBe(0);
    expect(row!.runs_this_session).toBe(0);
    expect(row!.updated_at).not.toBeNull();
  });

  test('is non-destructive: a second call preserves accumulated counters', () => {
    ensureSession(dbPath, 's1', '/tmp/conv.jsonl');
    incrementTurns(dbPath, 's1');
    incrementTurns(dbPath, 's1');
    // Re-ensuring must not wipe the counter back to 0.
    ensureSession(dbPath, 's1', '/tmp/conv.jsonl');
    expect(getSessionProgress(dbPath, 's1')!.turns_seen).toBe(2);
  });
});

describe('increment counters', () => {
  // Mutation guard (a): turn an increment into a no-op (x = x) → counter stays
  // 0 → these assertions go RED.
  test('incrementTurns accumulates user turns', () => {
    ensureSession(dbPath, 's1', null);
    incrementTurns(dbPath, 's1');
    incrementTurns(dbPath, 's1');
    incrementTurns(dbPath, 's1');
    expect(getSessionProgress(dbPath, 's1')!.turns_seen).toBe(3);
  });

  test('incrementTools accumulates tool calls independently of turns', () => {
    ensureSession(dbPath, 's1', null);
    incrementTools(dbPath, 's1');
    incrementTools(dbPath, 's1');
    const row = getSessionProgress(dbPath, 's1')!;
    expect(row.tools_seen).toBe(2);
    expect(row.turns_seen).toBe(0);
  });

  test('incrementRuns accumulates the session-lifetime budget counter', () => {
    ensureSession(dbPath, 's1', null);
    incrementRuns(dbPath, 's1');
    incrementRuns(dbPath, 's1');
    expect(getSessionProgress(dbPath, 's1')!.runs_this_session).toBe(2);
  });
});

describe('advanceOffset', () => {
  // Mutation guard (b): make advance a no-op (drop the SET / keep 0) → the
  // cursor stays 0 → this assertion goes RED.
  test('advances the incremental-extraction cursor', () => {
    ensureSession(dbPath, 's1', null);
    expect(getSessionProgress(dbPath, 's1')!.last_offset).toBe(0);
    advanceOffset(dbPath, 's1', 4096);
    expect(getSessionProgress(dbPath, 's1')!.last_offset).toBe(4096);
    advanceOffset(dbPath, 's1', 8192);
    expect(getSessionProgress(dbPath, 's1')!.last_offset).toBe(8192);
  });
});

describe('resetWindow', () => {
  // Mutation guard (c): make reset not zero the counters → they stay non-zero
  // → the first two assertions go RED.
  test('zeros the per-window counters but preserves runs and cursor', () => {
    ensureSession(dbPath, 's1', null);
    incrementTurns(dbPath, 's1');
    incrementTools(dbPath, 's1');
    incrementRuns(dbPath, 's1');
    advanceOffset(dbPath, 's1', 1024);

    resetWindow(dbPath, 's1');

    const row = getSessionProgress(dbPath, 's1')!;
    expect(row.turns_seen).toBe(0);
    expect(row.tools_seen).toBe(0);
    // The budget guard and the cursor must survive a window reset.
    expect(row.runs_this_session).toBe(1);
    expect(row.last_offset).toBe(1024);
  });
});
