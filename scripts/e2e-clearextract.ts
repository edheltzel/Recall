#!/usr/bin/env bun
// Synthetic E2E: drive ClearExtract.ts against a tmp $HOME with two JSONLs,
// confirm the parent picks the older one, acquires the semaphore, and the
// stubbed SessionExtract child runs with the expected args.
//
// Run: bun scripts/e2e-clearextract.ts

import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, existsSync, readFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { encodeProjectDir } from '../hooks/lib/path-encoding';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  console.log(`✓ ${label} = ${JSON.stringify(actual)}`);
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'recall-e2e-clear-'));
  const homeDir = join(tmp, 'home');
  const claudeDir = join(homeDir, '.claude');
  const hooksDir = join(claudeDir, 'hooks');
  const memoryDir = join(claudeDir, 'MEMORY');
  const projectsDir = join(claudeDir, 'projects');
  const dbPath = join(claudeDir, 'memory.db');
  const cwd = '/Users/test/some/project';
  const projectDir = join(projectsDir, encodeProjectDir(cwd));
  const stubMarkerPath = join(tmp, 'stub-marker.log');

  mkdirSync(projectDir, { recursive: true });
  mkdirSync(hooksDir, { recursive: true });
  mkdirSync(memoryDir, { recursive: true });

  console.log(`tmp dir: ${tmp}`);
  console.log(`db: ${dbPath}`);

  // 1. Init DB with extraction_locks + extraction_tracker
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`CREATE TABLE extraction_locks (
    conversation_path TEXT PRIMARY KEY, pid INTEGER NOT NULL, started_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE extraction_tracker (
    conversation_path TEXT PRIMARY KEY, size INTEGER NOT NULL,
    extracted_at TEXT, failed_at TEXT, retry_after TEXT, error TEXT, skipped INTEGER DEFAULT 0
  )`);
  db.close();
  console.log('✓ DB initialized');

  // 2. Write two JSONLs: old (60s ago) and new (1s ago — within guard).
  function writeJsonl(name: string, mtimeMs: number): string {
    const path = join(projectDir, name);
    writeFileSync(path, '{"role":"user","content":"hi"}\n');
    const secs = mtimeMs / 1000;
    utimesSync(path, secs, secs);
    return path;
  }
  const now = Date.now();
  const oldPath = writeJsonl('old.jsonl', now - 60_000);
  const newPath = writeJsonl('new.jsonl', now - 1_000);
  console.log(`✓ wrote two JSONLs: old=${oldPath} new=${newPath}`);

  // 3. Stub SessionExtract.ts that records its argv
  const stub = `#!/usr/bin/env bun
import { appendFileSync } from 'fs';
appendFileSync(${JSON.stringify(stubMarkerPath)}, process.argv.slice(2).join('|') + '\\n');
process.exit(0);
`;
  const stubPath = join(hooksDir, 'SessionExtract.ts');
  writeFileSync(stubPath, stub);
  chmodSync(stubPath, 0o755);
  console.log(`✓ stub SessionExtract installed at ${stubPath}`);

  // 4. Verify extraction_tracker is empty
  const dbCheck1 = new Database(dbPath);
  const trackerCountBefore = (dbCheck1.prepare('SELECT COUNT(*) c FROM extraction_tracker').get() as any).c;
  const lockCountBefore = (dbCheck1.prepare('SELECT COUNT(*) c FROM extraction_locks').get() as any).c;
  dbCheck1.close();
  assertEq(trackerCountBefore, 0, 'extraction_tracker empty before run');
  assertEq(lockCountBefore, 0, 'extraction_locks empty before run');

  // 5. Spawn ClearExtract with a SessionStart-style stdin
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: homeDir,
    MEM_DB_PATH: dbPath,
  };
  delete env.CLAUDECODE;
  const stdinPayload = JSON.stringify({
    cwd,
    source: 'clear',
    session_id: 'e2e-session',
    transcript_path: newPath,
  });

  const hookPath = join(import.meta.dir, '..', 'hooks', 'ClearExtract.ts');
  const result = spawnSync('bun', ['run', hookPath], {
    input: stdinPayload,
    env,
    encoding: 'utf-8',
    timeout: 15_000,
  });

  if (result.status !== 0) fail(`ClearExtract exited ${result.status}: ${result.stderr}`);
  console.log('✓ ClearExtract parent exited 0');

  // 6. Wait briefly for the detached stub to fire
  let attempts = 0;
  while (attempts < 30 && !existsSync(stubMarkerPath)) {
    attempts++;
    const tickEnd = Date.now() + 100;
    while (Date.now() < tickEnd) { /* busy wait */ }
  }
  if (!existsSync(stubMarkerPath)) fail('stub SessionExtract was never spawned');
  const marker = readFileSync(stubMarkerPath, 'utf-8').trim();
  console.log(`✓ stub marker: ${marker}`);
  const parts = marker.split('|');
  assertEq(parts[0], '--extract', 'stub called with --extract');
  assertEq(parts[1], oldPath, 'stub called with PREVIOUS JSONL (the older one)');
  assertEq(parts[2], cwd, 'stub called with original cwd');

  // 7. Confirm extraction_locks has a row keyed on the previous JSONL
  const dbCheck2 = new Database(dbPath);
  const lockRows = dbCheck2.prepare('SELECT conversation_path, pid FROM extraction_locks').all() as Array<{
    conversation_path: string; pid: number;
  }>;
  dbCheck2.close();
  assertEq(lockRows.length, 1, 'one lock row after acquire');
  assertEq(lockRows[0].conversation_path, oldPath, 'lock row keyed on previous JSONL');

  rmSync(tmp, { recursive: true, force: true });
  console.log('\n✅ ALL E2E ASSERTIONS PASSED');
}

main().catch((e) => fail(e?.message || String(e)));
