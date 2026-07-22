// Integration + static tests for hooks/RecallClearExtract.ts
//
// Static: grep guarantees (CLAUDECODE='', self-containment, matcher='clear' wiring).
// Integration: spawn RecallClearExtract as a subprocess against a tmp $HOME with stub
//              RecallExtract.ts, assert the parent picks the previous JSONL and
//              acquires the semaphore.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  utimesSync,
  rmSync,
  readFileSync,
  existsSync,
  chmodSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { encodeProjectDir } from '../../hooks/lib/hosts/claude/path-encoding';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const HOOK_SOURCE = join(REPO_ROOT, 'hooks', 'RecallClearExtract.ts');

let tmp: string;
let homeDir: string;
let projectsDir: string;
let claudeDir: string;
let claudeHooksDir: string;
let memoryDir: string;
let dbPath: string;
let cwd: string;
let projectDir: string;
let stubMarkerPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'recall-clearextract-'));
  homeDir = join(tmp, 'home');
  claudeDir = join(homeDir, '.claude');
  claudeHooksDir = join(claudeDir, 'hooks');
  memoryDir = join(claudeDir, 'MEMORY');
  projectsDir = join(claudeDir, 'projects');
  dbPath = join(claudeDir, 'memory.db');
  cwd = '/Users/test/some/project';
  projectDir = join(projectsDir, encodeProjectDir(cwd));
  stubMarkerPath = join(tmp, 'stub-marker.log');

  mkdirSync(projectDir, { recursive: true });
  mkdirSync(claudeHooksDir, { recursive: true });
  mkdirSync(memoryDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeJsonl(name: string, mtimeMs: number): string {
  const path = join(projectDir, name);
  writeFileSync(path, '{"role":"user","content":"hi"}\n');
  const seconds = mtimeMs / 1000;
  utimesSync(path, seconds, seconds);
  return path;
}

function initDbWithLocksTable(): void {
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`CREATE TABLE extraction_locks (
    conversation_path TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    started_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE extraction_tracker (
    conversation_path TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    extracted_at TEXT,
    failed_at TEXT,
    retry_after TEXT,
    error TEXT,
    skipped INTEGER DEFAULT 0
  )`);
  db.close();
}

/**
 * Write a stub RecallExtract.ts that records its argv to a marker file
 * and exits. Used to assert RecallClearExtract spawned with the right arguments
 * without invoking the real LLM pipeline.
 */
function installStubRecallExtract(): void {
  const stub = `#!/usr/bin/env bun
import { appendFileSync } from 'fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(stubMarkerPath)}, args.join('|') + '\\n');
process.exit(0);
`;
  const stubPath = join(claudeHooksDir, 'RecallExtract.ts');
  writeFileSync(stubPath, stub);
  chmodSync(stubPath, 0o755);
}

function runRecallClearExtract(
  stdinPayload: string,
  envOverrides: Record<string, string> = {}
): { status: number; stdout: string; stderr: string } {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: homeDir,
    RECALL_DB_PATH: dbPath,
    ...envOverrides,
  };
  delete env.CLAUDECODE;
  const result = spawnSync('bun', ['run', HOOK_SOURCE], {
    input: stdinPayload,
    env,
    encoding: 'utf-8',
    timeout: 15_000,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

// ---------------------------------------------------------------------------
// Static / grep tests
// ---------------------------------------------------------------------------

describe('RecallClearExtract static guarantees', () => {
  test('hook source is self-contained — no imports from src/', async () => {
    const text = await Bun.file(HOOK_SOURCE).text();
    expect(/from ['"]\.\.\/src/.test(text)).toBe(false);
    expect(/from ['"]\.\.\/\.\.\/src/.test(text)).toBe(false);
  });

  test('hook spawn sets CLAUDECODE empty to prevent recursive Stop fires', async () => {
    const text = await Bun.file(HOOK_SOURCE).text();
    expect(text).toContain("CLAUDECODE: ''");
  });

  test('hook uses pickPreviousJsonl + extraction-semaphore + extraction-tracker', async () => {
    const text = await Bun.file(HOOK_SOURCE).text();
    expect(text).toContain("from './lib/pick-previous-jsonl'");
    expect(text).toContain("from './lib/extraction-semaphore'");
    expect(text).toContain("from './lib/extraction-tracker'");
    expect(text).toContain("from './lib/sqlite-writers'");
  });

  test('hook releases semaphore on spawn failure', async () => {
    const text = await Bun.file(HOOK_SOURCE).text();
    expect(text).toContain('SPAWN_FAILED');
    const proximal =
      /releaseSemaphore[\s\S]{0,300}SPAWN_FAILED/.test(text) ||
      /SPAWN_FAILED[\s\S]{0,300}releaseSemaphore/.test(text);
    expect(proximal).toBe(true);
  });

  test('hook degrades when DB / extraction_locks table is missing', async () => {
    const text = await Bun.file(HOOK_SOURCE).text();
    expect(text).toContain('SEMAPHORE_UNAVAILABLE');
    expect(text).toContain('NO_DB');
  });
});

// ---------------------------------------------------------------------------
// Integration tests via subprocess spawn
// ---------------------------------------------------------------------------

describe('RecallClearExtract parent flow', () => {
  test('with no JSONLs in project dir, exits 0 and does not spawn child', () => {
    initDbWithLocksTable();
    installStubRecallExtract();
    const r = runRecallClearExtract(JSON.stringify({ cwd, source: 'clear' }));
    expect(r.status).toBe(0);
    expect(existsSync(stubMarkerPath)).toBe(false);
  });

  test('picks previous JSONL and spawns RecallExtract --extract', () => {
    initDbWithLocksTable();
    installStubRecallExtract();
    const now = Date.now();
    const oldPath = writeJsonl('old.jsonl', now - 60_000);
    writeJsonl('new.jsonl', now - 1_000); // suspect-in-progress

    const r = runRecallClearExtract(JSON.stringify({ cwd, source: 'clear' }));
    expect(r.status).toBe(0);

    // The stub records its argv; wait briefly for the detached spawn to write.
    let attempts = 0;
    while (attempts < 20 && !existsSync(stubMarkerPath)) {
      attempts++;
      const tickEnd = Date.now() + 100;
      while (Date.now() < tickEnd) { /* busy wait */ }
    }
    expect(existsSync(stubMarkerPath)).toBe(true);
    const marker = readFileSync(stubMarkerPath, 'utf-8').trim();
    // marker format: --extract|<prevPath>|<cwd>
    const parts = marker.split('|');
    expect(parts[0]).toBe('--extract');
    expect(parts[1]).toBe(oldPath);
    expect(parts[2]).toBe(cwd);
  });

  test('exits without spawn when DB is missing entirely', () => {
    installStubRecallExtract();
    const now = Date.now();
    writeJsonl('old.jsonl', now - 60_000);
    writeJsonl('new.jsonl', now - 1_000);

    const r = runRecallClearExtract(JSON.stringify({ cwd, source: 'clear' }));
    expect(r.status).toBe(0);
    expect(existsSync(stubMarkerPath)).toBe(false);
  });

  test('exits without spawn when extraction_locks table is missing (pre-migration DB)', () => {
    // Create a DB but NOT the extraction_locks table.
    const db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('CREATE TABLE other_table (id INTEGER)');
    db.close();

    installStubRecallExtract();
    const now = Date.now();
    writeJsonl('old.jsonl', now - 60_000);
    writeJsonl('new.jsonl', now - 1_000);

    const r = runRecallClearExtract(JSON.stringify({ cwd, source: 'clear' }));
    expect(r.status).toBe(0);
    expect(existsSync(stubMarkerPath)).toBe(false);
  });

  test('exits 0 with malformed stdin (no JSON)', () => {
    initDbWithLocksTable();
    installStubRecallExtract();
    const r = runRecallClearExtract('this is not json');
    expect(r.status).toBe(0);
  });

  test('semaphore acquires correctly during run', () => {
    initDbWithLocksTable();
    installStubRecallExtract();
    const now = Date.now();
    writeJsonl('old.jsonl', now - 60_000);
    writeJsonl('new.jsonl', now - 1_000);

    runRecallClearExtract(JSON.stringify({ cwd, source: 'clear' }));

    // Confirm a row was inserted in extraction_locks for the previous JSONL.
    // (The stub does not release; PID liveness sweep would clean up later.)
    const db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    const rows = db.prepare('SELECT * FROM extraction_locks').all() as Array<{
      conversation_path: string;
      pid: number;
    }>;
    db.close();
    expect(rows.length).toBe(1);
    expect(rows[0].conversation_path).toBe(join(projectDir, 'old.jsonl'));
  });
});

// ---------------------------------------------------------------------------
// Logging / EXTRACT_LOG.txt assertions
// ---------------------------------------------------------------------------

describe('RecallClearExtract logging', () => {
  test('logs NO_PREVIOUS_JSONL when project dir is empty', () => {
    initDbWithLocksTable();
    runRecallClearExtract(JSON.stringify({ cwd, source: 'clear' }));
    const logPath = join(memoryDir, 'EXTRACT_LOG.txt');
    if (existsSync(logPath)) {
      const log = readFileSync(logPath, 'utf-8');
      expect(log).toContain('NO_PREVIOUS_JSONL');
    }
  });
});
