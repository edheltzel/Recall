// #179 — scrub() wired into the EXPLICIT add paths.
//
// A known-prefix secret typed into `recall add` (CLI / runAdd*) or sent via
// `memory_add` (MCP → addDecision/addLearning/addBreadcrumb) must be redacted
// BEFORE it reaches SQLite, and the redacted kinds must be surfaced (never the
// values). Ordinary prose must pass through unchanged (no over-redaction).
//
// Fake, structurally-valid secrets only — repeated-char filler, never real or
// crypto-looking values (mirrors tests/hooks/write-safety.ts conventions).

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import {
  runAddDecision,
  runAddLearning,
  runAddBreadcrumb,
} from '../../src/commands/add';
import {
  addDecision,
  getDecision,
  addLearning,
  getLearning,
  addBreadcrumb,
  getBreadcrumb,
} from '../../src/lib/memory';

const ANTHROPIC_KEY = 'sk-ant-api03-' + 'A'.repeat(40); // → kind 'anthropic-key'
const BEARER = 'Bearer ' + 'p'.repeat(32);              // → kind 'bearer-token'
const CLEAN_PROSE = 'the api key is in the vault';      // no `:`/`=` → never matches

let dbPath: string;
const originalLog = console.log;
let logs: string[];

beforeEach(() => {
  dbPath = setupTestDb();
  logs = [];
  console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
});

afterEach(() => {
  console.log = originalLog;
  teardownTestDb();
});

function readLatest(table: 'decisions' | 'learnings' | 'breadcrumbs', column: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare(`SELECT ${column} AS v FROM ${table} ORDER BY id DESC LIMIT 1`).get() as { v: string };
    return row.v;
  } finally {
    db.close();
  }
}

// ============ MCP path — the three add* fns ============

describe('memory_add path (addDecision/addLearning/addBreadcrumb)', () => {
  test('redacts a secret in the stored decision and reports the kind', () => {
    const redactions: string[] = [];
    const id = addDecision(
      { decision: `deploy with ${ANTHROPIC_KEY}`, status: 'active', provenance: 'user_authored' },
      redactions,
    );

    const stored = getDecision(id)!;
    expect(stored.decision).not.toContain(ANTHROPIC_KEY);
    expect(stored.decision).toContain('[REDACTED:anthropic-key]');
    expect(redactions).toContain('anthropic-key');
  });

  test('scrubs secondary free-text fields (reasoning, alternatives) too', () => {
    const redactions: string[] = [];
    const id = addDecision(
      {
        decision: 'rotate the deploy token',
        reasoning: `old value was ${ANTHROPIC_KEY}`,
        alternatives: `header used ${BEARER}`,
        status: 'active',
        provenance: 'user_authored',
      },
      redactions,
    );

    const stored = getDecision(id)!;
    expect(stored.reasoning).toContain('[REDACTED:anthropic-key]');
    expect(stored.alternatives).toContain('[REDACTED:bearer-token]');
    expect(stored.alternatives).not.toContain('p'.repeat(32));
    // Aggregated, distinct, once each.
    expect([...redactions].sort()).toEqual(['anthropic-key', 'bearer-token']);
  });

  test('redacts a secret in a learning (solution field)', () => {
    const redactions: string[] = [];
    const id = addLearning(
      { problem: 'token leaked in logs', solution: `revoked ${BEARER}`, provenance: 'user_authored' },
      redactions,
    );

    const stored = getLearning(id)!;
    expect(stored.solution).toContain('Bearer [REDACTED:bearer-token]');
    expect(stored.solution).not.toContain('p'.repeat(32));
    expect(redactions).toContain('bearer-token');
  });

  test('redacts a secret in a breadcrumb (content field)', () => {
    const redactions: string[] = [];
    const id = addBreadcrumb(
      { content: `key is ${ANTHROPIC_KEY}`, importance: 5, provenance: 'user_authored' },
      redactions,
    );

    const stored = getBreadcrumb(id)!;
    expect(stored.content).toContain('[REDACTED:anthropic-key]');
    expect(stored.content).not.toContain(ANTHROPIC_KEY);
    expect(redactions).toContain('anthropic-key');
  });

  test('clean prose is stored unchanged and reports no redactions', () => {
    const redactions: string[] = [];
    const id = addDecision(
      { decision: CLEAN_PROSE, status: 'active', provenance: 'user_authored' },
      redactions,
    );

    expect(getDecision(id)!.decision).toBe(CLEAN_PROSE);
    expect(redactions).toHaveLength(0);
  });

  test('the same kind across two fields is reported once', () => {
    const redactions: string[] = [];
    addDecision(
      {
        decision: `a ${ANTHROPIC_KEY}`,
        reasoning: `b ${ANTHROPIC_KEY}`,
        status: 'active',
        provenance: 'user_authored',
      },
      redactions,
    );
    expect(redactions).toEqual(['anthropic-key']);
  });
});

// ============ CLI path — runAdd* ============

describe('recall add path (runAddDecision/runAddLearning/runAddBreadcrumb)', () => {
  test('redacts the stored decision and prints the warning after the ✓ line', () => {
    runAddDecision(`use ${ANTHROPIC_KEY} for prod`, {});

    const stored = readLatest('decisions', 'decision');
    expect(stored).toContain('[REDACTED:anthropic-key]');
    expect(stored).not.toContain(ANTHROPIC_KEY);

    expect(logs.some((l) => l.startsWith('✓ Added decision'))).toBe(true);
    expect(logs.some((l) => l.includes('⚠ redacted secrets before storing: anthropic-key'))).toBe(true);
  });

  test('redacts the stored learning and warns', () => {
    runAddLearning('rotated creds', `header was ${BEARER}`, {});

    const stored = readLatest('learnings', 'solution');
    expect(stored).toContain('[REDACTED:bearer-token]');
    expect(stored).not.toContain('p'.repeat(32));
    expect(logs.some((l) => l.includes('⚠ redacted secrets before storing: bearer-token'))).toBe(true);
  });

  test('redacts the stored breadcrumb and warns', () => {
    runAddBreadcrumb(`crumb ${ANTHROPIC_KEY}`, {});

    const stored = readLatest('breadcrumbs', 'content');
    expect(stored).toContain('[REDACTED:anthropic-key]');
    expect(logs.some((l) => l.includes('⚠ redacted secrets before storing: anthropic-key'))).toBe(true);
  });

  test('clean prose is stored unchanged and no warning is printed', () => {
    runAddBreadcrumb(CLEAN_PROSE, {});

    expect(readLatest('breadcrumbs', 'content')).toBe(CLEAN_PROSE);
    expect(logs.some((l) => l.startsWith('✓ Added breadcrumb'))).toBe(true);
    expect(logs.some((l) => l.includes('⚠ redacted secrets'))).toBe(false);
  });
});
