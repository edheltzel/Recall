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

function lifecycleMax(sessionId: string): number {
  return (getDb().prepare(`
    SELECT MAX(message_id) AS id FROM active_host_ingest_messages
    WHERE source = 'omp' AND session_id = ?
  `).get(sessionId) as { id: number }).id;
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

  test('a capture during extract is included before the worker exits', async () => {
    capture('ses-move', 'first capture', 0);
    let calls = 0;
    expect(await runLoaOmpEnd('ses-move', {
      extract: (content) => {
        calls += 1;
        if (calls <= 2) {
          capture('ses-move', `final capture ${calls}`, calls);
          return `stale ${calls}`;
        }
        return content;
      },
    })).toBe(0);
    expect(calls).toBeGreaterThan(2);
    const rows = curatedRows('ses-move');
    expect(rows).toHaveLength(1);
    expect(rows[0].fabric_extract).toContain('final capture 2');
    expect(rows[0].snapshot_max_message_id).toBe(lifecycleMax('ses-move'));
  });

  test('no lifecycle rows exits 0', async () => {
    let called = false;
    expect(await runLoaOmpEnd('missing', { extract: () => { called = true; return 'nope'; } })).toBe(0);
    expect(called).toBe(false);
    expect(curatedRows('missing')).toEqual([]);
  });

  test('a row committed after load is extracted, not labeled covered unseen', async () => {
    capture('ses-gap', 'first capture', 0);
    const seen: string[] = [];
    expect(await runLoaOmpEnd('ses-gap', {
      afterLoad: () => capture('ses-gap', 'late capture', 1),
      extract: (content) => {
        seen.push(content);
        return `extract ${seen.length}`;
      },
    })).toBe(0);
    expect(seen.at(-1)).toContain('late capture');
    const rows = curatedRows('ses-gap');
    expect(rows).toHaveLength(1);
    expect(rows[0].fabric_extract).toBe('extract 2');
    expect(rows[0].snapshot_max_message_id).toBe(lifecycleMax('ses-gap'));
  });

  test('a row committed before the write is extracted in the same worker', async () => {
    capture('ses-commit', 'seen turn', 0);
    let planted = false;
    expect(await runLoaOmpEnd('ses-commit', {
      extract: (content) => content,
      beforeWrite: () => {
        if (planted) return;
        planted = true;
        capture('ses-commit', 'unseen turn', 1);
      },
    })).toBe(0);
    const rows = curatedRows('ses-commit');
    expect(rows).toHaveLength(1);
    expect(rows[0].fabric_extract).toContain('unseen turn');
    expect(rows[0].snapshot_max_message_id).toBe(lifecycleMax('ses-commit'));
  });

  test('a capture during the child worker is covered without another parent call', async () => {
    const sessionId = 'ses-xproc';
    capture(sessionId, 'first capture', 0);
    const home = getRecallHome();
    const pid = join(home, `omp-loa-${sessionId}.pid`);
    const ready = join(home, 'ready');
    const go = join(home, 'go');
    writeFileSync(pid, '1');
    const modulePath = join(import.meta.dir, '../../src/commands/loa.ts');
    const child = Bun.spawn(['bun', '-e', `
      import { existsSync, writeFileSync } from 'fs';
      import { runLoaOmpEnd } from ${JSON.stringify(modulePath)};
      let waited = false;
      const code = await runLoaOmpEnd(process.env.SESSION_ID, {
        afterLoad() { writeFileSync(process.env.READY, '1'); },
        extract(content) {
          if (!waited) {
            waited = true;
            const start = Date.now();
            while (!existsSync(process.env.GO)) {
              if (Date.now() - start > 5000) {
                console.error('child timed out waiting to extract');
                return content;
              }
            }
          }
          return content;
        },
      });
      process.exit(code);
    `], {
      env: { ...process.env, RECALL_HOME: home, SESSION_ID: sessionId, READY: ready, GO: go },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    try {
      const start = Date.now();
      while (!existsSync(ready)) {
        if (child.exitCode !== null || Date.now() - start > 5000) break;
      }
      capture(sessionId, 'final capture', 1);
      writeFileSync(go, '1');
      const exit = await child.exited;
      const stderr = await new Response(child.stderr).text();
      expect(exit, stderr).toBe(0);
      const rows = curatedRows(sessionId);
      expect(rows, stderr).toHaveLength(1);
      expect(rows[0].fabric_extract).toContain('final capture');
      expect(rows[0].snapshot_max_message_id).toBe(lifecycleMax(sessionId));
      expect(existsSync(pid)).toBe(false);
    } finally {
      child.kill();
    }
  });
});
