import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '../../src/index.ts');

test('six concurrent CLI additions survive a killed WAL writer', async () => {
  const productionDb = join(process.env.HOME!, '.agents/Recall/recall.db');
  const snapshot = () => [productionDb, `${productionDb}-wal`, `${productionDb}-shm`]
    .map(path => existsSync(path) ? statSync(path) : null);
  const before = snapshot();
  const directory = mkdtempSync(join(tmpdir(), 'recall-recovery-'));
  const home = join(directory, 'home');
  mkdirSync(home);
  const env = {
    PATH: process.env.PATH!,
    HOME: home,
    RECALL_HOME: join(home, '.agents/Recall'),
    RECALL_DB_PATH: join(directory, 'recall.db'),
    RECALL_SKIP_LEGACY_DATA_MIGRATIONS: '1',
  };
  console.log({ HOME: home, RECALL_HOME: env.RECALL_HOME, RECALL_DB_PATH: env.RECALL_DB_PATH });
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, CLI, ...args], {
      env, cwd: directory, stdout: 'pipe', stderr: 'pipe',
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    return { exit, stdout, stderr };
  };

  try {
    const initialized = await run('init');
    expect({ exit: initialized.exit, stderr: initialized.stderr }).toEqual({ exit: 0, stderr: '' });
    const seed = new Database(env.RECALL_DB_PATH, { readonly: true });
    const schemaVersion = seed.query('PRAGMA schema_version').get();
    expect(seed.query(`SELECT name FROM sqlite_master WHERE type = 'view'
      AND name IN ('active_host_ingest_messages', 'published_messages') ORDER BY name`).all())
      .toEqual([{ name: 'active_host_ingest_messages' }, { name: 'published_messages' }]);
    seed.close();
    for (let round = 0; round < 20; round++) {
      const peer = Bun.spawn([process.execPath, '-e', `
        import { Database } from 'bun:sqlite';
        const db = new Database(process.env.RECALL_DB_PATH);
        db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
        db.prepare('INSERT INTO breadcrumbs(content) VALUES (?)').run('COMMITTED_${round}');
        db.exec('BEGIN IMMEDIATE');
        db.prepare('INSERT INTO breadcrumbs(content) VALUES (?)').run('UNCOMMITTED_${round}');
        console.log('READY');
        await Bun.sleep(60000);
      `], { env, stdout: 'pipe', stderr: 'pipe' });
      try {
        const reader = peer.stdout.getReader();
        const ready = await reader.read();
        expect(new TextDecoder().decode(ready.value)).toContain('READY');
      } finally {
        peer.kill('SIGKILL');
        await peer.exited;
      }
      expect(existsSync(`${env.RECALL_DB_PATH}-wal`)).toBe(true);
      const writes = await Promise.all(Array.from({ length: 6 }, (_, writer) =>
        run('add', 'breadcrumb', `RECOVERY_${round}_${writer}`)));
      expect(writes.map(({ exit, stderr }) => ({ exit, stderr })))
        .toEqual(Array.from({ length: 6 }, () => ({ exit: 0, stderr: '' })));
      const db = new Database(env.RECALL_DB_PATH, { readonly: true });
      try {
        expect(db.query('PRAGMA schema_version').get()).toEqual(schemaVersion);
        expect(db.query('SELECT content FROM breadcrumbs ORDER BY content').all())
          .toEqual(Array.from({ length: round + 1 }, (_, index) => [
            `COMMITTED_${index}`,
            ...Array.from({ length: 6 }, (_, writer) => `RECOVERY_${index}_${writer}`),
          ]).flat().sort().map(content => ({ content })));
        expect(db.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
        expect(db.query("SELECT count(*) AS n FROM breadcrumbs_fts WHERE breadcrumbs_fts MATCH 'RECOVERY'").get())
          .toEqual({ n: (round + 1) * 6 });
      } finally {
        db.close();
      }
    }
    expect(snapshot()).toEqual(before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60000);
