// The Stop hook refreshes the learned tail (#279) on every Stop, including the
// exits that never reach extraction, and a refused write keeps the old state.
// Notes come from real Stop extraction (`--extract`, the hook's own child mode)
// with a fake `claude` CLI, so they carry the importance and provenance
// extraction actually writes.
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

const REPO = join(import.meta.dir, '..', '..');
const CLI = join(REPO, 'src', 'index.ts');
const HOOKS = join(REPO, 'hooks');
const PRODUCTION_DB = join(homedir(), '.agents', 'Recall', 'recall.db');
const NOTE = 'Run the migration dry-run before every schema change.';
const ONE_OFF = 'Pin the alpha dev server to port 4100 for local runs.';
const UNSURE = 'Maybe split the settings page into two tabs later on.';
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
  mkdirSync(join(root, '.claude', 'MEMORY'), { recursive: true });
  const statePath = join(root, 'learned-tail-state.json');
  extract(root, hooks, env, 'session-one', 'alpha', [NOTE, ONE_OFF], [UNSURE]);
  extract(root, hooks, env, 'session-two', 'bravo', [NOTE], [UNSURE]);
  const rows = spawnSync(
    process.execPath,
    [
      '-e',
      `const { Database } = require('bun:sqlite');
       const db = new Database(process.argv[1], { readonly: true });
       process.stdout.write(JSON.stringify(db.query("SELECT decision, importance, provenance, confidence FROM decisions ORDER BY id").all()));`,
      join(root, 'recall.db'),
    ],
    { env, encoding: 'utf-8' },
  );
  expect(JSON.parse(rows.stdout)).toEqual([
    { decision: NOTE, importance: 5, provenance: 'extracted', confidence: 'high' },
    { decision: ONE_OFF, importance: 5, provenance: 'extracted', confidence: 'high' },
    { decision: UNSURE, importance: 5, provenance: 'extracted', confidence: 'low' },
    { decision: NOTE, importance: 5, provenance: 'extracted', confidence: 'high' },
    { decision: UNSURE, importance: 5, provenance: 'extracted', confidence: 'low' },
  ]);
  rmSync(statePath, { force: true });
  const claude = join(root, '.claude', 'CLAUDE.md');
  writeFileSync(claude, '# Mine\n');
  const nowhere = join(root, 'no-conversation');
  mkdirSync(nowhere, { recursive: true });
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

function extraction(sure: string[], unsure: string[]): string {
  return [
    '## ONE SENTENCE SUMMARY',
    'We tightened the schema change workflow so every migration is rehearsed before it touches a shared database.',
    '',
    '## MAIN IDEAS',
    '- Schema changes are rehearsed against a dry-run before they reach any shared database copy',
    '- The migration tooling reports every statement it would run so reviewers can read the plan',
    '- Local development servers keep fixed ports so the fixtures stay reproducible across runs',
    '',
    '## DECISIONS MADE',
    ...sure.map((d) => `- ${d} (confidence: HIGH)`),
    ...unsure.map((d) => `- ${d} (confidence: LOW)`),
    '',
    '## SESSION CONTEXT',
    'A workflow hardening session for database migrations.',
  ].join('\n');
}

function extract(root: string, hooks: string, env: NodeJS.ProcessEnv, session: string, project: string, sure: string[], unsure: string[]): void {
  const bin = join(root, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  const claude = join(bin, 'claude');
  writeFileSync(claude, `#!/usr/bin/env bun\ntry { require('fs').readFileSync(0, 'utf-8'); } catch {}\nprocess.stdout.write(${JSON.stringify(extraction(sure, unsure))});\n`);
  chmodSync(claude, 0o755);
  const cwd = join(root, 'work', project);
  mkdirSync(cwd, { recursive: true });
  const conversation = join(root, 'conversations', `${session}.jsonl`);
  mkdirSync(join(root, 'conversations'), { recursive: true });
  const lines: string[] = [];
  for (let i = 0; i < 80; i++) {
    lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: 'please help me with the migration' } }));
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'here is a detailed answer about the migration' }] } }));
  }
  writeFileSync(conversation, lines.join('\n') + '\n');
  const run = spawnSync(process.execPath, ['run', join(hooks, 'RecallExtract.ts'), '--extract', conversation, cwd], {
    env,
    encoding: 'utf-8',
    timeout: 60_000,
  });
  expect(run.status).toBe(0);
}

describe('learned tail from the Stop hook', () => {
  test('a Stop with no conversation still refreshes, and a recent refresh is not repeated', () => {
    const { claude, statePath, stop, state } = setup();
    expect(stop().status).toBe(0);
    expect(readFileSync(claude, 'utf-8')).toContain(`- ${NOTE}`);
    expect(readFileSync(claude, 'utf-8')).not.toContain(ONE_OFF);
    expect(readFileSync(claude, 'utf-8')).not.toContain(UNSURE);
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
    const [key] = Object.keys(first.tailSince);
    expect(Object.keys(state().tailSince)).toEqual([key]);
    expect(Date.parse(state().tailSince[key])).toBeGreaterThan(Date.parse(first.tailSince[key]));
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
