// Test helper: creates isolated temp DB per test file
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, closeDb } from '../../src/db/connection';

let tempDir: string;

export function setupTestDb(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'recall-test-'));
  const dbPath = join(tempDir, 'test.db');
  process.env.RECALL_DB_PATH = dbPath;
  // Ensure no leaked MEM_DB_PATH from a prior test biases the resolver.
  delete process.env.MEM_DB_PATH;
  initDb();
  // Migration 4→5 in src/db/migrations.ts seeds extraction_* tables from
  // ~/.claude/MEMORY/*.json on every fresh DB. That breaks test isolation
  // once a real machine accumulates session data there. Strip those rows
  // so tests reliably start from empty.
  closeDb();
  const scrub = new Database(dbPath);
  try {
    for (const t of ['extraction_sessions', 'extraction_tracker', 'extraction_errors']) {
      scrub.prepare(`DELETE FROM ${t}`).run();
    }
  } finally {
    scrub.close();
  }
  initDb();
  return dbPath;
}

export function teardownTestDb(): void {
  closeDb();
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  delete process.env.RECALL_DB_PATH;
  delete process.env.MEM_DB_PATH;
}
