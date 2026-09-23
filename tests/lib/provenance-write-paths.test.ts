// Record Provenance write-path stamping (issue #42, ADR-0001).
//
// Provenance is automatic write-path metadata. Each capture surface stamps
// the value its write-path semantics dictate; no public surface accepts a
// provenance override. These tests pin the stamp per path:
//   - CLI `recall add` → user_authored
//   - structured extraction (Haiku/Fabric output) → extracted
//   - raw message capture (import/dump batch writer) → verbatim
//   - search() structured results carry provenance for every record type

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Database } from 'bun:sqlite';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { runAddBreadcrumb, runAddDecision, runAddLearning } from '../../src/commands/add';
import { importConversations } from '../../src/lib/conversation-import';
import { writeStructuredExtraction } from '../../src/lib/structured-extraction';
import {
  createSession,
  addMessage,
  addMessagesBatch,
  addDecision,
  addLearning,
  addBreadcrumb,
  createLoaEntry,
  search,
} from '../../src/lib/memory';

const JEV_TEST_KEY = 'jev-test-secret';
const SECRET = 'sk-ant-FAKEKEYFORTESTINGONLY0000000000000000';

let dbPath: string;
let savedKey: string | undefined;
let savedFetch: typeof fetch;
let jevCalls: string[];
const originalLog = console.log;

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
  console.log = () => {}; // add commands print confirmations; keep output clean
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  if (savedKey === undefined) delete process.env.JEV_RECALL_KEY;
  else process.env.JEV_RECALL_KEY = savedKey;
  console.log = originalLog;
  teardownTestDb();
});

function readDb(): Database {
  return new Database(dbPath, { readonly: true });
}

describe('CLI add commands stamp user_authored', () => {
  test('breadcrumb, decision, and learning all land as user_authored', () => {
    runAddBreadcrumb('a crumb worth keeping', { project: 'demo' });
    runAddDecision('we choose sqlite', { project: 'demo' });
    runAddLearning('it was broken', 'we fixed it', { project: 'demo' });

    const db = readDb();
    for (const table of ['breadcrumbs', 'decisions', 'learnings']) {
      const row = db.prepare(`SELECT provenance FROM ${table} LIMIT 1`).get() as any;
      expect(row.provenance).toBe('user_authored');
    }
    db.close();
  });
});

describe('structured extraction stamps extracted', () => {
  test('decisions and LoA entry from an extract are marked extracted', async () => {
    createSession({ session_id: 'ext-1', started_at: '2026-01-01T00:00:00Z', project: 'demo' });

    const result = await writeStructuredExtraction({
      sessionId: 'ext-1',
      sessionLabel: 'extraction test',
      project: 'demo',
      timestamp: '2026-01-01',
      conversationPath: '/tmp/conv.jsonl',
      topics: ['testing'],
      summary: 'a one sentence summary',
      extracted: [
        '## ONE SENTENCE SUMMARY',
        'a one sentence summary',
        '',
        '## DECISIONS MADE',
        '- Adopt write-path provenance stamping (confidence: HIGH)',
      ].join('\n'),
    });

    expect(jevCalls).toEqual([]);
    expect(result.failures.jev).toBeUndefined();
    expect(result.jev).toEqual({ kept: 0, demoted: 0, dropped: 0, skipped: 1 });
    expect(result.decisions).toBe(1);
    expect(result.loa).toBe(1);

    const db = readDb();
    const decision = db.prepare('SELECT provenance FROM decisions LIMIT 1').get() as any;
    const loa = db.prepare('SELECT provenance FROM loa_entries LIMIT 1').get() as any;
    db.close();
    expect(decision.provenance).toBe('extracted');
    expect(loa.provenance).toBe('extracted');
  });
});

describe('raw message capture', () => {
  test('batch writer persists verbatim when the import path stamps it', () => {
    createSession({ session_id: 'imp-1', started_at: '2026-01-01T00:00:00Z', project: 'demo' });

    // import.ts / conversation-import.ts / dump.ts all map messages through
    // addMessagesBatch with provenance: 'verbatim'
    addMessagesBatch([
      { session_id: 'imp-1', timestamp: '2026-01-01T00:00:01Z', role: 'user', content: 'raw text', provenance: 'verbatim' },
      { session_id: 'imp-1', timestamp: '2026-01-01T00:00:02Z', role: 'assistant', content: 'raw reply', provenance: 'verbatim' },
    ]);

    const db = readDb();
    const rows = db.prepare('SELECT provenance FROM messages ORDER BY id').all() as any[];
    db.close();
    expect(rows.map(r => r.provenance)).toEqual(['verbatim', 'verbatim']);
  });

  test('a write without provenance stays NULL — unknown is representable, never defaulted', () => {
    createSession({ session_id: 'imp-2', started_at: '2026-01-01T00:00:00Z', project: 'demo' });
    addMessage({ session_id: 'imp-2', timestamp: '2026-01-01T00:00:01Z', role: 'user', content: 'unstamped' });

    const db = readDb();
    const row = db.prepare('SELECT provenance FROM messages LIMIT 1').get() as any;
    db.close();
    expect(row.provenance).toBeNull();
  });
});

describe('search() structured results carry provenance', () => {
  test('every record type returns its provenance; NULL surfaces as null', () => {
    createSession({ session_id: 'srch-1', started_at: '2026-01-01T00:00:00Z', project: 'demo' });

    addMessage({ session_id: 'srch-1', timestamp: '2026-01-01T00:00:01Z', role: 'user', content: 'xylocarp message', provenance: 'verbatim' });
    addDecision({ session_id: 'srch-1', decision: 'xylocarp decision', status: 'active', provenance: 'user_authored' });
    addLearning({ session_id: 'srch-1', problem: 'xylocarp problem', solution: 'fix', provenance: 'extracted' });
    addBreadcrumb({ session_id: 'srch-1', content: 'xylocarp crumb', importance: 5, provenance: 'user_authored' });
    createLoaEntry({ title: 'xylocarp loa', fabric_extract: 'xylocarp extract body', session_id: 'srch-1', provenance: 'extracted' });
    // legacy row with unknown provenance
    addBreadcrumb({ session_id: 'srch-1', content: 'xylocarp legacy crumb', importance: 5 });

    const results = search('xylocarp', { limit: 20 });
    const byKey = new Map(results.map(r => [`${r.table}:${r.content}`, r]));

    expect(byKey.get('messages:xylocarp message')?.provenance).toBe('verbatim');
    expect(byKey.get('decisions:xylocarp decision')?.provenance).toBe('user_authored');
    expect(byKey.get('learnings:xylocarp problem')?.provenance).toBe('extracted');
    expect(byKey.get('breadcrumbs:xylocarp crumb')?.provenance).toBe('user_authored');
    expect(byKey.get('breadcrumbs:xylocarp legacy crumb')?.provenance).toBeNull();

    const loaResult = results.find(r => r.table === 'loa');
    expect(loaResult?.provenance).toBe('extracted');
  });
});

describe('no public provenance override (ADR-0001 contract)', () => {
  const repoRoot = join(import.meta.dir, '..', '..');

  test('MCP memory_add input schema exposes no provenance parameter', () => {
    const source = readFileSync(join(repoRoot, 'src', 'mcp-server.ts'), 'utf-8');
    const toolStart = source.indexOf('"memory_add"');
    expect(toolStart).toBeGreaterThan(-1);
    // The zod input schema sits between the tool name and the handler callback.
    const handlerStart = source.indexOf('async (', toolStart);
    const schemaBlock = source.slice(toolStart, handlerStart);
    expect(schemaBlock).not.toContain('provenance');
    // The handler stamps it instead.
    const handlerBlock = source.slice(handlerStart, source.indexOf('server.tool', handlerStart));
    expect(handlerBlock).toContain('provenance: "user_authored"');
  });

  test('CLI exposes no --provenance flag anywhere', () => {
    const source = readFileSync(join(repoRoot, 'src', 'index.ts'), 'utf-8');
    expect(source).not.toContain('--provenance');
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

const UNSCORED_SUMMARY = 'session summary stays unscored';

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

function extractionCtx(extracted: string, project = 'demo') {
  return {
    sessionId: 'ext-jev',
    sessionLabel: 'extraction test',
    project,
    timestamp: '2026-01-01',
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

function decisionCount(): number {
  const db = readDb();
  const count = (db.prepare('SELECT COUNT(*) c FROM decisions').get() as { c: number }).c;
  db.close();
  return count;
}

describe('structured extraction jev gate', () => {
  test('explicit add does not call Jev', () => {
    process.env.JEV_RECALL_KEY = JEV_TEST_KEY;
    runAddDecision('we choose sqlite for an explicit add', { project: 'demo' });
    expect(jevCalls).toEqual([]);
    const db = readDb();
    const row = db.prepare('SELECT decision, provenance FROM decisions').get() as {
      decision: string;
      provenance: string;
    };
    db.close();
    expect(row).toEqual({
      decision: 'we choose sqlite for an explicit add',
      provenance: 'user_authored',
    });
  });

  test('a blank key writes every row and does not call Jev', async () => {
    process.env.JEV_RECALL_KEY = '   ';
    createSession({ session_id: 'ext-jev', started_at: '2026-01-01T00:00:00Z', project: 'demo' });
    const result = await writeStructuredExtraction(extractionCtx(SCORED_FIXTURE));
    expect(jevCalls).toEqual([]);
    expect(result.failures).toEqual({});
    expect(result.jev).toEqual({ kept: 0, demoted: 0, dropped: 0, skipped: 5 });
    expect(result.decisions).toBe(2);
    expect(result.learnings).toBe(2);
    expect(result.breadcrumbs).toBe(1);
  });

  test('keep, demote, and drop change only the scored rows', async () => {
    process.env.JEV_RECALL_KEY = JEV_TEST_KEY;
    mockJev(200, {
      answers: answerWith({ d0: 'drop', d1: 'keep', l0: 'demote', l1: 'drop', b0: 'drop' }),
    });
    createSession({ session_id: 'ext-jev', started_at: '2026-01-01T00:00:00Z', project: 'demo' });
    const result = await writeStructuredExtraction(extractionCtx(SCORED_FIXTURE));

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
    expect(jevCalls[0]).not.toContain(UNSCORED_SUMMARY);
    expect(jevCalls[0]).not.toContain('unscored-topic');

    const db = readDb();
    const decisions = db.prepare('SELECT decision, importance, provenance FROM decisions').all() as {
      decision: string;
      importance: number;
      provenance: string;
    }[];
    const learning = db.prepare('SELECT problem, solution, importance FROM learnings').get() as {
      problem: string;
      solution: string;
      importance: number;
    };
    const errors = db.prepare('SELECT error FROM extraction_errors').all() as { error: string }[];
    db.close();
    expect(decisions).toEqual([{
      decision: 'Use bun:sqlite, not a second database.',
      importance: 5,
      provenance: 'extracted',
    }]);
    expect(learning).toEqual({
      problem: 'lock file race',
      solution: 'wrap the acquire in BEGIN IMMEDIATE',
      importance: 3,
    });
    expect(errors.map(row => row.error).sort()).toEqual(['greeting only', 'lock file race']);
  });

  test('an HTTP failure writes the original breadcrumb at importance 5', async () => {
    process.env.JEV_RECALL_KEY = JEV_TEST_KEY;
    createSession({ session_id: 'ext-jev', started_at: '2026-01-01T00:00:00Z', project: 'demo' });
    const result = await writeStructuredExtraction(extractionCtx(`## MAIN IDEAS
- Keep this breadcrumb when the scorer is down
`));
    expect(jevCalls).toHaveLength(1);
    expect(result.failures.jev).toBe('Jev request failed: HTTP 500');
    expect(result.jev).toEqual({ kept: 0, demoted: 0, dropped: 0, skipped: 0 });
    expect(result.breadcrumbs).toBe(1);
    expect(JSON.stringify(result)).not.toContain(JEV_TEST_KEY);
    const db = readDb();
    const row = db.prepare('SELECT content, importance, provenance FROM breadcrumbs').get() as {
      content: string;
      importance: number;
      provenance: string;
    };
    db.close();
    expect(row).toEqual({
      content: 'Keep this breadcrumb when the scorer is down',
      importance: 5,
      provenance: 'extracted',
    });
  });

  test('a malformed Jev body writes the original rows', async () => {
    process.env.JEV_RECALL_KEY = JEV_TEST_KEY;
    mockJev(200, '{');
    createSession({ session_id: 'ext-jev', started_at: '2026-01-01T00:00:00Z', project: 'demo' });
    const result = await writeStructuredExtraction(extractionCtx(SCORED_FIXTURE));
    expect(result.failures.jev).toBe('Jev response was not valid JSON');
    expect(result.jev).toEqual({ kept: 0, demoted: 0, dropped: 0, skipped: 0 });
    expect(result.decisions).toBe(2);
    expect(result.learnings).toBe(2);
    expect(result.breadcrumbs).toBe(1);
    const db = readDb();
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
    createSession({ session_id: 'ext-jev', started_at: '2026-01-01T00:00:00Z', project: 'demo' });
    const extracted = `## MAIN IDEAS
- The note mentioned ${SECRET} during debugging and should be redacted

## DECISIONS MADE
- Rotate ${SECRET} immediately (confidence: HIGH)

## ERRORS FIXED
- leaked ${SECRET}: moved the token to the vault
`;
    const result = await writeStructuredExtraction(extractionCtx(extracted, `team-${SECRET}`));
    expect(result.failures.jev).toBeUndefined();
    expect(result.jev).toEqual({ kept: 3, demoted: 0, dropped: 0, skipped: 0 });
    expect(jevCalls[0]).not.toContain(SECRET);
    expect(jevCalls[0]).toContain('[REDACTED:anthropic-key]');
    const posted = JSON.parse(jevCalls[0] ?? '{}') as {
      state: { candidates: Record<string, { text: string; project?: string }> };
    };
    expect(posted.state.candidates.d0?.text).toContain('(confidence: high)');
    expect(posted.state.candidates.d0?.project).toBe('team-[REDACTED:anthropic-key]');
    expect(posted.state.candidates.l0?.text).toContain('moved the token to the vault');

    const db = readDb();
    const decision = db.prepare('SELECT decision, project FROM decisions').get() as {
      decision: string;
      project: string;
    };
    const learning = db.prepare('SELECT problem, solution FROM learnings').get() as {
      problem: string;
      solution: string;
    };
    db.close();
    expect(decision.decision).not.toContain(SECRET);
    expect(decision.decision).not.toContain('(confidence:');
    expect(decision.project).toBe('team-[REDACTED:anthropic-key]');
    expect(learning.problem).not.toContain('moved the token');
    expect(learning.solution).toBe('moved the token to the vault');
  });

  test('conversation import waits until the structured write finishes', async () => {
    process.env.JEV_RECALL_KEY = JEV_TEST_KEY;
    let releaseScore: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      releaseScore = resolve;
    });
    globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
      jevCalls.push(typeof init?.body === 'string' ? init.body : '');
      await gate;
      return new Response(JSON.stringify({ answers: { d0: jevChoice('keep') } }), { status: 200 });
    }) as typeof fetch;

    const dir = mkdtempSync(join(tmpdir(), 'recall-jev-import-'));
    try {
      const file = join(dir, 'claude.json');
      writeFileSync(file, JSON.stringify([{
        uuid: 'claude-jev',
        name: 'Claude export',
        chat_messages: [
          { sender: 'human', created_at: '2026-05-31T10:00:00Z', text: 'Please import this conversation.' },
          { sender: 'assistant', created_at: '2026-05-31T10:00:01Z', text: 'I can normalize it first.' },
        ],
      }]));
      let settled = false;
      const pending = importConversations(file, { format: 'claude-ai' }, {
        extractor: async () => `## DECISIONS MADE
- Use adapter normalization before persistence (confidence: HIGH)
`,
      });
      pending.then(() => { settled = true; }, () => { settled = true; });
      for (let step = 0; step < 10; step++) await Promise.resolve();
      expect(settled).toBe(false);
      expect(decisionCount()).toBe(0);
      releaseScore();
      const result = await pending;
      expect(result.structuredWrites.decisions).toBe(1);
      expect(decisionCount()).toBe(1);
      expect(jevCalls).toHaveLength(1);
      expect(jevCalls[0]).not.toContain('Please import this conversation.');
      expect(jevCalls[0]).toContain('Use adapter normalization before persistence (confidence: high)');
      expect(JSON.stringify(result)).not.toContain(JEV_TEST_KEY);
    } finally {
      releaseScore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
