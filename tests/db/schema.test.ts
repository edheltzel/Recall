import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { getDb } from '../../src/db/connection';
import { SCHEMA_VERSION } from '../../src/db/schema';

beforeAll(() => {
  setupTestDb();
});

afterAll(() => {
  teardownTestDb();
});

describe('SCHEMA_VERSION', () => {
  test('equals 3', () => {
    expect(SCHEMA_VERSION).toBe(3);
  });
});

describe('core tables', () => {
  test('all 9 core tables exist', () => {
    const db = getDb();
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = rows.map((r) => r.name);

    const expectedTables = [
      'breadcrumbs',
      'decisions',
      'documents',
      'learnings',
      'loa_entries',
      'messages',
      'schema_meta',
      'sessions',
      'telos',
    ];

    for (const table of expectedTables) {
      expect(tableNames).toContain(table);
    }
  });
});

describe('FTS5 virtual tables', () => {
  test('all 7 FTS5 virtual tables exist', () => {
    const db = getDb();
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts' ORDER BY name")
      .all() as { name: string }[];
    const ftsNames = rows.map((r) => r.name);

    const expectedFts = [
      'breadcrumbs_fts',
      'decisions_fts',
      'documents_fts',
      'learnings_fts',
      'loa_fts',
      'messages_fts',
      'telos_fts',
    ];

    expect(ftsNames.length).toBe(expectedFts.length);
    for (const fts of expectedFts) {
      expect(ftsNames).toContain(fts);
    }
  });
});

describe('embeddings table', () => {
  test('embeddings table exists', () => {
    const db = getDb();
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'")
      .get() as { name: string } | null;

    expect(row).not.toBeNull();
    expect(row?.name).toBe('embeddings');
  });
});

describe('indexes', () => {
  test('indexes are created', () => {
    const db = getDb();
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
      .all() as { name: string }[];
    const indexNames = rows.map((r) => r.name);

    const expectedIndexes = [
      'idx_breadcrumbs_created',
      'idx_breadcrumbs_importance',
      'idx_breadcrumbs_project',
      'idx_decisions_category',
      'idx_decisions_created',
      'idx_decisions_project',
      'idx_decisions_status',
      'idx_documents_created',
      'idx_documents_type',
      'idx_embeddings_model',
      'idx_embeddings_source',
      'idx_learnings_category',
      'idx_learnings_created',
      'idx_learnings_project',
      'idx_loa_created',
      'idx_loa_parent',
      'idx_loa_project',
      'idx_messages_project',
      'idx_messages_session',
      'idx_messages_timestamp',
      'idx_sessions_project',
      'idx_sessions_started',
      'idx_telos_category',
      'idx_telos_parent',
      'idx_telos_type',
    ];

    expect(indexNames.length).toBeGreaterThan(0);
    for (const idx of expectedIndexes) {
      expect(indexNames).toContain(idx);
    }
  });
});

describe('FTS triggers', () => {
  test('FTS sync triggers are created', () => {
    const db = getDb();
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
      .all() as { name: string }[];
    const triggerNames = rows.map((r) => r.name);

    const expectedTriggers = [
      'breadcrumbs_ad',
      'breadcrumbs_ai',
      'breadcrumbs_au',
      'decisions_ad',
      'decisions_ai',
      'decisions_au',
      'documents_ad',
      'documents_ai',
      'documents_au',
      'learnings_ad',
      'learnings_ai',
      'learnings_au',
      'loa_ad',
      'loa_ai',
      'loa_au',
      'messages_ad',
      'messages_ai',
      'messages_au',
      'telos_ad',
      'telos_ai',
      'telos_au',
    ];

    expect(triggerNames.length).toBe(expectedTriggers.length);
    for (const trigger of expectedTriggers) {
      expect(triggerNames).toContain(trigger);
    }
  });
});

describe('schema_meta', () => {
  test('schema version is stored in schema_meta table', () => {
    const db = getDb();
    const row = db
      .prepare("SELECT value FROM schema_meta WHERE key='version'")
      .get() as { value: string } | null;

    expect(row).not.toBeNull();
    expect(row?.value).toBe(String(SCHEMA_VERSION));
  });
});
