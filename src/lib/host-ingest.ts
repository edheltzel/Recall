import type { Database } from 'bun:sqlite';
import { createHash } from 'crypto';
import { getDb } from '../db/connection.js';
import { detectProject } from './project.js';
import { generateBasicSummary } from './extraction.js';
import { scrub } from './write-safety.js';

export type LifecycleHost = 'codex' | 'grok' | 'jcode';
export type HostMessageRole = 'user' | 'assistant' | 'system';

export interface HostTranscriptMessage {
  role: HostMessageRole;
  content: string;
  timestamp?: string;
  nativeId?: string;
}

export interface HostTranscript {
  source: LifecycleHost;
  sessionId: string;
  messages: HostTranscriptMessage[];
  cwd?: string;
  project?: string;
  transcriptRef?: string;
  watermark?: string;
  capturedAt?: string;
  finalize?: boolean;
}

export interface HostIngestResult {
  sessionId: string;
  inserted: number;
  skipped: number;
  finalized: boolean;
  loaId?: number;
  redactions: string[];
  digest: string;
}

interface PreparedMessage extends HostTranscriptMessage {
  content: string;
  timestamp: string;
  messageKey: string;
}

interface PreparedTranscript {
  capturedAt: string;
  messages: PreparedMessage[];
  cwd?: string;
  project?: string;
  transcriptRef?: string;
  watermark: string;
  digest: string;
  redactions: Set<string>;
}

interface IngestStateRow {
  finalized_at: string | null;
}

interface StoredMessage {
  id: number;
  role: HostMessageRole;
  content: string;
  timestamp: string;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertSessionId(sessionId: string): void {
  if (!sessionId || sessionId.length > 512 || /[\u0000-\u001f\u007f]/.test(sessionId)) {
    throw new Error('Lifecycle hook supplied an invalid native session ID');
  }
}

function normalizedTimestamp(value: string | undefined, fallback: string, ordinal: number): string {
  if (value && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  const base = Number.isFinite(Date.parse(fallback)) ? Date.parse(fallback) : Date.now();
  return new Date(base + ordinal).toISOString();
}

function prepareMessages(
  messages: HostTranscriptMessage[],
  capturedAt: string,
  redactions: Set<string>
): PreparedMessage[] {
  const occurrences = new Map<string, number>();
  const prepared: PreparedMessage[] = [];

  for (const [ordinal, message] of messages.entries()) {
    if (!['user', 'assistant', 'system'].includes(message.role)) continue;
    if (typeof message.content !== 'string' || !message.content.trim()) continue;

    const cleaned = scrub(message.content);
    for (const kind of cleaned.redactions) redactions.add(kind);
    if (!cleaned.text.trim()) continue;

    const base = `${message.role}\u0000${cleaned.text}`;
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    const identity = message.nativeId
      ? `native\u0000${message.nativeId}`
      : `content\u0000${base}\u0000${occurrence}`;

    prepared.push({
      ...message,
      content: cleaned.text,
      timestamp: normalizedTimestamp(message.timestamp, capturedAt, ordinal),
      messageKey: hash(identity),
    });
  }

  return prepared;
}

function prepareTranscript(input: HostTranscript): PreparedTranscript {
  const capturedAt = normalizedTimestamp(input.capturedAt, new Date().toISOString(), 0);
  const redactions = new Set<string>();
  const messages = prepareMessages(input.messages, capturedAt, redactions);
  const cwdResult = input.cwd ? scrub(input.cwd) : undefined;
  const detectedProject = input.project ?? detectProject(input.cwd);
  const projectResult = detectedProject ? scrub(detectedProject) : undefined;
  const refResult = input.transcriptRef ? scrub(input.transcriptRef) : undefined;
  const watermarkResult = input.watermark ? scrub(input.watermark) : undefined;

  for (const result of [cwdResult, projectResult, refResult, watermarkResult]) {
    for (const kind of result?.redactions ?? []) redactions.add(kind);
  }

  const digest = hash(
    JSON.stringify(
      messages.map(({ role, content, nativeId }) => ({
        role,
        content,
        nativeId: nativeId ?? null,
      }))
    )
  );

  return {
    capturedAt,
    messages,
    cwd: cwdResult?.text.slice(0, 4096),
    project: projectResult?.text.slice(0, 512) || undefined,
    transcriptRef: refResult?.text.slice(0, 4096),
    watermark: watermarkResult?.text.slice(0, 4096) ?? `${messages.length}:${digest}`,
    digest,
    redactions,
  };
}

function assertSessionOwnership(db: Database, input: HostTranscript): void {
  const existing = db
    .prepare('SELECT source FROM sessions WHERE session_id = ?')
    .get(input.sessionId) as { source: string | null } | undefined;
  if (existing?.source && existing.source !== 'unknown' && existing.source !== input.source) {
    throw new Error(`Native session ID ${input.sessionId} is already owned by ${existing.source}`);
  }
}

function upsertSession(db: Database, input: HostTranscript, prepared: PreparedTranscript): void {
  const timestamps = prepared.messages
    .map(message => message.timestamp)
    .sort((left, right) => left.localeCompare(right));
  const startedAt = timestamps[0] ?? prepared.capturedAt;
  const endedAt = input.finalize ? (timestamps.at(-1) ?? prepared.capturedAt) : null;

  db.prepare(`
    INSERT INTO sessions (session_id, started_at, ended_at, project, cwd, source)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      ended_at = COALESCE(excluded.ended_at, sessions.ended_at),
      project = COALESCE(sessions.project, excluded.project),
      cwd = COALESCE(sessions.cwd, excluded.cwd),
      source = excluded.source
  `).run(
    input.sessionId,
    startedAt,
    endedAt,
    prepared.project ?? null,
    prepared.cwd ?? null,
    input.source
  );
}

function insertNewMessages(
  db: Database,
  input: HostTranscript,
  prepared: PreparedTranscript
): number {
  const knownKeys = new Set(
    (
      db
        .prepare(`
          SELECT message_key FROM host_ingest_messages
          WHERE source = ? AND session_id = ?
        `)
        .all(input.source, input.sessionId) as Array<{ message_key: string }>
    ).map(row => row.message_key)
  );
  const insertMessage = db.prepare(`
    INSERT INTO messages (session_id, timestamp, role, content, project, importance, provenance)
    VALUES (?, ?, ?, ?, ?, 5, 'verbatim')
  `);
  const insertKey = db.prepare(`
    INSERT INTO host_ingest_messages (source, session_id, message_key, message_id)
    VALUES (?, ?, ?, ?)
  `);

  let inserted = 0;
  for (const message of prepared.messages) {
    if (knownKeys.has(message.messageKey)) continue;
    const result = insertMessage.run(
      input.sessionId,
      message.timestamp,
      message.role,
      message.content,
      prepared.project ?? null
    );
    insertKey.run(input.source, input.sessionId, message.messageKey, result.lastInsertRowid);
    knownKeys.add(message.messageKey);
    inserted++;
  }
  return inserted;
}

function getIngestState(db: Database, input: HostTranscript): IngestStateRow | undefined {
  return db
    .prepare(`
      SELECT finalized_at FROM host_ingest_state
      WHERE source = ? AND session_id = ?
    `)
    .get(input.source, input.sessionId) as IngestStateRow | undefined;
}

function finalizeSession(
  db: Database,
  input: HostTranscript,
  project: string | undefined,
  alreadyFinalized: boolean
): { finalized: boolean; loaId?: number } {
  if (!input.finalize || alreadyFinalized) return { finalized: false };

  const messages = db
    .prepare(`
      SELECT id, role, content, timestamp FROM messages
      WHERE session_id = ? ORDER BY timestamp, id
    `)
    .all(input.sessionId) as StoredMessage[];
  if (messages.length === 0) return { finalized: false };

  const title = `${input.source[0].toUpperCase()}${input.source.slice(1)} session ${input.sessionId}`;
  const result = db
    .prepare(`
      INSERT INTO loa_entries
        (title, description, fabric_extract, message_range_start, message_range_end,
         session_id, project, tags, message_count, importance, provenance)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 8, 'extracted')
    `)
    .run(
      title,
      `Automatic terminal extraction from ${input.source} lifecycle capture.`,
      generateBasicSummary(messages),
      messages[0].id,
      messages.at(-1)!.id,
      input.sessionId,
      project ?? null,
      `automatic-capture,${input.source}`,
      messages.length
    );
  db.prepare('UPDATE sessions SET summary = ? WHERE session_id = ?').run(title, input.sessionId);
  return { finalized: true, loaId: Number(result.lastInsertRowid) };
}

function persistIngestState(
  db: Database,
  input: HostTranscript,
  prepared: PreparedTranscript,
  previous: IngestStateRow | undefined,
  finalized: boolean
): void {
  const finalizedAt = finalized ? prepared.capturedAt : (previous?.finalized_at ?? null);
  db.prepare(`
    INSERT INTO host_ingest_state
      (source, session_id, transcript_ref, watermark, transcript_digest, finalized_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, session_id) DO UPDATE SET
      transcript_ref = excluded.transcript_ref,
      watermark = excluded.watermark,
      transcript_digest = excluded.transcript_digest,
      finalized_at = COALESCE(host_ingest_state.finalized_at, excluded.finalized_at),
      updated_at = excluded.updated_at
  `).run(
    input.source,
    input.sessionId,
    prepared.transcriptRef ?? null,
    prepared.watermark,
    prepared.digest,
    finalizedAt,
    prepared.capturedAt
  );
}

/**
 * Immediately ingest a host-supplied transcript into recall.db.
 *
 * This is the single host-neutral write seam for lifecycle adapters. It scrubs
 * before hashing or writing, preserves native session IDs, records source and
 * project attribution, and makes repeated overlapping hooks idempotent.
 */
export function ingestHostTranscript(input: HostTranscript): HostIngestResult {
  assertSessionId(input.sessionId);
  const prepared = prepareTranscript(input);
  const db = getDb();

  return db
    .transaction(() => {
      assertSessionOwnership(db, input);
      upsertSession(db, input, prepared);
      const inserted = insertNewMessages(db, input, prepared);
      const previous = getIngestState(db, input);
      const terminal = finalizeSession(
        db,
        input,
        prepared.project,
        Boolean(previous?.finalized_at)
      );
      persistIngestState(db, input, prepared, previous, terminal.finalized);

      return {
        sessionId: input.sessionId,
        inserted,
        skipped: prepared.messages.length - inserted,
        finalized: terminal.finalized,
        loaId: terminal.loaId,
        redactions: [...prepared.redactions],
        digest: prepared.digest,
      };
    })
    .immediate();
}
