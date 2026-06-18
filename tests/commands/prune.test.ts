// recall prune — issue #80: prune must not orphan a survivor's marked duplicates.
//
// Behavior under test:
// - a record recorded as a dedup survivor (status 'marked' or 'deleted' in
//   dedup_lineage) is withheld from prune — deleting it would orphan the
//   duplicates marked under it (hidden from search, visible representative gone)
// - the withheld rows are surfaced in the summary, never silently skipped
// - a non-survivor matching the same criteria is still pruned
// - 'reverted' lineage carries no obligation, so its former survivor is prunable

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { runPrune } from '../../src/commands/prune';
import { getDb } from '../../src/db/connection';
import {
  createSession,
  addMessage,
  addDecision,
  addBreadcrumb,
  createLoaEntry,
} from '../../src/lib/memory';
import type { LineageStatus } from '../../src/lib/dedup';

const originalLog = console.log;
const originalError = console.error;
const originalExitCode = process.exitCode;

// Far outside any retention window (default 180d / decisions 90d).
const OLD = '2020-01-01 00:00:00';

let logged: string[] = [];

beforeEach(() => {
  setupTestDb();
  logged = [];
  console.log = (...args: unknown[]) => { logged.push(args.join(' ')); };
  console.error = () => {};
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  process.exitCode = originalExitCode ?? 0;
  teardownTestDb();
});

function recordSurvivor(
  survivorTable: string, survivorId: number,
  duplicateTable: string, duplicateId: number,
  status: LineageStatus = 'marked',
): void {
  getDb().prepare(
    `INSERT INTO dedup_lineage
       (survivor_table, survivor_id, duplicate_table, duplicate_id, reason, similarity, status, detail)
     VALUES (?, ?, ?, ?, 'exact', NULL, ?, '{}')`
  ).run(survivorTable, survivorId, duplicateTable, duplicateId, status);
}

function rowExists(table: string, id: number): boolean {
  const row = getDb().prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id);
  return row !== undefined && row !== null;
}

describe('prune respects dedup survivors (#80)', () => {
  test('protects a recorded survivor message and still prunes a non-survivor', () => {
    // s1 is consolidated (has a LoA entry) → its old messages are prune-eligible.
    createSession({ session_id: 's1', started_at: OLD });
    createSession({ session_id: 's2', started_at: OLD });
    createLoaEntry({ title: 'consolidated', fabric_extract: 'x', session_id: 's1' });

    const survivorId = addMessage({ session_id: 's1', timestamp: OLD, role: 'user', content: 'survivor message' });
    const plainId = addMessage({ session_id: 's1', timestamp: OLD, role: 'user', content: 'plain old message' });
    // The duplicate lives in an unconsolidated session, so it is never itself
    // prune-eligible — isolating the survivor-guard behavior.
    const dupId = addMessage({ session_id: 's2', timestamp: OLD, role: 'user', content: 'duplicate message' });

    recordSurvivor('messages', survivorId, 'messages', dupId, 'marked');

    runPrune({ execute: true });

    expect(rowExists('messages', survivorId)).toBe(true);   // protected
    expect(rowExists('messages', dupId)).toBe(true);         // never orphaned
    expect(rowExists('messages', plainId)).toBe(false);      // pruned as normal

    // The exclusion must be surfaced, not silent.
    const messageLine = logged.find(l => l.includes('messages:'));
    expect(messageLine).toContain('1 rows');
    expect(messageLine).toContain('kept as dedup survivors');
  });

  test('protects a survivor decision and prunes a non-survivor decision', () => {
    const survivorId = addDecision({ decision: 'survivor decision', status: 'superseded' });
    const plainId = addDecision({ decision: 'plain decision', status: 'superseded' });
    getDb().prepare(`UPDATE decisions SET created_at = ?`).run(OLD);

    recordSurvivor('decisions', survivorId, 'decisions', survivorId + 999, 'marked');

    runPrune({ execute: true });

    expect(rowExists('decisions', survivorId)).toBe(true);   // protected
    expect(rowExists('decisions', plainId)).toBe(false);     // pruned
  });

  test("'deleted'-status lineage also protects its survivor (breadcrumbs)", () => {
    const survivorId = addBreadcrumb({ content: 'survivor crumb', importance: 5, expires_at: OLD });
    const plainId = addBreadcrumb({ content: 'plain crumb', importance: 5, expires_at: OLD });

    recordSurvivor('breadcrumbs', survivorId, 'breadcrumbs', plainId, 'deleted');

    runPrune({ execute: true });

    expect(rowExists('breadcrumbs', survivorId)).toBe(true);  // protected (status 'deleted')
  });

  test("'reverted' lineage carries no obligation — a former survivor is prunable", () => {
    const formerSurvivorId = addBreadcrumb({ content: 'reverted crumb', importance: 5, expires_at: OLD });
    recordSurvivor('breadcrumbs', formerSurvivorId, 'breadcrumbs', formerSurvivorId + 999, 'reverted');

    runPrune({ execute: true });

    expect(rowExists('breadcrumbs', formerSurvivorId)).toBe(false);  // not protected
  });

  test('dry-run reports protected survivors without deleting anything', () => {
    createSession({ session_id: 's1', started_at: OLD });
    createSession({ session_id: 's2', started_at: OLD });
    createLoaEntry({ title: 'consolidated', fabric_extract: 'x', session_id: 's1' });
    const survivorId = addMessage({ session_id: 's1', timestamp: OLD, role: 'user', content: 'survivor message' });
    const dupId = addMessage({ session_id: 's2', timestamp: OLD, role: 'user', content: 'duplicate message' });
    recordSurvivor('messages', survivorId, 'messages', dupId, 'marked');

    runPrune({}); // dry run

    expect(rowExists('messages', survivorId)).toBe(true);  // nothing deleted in dry-run
    const messageLine = logged.find(l => l.includes('messages:'));
    expect(messageLine).toContain('kept as dedup survivors');
  });
});
