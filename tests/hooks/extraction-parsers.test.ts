import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import {
  dualWriteToSqlite,
  parseDecisionItems,
  parseLearningItems,
  parseBreadcrumbItems,
  parseErrorPatternItems,
} from '../../hooks/lib/extraction-parsers';

const FABRIC_FIXTURE = `## ONE SENTENCE SUMMARY
We migrated the Stop hook to write to SQLite.

## MAIN IDEAS
- Hooks must not import from src/ — keep them self-contained
- Dual-write is additive, legacy files remain
- Best-effort writes never block legacy path

## DECISIONS MADE
- Use SQLite extraction_tracker (confidence: HIGH)
- Retire .extraction_tracker.json (confidence: MEDIUM)
- Keep legacy markdown writers intact (confidence: HIGH)

## ERRORS FIXED
- EEXIST on lock file: switched to SQLite extraction_locks
- TOCTOU race in semaphore: wrapped acquire in BEGIN IMMEDIATE

## THINGS TO REJECT / AVOID
- Removing the legacy files in this pass

## SESSION CONTEXT
A surgical migration of the Stop hook to use SQLite-native helpers.`;

// A later in-session window of the SAME session, with different content, so
// every row must still persist alongside the first slice's rows.
const SECOND_SLICE_FIXTURE = `## ONE SENTENCE SUMMARY
A later window covering the installer half of the session.

## MAIN IDEAS
- Lifecycle scripts share lib/install-lib.sh and nothing else
- JSONC edits run through a dependency-free helper

## DECISIONS MADE
- Drop the jsonc-parser runtime dependency (confidence: HIGH)

## ERRORS FIXED
- Trailing comma on insert: rebuilt the JSONC edit offsets

## SESSION CONTEXT
The installer half of the same session.`;

let dbPath: string;

beforeEach(() => {
  dbPath = setupTestDb();
});

afterEach(() => {
  teardownTestDb();
});

function openRead(): Database {
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  return db;
}

describe('parseDecisionItems', () => {
  test('extracts 3 decisions with confidence', () => {
    const items = parseDecisionItems(FABRIC_FIXTURE, { sessionId: 's1', project: 'demo' });
    expect(items.length).toBe(3);
    expect(items[0].decision).toContain('extraction_tracker');
    expect(items[0].confidence).toBe('high');
    expect(items[1].confidence).toBe('medium');
    expect(items[0].category).toBe('auto-extracted');
  });
});

describe('parseLearningItems', () => {
  test('extracts errors as learnings (problem/solution)', () => {
    const items = parseLearningItems(FABRIC_FIXTURE, {
      sessionId: 's1', project: 'demo', sessionLabel: 'demo-session',
    });
    expect(items.length).toBe(2);
    expect(items[0].problem).toContain('EEXIST');
    expect(items[0].solution).toContain('extraction_locks');
  });
});

describe('parseBreadcrumbItems', () => {
  test('extracts main ideas as breadcrumbs', () => {
    const items = parseBreadcrumbItems(FABRIC_FIXTURE, { sessionId: 's1', project: 'demo' });
    expect(items.length).toBe(3);
    expect(items[0].content).toContain('self-contained');
    expect(items[0].category).toBe('extracted-idea');
  });
});

describe('parseErrorPatternItems', () => {
  test('extracts errors with normalized error_key', () => {
    const items = parseErrorPatternItems(FABRIC_FIXTURE);
    expect(items.length).toBe(2);
    expect(items[0].errorKey).toMatch(/eexist/);
    expect(items[0].fix).toContain('extraction_locks');
  });
});

describe('dualWriteToSqlite', () => {
  test('populates all six surfaces from one fixture', () => {
    const result = dualWriteToSqlite(dbPath, {
      sessionId: 'sess-demo',
      sessionLabel: 'demo-session',
      project: 'atlas-recall',
      timestamp: '2026-05-17',
      conversationPath: '/tmp/conv.jsonl',
      topics: ['migration', 'sqlite'],
      summary: 'one sentence summary',
      extracted: FABRIC_FIXTURE,
    });

    expect(Object.keys(result.failures)).toEqual([]);
    expect(result.sessions).toBe(1);
    expect(result.decisions).toBe(3);
    expect(result.learnings).toBe(2);
    expect(result.breadcrumbs).toBe(3);
    expect(result.errors).toBe(2);
    expect(result.loa).toBe(1);

    const db = openRead();
    const sessionCount = (db.prepare('SELECT COUNT(*) c FROM extraction_sessions').get() as any).c;
    const decisionCount = (db.prepare('SELECT COUNT(*) c FROM decisions').get() as any).c;
    const learningCount = (db.prepare('SELECT COUNT(*) c FROM learnings').get() as any).c;
    const breadcrumbCount = (db.prepare('SELECT COUNT(*) c FROM breadcrumbs').get() as any).c;
    const errorCount = (db.prepare('SELECT COUNT(*) c FROM extraction_errors').get() as any).c;
    const loaCount = (db.prepare('SELECT COUNT(*) c FROM loa_entries').get() as any).c;
    db.close();

    expect(sessionCount).toBe(1);
    expect(decisionCount).toBe(3);
    expect(learningCount).toBe(2);
    expect(breadcrumbCount).toBe(3);
    expect(errorCount).toBe(2);
    expect(loaCount).toBe(1);
  });

  test('does not throw and reports failure when DB is unwritable', () => {
    const result = dualWriteToSqlite('/nope/not/here.db', {
      sessionId: 'x', sessionLabel: 'x', project: 'x', timestamp: '2026-05-17',
      conversationPath: 'x', topics: [], summary: 'x',
      extracted: FABRIC_FIXTURE,
    });
    expect(result.failures._db).toBe('not writable or locked');
    expect(result.sessions).toBe(0);
  });
});

// The Stop hook marks a conversation extracted only AFTER its markdown archive
// writes, and a partial SQLite failure marks it failed + retryable, so the same
// extraction can reach dualWriteToSqlite more than once. These lock the
// insert-if-absent guard in sqlite-writers.ts.
describe('dualWriteToSqlite retry idempotency', () => {
  const ctx = {
    sessionId: 'sess-retry',
    sessionLabel: 'demo-session',
    project: 'atlas-recall',
    timestamp: '2026-05-17',
    conversationPath: '/tmp/conv.jsonl',
    topics: ['migration', 'sqlite'],
    summary: 'one sentence summary',
    extracted: FABRIC_FIXTURE,
  };

  function rowCounts() {
    const db = openRead();
    const count = (t: string) =>
      (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as any).c as number;
    const counts = {
      decisions: count('decisions'),
      learnings: count('learnings'),
      breadcrumbs: count('breadcrumbs'),
      loa: count('loa_entries'),
    };
    db.close();
    return counts;
  }

  test('re-running an already-persisted extraction does not duplicate rows', () => {
    dualWriteToSqlite(dbPath, ctx);
    const afterFirst = rowCounts();

    // Archive write crashed before markAsExtracted → the whole pipeline reruns.
    const second = dualWriteToSqlite(dbPath, ctx);

    expect(Object.keys(second.failures)).toEqual([]);
    expect(second.decisions).toBe(0);
    expect(second.learnings).toBe(0);
    expect(second.breadcrumbs).toBe(0);
    expect(rowCounts()).toEqual(afterFirst);
    expect(afterFirst).toEqual({ decisions: 3, learnings: 2, breadcrumbs: 3, loa: 1 });
  });

  test('retry after a partial failure repairs the failed table without duplicating the rest', () => {
    const blocker = openRead();
    blocker.exec(
      `CREATE TRIGGER block_decisions BEFORE INSERT ON decisions
       BEGIN SELECT RAISE(ABORT, 'decisions writer down'); END`
    );
    blocker.close();

    const first = dualWriteToSqlite(dbPath, ctx);
    expect(first.failures.decisions).toBeDefined();
    expect(first.loa).toBe(1);
    expect(rowCounts()).toEqual({ decisions: 0, learnings: 2, breadcrumbs: 3, loa: 1 });

    const unblocker = openRead();
    unblocker.exec('DROP TRIGGER block_decisions');
    unblocker.close();

    const second = dualWriteToSqlite(dbPath, ctx);

    expect(Object.keys(second.failures)).toEqual([]);
    expect(second.decisions).toBe(3);
    expect(rowCounts()).toEqual({ decisions: 3, learnings: 2, breadcrumbs: 3, loa: 1 });
  });

  test('a different slice of the same session still persists (in-session windows)', () => {
    dualWriteToSqlite(dbPath, ctx);
    const second = dualWriteToSqlite(dbPath, { ...ctx, extracted: SECOND_SLICE_FIXTURE });

    expect(Object.keys(second.failures)).toEqual([]);
    expect(second.decisions).toBe(1);
    expect(second.breadcrumbs).toBe(2);
    expect(second.learnings).toBe(1);
    expect(second.loa).toBe(1);
    expect(rowCounts()).toEqual({ decisions: 4, learnings: 3, breadcrumbs: 5, loa: 2 });
  });
});
