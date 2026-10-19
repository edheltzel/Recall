import type { Database } from 'bun:sqlite';
import { closeSync, mkdirSync, openSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const OMP_CURATED_DESCRIPTION = 'Curated fabric extraction from omp session end.';

function ompLoaLockPath(sessionId: string): string {
  return join(process.env.RECALL_HOME || join(homedir(), '.agents', 'Recall'), `omp-loa-${sessionId}.pid`);
}

export function exclusiveLoaLock(sessionId: string): boolean {
  const path = ompLoaLockPath(sessionId);
  mkdirSync(dirname(path), { recursive: true });
  try {
    closeSync(openSync(path, 'wx'));
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') return false;
    throw error;
  }
}

export function releaseLoaLock(sessionId: string): void {
  try {
    unlinkSync(ompLoaLockPath(sessionId));
  } catch {}
}

export function loadOmpLifecycleMessages(db: Database, sessionId: string): unknown[] {
  return db.prepare(`
    SELECT m.id, m.session_id, m.timestamp, m.role, m.content, m.project, m.importance, m.provenance
    FROM active_host_ingest_messages h
    JOIN published_messages m ON m.id = h.message_id
    WHERE h.source = 'omp' AND h.session_id = ? AND h.source_position IS NOT NULL
    ORDER BY h.source_position, h.message_id
  `).all(sessionId);
}

export function ompSnapshotsMatch(left: readonly unknown[], right: readonly unknown[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function ompCuratedSnapshotBehind(db: Database, sessionId: string): boolean {
  return db.transaction(() => {
    const messages = loadOmpLifecycleMessages(db, sessionId);
    if (messages.length === 0) return false;
    const row = db.prepare(`
      SELECT id FROM loa_entries WHERE session_id = ? AND description = ?
      ORDER BY id DESC LIMIT 1
    `).get(sessionId, OMP_CURATED_DESCRIPTION) as { id: number } | undefined;
    if (!row) return true;
    const pins = db.prepare(`
      SELECT message_id AS id, session_id, timestamp, role, content, project, importance, provenance
      FROM loa_message_sources WHERE loa_id = ? ORDER BY ordinal
    `).all(row.id);
    return !ompSnapshotsMatch(messages, pins);
  })();
}
