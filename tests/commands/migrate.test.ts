import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

// Smoke tests for `recall migrate`. Exercises:
//   - dry-run prints a plan without touching files
//   - real run moves DB + sidecars to the destination
//   - refusal to overwrite an existing destination
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

beforeEach(() => {
  migrateTestHooks.failCommitPath = '';
  migrateTestHooks.beforeMove = undefined;
  migrateTestHooks.onCommitFailure = undefined;
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

  test('leaves the database and configs unchanged when an atomic config write cannot be staged', () => {
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

    expect(() => withExitThrow(() => runMigrate({ to: destDb }, tempDir))).toThrow('exit:1');

    expect(existsSync(srcDb)).toBe(true);
    expect(existsSync(srcDb + '-wal')).toBe(true);
    expect(existsSync(srcDb + '-shm')).toBe(true);
    expect(existsSync(destDb)).toBe(false);
    expect(readFileSync(legacy, 'utf-8')).toBe(legacyOriginal);
    expect(readFileSync(settings, 'utf-8')).toBe(settingsOriginal);
    expect(existsSync(`${legacy}.tmp`)).toBe(false);
    expect(statSync(`${settings}.tmp`).isDirectory()).toBe(true);
    expect(statSync(`${settings}.tmp`).mode & 0o777).toBe(0o751);
    expect(capturedErr.join('\n')).toContain(`cannot stage ${settings}`);
  });

  test('refuses to overwrite non-empty destination', () => {
    mkdirSync(join(tempDir, 'dest'), { recursive: true });
    writeFileSync(destDb, 'pre-existing');
    expect(() => withExitThrow(() => runMigrate({ to: destDb }, tempDir))).toThrow(/exit:1/);
    expect(existsSync(srcDb)).toBe(true);
    expect(statSync(destDb).size).toBeGreaterThan(0);
  });

  test('refuses to overwrite an empty destination', () => {
    mkdirSync(dirname(destDb), { recursive: true });
    writeFileSync(destDb, '');

    expect(() => withExitThrow(() => runMigrate({ to: destDb }, tempDir))).toThrow('exit:1');

    expect(existsSync(srcDb)).toBe(true);
    expect(statSync(destDb).size).toBe(0);
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
    expect(err).toContain(`destination already exists: ${destDb}-wal`);
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
    const probe = join(binDir, immutabilityProbe!);
    mkdirSync(binDir);
    writeFileSync(probe, '#!/bin/sh\nexit 1\n');
    chmodSync(probe, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;
    try {
      expect(() => withExitThrow(() => runMigrate({ to: destDb }, tempDir))).toThrow('exit:1');
    } finally {
      process.env.PATH = originalPath;
    }

    expect(existsSync(srcDb)).toBe(true);
    expect(existsSync(srcDb + '-wal')).toBe(true);
    expect(existsSync(srcDb + '-shm')).toBe(true);
    expect(existsSync(destDb)).toBe(false);
    expect(readFileSync(legacy, 'utf-8')).toBe(body);
    expect(readFileSync(settings, 'utf-8')).toBe(body);
    expect(existsSync(`${legacy}.tmp`)).toBe(false);
    expect(existsSync(`${settings}.tmp`)).toBe(false);
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

  test('does not overwrite a main database created after preflight', () => {
    migrateTestHooks.beforeMove = () => writeFileSync(destDb, 'FOREIGN');

    expect(() => withExitThrow(() => runMigrate({ to: destDb }, tempDir))).toThrow('exit:1');

    expect(readFileSync(srcDb, 'utf-8')).toBe('fake-sqlite-bytes');
    expect(readFileSync(destDb, 'utf-8')).toBe('FOREIGN');
  });

  test('does not overwrite a sidecar created after preflight', () => {
    migrateTestHooks.beforeMove = () => writeFileSync(destDb + '-wal', 'FOREIGN');

    expect(() => withExitThrow(() => runMigrate({ to: destDb }, tempDir))).toThrow('exit:1');

    expect(readFileSync(srcDb, 'utf-8')).toBe('fake-sqlite-bytes');
    expect(readFileSync(srcDb + '-wal', 'utf-8')).toBe('wal');
    expect(existsSync(destDb)).toBe(false);
    expect(readFileSync(destDb + '-wal', 'utf-8')).toBe('FOREIGN');
  });

  test('does not delete a journal created after preflight', () => {
    migrateTestHooks.beforeMove = () => writeFileSync(destDb + '-journal', 'FOREIGN');

    expect(() => withExitThrow(() => runMigrate({ to: destDb }, tempDir))).toThrow('exit:1');

    expect(existsSync(srcDb)).toBe(true);
    expect(existsSync(destDb)).toBe(false);
    expect(readFileSync(destDb + '-journal', 'utf-8')).toBe('FOREIGN');
  });

  test('does not overwrite databases or sidecars recreated during rollback', () => {
    const settings = join(tempDir, '.claude', 'settings.json');
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, JSON.stringify({
      mcpServers: { 'recall-memory': { env: { RECALL_DB_PATH: srcDb } } },
    }));
    migrateTestHooks.failCommitPath = settings;
    migrateTestHooks.onCommitFailure = () => {
      writeFileSync(srcDb, 'FOREIGN DB');
      writeFileSync(srcDb + '-wal', 'FOREIGN WAL');
      writeFileSync(srcDb + '-shm', 'FOREIGN SHM');
    };

    expect(() => withExitThrow(() => runMigrate({ to: destDb }, tempDir))).toThrow('exit:1');

    expect(readFileSync(srcDb, 'utf-8')).toBe('FOREIGN DB');
    expect(readFileSync(srcDb + '-wal', 'utf-8')).toBe('FOREIGN WAL');
    expect(readFileSync(srcDb + '-shm', 'utf-8')).toBe('FOREIGN SHM');
    expect(readFileSync(destDb, 'utf-8')).toBe('fake-sqlite-bytes');
    expect(readFileSync(destDb + '-wal', 'utf-8')).toBe('wal');
    expect(readFileSync(destDb + '-shm', 'utf-8')).toBe('shm');
    expect(capturedErr.join('\n')).toContain('failed to move database back');
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
