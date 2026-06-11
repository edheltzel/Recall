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
import { readFileSync } from 'fs';
import { join } from 'path';
import { Database } from 'bun:sqlite';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { runAddBreadcrumb, runAddDecision, runAddLearning } from '../../src/commands/add';
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

let dbPath: string;
const originalLog = console.log;

beforeEach(() => {
  dbPath = setupTestDb();
  console.log = () => {}; // add commands print confirmations; keep output clean
});

afterEach(() => {
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
  test('decisions and LoA entry from an extract are marked extracted', () => {
    createSession({ session_id: 'ext-1', started_at: '2026-01-01T00:00:00Z', project: 'demo' });

    const result = writeStructuredExtraction({
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
