// Test helper: creates isolated temp DB per test file
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, closeDb } from '../../src/db/connection';

let tempDir: string;

export function setupTestDb(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'recall-test-'));
  const dbPath = join(tempDir, 'test.db');
  process.env.MEM_DB_PATH = dbPath;
  initDb();
  return dbPath;
}

export function teardownTestDb(): void {
  closeDb();
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  delete process.env.MEM_DB_PATH;
}
