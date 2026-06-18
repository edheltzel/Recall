// src/lib/repair.ts — unit coverage (issue #46).
//
// Behavior under test:
// - FTS health detection: ok / drift (count mismatch, missing triggers,
//   stale content) / missing-fts / missing-source
// - applyFtsRepair recreates missing indexes + triggers from canonical DDL
//   and rebuilds from source tables
// - embedding gap detection: missing rows, too-short eligibility, assistant
//   role filter, marked-duplicate exclusion
// - applyEmbedRepair: injectable embed fn, partial failure reporting
// - orphan/invariant checks are named and report-only
// - migration state report

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { getDb } from '../../src/db/connection';
import { MIGRATIONS } from '../../src/db/migrations';
import { FTS_SCHEMA } from '../../src/db/schema';
import { embeddingToBlob, type EmbeddingResult } from '../../src/lib/embeddings';
import {
  addBreadcrumb,
  addDecision,
  addMessage,
  createLoaEntry,
  createSession,
} from '../../src/lib/memory';
import {
  applyEmbedRepair,
  applyFtsRepair,
  checkAllFts,
  checkFts,
  checkMigrations,
  checkOrphans,
  countEmbedGaps,
  embeddingTextFor,
  EMBED_SOURCES,
  FTS_SOURCES,
  planRepair,
} from '../../src/lib/repair';

beforeEach(() => {
  setupTestDb();
});

afterEach(() => {
  teardownTestDb();
});

const CRUMB = 'Always use bun for every script in this repository, never npm.';

const okEmbed = async (): Promise<EmbeddingResult> =>
  ({ embedding: [1, 0, 0], model: 'test', dimensions: 3 });

function wipeIndex(ftsTable: string): void {
  getDb().prepare(`INSERT INTO ${ftsTable}(${ftsTable}) VALUES('delete-all')`).run();
}

function dropTriggers(prefix: string): void {
  const db = getDb();
  for (const suffix of ['ai', 'ad', 'au']) {
    db.exec(`DROP TRIGGER IF EXISTS ${prefix}_${suffix}`);
  }
}

function decisionConfig() {
  return EMBED_SOURCES.find(c => c.table === 'decisions')!;
}

describe('FTS health detection', () => {
  test('a fresh database reports every index ok', () => {
    const reports = checkAllFts(getDb());
    expect(reports.length).toBe(FTS_SOURCES.length);
    for (const report of reports) {
      expect(report.status).toBe('ok');
      expect(report.action).toBe('none');
    }
  });

  test('row-count mismatch is drift → rebuild', () => {
    addBreadcrumb({ content: CRUMB, importance: 5 });
    wipeIndex('breadcrumbs_fts');

    const report = checkFts(getDb(), 'breadcrumbs');
    expect(report.status).toBe('drift');
    expect(report.action).toBe('rebuild');
    expect(report.sourceRows).toBe(1);
    expect(report.indexedRows).toBe(0);
  });

  test('a locked DB during the integrity check is never reported consistent (#71)', () => {
    // In-sync index: counts and triggers match, so checkFts reaches the
    // integrity-check write — which is where a locked DB used to be swallowed
    // as "consistent".
    addBreadcrumb({ content: CRUMB, importance: 5 });
    expect(checkFts(getDb(), 'breadcrumbs').status).toBe('ok'); // sanity: in sync

    const dbPath = process.env.RECALL_DB_PATH!;

    // Hold the single WAL write lock on a separate connection.
    const locker = new Database(dbPath);
    locker.exec('PRAGMA journal_mode = WAL');
    locker.exec('PRAGMA busy_timeout = 0');
    locker.exec('BEGIN IMMEDIATE');

    // The check runs on its own connection with no busy timeout: WAL lets its
    // reads through, but the integrity-check write hits the held lock and
    // fails immediately with 'database is locked'.
    const checker = new Database(dbPath);
    checker.exec('PRAGMA journal_mode = WAL');
    checker.exec('PRAGMA busy_timeout = 0');

    try {
      const report = checkFts(checker, 'breadcrumbs');
      // Before the fix this returned 'ok' — the locked write was read as a
      // passing integrity check. It must surface as drift instead.
      expect(report.status).not.toBe('ok');
      expect(report.status).toBe('drift');
    } finally {
      checker.close();
      locker.exec('ROLLBACK');
      locker.close();
    }
  });

  test('missing sync triggers are drift even when counts match', () => {
    addBreadcrumb({ content: CRUMB, importance: 5 });
    dropTriggers('breadcrumbs');

    const report = checkFts(getDb(), 'breadcrumbs');
    expect(report.status).toBe('drift');
    expect(report.detail).toContain('trigger');
  });

  test('missing FTS table → create-and-rebuild', () => {
    dropTriggers('breadcrumbs');
    getDb().exec('DROP TABLE breadcrumbs_fts');

    const report = checkFts(getDb(), 'breadcrumbs');
    expect(report.status).toBe('missing-fts');
    expect(report.action).toBe('create-and-rebuild');
  });

  test('missing source table is report-only', () => {
    const db = getDb();
    dropTriggers('telos');
    db.exec('DROP TABLE telos_fts');
    db.exec('DROP TABLE telos');

    const report = checkFts(db, 'telos');
    expect(report.status).toBe('missing-source');
    expect(report.action).toBe('report-only');
    expect(report.detail).toContain('recall init');
  });

  test('stale index content with matching counts is detected via integrity-check', () => {
    const version = (getDb().prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;
    const [major, minor] = version.split('.').map(Number);
    if (major < 3 || (major === 3 && minor < 42)) {
      // External-content integrity-check needs SQLite >= 3.42; on older
      // builds detection degrades to count comparison by design.
      return;
    }

    const id = addBreadcrumb({ content: CRUMB, importance: 5 });
    dropTriggers('breadcrumbs');
    // Trigger-bypassing update: counts still match, index content is stale.
    getDb().prepare('UPDATE breadcrumbs SET content = ? WHERE id = ?')
      .run('Completely different content after the triggers were lost.', id);
    // Restore triggers so only the stale content (not trigger absence) drives
    // the verdict.
    getDb().exec(FTS_SCHEMA.breadcrumbs.createTriggers);

    const report = checkFts(getDb(), 'breadcrumbs');
    expect(report.status).toBe('drift');
  });
});

describe('applyFtsRepair', () => {
  test('rebuilds a wiped index from the source table', () => {
    addBreadcrumb({ content: CRUMB, importance: 5 });
    wipeIndex('breadcrumbs_fts');

    const plan = planRepair(getDb(), { embed: false });
    const result = applyFtsRepair(getDb(), plan);
    expect(result.rebuilt).toContain('breadcrumbs_fts');
    expect(result.failed.length).toBe(0);

    const indexed = getDb().prepare('SELECT COUNT(*) AS c FROM breadcrumbs_fts').get() as { c: number };
    expect(indexed.c).toBe(1);
    expect(checkFts(getDb(), 'breadcrumbs').status).toBe('ok');
  });

  test('recreates a missing index and its triggers, then rebuilds', () => {
    addBreadcrumb({ content: CRUMB, importance: 5 });
    dropTriggers('breadcrumbs');
    getDb().exec('DROP TABLE breadcrumbs_fts');

    const plan = planRepair(getDb(), { embed: false });
    const result = applyFtsRepair(getDb(), plan);
    expect(result.created).toContain('breadcrumbs_fts');
    expect(result.rebuilt).toContain('breadcrumbs_fts');

    // Pre-existing rows are searchable again and new writes are indexed
    // (triggers restored).
    expect(checkFts(getDb(), 'breadcrumbs').status).toBe('ok');
    addBreadcrumb({ content: 'A brand new breadcrumb written after the repair ran.', importance: 5 });
    expect(checkFts(getDb(), 'breadcrumbs').status).toBe('ok');
    const indexed = getDb().prepare('SELECT COUNT(*) AS c FROM breadcrumbs_fts').get() as { c: number };
    expect(indexed.c).toBe(2);
  });

  test('never touches source tables', () => {
    addBreadcrumb({ content: CRUMB, importance: 5, provenance: 'user_authored' });
    wipeIndex('breadcrumbs_fts');
    const before = getDb().prepare('SELECT * FROM breadcrumbs ORDER BY id').all();

    const plan = planRepair(getDb(), { embed: false });
    applyFtsRepair(getDb(), plan);

    const after = getDb().prepare('SELECT * FROM breadcrumbs ORDER BY id').all();
    expect(after).toEqual(before);
  });
});

describe('embedding gap detection', () => {
  test('counts rows missing embeddings and flags too-short text', () => {
    addDecision({ decision: 'Adopt SQLite WAL mode for every database connection.', status: 'active' });
    addDecision({ decision: 'no', status: 'active' }); // too short to embed

    const report = countEmbedGaps(getDb(), decisionConfig());
    expect(report.missing).toBe(2);
    expect(report.tooShort).toBe(1);
  });

  test('already-embedded rows are not gaps', () => {
    const id = addDecision({ decision: 'Adopt SQLite WAL mode for every database connection.', status: 'active' });
    getDb().prepare(
      `INSERT INTO embeddings (source_table, source_id, model, dimensions, embedding)
       VALUES ('decisions', ?, 'test', 3, ?)`
    ).run(id, embeddingToBlob([1, 0, 0]));

    const report = countEmbedGaps(getDb(), decisionConfig());
    expect(report.missing).toBe(0);
  });

  test('only assistant messages are embedding candidates', () => {
    createSession({ session_id: 's1', started_at: '2026-01-01T00:00:00Z' });
    addMessage({ session_id: 's1', timestamp: '2026-01-01T00:00:01Z', role: 'user', content: CRUMB });
    addMessage({ session_id: 's1', timestamp: '2026-01-01T00:00:02Z', role: 'assistant', content: CRUMB });

    const config = EMBED_SOURCES.find(c => c.table === 'messages')!;
    const report = countEmbedGaps(getDb(), config);
    expect(report.missing).toBe(1);
  });

  test('marked duplicates are excluded from gaps', () => {
    const survivor = addDecision({ decision: 'Adopt SQLite WAL mode for every database connection.', status: 'active' });
    const duplicate = addDecision({ decision: 'Adopt SQLite WAL mode for every DB connection always.', status: 'active' });
    getDb().prepare(`
      INSERT INTO dedup_lineage
        (survivor_table, survivor_id, duplicate_table, duplicate_id, reason, similarity, status, detail)
      VALUES ('decisions', ?, 'decisions', ?, 'semantic', 0.99, 'marked', '{}')
    `).run(survivor, duplicate);

    const report = countEmbedGaps(getDb(), decisionConfig());
    expect(report.missing).toBe(1);
  });
});

describe('applyEmbedRepair', () => {
  test('embeds missing rows via the injected embed fn', async () => {
    const id = addDecision({ decision: 'Adopt SQLite WAL mode for every database connection.', status: 'active' });

    const plan = planRepair(getDb());
    const result = await applyEmbedRepair(getDb(), plan, okEmbed);
    expect(result.embedded).toBe(1);
    expect(result.failed.length).toBe(0);

    const row = getDb().prepare(
      `SELECT model, dimensions FROM embeddings WHERE source_table = 'decisions' AND source_id = ?`
    ).get(id) as { model: string; dimensions: number };
    expect(row.model).toBe('test');
    expect(row.dimensions).toBe(3);
  });

  test('partial failure: failures are reported, successes persist, nothing is hidden', async () => {
    addDecision({ decision: 'Adopt SQLite WAL mode for every database connection.', status: 'active' });
    addDecision({ decision: 'POISON row that the embedding service rejects every time.', status: 'active' });
    addDecision({ decision: 'no', status: 'active' }); // too short — skipped

    const flaky = async (text: string): Promise<EmbeddingResult> => {
      if (text.includes('POISON')) throw new Error('boom');
      return okEmbed();
    };

    const plan = planRepair(getDb());
    const result = await applyEmbedRepair(getDb(), plan, flaky);
    expect(result.embedded).toBe(1);
    expect(result.skippedTooShort).toBe(1);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0].table).toBe('decisions');
    expect(result.failed[0].error).toContain('boom');

    const count = getDb().prepare('SELECT COUNT(*) AS c FROM embeddings').get() as { c: number };
    expect(count.c).toBe(1);
  });
});

describe('embeddingTextFor', () => {
  test('matches the per-table composition rules', () => {
    expect(embeddingTextFor('loa_entries', { title: 'T', fabric_extract: 'F' })).toBe('T\n\nF');
    expect(embeddingTextFor('decisions', { decision: 'D', reasoning: null })).toBe('D\n\nReasoning: N/A');
    expect(embeddingTextFor('learnings', { problem: 'P', solution: 'S' })).toBe('P\n\nSolution: S');
    expect(embeddingTextFor('messages', { content: 'C' })).toBe('C');
    expect(embeddingTextFor('unknown_table', { content: 'fallback' })).toBe('fallback');
  });
});

describe('orphan/invariant checks (report-only)', () => {
  test('clean database reports nothing', () => {
    expect(checkOrphans(getDb())).toEqual([]);
  });

  test('orphaned embeddings are reported with samples', () => {
    getDb().prepare(
      `INSERT INTO embeddings (source_table, source_id, model, dimensions, embedding)
       VALUES ('decisions', 9999, 'test', 3, ?)`
    ).run(embeddingToBlob([1, 0, 0]));

    const reports = checkOrphans(getDb());
    const orphan = reports.find(r => r.check === 'orphaned-embeddings:decisions');
    expect(orphan).toBeDefined();
    expect(orphan!.count).toBe(1);
    expect(orphan!.sample).toEqual(['decisions#9999']);
  });

  test('unknown embedding source tables are reported', () => {
    getDb().prepare(
      `INSERT INTO embeddings (source_table, source_id, model, dimensions, embedding)
       VALUES ('bogus', 1, 'test', 3, ?)`
    ).run(embeddingToBlob([1, 0, 0]));

    const reports = checkOrphans(getDb());
    const orphan = reports.find(r => r.check === 'unknown-embedding-source');
    expect(orphan?.count).toBe(1);
    expect(orphan?.sample).toEqual(['bogus#1']);
  });

  test('marked lineage with a missing duplicate row is reported', () => {
    const survivor = addBreadcrumb({ content: CRUMB, importance: 5 });
    getDb().prepare(`
      INSERT INTO dedup_lineage
        (survivor_table, survivor_id, duplicate_table, duplicate_id, reason, similarity, status, detail)
      VALUES ('breadcrumbs', ?, 'breadcrumbs', 4242, 'exact', 1.0, 'marked', '{}')
    `).run(survivor);

    const reports = checkOrphans(getDb());
    const orphan = reports.find(r => r.check === 'lineage-missing-duplicate:breadcrumbs');
    expect(orphan?.count).toBe(1);
  });

  test('messages without a session and broken LoA links are reported', () => {
    const db = getDb();
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare(`
      INSERT INTO messages (session_id, timestamp, role, content)
      VALUES ('ghost-session', '2026-01-01T00:00:00Z', 'user', 'orphaned message')
    `).run();
    db.prepare(`
      INSERT INTO loa_entries (title, fabric_extract, message_range_start, message_range_end, parent_loa_id)
      VALUES ('broken', 'body', 9991, 9992, 7777)
    `).run();
    db.exec('PRAGMA foreign_keys = ON');

    const checks = new Map(checkOrphans(db).map(r => [r.check, r]));
    expect(checks.get('messages-without-session')?.count).toBe(1);
    expect(checks.get('loa-broken-message-range')?.count).toBe(1);
    expect(checks.get('loa-broken-parent')?.count).toBe(1);
  });

  test('a healthy LoA lineage is not reported', () => {
    createSession({ session_id: 's1', started_at: '2026-01-01T00:00:00Z' });
    const m1 = addMessage({ session_id: 's1', timestamp: '2026-01-01T00:00:01Z', role: 'user', content: CRUMB });
    const parent = createLoaEntry({ title: 'parent', fabric_extract: 'body' });
    createLoaEntry({
      title: 'child', fabric_extract: 'body',
      message_range_start: m1, message_range_end: m1, parent_loa_id: parent,
    });

    expect(checkOrphans(getDb())).toEqual([]);
  });
});

describe('migration state', () => {
  test('up-to-date database reports zero pending', () => {
    const report = checkMigrations(getDb());
    expect(report.current).toBe(MIGRATIONS.length);
    expect(report.pending).toBe(0);
  });

  test('an un-migrated database reports pending migrations', () => {
    getDb().exec('PRAGMA user_version = 5');
    const report = checkMigrations(getDb());
    expect(report.current).toBe(5);
    expect(report.pending).toBe(MIGRATIONS.length - 5);
  });
});
