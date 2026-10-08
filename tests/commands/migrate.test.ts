// Smoke tests for `recall migrate`. Exercises:
//   - dry-run prints a plan without touching files
//   - real run moves DB + sidecars to the destination
//   - refusal to overwrite a non-empty destination
//
// We bypass the lsof open-handle check by closing our own DB connection
// inside the test before invoking runMigrate (the resolver doesn't open
// handles from other processes during these tests).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { runMigrate } from '../../src/commands/migrate';
import { closeDb } from '../../src/db/connection';

let tempDir: string;
let srcDb: string;
let destDb: string;
let originalLog: typeof console.log;
let originalErr: typeof console.error;
let captured: string[] = [];
let capturedErr: string[] = [];

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

  test('refuses to overwrite non-empty destination', () => {
    mkdirSync(join(tempDir, 'dest'), { recursive: true });
    writeFileSync(destDb, 'pre-existing');
    expect(() => withExitThrow(() => runMigrate({ to: destDb }, tempDir))).toThrow(/exit:1/);
    expect(existsSync(srcDb)).toBe(true);
    expect(statSync(destDb).size).toBeGreaterThan(0);
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
