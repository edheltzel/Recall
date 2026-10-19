import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getDb } from '../../src/db/connection';
import { runLoaOmpEnd } from '../../src/commands/loa';
import { ExtractorConfigError } from '../../src/lib/extraction';
import { ingestHostTranscript } from '../../src/lib/host-ingest';
import { addMessage, getLoaMessages } from '../../src/lib/memory';
import { getRecallHome } from '../../src/lib/runtime-paths';
import { curatedSnapshotBehind, exclusiveLoaLock } from '../../hosts/omp/recall';
import { isolateTestHome, setupTestDb, teardownTestDb } from '../helpers/setup';

const BASIC = 'Automatic terminal extraction from omp lifecycle capture.';
const CURATED = 'Curated fabric extraction from omp session end.';

let restoreHome: (() => void) | undefined;
let previousRecallHome: string | undefined;
let workerDir: string;
let workerCli: string;

beforeAll(async () => {
  workerDir = mkdtempSync(join(import.meta.dir, '../../.agents/omp-loa-test-'));
  const entry = join(workerDir, 'index.ts');
  writeFileSync(entry, `
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { runLoaOmpEnd } from ${JSON.stringify(join(import.meta.dir, '../../src/commands/loa.ts'))};
    import { ingestHostTranscript } from ${JSON.stringify(join(import.meta.dir, '../../src/lib/host-ingest.ts'))};
    const sessionId = process.argv.at(-1);
    function pause() {
      if (existsSync(process.env.READY)) return;
      writeFileSync(process.env.READY, '1');
      const start = Date.now();
      while (!existsSync(process.env.GO)) {
        if (Date.now() - start > 5000) throw new Error('worker timed out');
      }
    }
    const code = await runLoaOmpEnd(sessionId, {
      [process.env.HOOK || 'afterLoad']: process.env.READY ? pause : undefined,
      extract(content) {
        if (process.env.COUNTER) {
          const calls = existsSync(process.env.COUNTER) ? Number(readFileSync(process.env.COUNTER, 'utf8')) + 1 : 1;
          writeFileSync(process.env.COUNTER, String(calls));
          if (calls <= 8) ingestHostTranscript({
            source: 'omp', sessionId, project: 'recall-test', finalize: true,
            messages: [{ role: 'user', content: 'retry round ' + calls, sourcePosition: calls, nativeId: 'n-' + calls }],
          });
        }
        return content;
      },
    });
    process.exit(code);
  `);
  const result = await Bun.build({ entrypoints: [entry], outdir: join(workerDir, 'dist'), target: 'bun', external: ['bun:sqlite', 'sqlite-vec'] });
  if (!result.success) throw new AggregateError(result.logs, 'Could not bundle omp worker');
  workerCli = join(workerDir, 'dist/index.js');
});

afterAll(() => {
  if (workerDir) rmSync(workerDir, { recursive: true, force: true });
});

beforeEach(() => {
  previousRecallHome = process.env.RECALL_HOME;
  restoreHome = isolateTestHome();
  process.env.RECALL_HOME = join(process.env.HOME!, '.agents', 'Recall');
  setupTestDb();
  mkdirSync(getRecallHome(), { recursive: true });
});

afterEach(() => {
  teardownTestDb();
  if (previousRecallHome === undefined) delete process.env.RECALL_HOME;
  else process.env.RECALL_HOME = previousRecallHome;
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
    WHERE source = 'omp' AND session_id = ? AND source_position IS NOT NULL
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

  test.each([false, true])('a revisited snapshot is curated with an earlier row id (existing curated: %s)', async (existing) => {
    capture('ses-revisit', 'snapshot A', 0);
    const firstId = lifecycleMax('ses-revisit');
    capture('ses-revisit', 'snapshot B', 1);
    if (existing) await runLoaOmpEnd('ses-revisit', { extract: content => content });
    capture('ses-revisit', 'snapshot A', 0);
    expect(lifecycleMax('ses-revisit')).toBe(firstId);
    expect(curatedSnapshotBehind('ses-revisit')).toBe(true);
    await runLoaOmpEnd('ses-revisit', { extract: content => content });
    const rows = curatedRows('ses-revisit');
    expect(rows).toHaveLength(1);
    expect(rows[0].fabric_extract).toContain('snapshot A');
    expect(rows[0].fabric_extract).not.toContain('snapshot B');
    expect(rows[0].snapshot_max_message_id).toBe(firstId);
    expect(curatedSnapshotBehind('ses-revisit')).toBe(false);
  });

  test('removing an earlier frame invalidates a snapshot with the same maximum id', async () => {
    const sessionId = 'ses-same-max';
    const earlier = { role: 'user' as const, content: 'earlier frame', sourcePosition: 0, nativeId: 'a' };
    const later = { role: 'user' as const, content: 'later frame', sourcePosition: 1, nativeId: 'b' };
    ingestHostTranscript({ source: 'omp', sessionId, finalize: true, messages: [earlier, later] });
    await runLoaOmpEnd(sessionId, { extract: content => content });
    const first = curatedRows(sessionId)[0];
    ingestHostTranscript({ source: 'omp', sessionId, finalize: true, messages: [later] });
    expect(lifecycleMax(sessionId)).toBe(first.snapshot_max_message_id!);
    expect(curatedSnapshotBehind(sessionId)).toBe(true);
    await runLoaOmpEnd(sessionId, { extract: content => content });
    const row = curatedRows(sessionId)[0];
    expect(row.id).toBe(first.id);
    expect(getLoaMessages(row.id).map(message => message.content)).toEqual(['later frame']);
    expect(curatedSnapshotBehind(sessionId)).toBe(false);
  });

  test.each(['old extract', 'new extract'])('an update returning %s keeps embeddings aligned with the extract', async (text) => {
    capture('ses-embedding', 'first frame', 0);
    await runLoaOmpEnd('ses-embedding', { extract: () => 'old extract' });
    const id = curatedRows('ses-embedding')[0].id;
    capture('ses-unrelated', 'unrelated frame', 0);
    const db = getDb();
    const insert = db.prepare(`INSERT INTO embeddings (source_table, source_id, model, dimensions, embedding) VALUES ('loa_entries', ?, 'fixture', 1, ?)`);
    const unrelated = (db.prepare('SELECT id FROM loa_entries WHERE session_id = ? AND description = ?').get('ses-unrelated', BASIC) as { id: number }).id;
    insert.run(id, new Uint8Array(4));
    insert.run(unrelated, new Uint8Array(4));
    capture('ses-embedding', 'second frame', 1);
    await runLoaOmpEnd('ses-embedding', { extract: () => text });
    expect(curatedRows('ses-embedding')[0].fabric_extract).toBe(text);
    expect(db.prepare('SELECT source_id FROM embeddings WHERE source_table = ? AND source_id = ?').all('loa_entries', id)).toEqual(text === 'old extract' ? [{ source_id: id }] : []);
    expect(db.prepare('SELECT source_id FROM embeddings WHERE source_table = ? AND source_id = ?').all('loa_entries', unrelated)).toEqual([{ source_id: unrelated }]);
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

  test.each(['afterLoad', 'afterWrite'])('a capture at %s is covered without another parent call', async (hook) => {
    const sessionId = 'ses-xproc';
    capture(sessionId, 'first capture', 0);
    const home = getRecallHome();
    const pid = join(home, `omp-loa-${sessionId}.pid`);
    const ready = join(home, 'ready');
    const go = join(home, 'go');
    writeFileSync(pid, '1');
    const child = Bun.spawn([process.execPath, workerCli, 'loa', 'omp-end', sessionId], {
      env: { ...process.env, READY: ready, GO: go, HOOK: hook },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    try {
      const start = Date.now();
      while (!existsSync(ready)) {
        if (child.exitCode !== null || Date.now() - start > 5000) break;
        await Bun.sleep(10);
      }
      expect(existsSync(ready)).toBe(true);
      capture(sessionId, 'final capture', 1);
      expect(exclusiveLoaLock(sessionId)).toBe(false);
      writeFileSync(go, '1');
      const exit = await child.exited;
      const stderr = await new Response(child.stderr).text();
      expect(exit, stderr).toBe(0);
      await waitForCuration(sessionId, pid);
      const rows = curatedRows(sessionId);
      expect(rows, stderr).toHaveLength(1);
      expect(rows[0].fabric_extract).toContain('final capture');
      expect(rows[0].snapshot_max_message_id).toBe(lifecycleMax(sessionId));
      expect(existsSync(pid)).toBe(false);
    } finally {
      writeFileSync(go, '1');
      child.kill();
      await child.exited;
    }
  }, 15_000);

  test('exhausted attempts hand off to a working bundled successor', async () => {
    const sessionId = 'ses-retry';
    capture(sessionId, 'initial frame', 0);
    const pid = join(getRecallHome(), `omp-loa-${sessionId}.pid`);
    const counter = join(getRecallHome(), 'counter');
    expect(exclusiveLoaLock(sessionId)).toBe(true);
    const child = Bun.spawn([process.execPath, workerCli, 'loa', 'omp-end', sessionId], {
      env: { ...process.env, COUNTER: counter }, stdout: 'pipe', stderr: 'pipe',
    });
    try {
      expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
      await waitForCuration(sessionId, pid);
      const rows = curatedRows(sessionId);
      expect(rows).toHaveLength(1);
      expect(rows[0].fabric_extract).toContain('retry round 8');
      expect(curatedSnapshotBehind(sessionId)).toBe(false);
    } finally {
      child.kill();
      await child.exited;
    }
  }, 15_000);
});

async function waitForCuration(sessionId: string, path: string): Promise<void> {
  const start = Date.now();
  while ((existsSync(path) || curatedSnapshotBehind(sessionId)) && Date.now() - start < 5000) await Bun.sleep(10);
  expect(existsSync(path)).toBe(false);
  expect(curatedSnapshotBehind(sessionId)).toBe(false);
}
