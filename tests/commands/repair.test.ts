// recall repair — issue #46 acceptance criteria.
//
// Behavior under test:
// - dry-run by default: reports the plan, writes nothing
// - --execute rebuilds FTS5 indexes from source tables (drift + missing
//   index recreated from canonical DDL) and re-embeds missing embeddings
// - planned/applied actions reported with counts by table and repair type
// - embedding service unavailable: missing embeddings reported, command
//   still exits successfully (diagnostic path)
// - partial embedding repair reports skipped rows and failures
// - orphan/invariant problems are report-only — never auto-repaired
// - repair never hard-deletes rows, never changes Record Provenance
// - --table scopes the run; invalid --table is rejected
// - doctor recommends repair but doctor --fix never runs data repair

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { dirname, join } from 'path';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { closeDb, getDb } from '../../src/db/connection';
import {
  CREATE_TABLES,
  CREATE_INDEXES,
  CREATE_FTS,
  CREATE_FTS_TRIGGERS,
  CREATE_VECTOR_TABLES,
} from '../../src/db/schema';
import { runRepair, type RepairDeps } from '../../src/commands/repair';
import { checkFtsIndexes } from '../../src/commands/doctor';
import { checkFts } from '../../src/lib/repair';
import { embeddingToBlob, type EmbeddingResult } from '../../src/lib/embeddings';
import {
  addBreadcrumb,
  addDecision,
  addLearning,
  addMessage,
  createLoaEntry,
  createSession,
  search,
} from '../../src/lib/memory';

const originalLog = console.log;
const originalError = console.error;
const originalExitCode = process.exitCode;

beforeEach(() => {
  setupTestDb();
  console.log = () => {};
  console.error = () => {};
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  // Bun silently ignores assigning undefined to process.exitCode, so a bare
  // restore would leave a poisoned exit code behind (CI-red with 0 failures).
  process.exitCode = originalExitCode ?? 0;
  teardownTestDb();
});

const CRUMB = 'Always use bun for every script in this repository, never npm.';

const okEmbed = async (): Promise<EmbeddingResult> =>
  ({ embedding: [1, 0, 0], model: 'test', dimensions: 3 });

const upDeps: RepairDeps = {
  checkService: async () => ({ available: true, model: 'test', url: 'http://test' }),
  embedFn: okEmbed,
};

const downDeps: RepairDeps = {
  checkService: async () => ({ available: false, model: 'test', url: 'http://test' }),
  embedFn: async () => { throw new Error('service is down — embedFn must never be called'); },
};

function wipeIndex(ftsTable: string): void {
  getDb().prepare(`INSERT INTO ${ftsTable}(${ftsTable}) VALUES('delete-all')`).run();
}

function dropTriggers(prefix: string): void {
  const db = getDb();
  for (const suffix of ['ai', 'ad', 'au']) {
    db.exec(`DROP TRIGGER IF EXISTS ${prefix}_${suffix}`);
  }
}

function embeddingsCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS c FROM embeddings').get() as { c: number }).c;
}

describe('dry-run vs execute', () => {
  test('dry-run reports the plan and writes nothing', async () => {
    addBreadcrumb({ content: CRUMB, importance: 5 });
    addDecision({ decision: 'Adopt SQLite WAL mode for every database connection.', status: 'active' });
    wipeIndex('breadcrumbs_fts');

    const result = (await runRepair({}, upDeps))!;

    // The plan reports the drift and the embedding gap...
    const crumbs = result.plan.fts.find(f => f.source === 'breadcrumbs')!;
    expect(crumbs.status).toBe('drift');
    expect(crumbs.action).toBe('rebuild');
    const decisionGap = result.plan.embedGaps.find(g => g.table === 'decisions')!;
    expect(decisionGap.missing).toBe(1);

    // ...but nothing was repaired.
    expect(result.fts).toBeNull();
    expect(result.embeddings).toBeNull();
    expect(checkFts(getDb(), 'breadcrumbs').status).toBe('drift');
    expect(embeddingsCount()).toBe(0);
    expect(search('bun').length).toBe(0); // index still broken
  });

  test('--execute rebuilds a drifted index and search works again', async () => {
    addBreadcrumb({ content: CRUMB, importance: 5 });
    wipeIndex('breadcrumbs_fts');
    expect(search('bun').length).toBe(0);

    const result = (await runRepair({ execute: true, embed: false }))!;
    expect(result.fts?.rebuilt).toContain('breadcrumbs_fts');
    expect(result.fts?.failed.length).toBe(0);
    expect(search('bun').length).toBe(1);
    expect(process.exitCode).not.toBe(1);
  });

  test('--execute recreates a missing index (un-migrated DB gap) and restores sync triggers', async () => {
    addBreadcrumb({ content: CRUMB, importance: 5 });
    dropTriggers('breadcrumbs');
    getDb().exec('DROP TABLE breadcrumbs_fts');

    const result = (await runRepair({ execute: true, embed: false }))!;
    expect(result.fts?.created).toContain('breadcrumbs_fts');
    expect(result.fts?.rebuilt).toContain('breadcrumbs_fts');

    // Old rows searchable again, and new writes are indexed via the
    // recreated triggers.
    expect(search('bun').length).toBe(1);
    addBreadcrumb({ content: 'Another breadcrumb about bun written after repair.', importance: 5 });
    expect(search('bun').length).toBe(2);
  });

  test('reports planned and applied actions with counts by table and repair type', async () => {
    addBreadcrumb({ content: CRUMB, importance: 5 });
    wipeIndex('breadcrumbs_fts');
    addDecision({ decision: 'Adopt SQLite WAL mode for every database connection.', status: 'active' });

    const result = (await runRepair({ execute: true }, upDeps))!;

    // Per-table FTS reports carry status, action, and row counts.
    for (const report of result.plan.fts) {
      expect(typeof report.status).toBe('string');
      expect(typeof report.action).toBe('string');
      expect(report.sourceRows).not.toBeNull();
    }
    // Per-table embedding gaps + applied counts by repair type.
    expect(result.plan.embedGaps.find(g => g.table === 'decisions')?.missing).toBe(1);
    expect(result.fts?.rebuilt).toEqual(['breadcrumbs_fts']);
    expect(result.embeddings?.embedded).toBe(1);
  });
});

describe('embedding repair', () => {
  test('embedding service unavailable: reports missing embeddings, exits successfully', async () => {
    addDecision({ decision: 'Adopt SQLite WAL mode for every database connection.', status: 'active' });

    const result = (await runRepair({ execute: true }, downDeps))!;
    expect(result.embedSkipped).toContain('unavailable');
    expect(result.embeddings).toBeNull();
    expect(embeddingsCount()).toBe(0);
    // Diagnostic path: not a failure.
    expect(process.exitCode).not.toBe(1);
  });

  test('embedding service unavailable does not mask an FTS repair that succeeded', async () => {
    addBreadcrumb({ content: CRUMB, importance: 5 });
    addDecision({ decision: 'Adopt SQLite WAL mode for every database connection.', status: 'active' });
    wipeIndex('breadcrumbs_fts');

    const result = (await runRepair({ execute: true }, downDeps))!;
    expect(result.fts?.rebuilt).toContain('breadcrumbs_fts');
    expect(search('bun').length).toBe(1);
    expect(process.exitCode).not.toBe(1);
  });

  test('partial success: failures and skipped rows are reported, successes persist', async () => {
    addDecision({ decision: 'Adopt SQLite WAL mode for every database connection.', status: 'active' });
    addDecision({ decision: 'POISON row that the embedding service rejects every time.', status: 'active' });
    addDecision({ decision: 'no', status: 'active' }); // too short to embed

    const flakyDeps: RepairDeps = {
      ...upDeps,
      embedFn: async (text) => {
        if (text.includes('POISON')) throw new Error('boom');
        return okEmbed();
      },
    };

    const result = (await runRepair({ execute: true }, flakyDeps))!;
    expect(result.embeddings?.embedded).toBe(1);
    expect(result.embeddings?.skippedTooShort).toBe(1);
    expect(result.embeddings?.failed.length).toBe(1);
    expect(result.embeddings?.failed[0].error).toContain('boom');
    expect(embeddingsCount()).toBe(1);
  });

  test('--no-embed skips the embedding pass entirely', async () => {
    addDecision({ decision: 'Adopt SQLite WAL mode for every database connection.', status: 'active' });

    const result = (await runRepair({ execute: true, embed: false }))!;
    expect(result.embedSkipped).toContain('--no-embed');
    expect(result.plan.embedGaps.length).toBe(0);
    expect(embeddingsCount()).toBe(0);
  });

  test('covers loa_entries, learnings, and assistant messages', async () => {
    createSession({ session_id: 's1', started_at: '2026-01-01T00:00:00Z' });
    addMessage({ session_id: 's1', timestamp: '2026-01-01T00:00:01Z', role: 'assistant', content: CRUMB });
    addMessage({ session_id: 's1', timestamp: '2026-01-01T00:00:02Z', role: 'user', content: CRUMB });
    addLearning({ problem: 'FTS index drifted after manual surgery on the database.', solution: 'Run recall repair.' });
    createLoaEntry({ title: 'Entry', fabric_extract: 'A fabric extract long enough to embed.' });

    const result = (await runRepair({ execute: true }, upDeps))!;
    expect(result.embeddings?.embedded).toBe(3); // assistant message + learning + loa
    const tables = getDb().prepare('SELECT DISTINCT source_table FROM embeddings ORDER BY source_table').all() as Array<{ source_table: string }>;
    expect(tables.map(t => t.source_table)).toEqual(['learnings', 'loa_entries', 'messages']);
  });
});

describe('safety invariants', () => {
  test('repair never hard-deletes rows', async () => {
    createSession({ session_id: 's1', started_at: '2026-01-01T00:00:00Z' });
    addMessage({ session_id: 's1', timestamp: '2026-01-01T00:00:01Z', role: 'assistant', content: CRUMB });
    addDecision({ decision: 'Adopt SQLite WAL mode for every database connection.', status: 'active' });
    addLearning({ problem: 'A problem statement long enough to be embedded.', solution: 'A fix.' });
    addBreadcrumb({ content: CRUMB, importance: 5 });
    createLoaEntry({ title: 'Entry', fabric_extract: 'A fabric extract long enough to embed.' });
    const db = getDb();
    db.prepare(`INSERT INTO telos (code, type, title, content) VALUES ('G0', 'goal', 'Goal', 'Telos content')`).run();
    db.prepare(`INSERT INTO documents (path, title, type, content) VALUES ('/tmp/d.md', 'Doc', 'reference', 'Document body')`).run();
    // Orphaned embedding — reported, must never be deleted.
    db.prepare(
      `INSERT INTO embeddings (source_table, source_id, model, dimensions, embedding)
       VALUES ('decisions', 9999, 'test', 3, ?)`
    ).run(embeddingToBlob([1, 0, 0]));
    wipeIndex('messages_fts');

    const tables = ['sessions', 'messages', 'decisions', 'learnings', 'breadcrumbs', 'loa_entries', 'telos', 'documents', 'dedup_lineage'];
    const before = tables.map(t => (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c);
    const embeddingsBefore = embeddingsCount();

    await runRepair({ execute: true }, upDeps);

    const after = tables.map(t => (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c);
    expect(after).toEqual(before);
    // Embeddings may only grow (re-embed), never shrink.
    expect(embeddingsCount()).toBeGreaterThanOrEqual(embeddingsBefore);
  });

  test('repair never changes Record Provenance', async () => {
    addBreadcrumb({ content: CRUMB, importance: 5, provenance: 'user_authored' });
    addBreadcrumb({ content: `${CRUMB} (second)`, importance: 5, provenance: 'extracted' });
    addDecision({ decision: 'Adopt SQLite WAL mode for every database connection.', status: 'active', provenance: 'verbatim' });
    addLearning({ problem: 'A problem statement long enough to be embedded.', solution: 'A fix.' }); // NULL provenance
    wipeIndex('breadcrumbs_fts');
    wipeIndex('decisions_fts');

    const db = getDb();
    const snapshot = () => ({
      breadcrumbs: db.prepare('SELECT id, provenance FROM breadcrumbs ORDER BY id').all(),
      decisions: db.prepare('SELECT id, provenance FROM decisions ORDER BY id').all(),
      learnings: db.prepare('SELECT id, provenance FROM learnings ORDER BY id').all(),
    });
    const before = snapshot();

    await runRepair({ execute: true }, upDeps);

    expect(snapshot()).toEqual(before);
  });

  test('orphan problems are reported but never auto-repaired', async () => {
    getDb().prepare(
      `INSERT INTO embeddings (source_table, source_id, model, dimensions, embedding)
       VALUES ('decisions', 9999, 'test', 3, ?)`
    ).run(embeddingToBlob([1, 0, 0]));

    const result = (await runRepair({ execute: true }, upDeps))!;
    const orphan = result.plan.orphans.find(r => r.check === 'orphaned-embeddings:decisions');
    expect(orphan?.count).toBe(1);

    // Still there after execute — repair only reports it.
    const remaining = getDb().prepare(
      `SELECT COUNT(*) AS c FROM embeddings WHERE source_table = 'decisions' AND source_id = 9999`
    ).get() as { c: number };
    expect(remaining.c).toBe(1);
  });

  test('a genuine pre-dedup legacy database does not crash and reports pending migrations', async () => {
    // Build the schema an install older than the dedup migration actually
    // has: full DDL of its era but no dedup_lineage table (that DDL ships
    // via `recall init` on current versions; getDb() runs no DDL at all).
    // PRAGMA user_version on a current schema would not reproduce this.
    const legacyPath = join(dirname(process.env.RECALL_DB_PATH!), 'legacy.db');
    closeDb();
    const legacy = new Database(legacyPath);
    legacy.exec(CREATE_TABLES);
    legacy.exec(CREATE_INDEXES);
    legacy.exec(CREATE_FTS);
    legacy.exec(CREATE_FTS_TRIGGERS);
    legacy.exec(CREATE_VECTOR_TABLES);
    legacy.exec('DROP TABLE dedup_lineage');
    legacy.exec('PRAGMA user_version = 9');
    legacy.prepare(
      `INSERT INTO decisions (decision, status) VALUES ('Adopt SQLite WAL mode for every database connection.', 'active')`
    ).run();
    legacy.close();
    process.env.RECALL_DB_PATH = legacyPath;

    // Plain dry-run — the path that crashed with a raw SQLiteError when the
    // embed gap query referenced the missing dedup_lineage table.
    const result = (await runRepair({}, upDeps))!;

    // The plan completes: the recall init recommendation can actually print.
    expect(result.plan.migrations.pending).toBeGreaterThan(0);
    // The embed pass still reports gaps — without the exclusion clause,
    // since nothing can be marked as a duplicate on this schema.
    expect(result.plan.embedGaps.find(g => g.table === 'decisions')?.missing).toBe(1);
    expect(process.exitCode).not.toBe(1);
  });
});

describe('scoping and validation', () => {
  test('--table scopes the FTS and embedding passes', async () => {
    addBreadcrumb({ content: CRUMB, importance: 5 });
    createSession({ session_id: 's1', started_at: '2026-01-01T00:00:00Z' });
    addMessage({ session_id: 's1', timestamp: '2026-01-01T00:00:01Z', role: 'assistant', content: CRUMB });
    wipeIndex('breadcrumbs_fts');
    wipeIndex('messages_fts');

    const result = (await runRepair({ execute: true, table: 'breadcrumbs' }, upDeps))!;
    expect(result.plan.fts.length).toBe(1);
    expect(result.plan.fts[0].source).toBe('breadcrumbs');
    expect(result.plan.embedGaps.length).toBe(0); // breadcrumbs carry no embeddings

    // The scoped table is repaired; the out-of-scope one is untouched.
    expect(checkFts(getDb(), 'breadcrumbs').status).toBe('ok');
    expect(checkFts(getDb(), 'messages').status).toBe('drift');
  });

  test('invalid --table is rejected', async () => {
    expect(await runRepair({ table: 'sessions' })).toBeUndefined();
    expect(process.exitCode).toBe(1);
  });
});

describe('doctor separation (issue #46)', () => {
  test('doctor detects drift and recommends recall repair without touching data', () => {
    addBreadcrumb({ content: CRUMB, importance: 5 });
    wipeIndex('breadcrumbs_fts');

    const check = checkFtsIndexes();
    expect(check.status).toBe('WARN');
    expect(check.message).toContain('recall repair');

    // The check is read-only: the drift is still there afterwards. Doctor's
    // --fix loop only iterates symlink probes, so data repair can never run
    // implicitly — repairing requires an explicit `recall repair --execute`.
    expect(checkFts(getDb(), 'breadcrumbs').status).toBe('drift');
  });

  test('doctor reports PASS when indexes are in sync', () => {
    addBreadcrumb({ content: CRUMB, importance: 5 });
    const check = checkFtsIndexes();
    expect(check.status).toBe('PASS');
  });
});
