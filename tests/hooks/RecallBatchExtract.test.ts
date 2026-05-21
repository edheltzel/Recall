// Tests for hooks/RecallBatchExtract.ts — verifies the SQLite-backed tracker
// replacement for the legacy .extraction_tracker.json file.
//
// Covers:
//   (a) When SQLite tracker says a path is already extracted with ≤50% growth → skip
//   (b) When path is not in tracker → mark as candidate
//   (c) When extraction_tracker table is missing → graceful skip with log line
//   (d) Static grep: RecallBatchExtract.ts no longer reads or writes
//       .extraction_tracker.json (legacy JSON path retired).

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  findCandidates,
  loadTracker,
  hasExtractionTracker,
  recordSuccess,
  recordFailure,
  type Tracker,
} from '../../hooks/RecallBatchExtract';
import {
  markAsExtracted,
  getExtractionRecord,
} from '../../hooks/lib/extraction-tracker';

const BATCH_EXTRACT_SOURCE = readFileSync(
  join(import.meta.dir, '..', '..', 'hooks', 'RecallBatchExtract.ts'),
  'utf-8'
);

const EXTRACTION_DDL = `
CREATE TABLE IF NOT EXISTS extraction_tracker (
  conversation_path TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  extracted_at TEXT,
  failed_at TEXT,
  retry_after TEXT,
  error TEXT,
  skipped INTEGER DEFAULT 0
);
`;

let tmp: string;
let dbPath: string;
let originalMemDbPath: string | undefined;
const originalLog = console.log;
let logLines: string[] = [];

function captureLogs(): void {
  logLines = [];
  console.log = (...args: any[]) => {
    logLines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
}

function releaseLogs(): void {
  console.log = originalLog;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'recall-batchextract-'));
  dbPath = join(tmp, 'memory.db');
  originalMemDbPath = process.env.RECALL_DB_PATH;
  process.env.RECALL_DB_PATH = dbPath;
});

afterEach(() => {
  releaseLogs();
  if (originalMemDbPath === undefined) delete process.env.RECALL_DB_PATH;
  else process.env.RECALL_DB_PATH = originalMemDbPath;
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

function initTrackerDb(): void {
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(EXTRACTION_DDL);
  db.close();
}

function initEmptyDb(): void {
  // Real SQLite file but no extraction_tracker table — pre-migration install.
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.close();
}

describe('findCandidates — SQLite tracker integration', () => {
  test('(a) skips conversations already extracted with ≤50% growth', () => {
    initTrackerDb();
    const convPath = '/projects/foo/session-1.jsonl';
    markAsExtracted(dbPath, convPath, 10_000);

    const tracker: Tracker = loadTracker(dbPath);
    expect(tracker[convPath]).toBeDefined();
    expect(tracker[convPath].extractedAt).toBeTruthy();

    // File grew from 10k to 11k — 10% growth, well under the 50% threshold.
    const conversations = [
      { path: convPath, size: 11_000, project: '-projects-foo', mtime: Date.now() },
    ];
    const candidates = findCandidates(conversations, tracker);
    expect(candidates.length).toBe(0);
  });

  test('(a-bis) re-extracts when file grew >50% since last extraction', () => {
    initTrackerDb();
    const convPath = '/projects/foo/session-2.jsonl';
    markAsExtracted(dbPath, convPath, 10_000);

    const tracker = loadTracker(dbPath);
    const conversations = [
      // 20k = 100% growth — exceeds threshold.
      { path: convPath, size: 20_000, project: '-projects-foo', mtime: Date.now() },
    ];
    const candidates = findCandidates(conversations, tracker);
    expect(candidates.length).toBe(1);
    expect(candidates[0].reason).toContain('grew');
  });

  test('(b) marks conversations not in tracker as candidates', () => {
    initTrackerDb();
    const tracker = loadTracker(dbPath);
    expect(Object.keys(tracker).length).toBe(0);

    const conversations = [
      // Above MIN_FILE_SIZE (2000)
      { path: '/projects/bar/new.jsonl', size: 5_000, project: '-projects-bar', mtime: Date.now() },
      // Below MIN_FILE_SIZE — should NOT be a candidate even when unknown.
      { path: '/projects/bar/tiny.jsonl', size: 100, project: '-projects-bar', mtime: Date.now() },
    ];
    const candidates = findCandidates(conversations, tracker);
    expect(candidates.length).toBe(1);
    expect(candidates[0].path).toBe('/projects/bar/new.jsonl');
    expect(candidates[0].reason).toBe('never extracted');
  });

  test('record write round-trips through SQLite', () => {
    initTrackerDb();
    const convPath = '/projects/baz/session.jsonl';

    expect(recordSuccess(dbPath, convPath, 4_321)).toBe(true);
    const row = getExtractionRecord(dbPath, convPath);
    expect(row).not.toBeNull();
    expect(row!.size).toBe(4_321);
    expect(row!.extracted_at).not.toBeNull();

    expect(recordFailure(dbPath, convPath, 9_999, 'simulated')).toBe(true);
    const row2 = getExtractionRecord(dbPath, convPath);
    expect(row2!.failed_at).not.toBeNull();
    expect(row2!.retry_after).not.toBeNull();
    expect(row2!.error).toBe('simulated');
  });
});

describe('Graceful degrade when extraction_tracker is missing', () => {
  test('(c) loadTracker on a DB without the table returns {} and logs', () => {
    initEmptyDb();
    expect(hasExtractionTracker(dbPath)).toBe(false);

    captureLogs();
    const tracker = loadTracker(dbPath);
    releaseLogs();

    expect(tracker).toEqual({});
    expect(logLines.some((l) => l.includes('extraction_tracker table missing'))).toBe(true);
  });

  test('(c-bis) loadTracker on a missing DB file returns {} and logs', () => {
    const ghostPath = join(tmp, 'does-not-exist.db');
    expect(existsSync(ghostPath)).toBe(false);

    captureLogs();
    const tracker = loadTracker(ghostPath);
    releaseLogs();

    expect(tracker).toEqual({});
    expect(logLines.some((l) => l.includes('SQLite DB not found'))).toBe(true);
  });

  test('(c-bis) recordSuccess/recordFailure swallow errors on a DB with no table', () => {
    initEmptyDb();
    captureLogs();
    const okSuccess = recordSuccess(dbPath, '/path/x.jsonl', 100);
    const okFailure = recordFailure(dbPath, '/path/x.jsonl', 100, 'err');
    releaseLogs();
    // Best-effort: returns false, never throws.
    expect(okSuccess).toBe(false);
    expect(okFailure).toBe(false);
    expect(logLines.some((l) => l.includes('WARN: failed to mark'))).toBe(true);
  });
});

describe('Static guarantees — legacy JSON tracker is retired', () => {
  test('(d) RecallBatchExtract.ts source does not reference .extraction_tracker.json', () => {
    expect(BATCH_EXTRACT_SOURCE).not.toContain('.extraction_tracker.json');
  });

  test('(d) RecallBatchExtract.ts does not call writeFileSync or readFileSync', () => {
    // Both are how the legacy JSON tracker was read/written. Neither should
    // appear in the refactored module — file I/O for state is now SQLite.
    expect(BATCH_EXTRACT_SOURCE).not.toContain('writeFileSync');
    expect(BATCH_EXTRACT_SOURCE).not.toContain('readFileSync');
  });

  test('(d) RecallBatchExtract.ts no longer defines saveTracker/loadTracker(JSON variants)', () => {
    // The old saveTracker(tracker: Record<string,...>) wrote JSON; loadTracker()
    // (no args) read JSON. Refactored loadTracker takes a dbPath param.
    expect(BATCH_EXTRACT_SOURCE).not.toContain('function saveTracker(');
    // loadTracker now signs as `loadTracker(dbPath: string ...)` — confirm.
    expect(BATCH_EXTRACT_SOURCE).toMatch(/loadTracker\(dbPath/);
  });

  test('(d) RecallBatchExtract.ts imports from extraction-tracker lib', () => {
    expect(BATCH_EXTRACT_SOURCE).toContain("from './lib/extraction-tracker'");
  });
});
