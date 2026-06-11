// recall provenance backfill — conservative legacy classification (issue #42, ADR-0001).
//
// Binding rules under test:
// - dry-run is the default and writes nothing
// - --execute only sets provenance where deterministic evidence exists
// - rows without evidence stay NULL (unknown), never guessed
// - rows that already have provenance are never overwritten
// - user_authored is never assigned by backfill

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { runProvenanceBackfill } from '../../src/commands/provenance';
import {
  createSession,
  addMessage,
  addDecision,
  addLearning,
  addBreadcrumb,
  createLoaEntry,
} from '../../src/lib/memory';

let dbPath: string;
const originalLog = console.log;

beforeEach(() => {
  dbPath = setupTestDb();
  console.log = () => {}; // backfill prints a report; keep test output clean
});

afterEach(() => {
  console.log = originalLog;
  teardownTestDb();
});

function readDb(): Database {
  return new Database(dbPath, { readonly: true });
}

/** Seeds one legacy (NULL-provenance) landscape across all five tables. */
function seedLegacyRows(): void {
  createSession({ session_id: 's1', started_at: '2026-01-01T00:00:00Z', project: 'demo' });

  // messages: all legacy rows are deterministic 'verbatim'
  addMessage({ session_id: 's1', timestamp: '2026-01-01T00:00:01Z', role: 'user', content: 'legacy message' });

  // decisions: evidence marker is category = 'auto-extracted'
  addDecision({ session_id: 's1', decision: 'extracted decision', category: 'auto-extracted', status: 'active' });
  addDecision({ session_id: 's1', decision: 'unmarked decision', category: 'manual', status: 'active' });
  addDecision({ session_id: 's1', decision: 'already stamped', status: 'active', provenance: 'user_authored' });

  // learnings: evidence marker is category = 'auto-extracted'
  addLearning({ session_id: 's1', problem: 'extracted problem', solution: 'fix', category: 'auto-extracted' });
  addLearning({ session_id: 's1', problem: 'unmarked problem', solution: 'fix', category: 'other' });

  // breadcrumbs: evidence marker is category = 'extracted-idea'
  addBreadcrumb({ session_id: 's1', content: 'extracted idea', category: 'extracted-idea', importance: 5 });
  addBreadcrumb({ session_id: 's1', content: 'unmarked note', category: 'note', importance: 5 });

  // loa_entries: all legacy rows are deterministic 'extracted'
  createLoaEntry({ title: 'legacy loa', fabric_extract: 'extract body', session_id: 's1' });
}

describe('runProvenanceBackfill — dry run (default)', () => {
  test('reports classifications without writing anything', () => {
    seedLegacyRows();

    const results = runProvenanceBackfill({});

    expect(results.length).toBe(5);
    const byTable = Object.fromEntries(results.map(r => [r.table, r]));
    expect(byTable.messages.classified).toBe(1);
    expect(byTable.messages.value).toBe('verbatim');
    expect(byTable.loa_entries.classified).toBe(1);
    expect(byTable.loa_entries.value).toBe('extracted');
    // only the evidence-marked rows qualify; pre-stamped row is not "unknown"
    expect(byTable.decisions.unknownBefore).toBe(2);
    expect(byTable.decisions.classified).toBe(1);
    expect(byTable.decisions.remainingUnknown).toBe(1);
    expect(byTable.learnings.classified).toBe(1);
    expect(byTable.breadcrumbs.classified).toBe(1);

    // Nothing was written
    const db = readDb();
    const nullCount = (table: string) =>
      (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE provenance IS NULL`).get() as { c: number }).c;
    expect(nullCount('messages')).toBe(1);
    expect(nullCount('decisions')).toBe(2);
    expect(nullCount('learnings')).toBe(2);
    expect(nullCount('breadcrumbs')).toBe(2);
    expect(nullCount('loa_entries')).toBe(1);
    db.close();
  });
});

describe('runProvenanceBackfill — execute', () => {
  test('classifies only evidence-backed rows; the rest stay NULL', () => {
    seedLegacyRows();

    runProvenanceBackfill({ dryRun: false });

    const db = readDb();
    const provenanceOf = (table: string, where: string) =>
      (db.prepare(`SELECT provenance FROM ${table} WHERE ${where}`).get() as any)?.provenance;

    expect(provenanceOf('messages', "content = 'legacy message'")).toBe('verbatim');
    expect(provenanceOf('loa_entries', "title = 'legacy loa'")).toBe('extracted');

    expect(provenanceOf('decisions', "decision = 'extracted decision'")).toBe('extracted');
    expect(provenanceOf('decisions', "decision = 'unmarked decision'")).toBeNull();
    // never overwritten, and user_authored is never assigned by backfill
    expect(provenanceOf('decisions', "decision = 'already stamped'")).toBe('user_authored');

    expect(provenanceOf('learnings', "problem = 'extracted problem'")).toBe('extracted');
    expect(provenanceOf('learnings', "problem = 'unmarked problem'")).toBeNull();

    expect(provenanceOf('breadcrumbs', "content = 'extracted idea'")).toBe('extracted');
    expect(provenanceOf('breadcrumbs', "content = 'unmarked note'")).toBeNull();
    db.close();
  });

  test('is idempotent: a second execute classifies nothing new', () => {
    seedLegacyRows();
    runProvenanceBackfill({ dryRun: false });

    const second = runProvenanceBackfill({ dryRun: false });
    for (const r of second) {
      expect(r.classified).toBe(0);
    }
  });

  test('table filter limits the run to one table', () => {
    seedLegacyRows();

    const results = runProvenanceBackfill({ dryRun: false, table: 'decisions' });

    expect(results.length).toBe(1);
    expect(results[0].table).toBe('decisions');

    const db = readDb();
    // messages untouched by a decisions-only run
    const msg = db.prepare("SELECT provenance FROM messages WHERE content = 'legacy message'").get() as any;
    expect(msg.provenance).toBeNull();
    db.close();
  });
});

describe('runProvenanceBackfill — input validation', () => {
  const originalExitCode = process.exitCode;
  const originalError = console.error;

  afterEach(() => {
    process.exitCode = originalExitCode ?? 0;
    console.error = originalError;
  });

  test('rejects an unknown table', () => {
    let errorOutput = '';
    console.error = (msg?: unknown) => {
      errorOutput += String(msg);
    };

    const results = runProvenanceBackfill({ table: 'sessions' as any });

    expect(results).toEqual([]);
    expect(errorOutput).toContain('Unknown table: sessions');
    expect(process.exitCode).toBe(1);
  });
});
