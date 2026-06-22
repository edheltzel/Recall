// Test helper: creates isolated temp DB per test file
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, closeDb } from '../../src/db/connection';
import { __resetAvailabilityCache } from '../../src/lib/availability-cache';

let tempDir: string;

export function setupTestDb(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'recall-test-'));
  const dbPath = join(tempDir, 'test.db');
  process.env.RECALL_DB_PATH = dbPath;
  // Ensure no leaked MEM_DB_PATH from a prior test biases the resolver.
  delete process.env.MEM_DB_PATH;
  // Migration 4→5 imports ~/.claude/MEMORY/*.json into extraction_* tables on
  // every fresh DB, which breaks isolation once a real machine accumulates
  // session data there. Skip the legacy import so tests start truly empty
  // (issue #29 — replaces the former scrub-after-initDb workaround).
  process.env.RECALL_SKIP_LEGACY_DATA_MIGRATIONS = '1';
  // #150: the embedding-service availability cache is a process-global singleton
  // with a 30s wall-clock TTL. Clear it per test file so a liveness result from
  // one file (e.g. real-Ollama-absent → "unavailable") can't leak into another
  // that mocks the service "available" and exercises the real hybridSearch.
  __resetAvailabilityCache();
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
  delete process.env.RECALL_SKIP_LEGACY_DATA_MIGRATIONS;
}
