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

const JEV_TEST_KEY = 'jev-test-secret';
const UNSCORED_SUMMARY = 'session summary stays unscored';

let dbPath: string;
let savedKey: string | undefined;
let savedFetch: typeof fetch;
let jevCalls: string[];

beforeEach(() => {
  dbPath = setupTestDb();
  savedKey = process.env.JEV_RECALL_KEY;
  savedFetch = globalThis.fetch;
  delete process.env.JEV_RECALL_KEY;
  jevCalls = [];
  globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
    jevCalls.push(typeof init?.body === 'string' ? init.body : '');
    return new Response('unexpected jev call', { status: 500 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  if (savedKey === undefined) delete process.env.JEV_RECALL_KEY;
  else process.env.JEV_RECALL_KEY = savedKey;
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
  test('populates all six surfaces from one fixture', async () => {
    const result = await dualWriteToSqlite(dbPath, {
      sessionId: 'sess-demo',
      sessionLabel: 'demo-session',
      project: 'atlas-recall',
      timestamp: '2026-05-17',
      conversationPath: '/tmp/conv.jsonl',
      topics: ['migration', 'sqlite'],
      summary: 'one sentence summary',
      extracted: FABRIC_FIXTURE,
    });

    expect(jevCalls).toEqual([]);
    expect(result.failures.jev).toBeUndefined();
    expect(result.jev).toEqual({ kept: 0, demoted: 0, dropped: 0, skipped: 8 });
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

  test('does not throw and reports failure when DB is unwritable', async () => {
    const result = await dualWriteToSqlite('/nope/not/here.db', {
      sessionId: 'x', sessionLabel: 'x', project: 'x', timestamp: '2026-05-17',
      conversationPath: 'x', topics: [], summary: 'x',
      extracted: FABRIC_FIXTURE,
    });
    expect(result.failures._db).toBe('not writable or locked');
    expect(result.jev).toEqual({ kept: 0, demoted: 0, dropped: 0, skipped: 0 });
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

  test('re-running an already-persisted extraction does not duplicate rows', async () => {
    await dualWriteToSqlite(dbPath, ctx);
    const afterFirst = rowCounts();

    // Archive write crashed before markAsExtracted → the whole pipeline reruns.
    const second = await dualWriteToSqlite(dbPath, ctx);

    expect(Object.keys(second.failures)).toEqual([]);
    expect(second.decisions).toBe(0);
    expect(second.learnings).toBe(0);
    expect(second.breadcrumbs).toBe(0);
    expect(rowCounts()).toEqual(afterFirst);
    expect(afterFirst).toEqual({ decisions: 3, learnings: 2, breadcrumbs: 3, loa: 1 });
  });

  test('retry after a partial failure repairs the failed table without duplicating the rest', async () => {
    const blocker = openRead();
    blocker.exec(
      `CREATE TRIGGER block_decisions BEFORE INSERT ON decisions
       BEGIN SELECT RAISE(ABORT, 'decisions writer down'); END`
    );
    blocker.close();

    const first = await dualWriteToSqlite(dbPath, ctx);
    expect(first.failures.decisions).toBeDefined();
    expect(first.loa).toBe(1);
    expect(rowCounts()).toEqual({ decisions: 0, learnings: 2, breadcrumbs: 3, loa: 1 });

    const unblocker = openRead();
    unblocker.exec('DROP TRIGGER block_decisions');
    unblocker.close();

    const second = await dualWriteToSqlite(dbPath, ctx);

    expect(Object.keys(second.failures)).toEqual([]);
    expect(second.decisions).toBe(3);
    expect(rowCounts()).toEqual({ decisions: 3, learnings: 2, breadcrumbs: 3, loa: 1 });
  });

  test('a different slice of the same session still persists (in-session windows)', async () => {
    await dualWriteToSqlite(dbPath, ctx);
    const second = await dualWriteToSqlite(dbPath, { ...ctx, extracted: SECOND_SLICE_FIXTURE });

    expect(Object.keys(second.failures)).toEqual([]);
    expect(second.decisions).toBe(1);
    expect(second.breadcrumbs).toBe(2);
    expect(second.learnings).toBe(1);
    expect(second.loa).toBe(1);
    expect(rowCounts()).toEqual({ decisions: 4, learnings: 3, breadcrumbs: 5, loa: 2 });
  });
});

const SCORED_FIXTURE = `## MAIN IDEAS
- Hooks stay self-contained and never import from src

## DECISIONS MADE
- hi (confidence: LOW)
- Use bun:sqlite, not a second database. (confidence: HIGH)

## ERRORS FIXED
- lock file race: wrap the acquire in BEGIN IMMEDIATE
- greeting only: say hello and move on
`;

const SECRET = 'sk-ant-FAKEKEYFORTESTINGONLY0000000000000000';

function jevChoice(name: 'keep' | 'demote' | 'drop') {
  return {
    type: 'choice',
    choice: name,
    probabilities: {
      keep: name === 'keep' ? 0.8 : 0.1,
      demote: name === 'demote' ? 0.8 : 0.1,
      drop: name === 'drop' ? 0.8 : 0.1,
    },
    confidence: 0.7,
  };
}

function answerWith(names: Record<string, 'keep' | 'demote' | 'drop'>) {
  return Object.fromEntries(Object.entries(names).map(([id, name]) => [id, jevChoice(name)]));
}

function writeCtx(extracted: string, project = 'atlas-recall') {
  return {
    sessionId: 'sess-jev',
    sessionLabel: 'demo-session',
    project,
    timestamp: '2026-05-17',
    conversationPath: '/tmp/conv.jsonl',
    topics: ['unscored-topic'],
    summary: UNSCORED_SUMMARY,
    extracted,
  };
}

function mockJev(status: number, body: unknown): void {
  globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
    jevCalls.push(typeof init?.body === 'string' ? init.body : '');
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(payload, { status });
  }) as typeof fetch;
}

describe('dualWriteToSqlite jev gate', () => {
  test('a blank key writes every row and does not call Jev', async () => {
    process.env.JEV_RECALL_KEY = '   ';
    const result = await dualWriteToSqlite(dbPath, writeCtx(FABRIC_FIXTURE));

    expect(jevCalls).toEqual([]);
    expect(result.failures).toEqual({});
    expect(result.jev).toEqual({ kept: 0, demoted: 0, dropped: 0, skipped: 8 });
    expect(result.decisions).toBe(3);
    expect(result.learnings).toBe(2);
    expect(result.breadcrumbs).toBe(3);
  });

  test('keep, demote, and drop change only the scored rows', async () => {
    process.env.JEV_RECALL_KEY = JEV_TEST_KEY;
    mockJev(200, {
      answers: answerWith({
        d0: 'drop',
        d1: 'keep',
        l0: 'demote',
        l1: 'drop',
        b0: 'drop',
      }),
    });

    const result = await dualWriteToSqlite(dbPath, writeCtx(SCORED_FIXTURE));

    expect(jevCalls).toHaveLength(1);
    expect(result.failures).toEqual({});
    expect(result.jev).toEqual({ kept: 1, demoted: 1, dropped: 3, skipped: 0 });
    expect(result.decisions).toBe(1);
    expect(result.learnings).toBe(1);
    expect(result.breadcrumbs).toBe(0);
    expect(result.errors).toBe(2);
    expect(result.sessions).toBe(1);
    expect(result.loa).toBe(1);
    expect(JSON.stringify(result)).not.toContain(JEV_TEST_KEY);

    const posted = JSON.parse(jevCalls[0] ?? '{}') as {
      state: { candidates: Record<string, { text?: string; decision?: string; problem?: string; content?: string }> };
    };
    expect(Object.keys(posted.state.candidates).sort()).toEqual(['b0', 'd0', 'd1', 'l0', 'l1']);
    expect(posted.state.candidates.d1?.text).toBe(
      'Use bun:sqlite, not a second database. (confidence: high)',
    );
    expect(posted.state.candidates.l0?.text).toBe(
      'lock file race: wrap the acquire in BEGIN IMMEDIATE',
    );
    expect(posted.state.candidates.b0?.text).toBe(
      'Hooks stay self-contained and never import from src',
    );
    expect(posted.state.candidates.d1?.decision).toBeUndefined();
    expect(posted.state.candidates.l0?.problem).toBeUndefined();
    expect(posted.state.candidates.b0?.content).toBeUndefined();
    expect(jevCalls[0]).not.toContain(UNSCORED_SUMMARY);
    expect(jevCalls[0]).not.toContain('unscored-topic');

    const db = openRead();
    const decisions = db.prepare('SELECT decision, importance FROM decisions ORDER BY id').all() as {
      decision: string;
      importance: number;
    }[];
    const learning = db.prepare('SELECT problem, solution, importance FROM learnings').get() as {
      problem: string;
      solution: string;
      importance: number;
    };
    const errors = db.prepare('SELECT error FROM extraction_errors ORDER BY error').all() as { error: string }[];
    const session = db.prepare('SELECT summary, topics FROM extraction_sessions').get() as {
      summary: string;
      topics: string;
    };
    const loa = db.prepare('SELECT description FROM loa_entries').get() as { description: string };
    db.close();

    expect(decisions).toEqual([
      { decision: 'Use bun:sqlite, not a second database.', importance: 5 },
    ]);
    expect(learning).toEqual({
      problem: 'lock file race',
      solution: 'wrap the acquire in BEGIN IMMEDIATE',
      importance: 3,
    });
    expect(errors.map(row => row.error).sort()).toEqual([
      'greeting only',
      'lock file race',
    ]);
    expect(session.summary).toBe(UNSCORED_SUMMARY);
    expect(session.topics).toContain('unscored-topic');
    expect(loa.description).toBe(UNSCORED_SUMMARY);
  });

  test('an HTTP failure writes the original breadcrumb at importance 5', async () => {
    process.env.JEV_RECALL_KEY = JEV_TEST_KEY;
    const result = await dualWriteToSqlite(dbPath, writeCtx(`## MAIN IDEAS
- Keep this breadcrumb when the scorer is down
`));

    expect(jevCalls).toHaveLength(1);
    expect(result.failures).toEqual({ jev: 'Jev request failed: HTTP 500' });
    expect(result.jev).toEqual({ kept: 0, demoted: 0, dropped: 0, skipped: 0 });
    expect(JSON.stringify(result)).not.toContain(JEV_TEST_KEY);
    expect(result.breadcrumbs).toBe(1);

    const db = openRead();
    const row = db.prepare('SELECT content, importance FROM breadcrumbs').get() as {
      content: string;
      importance: number;
    };
    db.close();
    expect(row).toEqual({
      content: 'Keep this breadcrumb when the scorer is down',
      importance: 5,
    });
  });

  test('a malformed Jev body writes the original rows', async () => {
    process.env.JEV_RECALL_KEY = JEV_TEST_KEY;
    mockJev(200, '{');
    const result = await dualWriteToSqlite(dbPath, writeCtx(SCORED_FIXTURE));

    expect(result.failures).toEqual({ jev: 'Jev response was not valid JSON' });
    expect(result.jev).toEqual({ kept: 0, demoted: 0, dropped: 0, skipped: 0 });
    expect(JSON.stringify(result)).not.toContain(JEV_TEST_KEY);
    expect(result.decisions).toBe(2);
    expect(result.learnings).toBe(2);
    expect(result.breadcrumbs).toBe(1);

    const db = openRead();
    const importance = [
      ...db.prepare('SELECT importance FROM decisions').all(),
      ...db.prepare('SELECT importance FROM learnings').all(),
      ...db.prepare('SELECT importance FROM breadcrumbs').all(),
    ] as { importance: number }[];
    db.close();
    expect(importance).toHaveLength(5);
    expect(importance.every(row => row.importance === 5)).toBe(true);
  });

  test('Jev sees scrubbed candidate text and the rows keep those scrubbed fields', async () => {
    process.env.JEV_RECALL_KEY = JEV_TEST_KEY;
    mockJev(200, { answers: answerWith({ d0: 'keep', l0: 'keep', b0: 'keep' }) });
    const extracted = `## MAIN IDEAS
- The note mentioned ${SECRET} during debugging and should be redacted

## DECISIONS MADE
- Rotate ${SECRET} immediately (confidence: HIGH)

## ERRORS FIXED
- leaked ${SECRET}: moved the token to the vault
`;

    const result = await dualWriteToSqlite(dbPath, writeCtx(extracted, `team-${SECRET}`));

    expect(result.failures).toEqual({});
    expect(result.jev).toEqual({ kept: 3, demoted: 0, dropped: 0, skipped: 0 });
    expect(jevCalls).toHaveLength(1);
    expect(jevCalls[0]).not.toContain(SECRET);
    expect(jevCalls[0]).toContain('[REDACTED:anthropic-key]');
    const posted = JSON.parse(jevCalls[0] ?? '{}') as {
      state: { candidates: Record<string, { text: string; project?: string; confidence?: string }> };
    };
    expect(posted.state.candidates.d0?.text).toContain('[REDACTED:anthropic-key]');
    expect(posted.state.candidates.d0?.text).toContain('(confidence: high)');
    expect(posted.state.candidates.d0?.confidence).toBe('high');
    expect(posted.state.candidates.d0?.project).toBe('team-[REDACTED:anthropic-key]');
    expect(posted.state.candidates.l0?.text).toContain('moved the token to the vault');
    expect(posted.state.candidates.b0?.text).toContain('[REDACTED:anthropic-key]');

    const db = openRead();
    const decision = db.prepare('SELECT decision, project, importance FROM decisions').get() as {
      decision: string;
      project: string;
      importance: number;
    };
    const learning = db.prepare('SELECT problem, solution FROM learnings').get() as {
      problem: string;
      solution: string;
    };
    const breadcrumb = db.prepare('SELECT content FROM breadcrumbs').get() as { content: string };
    db.close();
    expect(decision.decision).toContain('[REDACTED:anthropic-key]');
    expect(decision.decision).not.toContain(SECRET);
    expect(decision.decision).not.toContain('(confidence:');
    expect(decision.project).toBe('team-[REDACTED:anthropic-key]');
    expect(decision.importance).toBe(5);
    expect(learning.problem).toContain('[REDACTED:anthropic-key]');
    expect(learning.problem).not.toContain('moved the token');
    expect(learning.solution).toBe('moved the token to the vault');
    expect(breadcrumb.content).toContain('[REDACTED:anthropic-key]');
    expect(breadcrumb.content).not.toContain(SECRET);
  });
});
