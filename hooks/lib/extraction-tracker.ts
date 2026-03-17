// Extraction tracker CRUD — self-contained, no imports from src/
// All functions take dbPath as first parameter for testability.

import { Database } from 'bun:sqlite';

function openDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  return db;
}

export interface ExtractionRecord {
  conversation_path: string;
  size: number;
  extracted_at: string | null;
  failed_at: string | null;
  retry_after: string | null;
  error: string | null;
  skipped: number;
}

export function getExtractionRecord(dbPath: string, conversationPath: string): ExtractionRecord | null {
  const db = openDb(dbPath);
  try {
    const row = db
      .prepare('SELECT * FROM extraction_tracker WHERE conversation_path = ?')
      .get(conversationPath) as ExtractionRecord | undefined;
    return row ?? null;
  } finally {
    db.close();
  }
}

export function markAsExtracted(dbPath: string, conversationPath: string, size: number): void {
  const db = openDb(dbPath);
  try {
    db.prepare(
      "INSERT OR REPLACE INTO extraction_tracker (conversation_path, size, extracted_at) VALUES (?, ?, datetime('now'))"
    ).run(conversationPath, size);
  } finally {
    db.close();
  }
}

export function markAsFailed(
  dbPath: string,
  conversationPath: string,
  size: number,
  error?: string
): void {
  const db = openDb(dbPath);
  try {
    db.prepare(
      "INSERT OR REPLACE INTO extraction_tracker (conversation_path, size, failed_at, retry_after, error) VALUES (?, ?, datetime('now'), datetime('now', '+24 hours'), ?)"
    ).run(conversationPath, size, error ?? null);
  } finally {
    db.close();
  }
}

export function wasAlreadyExtracted(
  dbPath: string,
  conversationPath: string,
  currentSize: number
): boolean {
  const record = getExtractionRecord(dbPath, conversationPath);
  if (!record) return false;

  // Successfully extracted and size hasn't grown more than 50%
  if (record.extracted_at) {
    const growth = (currentSize - record.size) / record.size;
    return growth <= 0.5;
  }

  // Failed but still within retry cooldown
  if (record.failed_at && record.retry_after) {
    const retryAfter = new Date(record.retry_after);
    return retryAfter > new Date();
  }

  return false;
}

export function getAllTrackerRecords(dbPath: string): ExtractionRecord[] {
  const db = openDb(dbPath);
  try {
    return db.prepare('SELECT * FROM extraction_tracker').all() as ExtractionRecord[];
  } finally {
    db.close();
  }
}
