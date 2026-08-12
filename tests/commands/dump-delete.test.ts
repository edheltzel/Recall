// Path-level boundary coverage for issue #41: deleteLoaEntriesRecursive is
// the one SQL path whose bind count scales with input size, so it must
// survive id lists past the historical 999-variable SQLite limit.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { getDb } from '../../src/db/connection';
import { createLoaEntry } from '../../src/lib/memory';
import { deleteLoaEntriesRecursive } from '../../src/commands/dump';
import { embeddingToBlob } from '../../src/lib/embeddings';

function loaCount(): number {
  const row = getDb().prepare('SELECT COUNT(*) as count FROM loa_entries').get() as { count: number };
  return row.count;
}

describe('deleteLoaEntriesRecursive', () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
  });

  test('deletes 1001 entries in one call (past the 999 bind-variable limit)', () => {
    const ids: number[] = [];
    for (let i = 0; i < 1001; i++) {
      ids.push(createLoaEntry({ title: `entry ${i}`, fabric_extract: 'x' }));
    }
    expect(loaCount()).toBe(1001);

    deleteLoaEntriesRecursive(getDb(), ids);

    expect(loaCount()).toBe(0);
  });

  test('recursively deletes a child generation larger than one chunk', () => {
    const parents: number[] = [];
    for (let i = 0; i < 600; i++) {
      parents.push(createLoaEntry({ title: `parent ${i}`, fabric_extract: 'x' }));
    }
    // Two children per parent → 1200 children, spanning multiple chunks in
    // both the child lookup and the recursive delete.
    for (const parentId of parents) {
      createLoaEntry({ title: `child a of ${parentId}`, fabric_extract: 'x', parent_loa_id: parentId });
      createLoaEntry({ title: `child b of ${parentId}`, fabric_extract: 'x', parent_loa_id: parentId });
    }
    const survivor = createLoaEntry({ title: 'unrelated', fabric_extract: 'x' });
    expect(loaCount()).toBe(1801);

    deleteLoaEntriesRecursive(getDb(), parents);

    expect(loaCount()).toBe(1);
    const remaining = getDb().prepare('SELECT id FROM loa_entries').get() as { id: number };
    expect(remaining.id).toBe(survivor);
  });

  test('no-op on an empty id list', () => {
    createLoaEntry({ title: 'keep', fabric_extract: 'x' });

    deleteLoaEntriesRecursive(getDb(), []);

    expect(loaCount()).toBe(1);
  });

  test('restores cleanup readiness before deleting an embedded entry', () => {
    const db = getDb();
    const id = createLoaEntry({ title: 'embedded', fabric_extract: 'x' });
    db.prepare(
      `INSERT INTO embeddings (source_table, source_id, embedding) VALUES ('loa_entries', ?, ?)`
    ).run(id, embeddingToBlob(new Array(1024).fill(0)));
    db.exec('DROP TRIGGER embeddings_ad; DROP TRIGGER loa_entries_embedding_ad;');
    db.prepare(`DELETE FROM schema_meta WHERE key IN ('vec_index_dirty', 'vec_index_generation')`).run();

    deleteLoaEntriesRecursive(db, [id]);

    expect(db.prepare(
      `SELECT 1 FROM embeddings WHERE source_table = 'loa_entries' AND source_id = ?`
    ).get(id)).toBeNull();
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM sqlite_master
       WHERE type = 'trigger' AND name IN ('embeddings_ad', 'loa_entries_embedding_ad')`
    ).get()).toEqual({ count: 2 });
    expect(db.prepare(`SELECT value FROM schema_meta WHERE key = 'vec_index_dirty'`).get())
      .toEqual({ value: '1' });
  });
});
