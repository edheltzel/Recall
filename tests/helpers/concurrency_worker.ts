#!/usr/bin/env bun
/**
 * Concurrency test worker — spawned via Bun.spawn by semaphore tests.
 * 
 * Env vars:
 *   DB_PATH - path to SQLite database
 *   WORKER_ID - unique worker identifier
 *   MAX_CONCURRENT - maximum concurrent slots (default: 3)
 *   HOLD_MS - how long to hold the lock in ms (default: 100)
 *   CONV_PATH - conversation path to use for lock (default: /test/conv-{WORKER_ID}.jsonl)
 */

import { Database } from 'bun:sqlite';

const DB_PATH = process.env.DB_PATH;
const WORKER_ID = process.env.WORKER_ID || 'w0';
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '3', 10);
const HOLD_MS = parseInt(process.env.HOLD_MS || '100', 10);
const CONV_PATH = process.env.CONV_PATH || `/test/conv-${WORKER_ID}.jsonl`;

if (!DB_PATH) {
  console.error('DB_PATH is required');
  process.exit(2);
}

const db = new Database(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

// Create results table if not exists (for test assertions)
db.exec(`
  CREATE TABLE IF NOT EXISTS concurrency_results (
    worker_id TEXT PRIMARY KEY,
    acquired INTEGER NOT NULL,
    timestamp TEXT NOT NULL
  )
`);

// Ensure extraction_locks table exists
db.exec(`
  CREATE TABLE IF NOT EXISTS extraction_locks (
    conversation_path TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    started_at TEXT NOT NULL
  )
`);

// Try to acquire
const activeCount = (db.prepare('SELECT COUNT(*) as cnt FROM extraction_locks').get() as { cnt: number }).cnt;

let acquired = false;
if (activeCount < MAX_CONCURRENT) {
  const result = db.prepare(
    'INSERT OR IGNORE INTO extraction_locks (conversation_path, pid, started_at) VALUES (?, ?, datetime(\'now\'))'
  ).run(CONV_PATH, process.pid);
  acquired = result.changes > 0;
}

// Record result
db.prepare(
  'INSERT OR REPLACE INTO concurrency_results (worker_id, acquired, timestamp) VALUES (?, ?, datetime(\'now\'))'
).run(WORKER_ID, acquired ? 1 : 0);

if (acquired) {
  // Hold the lock for HOLD_MS
  await Bun.sleep(HOLD_MS);
  // Release
  db.prepare('DELETE FROM extraction_locks WHERE conversation_path = ?').run(CONV_PATH);
}

db.close();
process.exit(acquired ? 0 : 1);
