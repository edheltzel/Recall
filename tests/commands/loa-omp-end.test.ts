import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getDb } from '../../src/db/connection';
import { runLoaOmpEnd } from '../../src/commands/loa';
import { ExtractorConfigError } from '../../src/lib/extraction';
import { ingestHostTranscript } from '../../src/lib/host-ingest';
import { addMessage } from '../../src/lib/memory';
import { getRecallHome } from '../../src/lib/runtime-paths';
import { isolateTestHome, setupTestDb, teardownTestDb } from '../helpers/setup';

const BASIC = 'Automatic terminal extraction from omp lifecycle capture.';
const CURATED = 'Curated fabric extraction from omp session end.';

let restoreHome: (() => void) | undefined;

beforeEach(() => {
  restoreHome = isolateTestHome();
  setupTestDb();
  mkdirSync(getRecallHome(), { recursive: true });
});

afterEach(() => {
  teardownTestDb();
  restoreHome?.();
  restoreHome = undefined;
});

function capture(sessionId: string, content: string, position: number): void {
  ingestHostTranscript({
    source: 'omp',
    sessionId,
    project: 'recall-test',
    finalize: true,
    messages: [{ role: 'user', content, sourcePosition: position, nativeId: `n-${position}` }],
  });
}

function curatedRows(sessionId: string) {
  return getDb().prepare(`
    SELECT id, fabric_extract, snapshot_max_message_id, tags, description, title, project
    FROM loa_entries WHERE session_id = ? AND description = ?
  `).all(sessionId, CURATED) as Array<{
    id: number;
    fabric_extract: string;
    snapshot_max_message_id: number | null;
    tags: string;
    title: string;
    project: string | null;
  }>;
}

function basicExtract(sessionId: string): string {
  return (getDb().prepare(`
    SELECT fabric_extract FROM loa_entries WHERE session_id = ? AND description = ? AND tags = ?
  `).get(sessionId, BASIC, 'automatic-capture,omp') as { fabric_extract: string }).fabric_extract;
}

describe('recall loa omp-end', () => {
  test('writes one curated row and leaves the basic summary', async () => {
    capture('ses-1', 'lifecycle only', 0);
    const before = basicExtract('ses-1');
    const seen: string[] = [];
    expect(await runLoaOmpEnd('ses-1', { extract: (content) => {
      seen.push(content);
      return 'curated body';
    } })).toBe(0);
    const rows = curatedRows('ses-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fabric_extract: 'curated body',
      tags: 'curated,omp',
      title: 'Omp session ses-1',
      project: 'recall-test',
    });
    expect(rows[0].snapshot_max_message_id).toBeNumber();
    expect(basicExtract('ses-1')).toBe(before);
    expect(seen[0]).toContain('lifecycle only');
    expect(existsSync(join(getRecallHome(), 'omp-loa-ses-1.pid'))).toBe(false);
  });

  test('fabric failure exits 0 and does not add a curated row', async () => {
    capture('ses-fail', 'keep basic', 0);
    const before = basicExtract('ses-fail');
    const lock = join(getRecallHome(), 'omp-loa-ses-fail.pid');
    writeFileSync(lock, '1');
    expect(await runLoaOmpEnd('ses-fail', {
      extract: () => { throw new ExtractorConfigError('no fabric', 'curated'); },
    })).toBe(0);
    expect(curatedRows('ses-fail')).toEqual([]);
    expect(basicExtract('ses-fail')).toBe(before);
    expect(existsSync(lock)).toBe(false);
  });

  test('scores lifecycle rows and not an explicit dump on the same session', async () => {
    capture('ses-mix', 'lifecycle line', 0);
    addMessage({
      session_id: 'ses-mix',
      timestamp: '2026-10-18T00:00:00.000Z',
      role: 'user',
      content: 'dump only line',
    });
    let seen = '';
    await runLoaOmpEnd('ses-mix', { extract: (content) => { seen = content; return 'from lifecycle'; } });
    expect(seen).toContain('lifecycle line');
    expect(seen).not.toContain('dump only line');
    expect(curatedRows('ses-mix')).toHaveLength(1);
  });

  test('a second run updates the same curated id', async () => {
    capture('ses-rerun', 'first turn', 0);
    await runLoaOmpEnd('ses-rerun', { extract: () => 'first extract' });
    const first = curatedRows('ses-rerun')[0];
    capture('ses-rerun', 'second turn', 1);
    expect(await runLoaOmpEnd('ses-rerun', { extract: () => 'second extract' })).toBe(0);
    const rows = curatedRows('ses-rerun');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.id);
    expect(rows[0].fabric_extract).toBe('second extract');
    expect(rows[0].snapshot_max_message_id).toBeGreaterThan(first.snapshot_max_message_id!);
  });

  test('a later capture during extract is not overwritten by the stale extract', async () => {
    capture('ses-stale', 'first capture', 0);
    let calls = 0;
    expect(await runLoaOmpEnd('ses-stale', { extract: () => {
      calls += 1;
      if (calls === 1) {
        capture('ses-stale', 'second capture', 1);
        return 'stale extract';
      }
      return 'fresh extract';
    } })).toBe(0);
    const rows = curatedRows('ses-stale');
    expect(rows).toHaveLength(1);
    expect(rows[0].fabric_extract).toBe('fresh extract');
    expect(calls).toBe(2);
  });

  test('a high-water move during the retry writes nothing', async () => {
    capture('ses-move', 'first capture', 0);
    let calls = 0;
    expect(await runLoaOmpEnd('ses-move', { extract: () => {
      calls += 1;
      capture('ses-move', `capture ${calls}`, calls);
      return `extract ${calls}`;
    } })).toBe(0);
    expect(curatedRows('ses-move')).toEqual([]);
    expect(calls).toBe(2);
  });

  test('no lifecycle rows exits 0', async () => {
    let called = false;
    expect(await runLoaOmpEnd('missing', { extract: () => { called = true; return 'nope'; } })).toBe(0);
    expect(called).toBe(false);
    expect(curatedRows('missing')).toEqual([]);
  });
});
