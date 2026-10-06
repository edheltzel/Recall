import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

const REPO = join(import.meta.dir, '..', '..');
const CLI = join(REPO, 'src', 'index.ts');
const PRODUCTION_DB = join(homedir(), '.agents', 'Recall', 'recall.db');
const TOKEN = 'capturequokka640';

interface FileMeta {
  exists: boolean;
  size?: number;
  mtimeMs?: number;
  ino?: number;
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function metadata(path: string): FileMeta {
  if (!existsSync(path)) return { exists: false };
  const stat = statSync(path);
  return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
}

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string
): CliResult {
  const result = spawnSync('bun', [CLI, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    input,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function isolationEnv(root: string): { env: NodeJS.ProcessEnv; dbPath: string } {
  const dbPath = join(root, 'recall.db');
  const recallHome = join(root, 'recall-home');
  expect(dbPath).not.toBe(PRODUCTION_DB);
  expect(dbPath.startsWith(join(homedir(), '.agents', 'Recall'))).toBe(false);
  return {
    dbPath,
    env: {
      HOME: root,
      RECALL_DB_PATH: dbPath,
      RECALL_HOME: recallHome,
      RECALL_SKIP_LEGACY_DATA_MIGRATIONS: '1',
    },
  };
}

function initIsolatedDb(env: NodeJS.ProcessEnv): void {
  const initialized = runCli(['init'], env);
  expect(initialized.status).toBe(0);
}

function ambientRows(dbPath: string): {
  contents: string[];
  loa: Array<{ tags: string; importance: number; fabric_extract: string }>;
} {
  const db = new Database(dbPath, { readonly: true });
  try {
    const contents = db.query<{ content: string }, []>(
      'SELECT content FROM host_ingest_generation_messages WHERE content IS NOT NULL'
    ).all().map(row => row.content);
    const loa = db.query<{ tags: string; importance: number; fabric_extract: string }, []>(
      'SELECT tags, importance, fabric_extract FROM loa_entries'
    ).all();
    return { contents, loa };
  } finally {
    db.close();
  }
}

describe('recall capture public CLI', () => {
  const roots: string[] = [];
  const productionBefore = metadata(PRODUCTION_DB);

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
    expect(metadata(PRODUCTION_DB)).toEqual(productionBefore);
  });

  test('capture --help documents the public surface', () => {
    const help = runCli(['capture', '--help'], {});
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--contract');
    expect(help.stdout).toContain('--harness');
    expect(help.stdout).toContain('--event');
    expect(help.stdout).toContain('turn_end');
    expect(help.stdout).toContain('session_end');
    expect(help.stdout).toContain('--session-id');
    expect(help.stdout).toContain('--cwd');
    expect(help.stdout).toContain('--project');
    expect(help.stdout).toContain('--text');
    expect(help.stdout).toContain('--text-file');
    expect(help.stdout.toLowerCase()).toContain('stdin');
  });

  test('recall --help lists capture and keeps host-hook hidden', () => {
    const help = runCli(['--help'], {});
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/\scapture\s/);
    expect(help.stdout).not.toContain('host-hook');
  });

  test('missing harness is rejected with no DB write', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-capture-no-harness-'));
    roots.push(root);
    const { env, dbPath } = isolationEnv(root);
    const result = runCli(
      ['capture', '--event', 'turn_end', '--text', TOKEN],
      env
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/harness/i);
    expect(existsSync(dbPath)).toBe(false);
  });

  test('invalid harness id is rejected with no DB write', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-capture-harness-'));
    roots.push(root);
    const { env, dbPath } = isolationEnv(root);
    const result = runCli(
      ['capture', '--harness', 'OMP', '--event', 'turn_end', '--text', TOKEN],
      env
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/harness/i);
    expect(existsSync(dbPath)).toBe(false);
  });

  test('empty text is rejected with no DB write', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-capture-empty-'));
    roots.push(root);
    const { env, dbPath } = isolationEnv(root);
    const result = runCli(
      ['capture', '--harness', 'claude', '--event', 'turn_end', '--text', '   '],
      env
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/text/i);
    expect(existsSync(dbPath)).toBe(false);
  });

  test('invalid event exits non-zero with no DB write', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-capture-event-'));
    roots.push(root);
    const { env, dbPath } = isolationEnv(root);
    initIsolatedDb(env);
    const result = runCli(
      ['capture', '--harness', 'claude', '--event', 'session_stop', '--text', TOKEN],
      env
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/event/i);
    expect(ambientRows(dbPath)).toEqual({ contents: [], loa: [] });
  });

  test('missing --contract defaults to 1', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-capture-contract-'));
    roots.push(root);
    const { env, dbPath } = isolationEnv(root);
    initIsolatedDb(env);
    const result = runCli(
      [
        'capture',
        '--harness', 'claude',
        '--event', 'turn_end',
        '--session-id', 'capture-default-contract',
        '--text', TOKEN,
      ],
      env
    );
    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/contract/i);
    const rows = ambientRows(dbPath);
    expect(rows.contents.some(content => content.includes(TOKEN))).toBe(true);
  });

  test('turn_end with harness claude stores searchable automatic-capture ambient text', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-capture-happy-'));
    roots.push(root);
    const { env, dbPath } = isolationEnv(root);
    initIsolatedDb(env);
    const captured = runCli(
      [
        'capture',
        '--contract', '1',
        '--harness', 'claude',
        '--event', 'turn_end',
        '--session-id', 'capture-claude-turn',
        '--project', 'Recall',
        '--text', `Decision: keep ${TOKEN} below curated importance.`,
      ],
      env
    );
    expect(captured.status).toBe(0);

    const search = runCli(['search', TOKEN, '-t', 'messages'], env);
    expect(search.status).toBe(0);
    expect(search.stdout).toContain(TOKEN);

    const rows = ambientRows(dbPath);
    expect(rows.loa).toHaveLength(1);
    expect(rows.loa[0]?.tags).toBe('automatic-capture,claude');
    expect(rows.loa[0]?.importance).toBe(6);
    expect(rows.loa[0]?.fabric_extract).toContain(TOKEN);
  });

  test('stdin JSON twin with identical fields matches the flag-form store outcome', () => {
    const flagRoot = mkdtempSync(join(tmpdir(), 'recall-capture-flag-'));
    const jsonRoot = mkdtempSync(join(tmpdir(), 'recall-capture-json-'));
    roots.push(flagRoot, jsonRoot);
    const flag = isolationEnv(flagRoot);
    const json = isolationEnv(jsonRoot);
    initIsolatedDb(flag.env);
    initIsolatedDb(json.env);
    const fields = {
      contract: 1,
      harness: 'claude',
      event: 'turn_end' as const,
      session_id: 'capture-parity',
      project: 'Recall',
      text: `Parity payload ${TOKEN} from both doors.`,
    };

    const flagResult = runCli(
      [
        'capture',
        '--contract', '1',
        '--harness', fields.harness,
        '--event', fields.event,
        '--session-id', fields.session_id,
        '--project', fields.project,
        '--text', fields.text,
      ],
      flag.env
    );
    const jsonResult = runCli(['capture'], json.env, `${JSON.stringify(fields)}\n`);

    expect(flagResult.status).toBe(0);
    expect(jsonResult.status).toBe(0);
    expect(ambientRows(flag.dbPath)).toEqual(ambientRows(json.dbPath));
  });

  test('--text-file is accepted as the text source', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-capture-file-'));
    roots.push(root);
    const { env, dbPath } = isolationEnv(root);
    initIsolatedDb(env);
    const textFile = join(root, 'turn.txt');
    writeFileSync(textFile, `File-sourced ${TOKEN} turn.`);
    const result = runCli(
      [
        'capture',
        '--harness', 'claude',
        '--event', 'session_end',
        '--session-id', 'capture-text-file',
        '--text-file', textFile,
      ],
      env
    );
    expect(result.status).toBe(0);
    expect(ambientRows(dbPath).contents.some(content => content.includes(TOKEN))).toBe(true);
  });
});
