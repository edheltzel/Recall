// The Stop hook refreshes the learned tail (#279) on every Stop, including the
// exits that never reach extraction, and a refused write keeps the old state.
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

const REPO = join(import.meta.dir, '..', '..');
const CLI = join(REPO, 'src', 'index.ts');
const HOOKS = join(REPO, 'hooks');
const PRODUCTION_DB = join(homedir(), '.agents', 'Recall', 'recall.db');
const NOTE = 'Run the migration dry-run before every schema change.';
const DAY = 86_400_000;

const roots: string[] = [];
const productionBefore = metadata(PRODUCTION_DB);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  expect(metadata(PRODUCTION_DB)).toEqual(productionBefore);
});

function metadata(path: string): { exists: boolean; size?: number; mtimeMs?: number } {
  if (!existsSync(path)) return { exists: false };
  const stat = statSync(path);
  return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'recall-tail-stop-'));
  roots.push(root);
  const hooks = join(root, 'installed', 'hooks');
  cpSync(HOOKS, hooks, { recursive: true });
  const bin = join(root, 'empty-bin');
  mkdirSync(bin, { recursive: true });
  // A minimal env: other suites leave Recall/Claude variables set in this process.
  const env: NodeJS.ProcessEnv = {
    TMPDIR: tmpdir(),
    HOME: root,
    PATH: `${bin}:${join(process.execPath, '..')}:/usr/bin:/bin`,
    RECALL_DB_PATH: join(root, 'recall.db'),
    RECALL_HOME: join(root, 'recall-home'),
    RECALL_SKIP_LEGACY_DATA_MIGRATIONS: '1',
  };
  expect(spawnSync(process.execPath, [CLI, 'init'], { env, encoding: 'utf-8' }).status).toBe(0);
  // Seed in a child process: other suites mock modules in this one.
  const seed = spawnSync(
    process.execPath,
    [
      '-e',
      `const { Database } = require('bun:sqlite');
       const db = new Database(process.argv[1]);
       db.query("INSERT INTO decisions (created_at, project, decision, status, importance, provenance, access_count, confidence) VALUES (datetime('now'), 'alpha', ?, 'active', 9, 'extracted', 1, 'high')").run(process.argv[2]);
       db.close();`,
      join(root, 'recall.db'),
      NOTE,
    ],
    { env, encoding: 'utf-8' },
  );
  expect(seed.status).toBe(0);
  const claude = join(root, '.claude', 'CLAUDE.md');
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(claude, '# Mine\n');
  const nowhere = join(root, 'no-conversation');
  mkdirSync(nowhere, { recursive: true });
  const statePath = join(root, 'learned-tail-state.json');
  const stop = () =>
    spawnSync(process.execPath, [join(hooks, 'RecallExtract.ts')], {
      input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'tail-stop', cwd: nowhere }),
      env,
      encoding: 'utf-8',
      timeout: 30_000,
    });
  const state = () => JSON.parse(readFileSync(statePath, 'utf-8')) as { refreshedAt: number; tailSince: Record<string, string> };
  return { claude, statePath, stop, state };
}

describe('learned tail from the Stop hook', () => {
  test('a Stop with no conversation still refreshes, and a recent refresh is not repeated', () => {
    const { claude, statePath, stop, state } = setup();
    expect(stop().status).toBe(0);
    expect(readFileSync(claude, 'utf-8')).toContain(`- ${NOTE}`);
    expect(readFileSync(claude, 'utf-8').startsWith('# Mine\n')).toBe(true);
    const first = state();
    expect(first.refreshedAt).toBeGreaterThan(0);
    expect(Object.keys(first.tailSince)).toHaveLength(1);

    writeFileSync(claude, '# Mine\n');
    expect(stop().status).toBe(0);
    expect(readFileSync(claude, 'utf-8')).toBe('# Mine\n');

    writeFileSync(statePath, JSON.stringify({ ...first, refreshedAt: Date.now() - 2 * DAY }));
    expect(stop().status).toBe(0);
    expect(readFileSync(claude, 'utf-8')).toContain(`- ${NOTE}`);
    expect(state().tailSince).toEqual(first.tailSince);
  }, 60_000);

  test('a refused write keeps the old refresh time so the next Stop retries', () => {
    const { claude, statePath, stop, state } = setup();
    const old = Date.now() - 2 * DAY;
    writeFileSync(statePath, JSON.stringify({ refreshedAt: old, tailSince: {} }));
    const broken = '<!-- recall:begin -->\n<!-- recall:begin -->\n<!-- recall:end -->\n';
    writeFileSync(claude, broken);
    expect(stop().status).toBe(0);
    expect(readFileSync(claude, 'utf-8')).toBe(broken);
    expect(state()).toEqual({ refreshedAt: old, tailSince: {} });

    writeFileSync(claude, '# Mine\n');
    expect(stop().status).toBe(0);
    expect(readFileSync(claude, 'utf-8')).toContain(`- ${NOTE}`);
    expect(state().refreshedAt).toBeGreaterThan(old);
  }, 60_000);
});
