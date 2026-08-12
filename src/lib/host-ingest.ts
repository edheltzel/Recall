import type { Database } from 'bun:sqlite';
import { createHash } from 'crypto';
import { getDb } from '../db/connection.js';
import { chunked } from './chunk.js';
import { detectProject } from './project.js';
import { generateBasicSummary, generateFrameSummary } from './extraction.js';
import { invalidateRecordEmbedding } from './memory.js';
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
  incremental?: boolean;
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

export interface HostIngestCheckpoint {
  transcriptRef?: string;
  watermark?: string;
  finalized: boolean;
}

interface PreparedMessage extends HostTranscriptMessage {
  content: string;
  timestamp: string;
  messageKey: string;
  identityBase?: string;
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
  transcript_ref: string | null;
  watermark: string | null;
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
  const prepared: PreparedMessage[] = [];

  for (const [ordinal, message] of messages.entries()) {
    if (!['user', 'assistant', 'system'].includes(message.role)) continue;
    if (typeof message.content !== 'string' || !message.content.trim()) continue;

    const cleaned = scrub(message.content);
    for (const kind of cleaned.redactions) redactions.add(kind);
    if (!cleaned.text.trim()) continue;

    const identityBase = message.nativeId
      ? undefined
      : hash(`${message.role}\u0000${cleaned.text}`);

    prepared.push({
      ...message,
      content: cleaned.text,
      timestamp: normalizedTimestamp(message.timestamp, capturedAt, ordinal),
      messageKey: message.nativeId ? `native:${hash(message.nativeId)}` : '',
      identityBase,
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
  const occurrences = new Map<string, number>();
  const latestOccurrence = db.prepare(`
    SELECT message_key FROM host_ingest_messages
    WHERE source = ? AND session_id = ? AND message_key >= ? AND message_key < ?
    ORDER BY message_key DESC LIMIT 1
  `);
  for (const message of prepared.messages) {
    if (!message.identityBase) continue;
    let occurrence = occurrences.get(message.identityBase);
    if (occurrence === undefined) {
      occurrence = 0;
      if (input.incremental) {
        const prefix = `content:${message.identityBase}:`;
        const row = latestOccurrence.get(
          input.source,
          input.sessionId,
          prefix,
          `content:${message.identityBase};`
        ) as { message_key: string } | undefined;
        const stored = Number(row?.message_key.slice(prefix.length));
        if (Number.isSafeInteger(stored) && stored >= 0) occurrence = stored;
      }
    }
    occurrence++;
    occurrences.set(message.identityBase, occurrence);
    message.messageKey = `content:${message.identityBase}:${String(occurrence).padStart(16, '0')}`;
  }

  const knownKeys = new Set<string>();
  for (const keys of chunked(prepared.messages.map(message => message.messageKey))) {
    const rows = db
      .prepare(`
        SELECT message_key FROM host_ingest_messages
        WHERE source = ? AND session_id = ?
          AND message_key IN (${keys.map(() => '?').join(',')})
      `)
      .all(input.source, input.sessionId, ...keys) as Array<{ message_key: string }>;
    for (const row of rows) knownKeys.add(row.message_key);
  }
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
      SELECT transcript_ref, watermark, finalized_at FROM host_ingest_state
      WHERE source = ? AND session_id = ?
    `)
    .get(input.source, input.sessionId) as IngestStateRow | undefined;
}

export function getHostIngestCheckpoint(
  source: LifecycleHost,
  sessionId: string
): HostIngestCheckpoint | undefined {
  assertSessionId(sessionId);
  const row = getDb()
    .prepare(`
      SELECT transcript_ref, watermark, finalized_at FROM host_ingest_state
      WHERE source = ? AND session_id = ?
    `)
    .get(source, sessionId) as IngestStateRow | undefined;
  if (!row) return undefined;
  return {
    transcriptRef: row.transcript_ref ?? undefined,
    watermark: row.watermark ?? undefined,
    finalized: Boolean(row.finalized_at),
  };
}

function finalizeSession(
  db: Database,
  input: HostTranscript,
  project: string | undefined,
  shouldFinalize: boolean
): { finalized: boolean; loaId?: number } {
  if (!input.finalize || !shouldFinalize) return { finalized: false };

  const messages = db
    .prepare(`
      SELECT m.id, m.role, m.content, m.timestamp FROM messages m
      WHERE m.session_id = ? AND EXISTS (
        SELECT 1 FROM host_ingest_messages h
        WHERE h.source = ? AND h.session_id = ? AND h.message_id = m.id
      )
      ORDER BY m.timestamp, m.id
    `)
    .all(input.sessionId, input.source, input.sessionId) as StoredMessage[];
  if (messages.length === 0) return { finalized: false };

  const title = `${input.source[0].toUpperCase()}${input.source.slice(1)} session ${input.sessionId}`;
  const description = `Automatic terminal extraction from ${input.source} lifecycle capture.`;
  const tags = `automatic-capture,${input.source}`;
  const currentExtract = input.source === 'grok'
    ? generateFrameSummary(messages, 'Grok export')
    : generateBasicSummary(messages);
  const sourceIds = JSON.stringify(messages.map(message => ({ table: 'messages', id: message.id })));
  const existing = db
    .prepare(`
      SELECT id, fabric_extract FROM loa_entries
      WHERE session_id = ? AND description = ? AND tags = ?
      ORDER BY id DESC LIMIT 1
    `)
    .get(input.sessionId, description, tags) as
      { id: number; fabric_extract: string } | undefined;
  const lifecycleCounts = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN message_id IS NULL THEN 1 ELSE 0 END) AS pruned
    FROM host_ingest_messages WHERE source = ? AND session_id = ?
  `).get(input.source, input.sessionId) as { total: number; pruned: number | null };
  const fabricExtract = existing && (lifecycleCounts.pruned ?? 0) > 0
    ? `${existing.fabric_extract}\n\n## RESUMED SESSION UPDATE\n\n${currentExtract}`
    : currentExtract;
  let loaId: number;
  if (existing) {
    db.prepare(`
      UPDATE loa_entries SET
        title = ?, fabric_extract = ?, message_range_start = ?, message_range_end = ?,
        project = ?, message_count = ?, source_ids = ?, created_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      title,
      fabricExtract,
      messages[0].id,
      messages.at(-1)!.id,
      project ?? null,
      lifecycleCounts.total,
      sourceIds,
      existing.id
    );
    invalidateRecordEmbedding(db, 'loa_entries', existing.id);
    loaId = existing.id;
  } else {
    const result = db.prepare(`
      INSERT INTO loa_entries
        (title, description, fabric_extract, message_range_start, message_range_end,
         session_id, project, tags, message_count, importance, provenance, source_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 8, 'extracted', ?)
    `).run(
      title,
      description,
      fabricExtract,
      messages[0].id,
      messages.at(-1)!.id,
      input.sessionId,
      project ?? null,
      tags,
      lifecycleCounts.total,
      sourceIds
    );
    loaId = Number(result.lastInsertRowid);
  }
  db.prepare('UPDATE sessions SET summary = ? WHERE session_id = ?').run(title, input.sessionId);
  return { finalized: true, loaId };
}

function persistIngestState(
  db: Database,
  input: HostTranscript,
  prepared: PreparedTranscript,
  previous: IngestStateRow | undefined,
  finalized: boolean,
  resumed: boolean
): void {
  const finalizedAt = finalized
    ? prepared.capturedAt
    : resumed
      ? null
      : (previous?.finalized_at ?? null);
  db.prepare(`
    INSERT INTO host_ingest_state
      (source, session_id, transcript_ref, watermark, transcript_digest, finalized_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, session_id) DO UPDATE SET
      transcript_ref = excluded.transcript_ref,
      watermark = excluded.watermark,
      transcript_digest = excluded.transcript_digest,
      finalized_at = excluded.finalized_at,
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
      const previous = getIngestState(db, input);
      upsertSession(db, input, prepared);
      const inserted = insertNewMessages(db, input, prepared);
      const resumed = inserted > 0 && Boolean(previous?.finalized_at);
      if (resumed && !input.finalize) {
        db.prepare('UPDATE sessions SET ended_at = NULL WHERE session_id = ?').run(input.sessionId);
      }
      const session = db
        .prepare('SELECT project FROM sessions WHERE session_id = ?')
        .get(input.sessionId) as { project: string | null };
      const terminal = finalizeSession(
        db,
        input,
        session.project ?? undefined,
        !previous?.finalized_at || resumed
      );
      persistIngestState(db, input, prepared, previous, terminal.finalized, resumed);

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
