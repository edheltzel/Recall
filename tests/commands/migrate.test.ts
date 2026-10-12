import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

// Smoke tests for `recall migrate`. Exercises:
//   - dry-run prints a plan without touching files
//   - real run moves DB + sidecars to the destination
//   - refusal to overwrite a non-empty destination
//
// We bypass the lsof open-handle check by closing our own DB connection
// inside the test before invoking runMigrate (the resolver doesn't open
// handles from other processes during these tests).

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, statSync, lstatSync, symlinkSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { migrateTestHooks, runMigrate } from '../../src/commands/migrate';
import { closeDb } from '../../src/db/connection';
import { atomicTempEntries } from '../helpers/fs';

let tempDir: string;
let srcDb: string;
let destDb: string;
let originalLog: typeof console.log;
let originalErr: typeof console.error;
let captured: string[] = [];
let capturedErr: string[] = [];
const immutabilityProbe = process.platform === 'darwin' || process.platform === 'freebsd'
  ? 'stat'
  : process.platform === 'linux'
    ? 'lsattr'
    : undefined;
const chflags = process.platform === 'darwin' || process.platform === 'freebsd'
  ? Bun.which('chflags')
  : null;

function withExitThrow(run: () => void): void {
  const originalExit = process.exit;
  process.exit = ((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never;
  try {
    run();
  } finally {
    process.exit = originalExit;
  }
}

function runMigrateCli(to: string): string {
  return execFileSync(process.execPath, [join(import.meta.dir, '../../src/index.ts'), 'migrate', '--to', to], {
    env: { ...process.env, HOME: tempDir, RECALL_HOME: join(tempDir, '.agents', 'Recall') },
    encoding: 'utf-8',
  });
}

beforeEach(() => {
  migrateTestHooks.failCommitPath = '';
  migrateTestHooks.commitProbeExecutable = '';
  tempDir = mkdtempSync(join(tmpdir(), 'recall-migrate-test-'));
  srcDb = join(tempDir, 'src', 'recall.db');
  destDb = join(tempDir, 'dest', 'recall.db');

  // Seed source DB + sidecars.
  mkdirSync(join(tempDir, 'src'), { recursive: true });
  writeFileSync(srcDb, 'fake-sqlite-bytes');
  writeFileSync(srcDb + '-wal', 'wal');
  writeFileSync(srcDb + '-shm', 'shm');

  process.env.RECALL_DB_PATH = srcDb;
  closeDb(); // ensure no stale handle

  originalLog = console.log;
  originalErr = console.error;
  captured = [];
  capturedErr = [];
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => capturedErr.push(args.map(String).join(' '));
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalErr;
  closeDb();
  delete process.env.RECALL_DB_PATH;
  if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe('recall migrate', () => {
  test('--dry-run prints a plan and changes nothing', () => {
    runMigrate({ to: destDb, dryRun: true }, tempDir);
    const out = captured.join('\n');
    expect(out).toContain('dry-run');
    expect(out).toContain(srcDb);
    expect(out).toContain(destDb);
    // No mutation: source still exists, dest does not.
    expect(existsSync(srcDb)).toBe(true);
    expect(existsSync(destDb)).toBe(false);
  });

  test('moves DB + sidecars to destination', () => {
    runMigrate({ to: destDb }, tempDir);
    expect(existsSync(srcDb)).toBe(false);
    expect(existsSync(destDb)).toBe(true);
    expect(existsSync(destDb + '-wal')).toBe(true);
    expect(existsSync(destDb + '-shm')).toBe(true);
    // Migration log mentions the move.
    expect(captured.join('\n')).toContain('Moved DB');
  });

  test('moves the database a symlink/.. source path names, not its lexical twin (#324)', () => {
    mkdirSync(join(tempDir, 'store', 'leaf'), { recursive: true });
    symlinkSync(join(tempDir, 'store', 'leaf'), join(tempDir, 'link'));
    writeFileSync(join(tempDir, 'store', 'recall.db'), 'intended');
    writeFileSync(join(tempDir, 'recall.db'), 'decoy');
    process.env.RECALL_DB_PATH = `${tempDir}/link/../recall.db`;

    runMigrate({ to: destDb }, tempDir);

    expect(readFileSync(destDb, 'utf-8')).toBe('intended');
    expect(readFileSync(join(tempDir, 'recall.db'), 'utf-8')).toBe('decoy');
  });

  test.each(['literal path', 'physical alias'])('does nothing when --to names the symlink/.. source via %s (#324)', (form) => {
    mkdirSync(join(tempDir, 'store', 'leaf'), { recursive: true });
    symlinkSync(join(tempDir, 'store', 'leaf'), join(tempDir, 'link'));
    const dbPath = `${tempDir}/link/../recall.db`;
    writeFileSync(join(tempDir, 'store', 'recall.db'), 'intended');
    writeFileSync(join(tempDir, 'store', 'recall.db-wal'), 'wal');
    writeFileSync(join(tempDir, 'store', 'recall.db-shm'), 'shm');
    process.env.RECALL_DB_PATH = dbPath;
    const configPath = join(tempDir, '.claude.json');
    const config = JSON.stringify({
      mcpServers: { 'recall-memory': { env: { RECALL_DB_PATH: dbPath } } },
    });
    writeFileSync(configPath, config);
    const inodes = ['', '-wal', '-shm'].map(ext => statSync(dbPath + ext).ino);

    const output = runMigrateCli(form === 'literal path' ? dbPath : join(tempDir, 'store', 'recall.db'));

    expect(output).toContain('Source and destination are identical');
    expect(readFileSync(dbPath, 'utf-8')).toBe('intended');
    expect(readFileSync(dbPath + '-wal', 'utf-8')).toBe('wal');
    expect(readFileSync(dbPath + '-shm', 'utf-8')).toBe('shm');
    expect(['', '-wal', '-shm'].map(ext => statSync(dbPath + ext).ino)).toEqual(inodes);
    expect(existsSync(join(tempDir, 'recall.db'))).toBe(false);
    expect(readFileSync(configPath, 'utf-8')).toBe(config);
    expect(existsSync(join(tempDir, '.agents'))).toBe(false);
  });

  test('migrates between distinct symlink/.. paths with existing parents (#324)', () => {
    for (const name of ['source', 'destination']) {
      mkdirSync(join(tempDir, `${name}  store`, 'leaf'), { recursive: true });
      symlinkSync(join(tempDir, `${name}  store`, 'leaf'), join(tempDir, `${name}  link`));
    }
    const source = `${tempDir}/source  link/../recall.db`;
    const destination = `${tempDir}/destination  link/../recall.db`;
    const physicalDestination = join(tempDir, 'destination  store', 'recall.db');
    const contents = [['', 'intended'], ['-wal', 'wal'], ['-shm', 'shm']];
    for (const [ext, content] of contents) writeFileSync(source + ext, content);
    const inodes = contents.map(([ext]) => statSync(source + ext).ino);
    process.env.RECALL_DB_PATH = source;
    const configPath = join(tempDir, '.claude.json');
    writeFileSync(configPath, JSON.stringify({
      mcpServers: { 'recall-memory': { env: { RECALL_DB_PATH: source } } },
    }));

    expect(runMigrateCli(destination)).toContain('Migration complete');

    for (const [ext, content] of contents) {
      expect(existsSync(source + ext)).toBe(false);
      expect(readFileSync(physicalDestination + ext, 'utf-8')).toBe(content);
    }
    expect(contents.map(([ext]) => statSync(physicalDestination + ext).ino)).toEqual(inodes);
    expect(existsSync(join(tempDir, 'recall.db'))).toBe(false);
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).mcpServers['recall-memory'].env.RECALL_DB_PATH).toBe(destination);
  });

  test('patches Claude, OpenCode, and Pi JSONC registrations', () => {
    const configs = [
      {
        path: join(tempDir, '.claude.json'),
        body: `{
          // Claude legacy settings.
          "mcpServers": {
            "__proto__": { "command": "keep", },
            "recall-memory": { "env": { "RECALL_DB_PATH": "${srcDb}", }, },
          },
        }`,
        readPath: ['mcpServers', 'recall-memory', 'env'],
      },
      {
        path: join(tempDir, '.claude', 'settings.json'),
        body: `{
          // Claude settings.
          "mcpServers": {
            "__proto__": { "command": "keep", },
            "recall-memory": { "env": { "RECALL_DB_PATH": "${srcDb}", }, },
          },
        }`,
        readPath: ['mcpServers', 'recall-memory', 'env'],
      },
      {
        path: join(tempDir, '.config', 'opencode', 'opencode.json'),
        body: `{
          // OpenCode settings.
          "mcp": {
            "__proto__": { "command": "keep", },
            "recall-memory": { "environment": { "RECALL_DB_PATH": "${srcDb}", }, },
          },
        }`,
        readPath: ['mcp', 'recall-memory', 'environment'],
      },
      {
        path: join(tempDir, '.pi', 'agent', 'mcp.json'),
        body: `{
          // Pi settings.
          "mcpServers": {
            "__proto__": { "command": "keep", },
            "recall-memory": { "env": { "RECALL_DB_PATH": "${srcDb}", }, },
          },
        }`,
        readPath: ['mcpServers', 'recall-memory', 'env'],
      },
    ];
    for (const config of configs) {
      mkdirSync(dirname(config.path), { recursive: true });
      writeFileSync(config.path, config.body);
    }

    runMigrate({ to: destDb }, tempDir);

    for (const config of configs) {
      const parsed = JSON.parse(readFileSync(config.path, 'utf-8')) as Record<string, unknown>;
      const registry = parsed[config.readPath[0]] as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(registry, '__proto__')).toBe(true);
      expect(registry.__proto__).toEqual({ command: 'keep' });
      let value: unknown = parsed;
      for (const segment of config.readPath) value = (value as Record<string, unknown>)[segment];
      expect((value as Record<string, unknown>).RECALL_DB_PATH).toBe(destDb);
    }
    expect(existsSync(srcDb)).toBe(false);
    expect(existsSync(destDb)).toBe(true);
  });

  test('patches a symlinked host config through its real target', () => {
    const target = join(tempDir, 'managed', 'claude.json');
    const config = join(tempDir, '.claude.json');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({
      mcpServers: { 'recall-memory': { env: { RECALL_DB_PATH: srcDb } } },
    }));
    symlinkSync(target, config);

    runMigrate({ to: destDb }, tempDir);

    expect(lstatSync(config).isSymbolicLink()).toBe(true);
    const parsed = JSON.parse(readFileSync(target, 'utf-8'));
    expect(parsed.mcpServers['recall-memory'].env.RECALL_DB_PATH).toBe(destDb);
  });

  test('rejects malformed host config before moving the database', () => {
    const settings = join(tempDir, '.claude', 'settings.json');
    mkdirSync(join(tempDir, '.claude'), { recursive: true });
    writeFileSync(settings, '{ "mcpServers": { "recall-memory": { } }');

    expect(() => withExitThrow(() => runMigrate({ to: destDb }, tempDir))).toThrow('exit:1');

    expect(existsSync(srcDb)).toBe(true);
    expect(existsSync(destDb)).toBe(false);
    expect(capturedErr.join('\n')).toContain('cannot patch');
  });

  test('rejects an invalid Claude Recall entry before moving the database', () => {
    const settings = join(tempDir, '.claude', 'settings.json');
    mkdirSync(join(tempDir, '.claude'), { recursive: true });
    writeFileSync(settings, '{"mcpServers":{"recall-memory":[]}}');

    expect(() => withExitThrow(() => runMigrate({ to: destDb }, tempDir))).toThrow('exit:1');

    expect(existsSync(srcDb)).toBe(true);
    expect(existsSync(destDb)).toBe(false);
    expect(capturedErr.join('\n')).toContain('cannot patch');
  });

  test('leaves a sibling .tmp directory untouched while staging a unique temp', () => {
    const legacy = join(tempDir, '.claude.json');
    const settings = join(tempDir, '.claude', 'settings.json');
    mkdirSync(dirname(settings), { recursive: true });
    const legacyOriginal = JSON.stringify({
      mcpServers: { 'recall-memory': { env: { RECALL_DB_PATH: srcDb } } },
    });
    const settingsOriginal = JSON.stringify({
      mcpServers: { 'recall-memory': { env: { RECALL_DB_PATH: srcDb } } },
    });
    writeFileSync(legacy, legacyOriginal);
    writeFileSync(settings, settingsOriginal);
    mkdirSync(`${settings}.tmp`);
    chmodSync(`${settings}.tmp`, 0o751);
    const legacyTempsBefore = atomicTempEntries(legacy);
    const settingsTempsBefore = atomicTempEntries(settings);

    runMigrate({ to: destDb }, tempDir);

    expect(existsSync(srcDb)).toBe(false);
    expect(existsSync(destDb)).toBe(true);
    expect(JSON.parse(readFileSync(settings, 'utf-8')).mcpServers['recall-memory'].env.RECALL_DB_PATH).toBe(destDb);
    expect(JSON.parse(readFileSync(legacy, 'utf-8')).mcpServers['recall-memory'].env.RECALL_DB_PATH).toBe(destDb);
    expect(atomicTempEntries(legacy)).toEqual(legacyTempsBefore);
    expect(atomicTempEntries(settings)).toEqual(settingsTempsBefore);
    expect(statSync(`${settings}.tmp`).isDirectory()).toBe(true);
    expect(statSync(`${settings}.tmp`).mode & 0o777).toBe(0o751);
  });

  test('refuses to overwrite non-empty destination', () => {
    mkdirSync(join(tempDir, 'dest'), { recursive: true });
    writeFileSync(destDb, 'pre-existing');
    expect(() => withExitThrow(() => runMigrate({ to: destDb }, tempDir))).toThrow(/exit:1/);
    expect(existsSync(srcDb)).toBe(true);
    expect(statSync(destDb).size).toBeGreaterThan(0);
  });

  test('refuses a destination sidecar of any type or size and does not unlink it', () => {
    mkdirSync(join(tempDir, 'dest'), { recursive: true });
    writeFileSync(destDb + '-wal', '');
    mkdirSync(destDb + '-shm');
    writeFileSync(destDb + '-journal', 'old-journal');
    rmSync(srcDb + '-wal');

    expect(() => withExitThrow(() => runMigrate({ to: destDb }, tempDir))).toThrow('exit:1');

    expect(existsSync(srcDb)).toBe(true);
    expect(existsSync(destDb)).toBe(false);
    expect(statSync(destDb + '-wal').size).toBe(0);
    expect(lstatSync(destDb + '-shm').isDirectory()).toBe(true);
    expect(readFileSync(destDb + '-journal', 'utf-8')).toBe('old-journal');
    const err = capturedErr.join('\n');
    expect(err).toContain(`destination already exists and is non-empty: ${destDb}-wal`);
    expect(err).toContain('Refusing to overwrite');
  });

  test('refuses to overwrite a foreign destination WAL when the source also has one', () => {
    mkdirSync(join(tempDir, 'dest'), { recursive: true });
    writeFileSync(destDb + '-wal', 'FOREIGN');

    expect(() => withExitThrow(() => runMigrate({ to: destDb }, tempDir))).toThrow('exit:1');

    expect(existsSync(srcDb)).toBe(true);
    expect(existsSync(srcDb + '-wal')).toBe(true);
    expect(readFileSync(srcDb + '-wal', 'utf-8')).toBe('wal');
    expect(existsSync(destDb)).toBe(false);
    expect(readFileSync(destDb + '-wal', 'utf-8')).toBe('FOREIGN');
  });

  test.skipIf(chflags === null)('aborts before moving when a staged config commit would fail', () => {
    const legacy = join(tempDir, '.claude.json');
    const settings = join(tempDir, '.claude', 'settings.json');
    mkdirSync(dirname(settings), { recursive: true });
    const body = JSON.stringify({
      mcpServers: { 'recall-memory': { env: { RECALL_DB_PATH: srcDb } } },
    });
    writeFileSync(legacy, body);
    writeFileSync(settings, body);
    execFileSync(chflags!, ['uchg', settings]);
    try {
      expect(() => withExitThrow(() => runMigrate({ to: destDb }, tempDir))).toThrow('exit:1');
      expect(existsSync(srcDb)).toBe(true);
      expect(existsSync(srcDb + '-wal')).toBe(true);
      expect(existsSync(destDb)).toBe(false);
      expect(readFileSync(legacy, 'utf-8')).toBe(body);
      expect(readFileSync(settings, 'utf-8')).toBe(body);
      expect(capturedErr.join('\n')).toContain(`cannot commit ${settings}`);
    } finally {
      execFileSync(chflags!, ['nouchg', settings]);
    }
  });

  test.skipIf(immutabilityProbe === undefined)('cleans staged configs when commit preflight fails', () => {
    const legacy = join(tempDir, '.claude.json');
    const settings = join(tempDir, '.claude', 'settings.json');
    mkdirSync(dirname(settings), { recursive: true });
    const body = JSON.stringify({
      mcpServers: { 'recall-memory': { env: { RECALL_DB_PATH: srcDb } } },
    });
    writeFileSync(legacy, body);
    writeFileSync(settings, body);

    const binDir = join(tempDir, 'bin');
    const probe = join(binDir, 'commit-probe');
    mkdirSync(binDir);
    writeFileSync(probe, '#!/bin/sh\nexit 1\n');
    chmodSync(probe, 0o755);
    migrateTestHooks.commitProbeExecutable = probe;
    const legacyTempsBefore = atomicTempEntries(legacy);
    const settingsTempsBefore = atomicTempEntries(settings);
    expect(() => withExitThrow(() => runMigrate({ to: destDb }, tempDir))).toThrow('exit:1');

    expect(existsSync(srcDb)).toBe(true);
    expect(existsSync(srcDb + '-wal')).toBe(true);
    expect(existsSync(srcDb + '-shm')).toBe(true);
    expect(existsSync(destDb)).toBe(false);
    expect(readFileSync(legacy, 'utf-8')).toBe(body);
    expect(readFileSync(settings, 'utf-8')).toBe(body);
    expect(atomicTempEntries(legacy)).toEqual(legacyTempsBefore);
    expect(atomicTempEntries(settings)).toEqual(settingsTempsBefore);
    expect(capturedErr.join('\n')).toContain(`cannot commit ${legacy}`);
  });

  test('restores an already-committed config when a later commit fails', () => {
    const legacy = join(tempDir, '.claude.json');
    const settings = join(tempDir, '.claude', 'settings.json');
    mkdirSync(dirname(settings), { recursive: true });
    const body = JSON.stringify({
      mcpServers: { 'recall-memory': { env: { RECALL_DB_PATH: srcDb } } },
    });
    writeFileSync(legacy, body);
    writeFileSync(settings, body);
    chmodSync(legacy, 0o444);
    migrateTestHooks.failCommitPath = settings;

    expect(() => withExitThrow(() => runMigrate({ to: destDb }, tempDir))).toThrow('exit:1');

    expect(existsSync(srcDb)).toBe(true);
    expect(existsSync(srcDb + '-wal')).toBe(true);
    expect(existsSync(destDb)).toBe(false);
    expect(readFileSync(legacy, 'utf-8')).toBe(body);
    expect(statSync(legacy).mode & 0o777).toBe(0o444);
    expect(readFileSync(settings, 'utf-8')).toBe(body);
    expect(capturedErr.join('\n')).toContain('injected commit failure');
  });

  test('does not leave the database moved when the destination WAL is a directory', () => {
    mkdirSync(destDb + '-wal', { recursive: true });

    expect(() => withExitThrow(() => runMigrate({ to: destDb }, tempDir))).toThrow('exit:1');

    expect(existsSync(srcDb)).toBe(true);
    expect(readFileSync(srcDb + '-wal', 'utf-8')).toBe('wal');
    expect(existsSync(destDb)).toBe(false);
    expect(lstatSync(destDb + '-wal').isDirectory()).toBe(true);
  });

  test('source absent → graceful no-op', () => {
    rmSync(srcDb);
    rmSync(srcDb + '-wal');
    rmSync(srcDb + '-shm');
    runMigrate({ to: destDb }, tempDir);
    expect(captured.join('\n')).toContain('does not exist');
    expect(existsSync(destDb)).toBe(false);
  });
});
