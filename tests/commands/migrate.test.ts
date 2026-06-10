// Smoke tests for `recall migrate`. Exercises:
//   - dry-run prints a plan without touching files
//   - real run moves DB + sidecars to the destination
//   - refusal to overwrite a non-empty destination
//
// We bypass the lsof open-handle check by closing our own DB connection
// inside the test before invoking runMigrate (the resolver doesn't open
// handles from other processes during these tests).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, writeFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runMigrate } from '../../src/commands/migrate';
import { closeDb } from '../../src/db/connection';

let tempDir: string;
let srcDb: string;
let destDb: string;
let originalLog: typeof console.log;
let originalErr: typeof console.error;
let captured: string[] = [];
let capturedErr: string[] = [];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'recall-migrate-test-'));
  srcDb = join(tempDir, 'src', 'recall.db');
  destDb = join(tempDir, 'dest', 'recall.db');

  // Seed source DB + sidecars.
  require('fs').mkdirSync(join(tempDir, 'src'), { recursive: true });
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
    runMigrate({ to: destDb, dryRun: true });
    const out = captured.join('\n');
    expect(out).toContain('dry-run');
    expect(out).toContain(srcDb);
    expect(out).toContain(destDb);
    // No mutation: source still exists, dest does not.
    expect(existsSync(srcDb)).toBe(true);
    expect(existsSync(destDb)).toBe(false);
  });

  test('moves DB + sidecars to destination', () => {
    runMigrate({ to: destDb });
    expect(existsSync(srcDb)).toBe(false);
    expect(existsSync(destDb)).toBe(true);
    expect(existsSync(destDb + '-wal')).toBe(true);
    expect(existsSync(destDb + '-shm')).toBe(true);
    // Migration log mentions the move.
    expect(captured.join('\n')).toContain('Moved DB');
  });

  test('refuses to overwrite non-empty destination', () => {
    require('fs').mkdirSync(join(tempDir, 'dest'), { recursive: true });
    writeFileSync(destDb, 'pre-existing');
    let exited = false;
    const origExit = process.exit;
    // @ts-expect-error – test override
    process.exit = (code?: number) => {
      exited = true;
      throw new Error(`exit:${code ?? 0}`);
    };
    try {
      expect(() => runMigrate({ to: destDb })).toThrow(/exit:1/);
      expect(exited).toBe(true);
      // Source untouched.
      expect(existsSync(srcDb)).toBe(true);
      expect(statSync(destDb).size).toBeGreaterThan(0); // unchanged
    } finally {
      process.exit = origExit;
    }
  });

  test('source absent → graceful no-op', () => {
    rmSync(srcDb);
    rmSync(srcDb + '-wal');
    rmSync(srcDb + '-shm');
    runMigrate({ to: destDb });
    expect(captured.join('\n')).toContain('does not exist');
    expect(existsSync(destDb)).toBe(false);
  });
});
