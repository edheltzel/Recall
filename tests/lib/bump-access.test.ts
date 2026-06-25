import { describe, test, expect, beforeAll, beforeEach, afterEach, mock } from 'bun:test';

// Bump-on-use (issue #153) runs on the recall read path; the embedding service
// is irrelevant to it. Force the service "unavailable" so hybridSearch takes its
// FTS-only fallback deterministically (no network, no model) — that branch is
// where we assert only the FINAL returned set is bumped, never the limit*2
// candidate pool that fed search().
mock.module('../../src/lib/embeddings', () => ({
  ...require('../../src/lib/embeddings'),
  checkEmbeddingService: async () => ({ available: false, model: 'qwen3-embedding:0.6b', url: 'mock://down' }),
  embed: async () => { throw new Error('embedding service unavailable'); },
}));

import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { getDb } from '../../src/db/connection';
import { bumpAccess, search, addBreadcrumb } from '../../src/lib/memory';
import { SQLITE_SAFE_CHUNK_SIZE } from '../../src/lib/chunk';

let hybridSearch: typeof import('../../src/mcp-server')['hybridSearch'];

beforeAll(async () => {
  ({ hybridSearch } = await import('../../src/mcp-server'));
});

beforeEach(() => setupTestDb());
afterEach(() => teardownTestDb());

const accessCount = (table: string, id: number): number =>
  (getDb().prepare(`SELECT access_count FROM ${table} WHERE id = ?`).get(id) as { access_count: number }).access_count;

const ftsMatchCount = (ftsTable: string, term: string): number =>
  (getDb().prepare(`SELECT COUNT(*) AS n FROM ${ftsTable} WHERE ${ftsTable} MATCH ?`).get(term) as { n: number }).n;

describe('bumpAccess (issue #153)', () => {
  test('increments access_count and sets last_accessed', () => {
    const id = addBreadcrumb({ content: 'bump target', importance: 5 });
    const before = getDb().prepare('SELECT access_count, last_accessed FROM breadcrumbs WHERE id = ?').get(id) as any;
    expect(before.access_count).toBe(0);
    expect(before.last_accessed).toBeNull();

    bumpAccess([{ table: 'breadcrumbs', id }]);

    const after = getDb().prepare('SELECT access_count, last_accessed FROM breadcrumbs WHERE id = ?').get(id) as any;
    expect(after.access_count).toBe(1);
    expect(after.last_accessed).not.toBeNull();

    // A second surfacing accumulates.
    bumpAccess([{ table: 'breadcrumbs', id }]);
    expect(accessCount('breadcrumbs', id)).toBe(2);
  });

  test("maps the search label 'loa' to the physical loa_entries table", () => {
    const id = Number(
      getDb().prepare('INSERT INTO loa_entries (title, fabric_extract) VALUES (?, ?)').run('t', 'x').lastInsertRowid
    );
    bumpAccess([{ table: 'loa', id }]);
    expect(accessCount('loa_entries', id)).toBe(1);
  });

  test('dedups repeated ids within one call (a row surfaced twice counts once)', () => {
    const id = addBreadcrumb({ content: 'dedupe me', importance: 5 });
    bumpAccess([{ table: 'breadcrumbs', id }, { table: 'breadcrumbs', id }]);
    expect(accessCount('breadcrumbs', id)).toBe(1);
  });

  test('bumps every id across chunk boundaries for a >cap set (issue #189)', () => {
    // bumpAccess chunks its IN (...) list through chunked() at
    // SQLITE_SAFE_CHUNK_SIZE. A set larger than one chunk exercises the
    // multi-chunk path inside its single transaction; assert ALL ids land at 1 —
    // none dropped at a chunk boundary, the whole bump committed atomically.
    const n = SQLITE_SAFE_CHUNK_SIZE * 2 + 1; // spans three chunks (500/500/1)
    const ids = Array.from({ length: n }, (_, i) =>
      addBreadcrumb({ content: `chunkword row ${i}`, importance: 5 })
    );
    bumpAccess(ids.map((id) => ({ table: 'breadcrumbs', id })));
    const bumped = ids.filter((id) => accessCount('breadcrumbs', id) === 1).length;
    expect(bumped).toBe(n);
  });

  test('ignores unknown / non-bumpable tables and an empty set (no throw)', () => {
    const id = addBreadcrumb({ content: 'safe', importance: 5 });
    expect(() => bumpAccess([])).not.toThrow();
    expect(() => bumpAccess([{ table: 'sessions', id }, { table: 'telos', id }])).not.toThrow();
    // The real row is untouched by the unknown-table entries.
    expect(accessCount('breadcrumbs', id)).toBe(0);
  });

  test('an access-only bump does NOT reindex FTS (scoped AFTER UPDATE OF triggers)', () => {
    const id = addBreadcrumb({ content: 'zzbumpalpha unique', importance: 5 });
    expect(ftsMatchCount('breadcrumbs_fts', 'zzbumpalpha')).toBe(1);

    // Desync the external-content FTS index by deleting this row's entry. If the
    // AFTER UPDATE trigger were still unscoped, the bump below would re-fire a
    // delete+reinsert and RESTORE the entry — so a surviving 0 proves no reindex.
    getDb().prepare(
      "INSERT INTO breadcrumbs_fts(breadcrumbs_fts, rowid, content, category, project) VALUES('delete', ?, ?, ?, ?)"
    ).run(id, 'zzbumpalpha unique', null, null);
    expect(ftsMatchCount('breadcrumbs_fts', 'zzbumpalpha')).toBe(0);

    bumpAccess([{ table: 'breadcrumbs', id }]);

    // Still desynced → the bump did not trip the FTS trigger.
    expect(ftsMatchCount('breadcrumbs_fts', 'zzbumpalpha')).toBe(0);
    // …and the access columns were written.
    expect(accessCount('breadcrumbs', id)).toBe(1);
  });

  test('a real content edit STILL reindexes FTS (scope is not too narrow)', () => {
    const id = addBreadcrumb({ content: 'zzcontentalpha', importance: 5 });
    expect(ftsMatchCount('breadcrumbs_fts', 'zzcontentalpha')).toBe(1);
    expect(ftsMatchCount('breadcrumbs_fts', 'zzcontentbeta')).toBe(0);

    getDb().prepare('UPDATE breadcrumbs SET content = ? WHERE id = ?').run('zzcontentbeta', id);

    // AFTER UPDATE OF content fired → FTS reflects the new content.
    expect(ftsMatchCount('breadcrumbs_fts', 'zzcontentbeta')).toBe(1);
    expect(ftsMatchCount('breadcrumbs_fts', 'zzcontentalpha')).toBe(0);
  });

  test('surgical scope: telos_au is left unscoped (telos is not bumped)', () => {
    const sql = (getDb().prepare(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name = 'telos_au'"
    ).get() as { sql: string }).sql;
    expect(sql).toContain('AFTER UPDATE ON telos');
    expect(sql).not.toContain('AFTER UPDATE OF');
  });
});

describe('bump-on-use wiring: only the returned set is bumped, never the candidate pool', () => {
  test('search() itself does not bump (bump lives at the surfaced boundary)', () => {
    const ids = [0, 1, 2].map((i) => addBreadcrumb({ content: `poolword item ${i}`, importance: 5 }));
    const results = search('poolword', { limit: 10 });
    expect(results.length).toBe(3);
    // search() is the candidate-producing layer; it must not write access state.
    for (const id of ids) expect(accessCount('breadcrumbs', id)).toBe(0);
  });

  test('hybridSearch bumps exactly the returned limit, not the limit*2 search() pool', async () => {
    // Five matching rows; limit 2 → search() inside hybridSearch pulls limit*2=4
    // candidates, hybridSearch slices to 2 and bumps only those.
    const ids = [0, 1, 2, 3, 4].map((i) => addBreadcrumb({ content: `frecencyword row ${i}`, importance: 5 }));

    const { results, embeddingsAvailable } = await hybridSearch('frecencyword', { limit: 2 });
    expect(embeddingsAvailable).toBe(false); // FTS-only fallback path
    expect(results.length).toBe(2);

    const bumped = ids.filter((id) => accessCount('breadcrumbs', id) === 1);
    const untouched = ids.filter((id) => accessCount('breadcrumbs', id) === 0);
    // Exactly the 2 returned rows are bumped; the other 3 (incl. 2 that sat in
    // the limit*2 candidate pool) stay at 0 — the pool trap is avoided.
    expect(bumped.length).toBe(2);
    expect(untouched.length).toBe(3);
  });
});
