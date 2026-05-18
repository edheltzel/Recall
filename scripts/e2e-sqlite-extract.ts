#!/usr/bin/env bun
// Synthetic end-to-end verification of the SQLite-native extraction path.
// Run from the repo root: bun scripts/e2e-sqlite-extract.ts

import { Database } from 'bun:sqlite';
import { mkdtempSync, existsSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { dualWriteToSqlite } from '../hooks/lib/extraction-parsers';
import {
  markAsExtracted as trackerMarkAsExtracted,
  wasAlreadyExtracted as trackerWasAlreadyExtracted,
} from '../hooks/lib/extraction-tracker';
import { childAcquireLock, childReleaseLock } from '../hooks/lib/extraction-lock';
import { acquireSemaphore, releaseSemaphore, getActiveLockCount } from '../hooks/lib/extraction-semaphore';
import { initDb } from '../src/db/connection';

const FIXTURE = `## ONE SENTENCE SUMMARY
End-to-end test of the SQLite-native extraction path.

## MAIN IDEAS
- Hooks now dual-write into SQLite without breaking legacy file outputs
- Locks unified on extraction_locks table
- JSON tracker retired with one-shot migration

## DECISIONS MADE
- Migrate Stop hook tracker to SQLite (confidence: HIGH)
- Keep legacy markdown writers as additive surface (confidence: HIGH)

## ERRORS FIXED
- TOCTOU race in semaphore: wrap in BEGIN IMMEDIATE
- EEXIST file-lock collision: switch to extraction_locks SQLite table

## SESSION CONTEXT
A surgical migration finishing the SQLite-native extraction path.`;

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) fail(`${label}: expected ${expected}, got ${actual}`);
  console.log(`✓ ${label} = ${actual}`);
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'recall-e2e-'));
  const dbPath = join(tmp, 'memory.db');
  const convPath = join(tmp, 'fake-conv.jsonl');
  writeFileSync(convPath, '{"role":"user","content":"hi"}\n');
  process.env.MEM_DB_PATH = dbPath;

  console.log(`tmp dir: ${tmp}`);
  console.log(`db: ${dbPath}`);

  initDb();
  console.log('✓ db initialized');

  // In the real --extract flow, the parent acquires the semaphore (which IS
  // the per-conv lock since extraction_locks.PK = conversation_path) and the
  // child runs without re-acquiring. Model that here.
  const sem = acquireSemaphore(dbPath, convPath, process.pid, 3);
  assertEq(sem, true, 'parent semaphore acquired (doubles as per-conv lock)');

  // Verify the semaphore is also the per-conv lock: a second acquireSemaphore
  // for the same conv from a different PID must fail.
  const dupe = acquireSemaphore(dbPath, convPath, process.pid + 1, 3);
  assertEq(dupe, false, 'duplicate semaphore acquire (same conv, diff pid) rejected');

  const result = dualWriteToSqlite(dbPath, {
    sessionId: 'e2e-session',
    sessionLabel: 'e2e-test',
    project: 'atlas-recall',
    timestamp: '2026-05-17',
    conversationPath: convPath,
    topics: ['e2e', 'sqlite-native'],
    summary: 'One sentence summary',
    extracted: FIXTURE,
  });
  if (Object.keys(result.failures).length > 0) {
    fail(`dualWrite failures: ${JSON.stringify(result.failures)}`);
  }
  assertEq(result.sessions, 1, 'dualWrite sessions');
  assertEq(result.decisions, 2, 'dualWrite decisions');
  assertEq(result.learnings, 2, 'dualWrite learnings');
  assertEq(result.breadcrumbs, 3, 'dualWrite breadcrumbs');
  assertEq(result.errors, 2, 'dualWrite errors');
  assertEq(result.loa, 1, 'dualWrite loa');

  trackerMarkAsExtracted(dbPath, convPath, statSync(convPath).size);
  // Child path (--extract) releases the semaphore (which is the lock).
  // childReleaseLock is a defense for --reextract* paths; here it's a no-op
  // because the row's PID is process.pid which matches anyway.
  childReleaseLock(dbPath, convPath, process.pid);
  releaseSemaphore(dbPath, convPath);

  const wasExtracted = trackerWasAlreadyExtracted(dbPath, convPath, statSync(convPath).size);
  assertEq(wasExtracted, true, 'wasAlreadyExtracted after mark');

  const lockCount = getActiveLockCount(dbPath);
  assertEq(lockCount, 0, 'extraction_locks count after release');

  const tmpLocksDir = join(tmp, '.extract_locks');
  assertEq(existsSync(tmpLocksDir), false, 'tmp dir has no .extract_locks/');

  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  const trackerRow = db.prepare('SELECT * FROM extraction_tracker WHERE conversation_path = ?').get(convPath) as any;
  if (!trackerRow || !trackerRow.extracted_at) fail('extraction_tracker row missing extracted_at');
  console.log(`✓ extraction_tracker.extracted_at = ${trackerRow.extracted_at}`);

  const sessRow = db.prepare('SELECT * FROM extraction_sessions WHERE session_id = ?').get('e2e-session') as any;
  if (!sessRow) fail('extraction_sessions row missing');
  const topics = JSON.parse(sessRow.topics);
  if (!Array.isArray(topics) || topics.length === 0) fail('extraction_sessions topics empty');
  console.log(`✓ extraction_sessions.topics = ${JSON.stringify(topics)}`);

  db.close();
  rmSync(tmp, { recursive: true, force: true });
  console.log('\n✅ ALL E2E ASSERTIONS PASSED');
}

main().catch((e) => fail(e?.message || String(e)));
