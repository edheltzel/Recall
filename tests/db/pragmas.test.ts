import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { JOURNAL_SIZE_LIMIT_BYTES, getDb } from '../../src/db/connection';
import { setupTestDb, teardownTestDb } from '../helpers/setup';

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());

describe('writer connection pragmas', () => {
  test('a writer connection waits on locks, uses WAL, and caps the WAL file', () => {
    const db = getDb();
    expect(db.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
    expect(db.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(db.query('PRAGMA journal_size_limit').get()).toEqual({ journal_size_limit: JOURNAL_SIZE_LIMIT_BYTES });
  });
});
