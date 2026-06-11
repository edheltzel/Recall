// recall dedup — issue #45 acceptance criteria.
//
// Behavior under test:
// - dry-run by default: reports the plan, writes nothing
// - --execute marks duplicates in dedup_lineage; records stay intact
// - exact/normalized duplicate detection within table + project
// - survivor priority user_authored > verbatim > extracted > derived > unknown
// - semantic pass uses stored embeddings only; skipped (and reported) when
//   none exist; threshold respected, below-threshold never merged
// - idempotence: a second execute finds nothing new
// - cross-table candidates are report-only
// - search hides marked duplicates by default; --include-duplicates shows them
// - lineage rows persist full audit detail
// - --delete (destructive opt-in) removes rows + embeddings; FK-referenced
//   duplicates are kept as marked instead of failing the transaction

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { runDedup } from '../../src/commands/dedup';
import { embeddingToBlob } from '../../src/lib/embeddings';
import { getDb } from '../../src/db/connection';
import { search } from '../../src/lib/memory';
import {
  createSession,
  addMessage,
  addDecision,
  addBreadcrumb,
  createLoaEntry,
  supersedeDecision,
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
  process.exitCode = originalExitCode;
  teardownTestDb();
});

// Long enough to clear MIN_DEDUP_TEXT_LENGTH after normalization.
const CRUMB = 'Always use bun for every script in this repository, never npm.';
const OTHER = 'A completely different breadcrumb about the release process.';

function lineageRows(): Array<Record<string, unknown>> {
  return getDb().prepare('SELECT * FROM dedup_lineage ORDER BY id').all() as Array<Record<string, unknown>>;
}

function insertEmbedding(table: string, id: number, vector: number[]): void {
  getDb().prepare(
    `INSERT OR REPLACE INTO embeddings (source_table, source_id, model, dimensions, embedding)
     VALUES (?, ?, 'test', ?, ?)`
  ).run(table, id, vector.length, embeddingToBlob(vector));
}

describe('dry-run vs execute', () => {
  test('dry-run reports the plan and writes nothing', () => {
    addBreadcrumb({ content: CRUMB, importance: 5 });
    addBreadcrumb({ content: CRUMB, importance: 5 });
    addBreadcrumb({ content: OTHER, importance: 5 });

    const result = runDedup({})!;
    const crumbs = result.plan.tables.find(t => t.table === 'breadcrumbs')!;
    expect(crumbs.exactGroups).toBe(1);
    expect(crumbs.planned.length).toBe(1);
    expect(result.applied).toBeNull();
    expect(lineageRows().length).toBe(0);
    expect(search('breadcrumb OR bun').length).toBe(3);
  });

  test('--execute marks duplicates non-destructively and search hides them', () => {
    const id1 = addBreadcrumb({ content: CRUMB, importance: 5 });
    const id2 = addBreadcrumb({ content: CRUMB, importance: 5 });

    const result = runDedup({ execute: true })!;
    expect(result.applied?.marked).toBe(1);

    // Non-destructive: both records still exist.
    const count = getDb().prepare('SELECT COUNT(*) AS c FROM breadcrumbs').get() as { c: number };
    expect(count.c).toBe(2);

    // Search hides the marked duplicate by default...
    const hidden = search('bun');
    expect(hidden.length).toBe(1);
    // ...and shows it again with the explicit include option.
    const shown = search('bun', { includeDuplicates: true });
    expect(shown.length).toBe(2);
    expect(shown.map(r => r.id).sort()).toEqual([id1, id2].sort());
  });

  test('--delete without --execute is rejected', () => {
    expect(runDedup({ delete: true })).toBeUndefined();
    expect(process.exitCode).toBe(1);
  });
});

describe('exact detection and survivor selection', () => {
  test('normalized variants dedupe; provenance picks the survivor', () => {
    const extracted = addBreadcrumb({ content: CRUMB, importance: 9, provenance: 'extracted' });
    const authored = addBreadcrumb({ content: CRUMB.toUpperCase(), importance: 1, provenance: 'user_authored' });
    const legacy = addBreadcrumb({ content: `  ${CRUMB}  `, importance: 9 });

    runDedup({ execute: true });

    const rows = lineageRows();
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.survivor_id).toBe(authored);
      expect(row.survivor_table).toBe('breadcrumbs');
      expect(row.reason).toBe('exact');
      expect(row.status).toBe('marked');
    }
    expect(rows.map(r => r.duplicate_id).sort()).toEqual([extracted, legacy].sort());
  });

  test('identical text in different projects is not deduped', () => {
    addBreadcrumb({ content: CRUMB, importance: 5, project: 'alpha' });
    addBreadcrumb({ content: CRUMB, importance: 5, project: 'beta' });
    const result = runDedup({ execute: true })!;
    expect(result.applied?.marked).toBe(0);
  });

  test('short records are never candidates', () => {
    addBreadcrumb({ content: 'ok', importance: 5 });
    addBreadcrumb({ content: 'ok', importance: 5 });
    const result = runDedup({})!;
    const crumbs = result.plan.tables.find(t => t.table === 'breadcrumbs')!;
    expect(crumbs.tooShort).toBe(2);
    expect(crumbs.planned.length).toBe(0);
  });

  test('only active decisions participate', () => {
    const text = 'Adopt SQLite WAL mode for every database connection in Recall.';
    const stale = addDecision({ decision: text, status: 'active' });
    supersedeDecision(stale);
    addDecision({ decision: text, status: 'active' });

    const result = runDedup({ execute: true })!;
    expect(result.applied?.marked).toBe(0);
  });

  test('--table scopes the run', () => {
    addBreadcrumb({ content: CRUMB, importance: 5 });
    addBreadcrumb({ content: CRUMB, importance: 5 });
    createSession({ session_id: 's1', started_at: '2026-01-01T00:00:00Z' });
    addMessage({ session_id: 's1', timestamp: '2026-01-01T00:00:01Z', role: 'user', content: CRUMB });
    addMessage({ session_id: 's1', timestamp: '2026-01-01T00:00:02Z', role: 'user', content: CRUMB });

    const result = runDedup({ execute: true, table: 'messages' })!;
    expect(result.plan.tables.length).toBe(1);
    expect(result.applied?.marked).toBe(1);
    expect(lineageRows().every(r => r.duplicate_table === 'messages')).toBe(true);
  });

  test('invalid --table and --threshold are rejected', () => {
    expect(runDedup({ table: 'sessions' })).toBeUndefined();
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(runDedup({ threshold: 1.5 })).toBeUndefined();
    expect(process.exitCode).toBe(1);
  });
});

describe('semantic pass', () => {
  test('skipped with a clear reason when no embeddings exist', () => {
    addBreadcrumb({ content: CRUMB, importance: 5 });
    addBreadcrumb({ content: OTHER, importance: 5 });
    const result = runDedup({})!;
    expect(result.plan.semanticSkipped).toContain('embed');
  });

  test('skipped when disabled via --no-semantic', () => {
    addBreadcrumb({ content: CRUMB, importance: 5 });
    const result = runDedup({ semantic: false })!;
    expect(result.plan.semanticSkipped).toContain('--no-semantic');
  });

  test('marks pairs at the threshold, never below it', () => {
    const near = Math.sqrt(1 - 0.97 * 0.97);
    const a = addBreadcrumb({ content: CRUMB, importance: 5 });
    const b = addBreadcrumb({ content: OTHER, importance: 5 });
    insertEmbedding('breadcrumbs', a, [1, 0, 0]);
    insertEmbedding('breadcrumbs', b, [0.97, near, 0]);

    // Above the default 0.95 threshold → marked, with similarity recorded.
    const marked = runDedup({ execute: true })!;
    expect(marked.applied?.marked).toBe(1);
    const row = lineageRows()[0];
    expect(row.reason).toBe('semantic');
    expect(row.similarity as number).toBeCloseTo(0.97, 3);

    // Survivor is the richer record (longer normalized text wins the tie).
    const longer = CRUMB.length >= OTHER.length ? a : b;
    expect(row.survivor_id).toBe(longer);
  });

  test('a stricter threshold leaves the same pair untouched', () => {
    const near = Math.sqrt(1 - 0.97 * 0.97);
    const a = addBreadcrumb({ content: CRUMB, importance: 5 });
    const b = addBreadcrumb({ content: OTHER, importance: 5 });
    insertEmbedding('breadcrumbs', a, [1, 0, 0]);
    insertEmbedding('breadcrumbs', b, [0.97, near, 0]);

    const result = runDedup({ execute: true, threshold: 0.99 })!;
    expect(result.applied?.marked).toBe(0);
    expect(lineageRows().length).toBe(0);
  });
});

describe('idempotence', () => {
  test('a second execute finds nothing new', () => {
    addBreadcrumb({ content: CRUMB, importance: 5 });
    addBreadcrumb({ content: CRUMB, importance: 5 });
    addBreadcrumb({ content: CRUMB, importance: 5 });

    const first = runDedup({ execute: true })!;
    expect(first.applied?.marked).toBe(2);
    const after = lineageRows().length;

    const second = runDedup({ execute: true })!;
    expect(second.applied?.marked).toBe(0);
    const crumbs = second.plan.tables.find(t => t.table === 'breadcrumbs')!;
    expect(crumbs.alreadyMarked).toBe(2);
    expect(lineageRows().length).toBe(after);
  });
});

describe('cross-table candidates are report-only', () => {
  test('reported, never marked', () => {
    createSession({ session_id: 's1', started_at: '2026-01-01T00:00:00Z' });
    addMessage({ session_id: 's1', timestamp: '2026-01-01T00:00:01Z', role: 'user', content: CRUMB });
    addBreadcrumb({ content: CRUMB, importance: 5 });

    const result = runDedup({ execute: true })!;
    expect(result.plan.crossTable.textMatches.length).toBe(1);
    expect(result.applied?.marked).toBe(0);
    expect(lineageRows().length).toBe(0);
    // Both records remain searchable.
    expect(search('bun').length).toBe(2);
  });
});

describe('lineage persistence', () => {
  test('rows carry full audit detail', () => {
    const survivor = addBreadcrumb({ content: CRUMB, importance: 5, provenance: 'user_authored', project: 'demo' });
    const dup = addBreadcrumb({ content: CRUMB, importance: 5, provenance: 'extracted', project: 'demo' });

    runDedup({ execute: true });

    const row = lineageRows()[0];
    expect(row.survivor_table).toBe('breadcrumbs');
    expect(row.survivor_id).toBe(survivor);
    expect(row.duplicate_table).toBe('breadcrumbs');
    expect(row.duplicate_id).toBe(dup);
    expect(row.reason).toBe('exact');
    expect(row.similarity).toBe(1);
    expect(row.status).toBe('marked');
    expect(typeof row.created_at).toBe('string');
    const detail = JSON.parse(row.detail as string);
    expect(detail.survivor_provenance).toBe('user_authored');
    expect(detail.duplicate_provenance).toBe('extracted');
    expect(detail.project).toBe('demo');
  });
});

describe('destructive opt-in (--execute --delete)', () => {
  test('deletes duplicates and their embeddings; lineage records the deletion', () => {
    const survivor = addBreadcrumb({ content: CRUMB, importance: 5, provenance: 'user_authored' });
    const dup = addBreadcrumb({ content: CRUMB, importance: 5 });
    insertEmbedding('breadcrumbs', dup, [1, 0, 0]);

    const result = runDedup({ execute: true, delete: true })!;
    expect(result.applied?.deleted).toBe(1);

    const db = getDb();
    const remaining = db.prepare('SELECT id FROM breadcrumbs').all() as Array<{ id: number }>;
    expect(remaining.map(r => r.id)).toEqual([survivor]);
    const embeddings = db.prepare('SELECT COUNT(*) AS c FROM embeddings').get() as { c: number };
    expect(embeddings.c).toBe(0);
    expect(lineageRows()[0].status).toBe('deleted');
  });

  test('FK-referenced duplicates are kept as marked instead of failing', () => {
    createSession({ session_id: 's1', started_at: '2026-01-01T00:00:00Z' });
    const survivor = addMessage({ session_id: 's1', timestamp: '2026-01-02T00:00:00Z', role: 'user', content: CRUMB });
    const referenced = addMessage({ session_id: 's1', timestamp: '2026-01-01T00:00:00Z', role: 'user', content: CRUMB });
    // The older message loses survivorship (recency tie-break) but is pinned
    // by an LoA message range — hard-deleting it would violate the FK.
    createLoaEntry({
      title: 'entry', fabric_extract: 'body',
      message_range_start: referenced, message_range_end: referenced,
    });

    const result = runDedup({ execute: true, delete: true })!;
    expect(result.applied?.deleted).toBe(0);
    expect(result.applied?.fkProtected).toBe(1);

    const row = lineageRows()[0];
    expect(row.duplicate_id).toBe(referenced);
    expect(row.survivor_id).toBe(survivor);
    expect(row.status).toBe('marked');
    // The record still exists, just hidden.
    const msg = getDb().prepare('SELECT id FROM messages WHERE id = ?').get(referenced);
    expect(msg).toBeDefined();
  });
});
