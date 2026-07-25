import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { CREATE_TABLES } from '../../src/db/schema';
import { writeBreadcrumbsBatch, writeDecisionsBatch, writeLearningsBatch } from '../../hooks/lib/sqlite-writers';

/**
 * Concurrent Claude + OpenCode extraction against one shared WAL database.
 *
 * The batch writers probe for duplicates (skipDuplicates) before inserting.
 * Inside a DEFERRED transaction that read-then-write sequence makes SQLite
 * fail the upgrade with SQLITE_BUSY *immediately* — `busy_timeout` is not
 * consulted at all — so a peer's short transaction silently cost a record
 * instead of being waited out. Measured: ~1ms hard failure when deferred,
 * versus honouring the full timeout when the write lock is taken up front.
 *
 * These tests hold the write lock from a separate PROCESS (the writers are
 * synchronous, so an in-process timer could never release it) and assert the
 * write waits and lands.
 */
describe('shared-database extraction writers (concurrent hosts)', () => {
  let tempDir: string;
  let dbPath: string;

  /** Hold the write lock in a peer process, releasing it after `holdMs`. */
  async function peerHoldingWriteLock(holdMs: number): Promise<{ done: Promise<void> }> {
    const script = join(tempDir, 'peer.ts');
    writeFileSync(script, `
import { Database } from 'bun:sqlite';
const db = new Database(${JSON.stringify(dbPath)});
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('BEGIN IMMEDIATE');
db.prepare("INSERT INTO breadcrumbs (session_id, project, content, importance) VALUES ('peer','peer','peer holds the write lock',5)").run();
console.log('LOCKED');
await Bun.sleep(${holdMs});
db.exec('COMMIT');
db.close();
`);
    const child = Bun.spawn(['bun', 'run', script], { stdout: 'pipe', stderr: 'pipe' });

    // Wait until the peer confirms it holds the lock.
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    while (!seen.includes('LOCKED')) {
      const { done, value } = await reader.read();
      if (done) throw new Error(`peer never took the lock: ${seen}${await new Response(child.stderr).text()}`);
      seen += decoder.decode(value, { stream: true });
    }
    return { done: child.exited.then(() => undefined) };
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'recall-concurrency-'));
    dbPath = join(tempDir, 'recall.db');
    const db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.run(CREATE_TABLES);
    db.close();
  });

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  test('a decision batch waits out a peer write lock instead of losing the record', async () => {
    const peer = await peerHoldingWriteLock(600);

    const started = Date.now();
    const written = writeDecisionsBatch(
      dbPath,
      [{ sessionId: 'opencode-session', project: 'opencode', decision: 'Recall waits for a peer writer', importance: 6 }],
      { skipDuplicates: true },
    );
    const waited = Date.now() - started;
    await peer.done;

    expect(written).toBe(1);
    // Proves the wait actually happened rather than the write racing in first.
    expect(waited).toBeGreaterThan(200);

    const db = new Database(dbPath, { readonly: true });
    const rows = db.query('SELECT decision FROM decisions').all() as { decision: string }[];
    db.close();
    expect(rows.map(r => r.decision)).toContain('Recall waits for a peer writer');
  });

  test('learning and breadcrumb batches also survive a peer write lock', async () => {
    const peer = await peerHoldingWriteLock(500);

    const learnings = writeLearningsBatch(
      dbPath,
      [{ sessionId: 'claude-session', project: 'claude', problem: 'deferred upgrade returns SQLITE_BUSY instantly', solution: 'take the write lock up front', confidence: 'high', importance: 7 }],
      { skipDuplicates: true },
    );
    const breadcrumbs = writeBreadcrumbsBatch(
      dbPath,
      [{ sessionId: 'opencode-session', project: 'opencode', content: 'concurrent hosts share one WAL database', importance: 5 }],
      { skipDuplicates: true },
    );
    await peer.done;

    expect(learnings).toBe(1);
    expect(breadcrumbs).toBe(1);
  });

  test('both hosts writing at once keep every record and their own source', async () => {
    // No peer lock here — this is the plain interleaved case: two hosts writing
    // the same tables must not drop or merge each other's rows.
    const results = await Promise.all([
      Promise.resolve().then(() => writeDecisionsBatch(
        dbPath,
        [{ sessionId: 'claude-session', project: 'claude', decision: 'CLAUDE_SOURCED_DECISION', importance: 5 }],
        { skipDuplicates: true },
      )),
      Promise.resolve().then(() => writeDecisionsBatch(
        dbPath,
        [{ sessionId: 'opencode-session', project: 'opencode', decision: 'OPENCODE_SOURCED_DECISION', importance: 5 }],
        { skipDuplicates: true },
      )),
    ]);

    expect(results).toEqual([1, 1]);

    const db = new Database(dbPath, { readonly: true });
    const rows = db.query('SELECT project, decision FROM decisions ORDER BY decision').all() as { project: string; decision: string }[];
    db.close();

    expect(rows).toHaveLength(2);
    expect(rows.map(r => `${r.project}:${r.decision}`)).toEqual([
      'claude:CLAUDE_SOURCED_DECISION',
      'opencode:OPENCODE_SOURCED_DECISION',
    ]);
  });
});
