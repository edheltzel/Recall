// Smoke tests for `recall path`. Confirms human + JSON output and that the
// resolved DB path matches whatever's actually in the resolver.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { runPath } from '../../src/commands/path';

let dbPath: string;
let originalLog: typeof console.log;
let captured: string[] = [];

beforeAll(() => {
  dbPath = setupTestDb();
  originalLog = console.log;
  console.log = (...args: unknown[]) => {
    captured.push(args.map(String).join(' '));
  };
});

afterAll(() => {
  console.log = originalLog;
  teardownTestDb();
});

describe('recall path', () => {
  test('human output mentions the resolved DB path', () => {
    captured = [];
    runPath({ json: false });
    const out = captured.join('\n');
    expect(out).toContain(dbPath);
    expect(out).toContain('Install root');
    expect(out).toContain('Per-platform symlinks');
  });

  test('--json output is parseable and includes the resolved DB path', () => {
    captured = [];
    runPath({ json: true });
    const out = captured.join('\n');
    const parsed = JSON.parse(out) as {
      db: { path: string; env_source: string };
      install_root: string;
      symlinks: Array<{ name: string }>;
    };
    expect(parsed.db.path).toBe(dbPath);
    expect(parsed.install_root).toMatch(/\.agents\/Recall$/);
    expect(Array.isArray(parsed.symlinks)).toBe(true);
    expect(parsed.symlinks.length).toBeGreaterThan(0);
  });

  test('--json reports the active env-var source for the DB path', () => {
    captured = [];
    runPath({ json: true });
    const out = captured.join('\n');
    const parsed = JSON.parse(out) as { db: { env_source: string } };
    // setupTestDb sets RECALL_DB_PATH, so env_source should be RECALL_DB_PATH.
    expect(parsed.db.env_source).toBe('RECALL_DB_PATH');
  });
});
