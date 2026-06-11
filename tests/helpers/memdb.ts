// Test helper: fresh in-memory database with the full Recall schema.
//
// Property-based suites create a database per generated case (dozens per
// test), so the file-backed setupTestDb harness is too heavy — this builds
// the same tables/indexes in memory in ~1ms. FTS virtual tables and triggers
// are omitted: the export/dedup logic under property test never touches them.
import { Database } from 'bun:sqlite';
import { CREATE_TABLES, CREATE_INDEXES, CREATE_VECTOR_TABLES } from '../../src/db/schema';

export function createMemoryDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON'); // matches production getDb()
  db.exec(CREATE_TABLES);
  db.exec(CREATE_INDEXES);
  db.exec(CREATE_VECTOR_TABLES);
  return db;
}
