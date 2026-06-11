import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { Database } from 'bun:sqlite';
import {
  getDbPath as writerGetDbPath,
  ensureDbWritable,
  writeExtractionSession,
  writeDecisionsBatch,
  writeLearningsBatch,
  writeBreadcrumbsBatch,
  writeLoaEntryFromExtraction,
  writeExtractionErrors,
} from '../../hooks/lib/sqlite-writers';

let dbPath: string;

beforeEach(() => {
  dbPath = setupTestDb();
});

afterEach(() => {
  teardownTestDb();
});

function openRead(): Database {
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  return db;
}

describe('getDbPath', () => {
  test('honors RECALL_DB_PATH override (set by setupTestDb)', () => {
    expect(writerGetDbPath()).toBe(dbPath);
  });

  test('falls back to MEM_DB_PATH when RECALL_DB_PATH is unset (back-compat)', () => {
    const originalRecall = process.env.RECALL_DB_PATH;
    const originalMem = process.env.MEM_DB_PATH;
    delete process.env.RECALL_DB_PATH;
    process.env.MEM_DB_PATH = '/tmp/legacy-fallback.db';
    try {
      expect(writerGetDbPath()).toBe('/tmp/legacy-fallback.db');
    } finally {
      if (originalRecall !== undefined) process.env.RECALL_DB_PATH = originalRecall;
      if (originalMem !== undefined) process.env.MEM_DB_PATH = originalMem;
      else delete process.env.MEM_DB_PATH;
    }
  });
});

describe('ensureDbWritable', () => {
  test('returns true for an initialized DB', () => {
    expect(ensureDbWritable(dbPath)).toBe(true);
  });
  test('returns false for a nonexistent DB', () => {
    expect(ensureDbWritable('/nope/not/here.db')).toBe(false);
  });
});

describe('writeExtractionSession', () => {
  test('inserts a row with topics serialized as JSON', () => {
    writeExtractionSession(dbPath, {
      sessionId: 'sess-1',
      project: 'demo',
      timestamp: '2026-05-17',
      summary: 'one sentence',
      topics: ['t1', 't2'],
      conversationPath: '/tmp/foo.jsonl',
    });
    const db = openRead();
    const row = db.prepare('SELECT * FROM extraction_sessions WHERE session_id = ?').get('sess-1') as any;
    db.close();
    expect(row.project).toBe('demo');
    expect(row.summary).toBe('one sentence');
    expect(JSON.parse(row.topics)).toEqual(['t1', 't2']);
  });

  test('upserts on duplicate session_id', () => {
    writeExtractionSession(dbPath, {
      sessionId: 'sess-1', project: 'demo', timestamp: '2026-05-17', summary: 'v1', topics: [], conversationPath: null,
    });
    writeExtractionSession(dbPath, {
      sessionId: 'sess-1', project: 'demo', timestamp: '2026-05-17', summary: 'v2', topics: [], conversationPath: null,
    });
    const db = openRead();
    const cnt = (db.prepare('SELECT COUNT(*) c FROM extraction_sessions').get() as any).c;
    const row = db.prepare('SELECT summary FROM extraction_sessions WHERE session_id = ?').get('sess-1') as any;
    db.close();
    expect(cnt).toBe(1);
    expect(row.summary).toBe('v2');
  });
});

describe('writeDecisionsBatch', () => {
  test('inserts all rows with category and confidence', () => {
    const n = writeDecisionsBatch(dbPath, [
      { decision: 'use sqlite for tracker', confidence: 'high', sessionId: 's1', project: 'demo' },
      { decision: 'retire json file', confidence: 'medium', sessionId: 's1', project: 'demo' },
    ]);
    expect(n).toBe(2);
    const db = openRead();
    const rows = db.prepare('SELECT * FROM decisions ORDER BY id').all() as any[];
    db.close();
    expect(rows.length).toBe(2);
    expect(rows[0].decision).toBe('use sqlite for tracker');
    expect(rows[0].confidence).toBe('high');
    expect(rows[0].category).toBe('auto-extracted');
    expect(rows[0].status).toBe('active');
  });

  test('clamps importance to 1..10', () => {
    writeDecisionsBatch(dbPath, [{ decision: 'd', importance: 999 }]);
    const db = openRead();
    const row = db.prepare('SELECT importance FROM decisions LIMIT 1').get() as any;
    db.close();
    expect(row.importance).toBeLessThanOrEqual(10);
    expect(row.importance).toBeGreaterThanOrEqual(1);
  });

  test('empty input returns 0 and does not throw', () => {
    expect(writeDecisionsBatch(dbPath, [])).toBe(0);
  });
});

describe('writeLearningsBatch', () => {
  test('persists problem + solution + tags', () => {
    writeLearningsBatch(dbPath, [
      { problem: 'foo crashed', solution: 'wrap try/catch', tags: 'recall', project: 'demo', sessionId: 's1' },
    ]);
    const db = openRead();
    const row = db.prepare('SELECT * FROM learnings').get() as any;
    db.close();
    expect(row.problem).toBe('foo crashed');
    expect(row.solution).toBe('wrap try/catch');
    expect(row.tags).toBe('recall');
    expect(row.category).toBe('auto-extracted');
  });
});

describe('writeBreadcrumbsBatch', () => {
  test('persists content with extracted-idea category by default', () => {
    writeBreadcrumbsBatch(dbPath, [{ content: 'idea one', project: 'demo' }]);
    const db = openRead();
    const row = db.prepare('SELECT * FROM breadcrumbs').get() as any;
    db.close();
    expect(row.content).toBe('idea one');
    expect(row.category).toBe('extracted-idea');
  });
});

describe('writeLoaEntryFromExtraction', () => {
  test('inserts LoA with floored importance ≥5', () => {
    const id = writeLoaEntryFromExtraction(dbPath, {
      title: 'session-X — 2026-05-17',
      fabricExtract: '## ONE SENTENCE SUMMARY\ntext',
      project: 'demo',
      sessionId: 's1',
      importance: 1, // should be floored to 5
    });
    expect(id).toBeGreaterThan(0);
    const db = openRead();
    const row = db.prepare('SELECT * FROM loa_entries WHERE id = ?').get(id) as any;
    db.close();
    expect(row.title).toBe('session-X — 2026-05-17');
    expect(row.importance).toBeGreaterThanOrEqual(5);
  });
});

describe('writeExtractionErrors', () => {
  test('inserts new error and upserts on conflict', () => {
    writeExtractionErrors(dbPath, [{ errorKey: 'eperm', error: 'EPERM', fix: 'chmod' }]);
    writeExtractionErrors(dbPath, [{ errorKey: 'eperm', error: 'EPERM', fix: 'chmod +x' }]);
    const db = openRead();
    const rows = db.prepare('SELECT * FROM extraction_errors').all() as any[];
    db.close();
    expect(rows.length).toBe(1);
    expect(rows[0].fix).toBe('chmod +x');
  });
});

describe('Record Provenance stamping (ADR-0001, issue #42)', () => {
  test('every extraction writer stamps provenance = extracted', () => {
    writeDecisionsBatch(dbPath, [{ decision: 'stamped decision' }]);
    writeLearningsBatch(dbPath, [{ problem: 'stamped problem', solution: 'fix' }]);
    writeBreadcrumbsBatch(dbPath, [{ content: 'stamped crumb' }]);
    writeLoaEntryFromExtraction(dbPath, {
      title: 'stamped loa',
      fabricExtract: '## ONE SENTENCE SUMMARY\ntext',
      sessionId: 's1',
    });

    const db = openRead();
    for (const table of ['decisions', 'learnings', 'breadcrumbs', 'loa_entries']) {
      const row = db.prepare(`SELECT provenance FROM ${table} LIMIT 1`).get() as any;
      expect(row.provenance).toBe('extracted');
    }
    db.close();
  });

  test('still writes into a legacy DB whose tables have no provenance column', () => {
    const legacyPath = dbPath.replace('test.db', 'legacy-writers.db');
    const legacy = new Database(legacyPath);
    legacy.exec(`
      CREATE TABLE decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        category TEXT,
        project TEXT,
        decision TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        importance INTEGER DEFAULT 5
      );
    `);
    legacy.close();

    const n = writeDecisionsBatch(legacyPath, [{ decision: 'legacy write' }]);
    expect(n).toBe(1);

    const db = new Database(legacyPath, { readonly: true });
    const row = db.prepare('SELECT decision FROM decisions').get() as any;
    db.close();
    expect(row.decision).toBe('legacy write');
  });
});
