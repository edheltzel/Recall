import { Database } from 'bun:sqlite';
import { createHash } from 'crypto';
import { closeSync, mkdtempSync, openSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getDb } from '../db/connection.js';
import { chunked } from './chunk.js';
import { detectProject } from './project.js';
import { invalidateVecIndex } from '../db/vec.js';
import {
  generateBasicSummaryFromStats,
  generateFrameSummaryFromStats,
} from './extraction.js';
import { invalidateRecordEmbedding } from './memory.js';
import { scrub } from './write-safety.js';

export type LifecycleHost = 'codex' | 'grok' | 'jcode';
export type HostMessageRole = 'user' | 'assistant' | 'system';

export interface HostTranscriptMessage {
  role: HostMessageRole;
  content: string;
  timestamp?: string;
  nativeId?: string;
  identityContent?: string;
  sourcePosition?: number;
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
  reconcileComplete?: boolean;
  finalize?: boolean;
  batch?: HostIngestBatch;
}

export interface HostIngestBatch {
  fallbackOccurrences: Map<string, number>;
  nextOrdinal: number;
  previousPositions?: Map<string, number | null>;
  seenMessageKeys: Set<string>;
}

export function createHostIngestBatch(): HostIngestBatch {
  return { fallbackOccurrences: new Map(), nextOrdinal: 0, seenMessageKeys: new Set() };
}

export interface HostIngestResult {
  sessionId: string;
  inserted: number;
  reconciled?: number;
  skipped: number;
  finalized: boolean;
  loaId?: number;
  redactions: string[];
  digest: string;
}

export function mergeHostIngestResults(
  current: HostIngestResult | undefined,
  next: HostIngestResult
): HostIngestResult {
  if (!current) return next;
  return {
    sessionId: next.sessionId,
    inserted: current.inserted + next.inserted,
    reconciled: (current.reconciled ?? 0) + (next.reconciled ?? 0),
    skipped: current.skipped + next.skipped,
    finalized: current.finalized || next.finalized,
    loaId: next.loaId ?? current.loaId,
    redactions: [...new Set([...current.redactions, ...next.redactions])],
    digest: next.digest,
  };
}

export interface HostIngestCheckpoint {
  transcriptRef?: string;
  watermark?: string;
  finalized: boolean;
}

export interface HostIngestCheckpointExpectation {
  source: LifecycleHost;
  sessionId: string;
  checkpoint?: HostIngestCheckpoint;
}

export class HostIngestCheckpointConflictError extends Error {
  constructor(source: LifecycleHost, sessionId: string) {
    super(`Lifecycle checkpoint advanced for ${source} session ${sessionId}`);
    this.name = 'HostIngestCheckpointConflictError';
  }
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

interface PreparedInputStage {
  directory: string;
  path: string;
  db: Database;
}

interface StagedInputRow {
  ordinal: number;
  source: LifecycleHost;
  session_id: string;
  incremental: number | null;
  reconcile_complete: number | null;
  finalize: number | null;
  captured_at: string;
  cwd: string | null;
  project: string | null;
  transcript_ref: string | null;
  watermark: string;
  digest: string;
}

interface IngestStateRow {
  transcript_ref: string | null;
  watermark: string | null;
  finalized_at: string | null;
}

interface PreparedBatchGeneration {
  input: HostTranscript;
  prepared: PreparedTranscript;
  startedAt: string;
  endedAt: string | null;
  messageCount: number;
  expectedKeyCount: number;
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

export function assertHostDeadline(deadline?: number): void {
  if (deadline !== undefined && Date.now() >= deadline) {
    throw new Error('Host lifecycle ingest deadline exhausted');
  }
}

function prepareMessages(
  messages: HostTranscriptMessage[],
  capturedAt: string,
  redactions: Set<string>,
  ordinalOffset: number,
  deadline?: number
): PreparedMessage[] {
  const prepared: PreparedMessage[] = [];

  for (const [ordinal, message] of messages.entries()) {
    assertHostDeadline(deadline);
    if (!['user', 'assistant', 'system'].includes(message.role)) continue;
    if (typeof message.content !== 'string' || !message.content.trim()) continue;

    const cleaned = scrub(message.content);
    for (const kind of cleaned.redactions) redactions.add(kind);
    if (!cleaned.text.trim()) continue;
    const identity = message.identityContent === undefined
      ? cleaned
      : scrub(message.identityContent);
    for (const kind of identity.redactions) redactions.add(kind);

    const identityBase = message.nativeId
      ? undefined
      : hash(`${message.role}\u0000${identity.text}`);

    prepared.push({
      ...message,
      content: cleaned.text,
      timestamp: normalizedTimestamp(message.timestamp, capturedAt, ordinalOffset + ordinal),
      messageKey: message.nativeId ? `native:${hash(message.nativeId)}` : '',
      identityBase,
      sourcePosition: Number.isSafeInteger(message.sourcePosition) && message.sourcePosition! >= 0
        ? message.sourcePosition
        : undefined,
    });
  }

  assertHostDeadline(deadline);

  return prepared;
}

function prepareTranscript(input: HostTranscript, deadline?: number): PreparedTranscript {
  assertHostDeadline(deadline);
  const capturedAt = normalizedTimestamp(input.capturedAt, new Date().toISOString(), 0);
  const redactions = new Set<string>();
  const ordinalOffset = input.batch?.nextOrdinal ?? 0;
  const messages = prepareMessages(
    input.messages,
    capturedAt,
    redactions,
    ordinalOffset,
    deadline
  );
  if (input.batch) input.batch.nextOrdinal += input.messages.length;
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
  assertHostDeadline(deadline);

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

function storedFlag(value: boolean | undefined): number | null {
  return value === undefined ? null : Number(value);
}

function restoredFlag(value: number | null): boolean | undefined {
  return value === null ? undefined : Boolean(value);
}

function stagePreparedInputs(
  inputs: Iterable<HostTranscript>,
  expectation?: HostIngestCheckpointExpectation,
  deadline?: number
): PreparedInputStage {
  const directory = mkdtempSync(join(tmpdir(), 'recall-host-ingest-'));
  const path = join(directory, 'prepared.sqlite');
  closeSync(openSync(path, 'wx', 0o600));
  const stageDb = new Database(path);
  let count = 0;
  try {
    stageDb.exec(`
      PRAGMA journal_mode = MEMORY;
      PRAGMA synchronous = OFF;
      CREATE TABLE inputs (
        ordinal INTEGER PRIMARY KEY,
        source TEXT NOT NULL,
        session_id TEXT NOT NULL,
        incremental INTEGER,
        reconcile_complete INTEGER,
        finalize INTEGER,
        captured_at TEXT NOT NULL,
        cwd TEXT,
        project TEXT,
        transcript_ref TEXT,
        watermark TEXT NOT NULL,
        digest TEXT NOT NULL
      );
      CREATE TABLE messages (
        input_ordinal INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        message_key TEXT NOT NULL,
        identity_base TEXT,
        source_position INTEGER,
        PRIMARY KEY (input_ordinal, ordinal)
      );
      CREATE TABLE redactions (
        input_ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL,
        PRIMARY KEY (input_ordinal, kind)
      );
      CREATE TABLE generation_messages (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        session_id TEXT NOT NULL,
        message_key TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        project TEXT,
        source_position INTEGER,
        existing_key INTEGER NOT NULL DEFAULT 0,
        message_id INTEGER,
        UNIQUE (source, session_id, message_key)
      );
      CREATE TABLE occurrence_bases (
        identity_base TEXT PRIMARY KEY,
        base INTEGER NOT NULL
      );
    `);
    const insertInput = stageDb.prepare(`
      INSERT INTO inputs (
        ordinal, source, session_id, incremental, reconcile_complete, finalize,
        captured_at, cwd, project, transcript_ref, watermark, digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMessage = stageDb.prepare(`
      INSERT INTO messages (
        input_ordinal, ordinal, role, content, timestamp, message_key,
        identity_base, source_position
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertRedaction = stageDb.prepare(`
      INSERT INTO redactions (input_ordinal, kind) VALUES (?, ?)
    `);
    for (const input of inputs) {
      assertHostDeadline(deadline);
      assertSessionId(input.sessionId);
      if (expectation && (
        input.source !== expectation.source || input.sessionId !== expectation.sessionId
      )) {
        throw new Error('Expected checkpoint must own every host transcript batch input');
      }
      const prepared = prepareTranscript(input, deadline);
      stageDb.transaction(() => {
        insertInput.run(
          count,
          input.source,
          input.sessionId,
          storedFlag(input.incremental),
          storedFlag(input.reconcileComplete),
          storedFlag(input.finalize),
          prepared.capturedAt,
          prepared.cwd ?? null,
          prepared.project ?? null,
          prepared.transcriptRef ?? null,
          prepared.watermark,
          prepared.digest
        );
        for (const [ordinal, message] of prepared.messages.entries()) {
          assertHostDeadline(deadline);
          insertMessage.run(
            count,
            ordinal,
            message.role,
            message.content,
            message.timestamp,
            message.messageKey,
            message.identityBase ?? null,
            message.sourcePosition ?? null
          );
        }
        for (const kind of prepared.redactions) insertRedaction.run(count, kind);
      })();
      count++;
    }
    if (count === 0) throw new Error('Host transcript batch must not be empty');
    assertHostDeadline(deadline);
    return { directory, path, db: stageDb };
  } catch (error) {
    stageDb.close();
    rmSync(path, { force: true });
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function prepareBatchGeneration(
  stage: PreparedInputStage,
  db: Database,
  deadline?: number
): PreparedBatchGeneration {
  assertHostDeadline(deadline);
  const rows = stage.db
    .prepare('SELECT * FROM inputs ORDER BY ordinal')
    .iterate() as IterableIterator<StagedInputRow>;
  let first: StagedInputRow | undefined;
  let last: StagedInputRow | undefined;
  for (const row of rows) {
    assertHostDeadline(deadline);
    assertSessionOwnership(db, {
      source: row.source,
      sessionId: row.session_id,
      messages: [],
    });
    first ??= row;
    if (first.source !== row.source || first.session_id !== row.session_id) {
      throw new Error('Host transcript batch must contain one native session');
    }
    last = row;
  }
  if (!first || !last) throw new Error('Host transcript batch must not be empty');

  const insertBase = stage.db.prepare(`
    INSERT INTO occurrence_bases (identity_base, base) VALUES (?, ?)
  `);
  const latestOccurrence = db.prepare(`
    SELECT message_key FROM host_ingest_messages
    WHERE source = ? AND session_id = ? AND message_key >= ? AND message_key < ?
    ORDER BY message_key DESC LIMIT 1
  `);
  const identities = stage.db.prepare(`
    SELECT DISTINCT identity_base FROM messages
    WHERE identity_base IS NOT NULL ORDER BY identity_base
  `).iterate() as IterableIterator<{ identity_base: string }>;
  for (const { identity_base: identityBase } of identities) {
    assertHostDeadline(deadline);
    let base = 0;
    if (Boolean(first.incremental)) {
      const prefix = `content:${identityBase}:`;
      const stored = latestOccurrence.get(
        first.source,
        first.session_id,
        prefix,
        `content:${identityBase};`
      ) as { message_key: string } | undefined;
      const occurrence = Number(stored?.message_key.slice(prefix.length));
      if (Number.isSafeInteger(occurrence) && occurrence >= 0) base = occurrence;
    }
    insertBase.run(identityBase, base);
  }
  stage.db.exec(`
    WITH ranked AS (
      SELECT input_ordinal, ordinal, identity_base,
        ROW_NUMBER() OVER (
          PARTITION BY identity_base ORDER BY input_ordinal, ordinal
        ) AS occurrence
      FROM messages WHERE identity_base IS NOT NULL
    )
    UPDATE messages SET message_key = 'content:' || identity_base || ':' || printf('%016d',
      (SELECT base FROM occurrence_bases WHERE occurrence_bases.identity_base = messages.identity_base) +
      (SELECT occurrence FROM ranked
       WHERE ranked.input_ordinal = messages.input_ordinal AND ranked.ordinal = messages.ordinal)
    )
    WHERE identity_base IS NOT NULL;

    INSERT OR IGNORE INTO generation_messages (
      source, session_id, message_key, timestamp, role, content, project, source_position
    )
    SELECT i.source, i.session_id, m.message_key, m.timestamp, m.role, m.content,
      i.project, m.source_position
    FROM messages m JOIN inputs i ON i.ordinal = m.input_ordinal
    ORDER BY m.input_ordinal, m.ordinal;
  `);
  assertHostDeadline(deadline);

  const timeRange = stage.db.prepare(`
    SELECT MIN(timestamp) AS first_timestamp, MAX(timestamp) AS last_timestamp,
      COUNT(*) AS count FROM messages
  `).get() as { first_timestamp: string | null; last_timestamp: string | null; count: number };
  const metadata = stage.db.prepare(`
    SELECT
      (SELECT cwd FROM inputs WHERE cwd IS NOT NULL ORDER BY ordinal LIMIT 1) AS cwd,
      (SELECT project FROM inputs WHERE project IS NOT NULL ORDER BY ordinal LIMIT 1) AS project
  `).get() as { cwd: string | null; project: string | null };
  const redactions = new Set(
    (stage.db.prepare('SELECT DISTINCT kind FROM redactions ORDER BY kind').all() as
      Array<{ kind: string }>).map(row => row.kind)
  );
  const expectedKeyCount = (db.prepare(`
    SELECT COUNT(*) AS count FROM host_ingest_messages WHERE source = ? AND session_id = ?
  `).get(first.source, first.session_id) as { count: number }).count;
  const input: HostTranscript = {
    source: last.source,
    sessionId: last.session_id,
    messages: [],
    incremental: restoredFlag(last.incremental),
    reconcileComplete: restoredFlag(last.reconcile_complete),
    finalize: restoredFlag(last.finalize),
  };
  return {
    input,
    prepared: {
      capturedAt: last.captured_at,
      messages: [],
      cwd: metadata.cwd ?? undefined,
      project: metadata.project ?? undefined,
      transcriptRef: last.transcript_ref ?? undefined,
      watermark: last.watermark,
      digest: last.digest,
      redactions,
    },
    startedAt: timeRange.first_timestamp ?? first.captured_at,
    endedAt: input.finalize ? (timeRange.last_timestamp ?? last.captured_at) : null,
    messageCount: timeRange.count,
    expectedKeyCount,
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

  upsertSessionRecord(db, input, prepared, startedAt, endedAt);
}

function upsertSessionRecord(
  db: Database,
  input: HostTranscript,
  prepared: PreparedTranscript,
  startedAt: string,
  endedAt: string | null
): void {
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

function upsertGeneratedSession(
  db: Database,
  generation: PreparedBatchGeneration
): void {
  upsertSessionRecord(
    db,
    generation.input,
    generation.prepared,
    generation.startedAt,
    generation.endedAt
  );
}

function publishGenerationMessages(
  db: Database,
  generation: PreparedBatchGeneration,
  deadline?: number
): { inserted: number; reconciled: number } {
  assertHostDeadline(deadline);
  const { input } = generation;
  const currentKeyCount = (db.prepare(`
    SELECT COUNT(*) AS count FROM host_ingest_messages WHERE source = ? AND session_id = ?
  `).get(input.source, input.sessionId) as { count: number }).count;
  if (currentKeyCount !== generation.expectedKeyCount) {
    throw new HostIngestCheckpointConflictError(input.source, input.sessionId);
  }
  db.prepare(`
    UPDATE host_ingest_stage.generation_messages AS generation
    SET
      existing_key = EXISTS (
        SELECT 1 FROM host_ingest_messages AS stored
        WHERE stored.source = generation.source
          AND stored.session_id = generation.session_id
          AND stored.message_key = generation.message_key
      ),
      message_id = (
        SELECT stored.message_id FROM host_ingest_messages AS stored
        WHERE stored.source = generation.source
          AND stored.session_id = generation.session_id
          AND stored.message_key = generation.message_key
      )
  `).run();
  const insertMessage = db.prepare(`
    INSERT INTO messages
      (session_id, timestamp, role, content, project, importance, provenance)
    VALUES (?, ?, ?, ?, ?, 5, 'verbatim')
  `);
  const setMessageId = db.prepare(`
    UPDATE host_ingest_stage.generation_messages SET message_id = ? WHERE ordinal = ?
  `);
  const pending = db.prepare(`
    SELECT ordinal, session_id, timestamp, role, content, project
    FROM host_ingest_stage.generation_messages
    WHERE existing_key = 0 ORDER BY ordinal
  `).iterate() as IterableIterator<{
    ordinal: number;
    session_id: string;
    timestamp: string;
    role: HostMessage['role'];
    content: string;
    project: string | null;
  }>;
  let inserted = 0;
  for (const message of pending) {
    assertHostDeadline(deadline);
    const result = insertMessage.run(
      message.session_id,
      message.timestamp,
      message.role,
      message.content,
      message.project
    );
    setMessageId.run(Number(result.lastInsertRowid), message.ordinal);
    inserted++;
  }
  db.prepare(`
    INSERT INTO host_ingest_messages
      (source, session_id, message_key, message_id, source_position)
    SELECT source, session_id, message_key, message_id, source_position
    FROM host_ingest_stage.generation_messages
    WHERE existing_key = 0 AND message_id IS NOT NULL
    ORDER BY ordinal
  `).run();

  const positionChanges = db.prepare(`
    UPDATE host_ingest_messages SET source_position = (
      SELECT generation.source_position
      FROM host_ingest_stage.generation_messages AS generation
      WHERE generation.source = host_ingest_messages.source
        AND generation.session_id = host_ingest_messages.session_id
        AND generation.message_key = host_ingest_messages.message_key
    )
    WHERE source = ? AND session_id = ?
      AND EXISTS (
        SELECT 1 FROM host_ingest_stage.generation_messages AS generation
        WHERE generation.source = host_ingest_messages.source
          AND generation.session_id = host_ingest_messages.session_id
          AND generation.message_key = host_ingest_messages.message_key
          AND generation.source_position IS NOT NULL
          AND generation.source_position IS NOT host_ingest_messages.source_position
      )
  `).run(input.source, input.sessionId).changes;
  const removedEmbeddings = db.prepare(`
    DELETE FROM embeddings WHERE source_table = 'messages' AND source_id IN (
      SELECT stored.message_id FROM host_ingest_messages AS stored
      JOIN host_ingest_stage.generation_messages AS generation
        ON generation.source = stored.source
       AND generation.session_id = stored.session_id
       AND generation.message_key = stored.message_key
      JOIN messages AS message ON message.id = stored.message_id
      WHERE stored.source = ? AND stored.session_id = ?
        AND generation.source_position IS NOT NULL
        AND message.content IS NOT generation.content
    )
  `).run(input.source, input.sessionId).changes;
  if (removedEmbeddings > 0) invalidateVecIndex(db);
  const contentChanges = db.prepare(`
    UPDATE messages SET content = (
      SELECT generation.content
      FROM host_ingest_messages AS stored
      JOIN host_ingest_stage.generation_messages AS generation
        ON generation.source = stored.source
       AND generation.session_id = stored.session_id
       AND generation.message_key = stored.message_key
      WHERE stored.message_id = messages.id
        AND stored.source = ? AND stored.session_id = ?
    )
    WHERE id IN (
      SELECT stored.message_id FROM host_ingest_messages AS stored
      JOIN host_ingest_stage.generation_messages AS generation
        ON generation.source = stored.source
       AND generation.session_id = stored.session_id
       AND generation.message_key = stored.message_key
      JOIN messages AS current ON current.id = stored.message_id
      WHERE stored.source = ? AND stored.session_id = ?
        AND generation.source_position IS NOT NULL
        AND current.content IS NOT generation.content
    )
  `).run(
    input.source,
    input.sessionId,
    input.source,
    input.sessionId
  ).changes;
  let clearedPositions = 0;
  if (input.source === 'grok' && !input.incremental && (input.reconcileComplete ?? true)) {
    clearedPositions = db.prepare(`
      UPDATE host_ingest_messages SET source_position = NULL
      WHERE source = ? AND session_id = ? AND source_position IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM host_ingest_stage.generation_messages AS generation
          WHERE generation.source = host_ingest_messages.source
            AND generation.session_id = host_ingest_messages.session_id
            AND generation.message_key = host_ingest_messages.message_key
        )
    `).run(input.source, input.sessionId).changes;
  }
  assertHostDeadline(deadline);
  return {
    inserted,
    reconciled: positionChanges + contentChanges + clearedPositions,
  };
}

function insertNewMessages(
  db: Database,
  input: HostTranscript,
  prepared: PreparedTranscript,
  deadline?: number
): { inserted: number; reconciled: number } {
  assertHostDeadline(deadline);
  const resettingPositions = input.source === 'grok' && !input.incremental;
  let previousPositions = input.batch?.previousPositions;
  if (resettingPositions && !previousPositions) {
    const rows = db.prepare(`
      SELECT message_key, source_position FROM host_ingest_messages
      WHERE source = ? AND session_id = ?
    `).all(input.source, input.sessionId) as Array<{
      message_key: string;
      source_position: number | null;
    }>;
    previousPositions = new Map(
      rows.map(row => [row.message_key, row.source_position])
    );
    if (input.batch) input.batch.previousPositions = previousPositions;
  }
  const seenMessageKeys = input.batch?.seenMessageKeys ?? new Set<string>();
  const occurrences = input.batch?.fallbackOccurrences ?? new Map<string, number>();
  const latestOccurrence = db.prepare(`
    SELECT message_key FROM host_ingest_messages
    WHERE source = ? AND session_id = ? AND message_key >= ? AND message_key < ?
    ORDER BY message_key DESC LIMIT 1
  `);
  for (const message of prepared.messages) {
    assertHostDeadline(deadline);
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

  const knownKeys = new Map<string, {
    messageId: number | null;
    sourcePosition: number | null;
    content: string | null;
  }>();
  for (const keys of chunked(prepared.messages.map(message => message.messageKey))) {
    assertHostDeadline(deadline);
    const rows = db
      .prepare(`
        SELECT h.message_key, h.message_id, h.source_position, m.content
        FROM host_ingest_messages h
        LEFT JOIN messages m ON m.id = h.message_id
        WHERE h.source = ? AND h.session_id = ?
          AND h.message_key IN (${keys.map(() => '?').join(',')})
      `)
      .all(input.source, input.sessionId, ...keys) as Array<{
        message_key: string;
        message_id: number | null;
        source_position: number | null;
        content: string | null;
      }>;
    for (const row of rows) {
      knownKeys.set(row.message_key, {
        messageId: row.message_id,
        sourcePosition: row.source_position,
        content: row.content,
      });
    }
  }
  const insertMessage = db.prepare(`
    INSERT INTO messages (session_id, timestamp, role, content, project, importance, provenance)
    VALUES (?, ?, ?, ?, ?, 5, 'verbatim')
  `);
  const insertKey = db.prepare(`
    INSERT INTO host_ingest_messages
      (source, session_id, message_key, message_id, source_position)
    VALUES (?, ?, ?, ?, ?)
  `);
  const updateKeyPosition = db.prepare(`
    UPDATE host_ingest_messages SET source_position = ?
    WHERE source = ? AND session_id = ? AND message_key = ?
      AND source_position IS NOT ?
  `);
  const clearKeyPosition = db.prepare(`
    UPDATE host_ingest_messages SET source_position = NULL
    WHERE source = ? AND session_id = ? AND message_key = ?
      AND source_position IS NOT NULL
  `);
  const updateMessage = db.prepare(`
    UPDATE messages SET content = ? WHERE id = ?
  `);

  let inserted = 0;
  let reconciled = 0;
  for (const message of prepared.messages) {
    assertHostDeadline(deadline);
    seenMessageKeys.add(message.messageKey);
    if (knownKeys.has(message.messageKey)) {
      if (message.sourcePosition !== undefined) {
        reconciled += updateKeyPosition.run(
          message.sourcePosition,
          input.source,
          input.sessionId,
          message.messageKey,
          message.sourcePosition
        ).changes;
        const known = knownKeys.get(message.messageKey);
        if (known && known.messageId !== null && known.content !== message.content) {
          updateMessage.run(message.content, known.messageId);
          invalidateRecordEmbedding(db, 'messages', known.messageId);
          reconciled++;
        }
      }
      continue;
    }
    const result = insertMessage.run(
      input.sessionId,
      message.timestamp,
      message.role,
      message.content,
      prepared.project ?? null
    );
    insertKey.run(
      input.source,
      input.sessionId,
      message.messageKey,
      result.lastInsertRowid,
      message.sourcePosition ?? null
    );
    knownKeys.set(message.messageKey, {
      messageId: Number(result.lastInsertRowid),
      sourcePosition: message.sourcePosition ?? null,
      content: message.content,
    });
    inserted++;
  }
  if (resettingPositions && (input.reconcileComplete ?? true)) {
    for (const [messageKey, sourcePosition] of previousPositions ?? []) {
      assertHostDeadline(deadline);
      if (sourcePosition === null || seenMessageKeys.has(messageKey)) continue;
      reconciled += clearKeyPosition.run(
        input.source,
        input.sessionId,
        messageKey
      ).changes;
    }
  }
  return { inserted, reconciled };
}

function getIngestState(db: Database, input: HostTranscript): IngestStateRow | undefined {
  return db
    .prepare(`
      SELECT transcript_ref, watermark, finalized_at FROM host_ingest_state
      WHERE source = ? AND session_id = ?
    `)
    .get(input.source, input.sessionId) as IngestStateRow | undefined;
}

function assertExpectedCheckpoint(
  db: Database,
  expectation: HostIngestCheckpointExpectation
): void {
  const current = db
    .prepare(`
      SELECT transcript_ref, watermark, finalized_at FROM host_ingest_state
      WHERE source = ? AND session_id = ?
    `)
    .get(expectation.source, expectation.sessionId) as IngestStateRow | null;
  const expected = expectation.checkpoint;
  const matches = current === null
    ? expected === undefined
    : expected !== undefined &&
      (current.transcript_ref ?? undefined) === expected.transcriptRef &&
      (current.watermark ?? undefined) === expected.watermark &&
      Boolean(current.finalized_at) === expected.finalized;
  if (!matches) {
    throw new HostIngestCheckpointConflictError(expectation.source, expectation.sessionId);
  }
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

interface LifecycleMessageStats {
  total: number;
  active: number;
  pruned: number;
  rangeStart: number | null;
  rangeEnd: number | null;
}

function lifecycleMessageStats(db: Database, input: HostTranscript): LifecycleMessageStats {
  const row = db.prepare(`
    SELECT COUNT(*) AS total, COUNT(message.id) AS active,
      COALESCE(SUM(CASE WHEN stored.message_id IS NULL THEN 1 ELSE 0 END), 0) AS pruned,
      MIN(message.id) AS range_start, MAX(message.id) AS range_end
    FROM host_ingest_messages AS stored
    LEFT JOIN messages AS message ON message.id = stored.message_id
    WHERE stored.source = ? AND stored.session_id = ?
      AND (? <> 'grok' OR stored.source_position IS NOT NULL)
  `).get(input.source, input.sessionId, input.source) as {
    total: number;
    active: number;
    pruned: number;
    range_start: number | null;
    range_end: number | null;
  };
  return {
    total: row.total,
    active: row.active,
    pruned: row.pruned,
    rangeStart: row.range_start,
    rangeEnd: row.range_end,
  };
}

function basicSummaryStats(db: Database, input: HostTranscript, afterMessageId?: number) {
  const params = [
    input.source,
    input.sessionId,
    afterMessageId ?? null,
    afterMessageId ?? null,
  ] as const;
  const counts = db.prepare(`
    SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN message.role = 'user' THEN 1 ELSE 0 END), 0) AS user,
      COALESCE(SUM(CASE WHEN message.role = 'assistant' THEN 1 ELSE 0 END), 0) AS assistant
    FROM messages AS message JOIN host_ingest_messages AS stored ON stored.message_id = message.id
    WHERE stored.source = ? AND stored.session_id = ? AND (? IS NULL OR message.id > ?)
  `).get(...params) as { total: number; user: number; assistant: number };
  const firstUser = db.prepare(`
    SELECT message.content FROM messages AS message
    JOIN host_ingest_messages AS stored ON stored.message_id = message.id
    WHERE stored.source = ? AND stored.session_id = ? AND (? IS NULL OR message.id > ?)
      AND message.role = 'user'
    ORDER BY message.timestamp, message.id LIMIT 1
  `).get(...params) as { content: string } | undefined;
  const lastAssistant = db.prepare(`
    SELECT message.content FROM messages AS message
    JOIN host_ingest_messages AS stored ON stored.message_id = message.id
    WHERE stored.source = ? AND stored.session_id = ? AND (? IS NULL OR message.id > ?)
      AND message.role = 'assistant'
    ORDER BY message.timestamp DESC, message.id DESC LIMIT 1
  `).get(...params) as { content: string } | undefined;
  return {
    ...counts,
    firstUser: firstUser?.content,
    lastAssistant: lastAssistant?.content,
  };
}

function frameSummaryStats(db: Database, input: HostTranscript, afterMessageId?: number) {
  const params = [
    input.source,
    input.sessionId,
    afterMessageId ?? null,
    afterMessageId ?? null,
  ] as const;
  const count = db.prepare(`
    SELECT COUNT(*) AS total FROM messages AS message
    JOIN host_ingest_messages AS stored ON stored.message_id = message.id
    WHERE stored.source = ? AND stored.session_id = ? AND (? IS NULL OR message.id > ?)
      AND stored.source_position IS NOT NULL AND message.role = 'system'
  `).get(...params) as { total: number };
  const first = db.prepare(`
    SELECT message.content FROM messages AS message
    JOIN host_ingest_messages AS stored ON stored.message_id = message.id
    WHERE stored.source = ? AND stored.session_id = ? AND (? IS NULL OR message.id > ?)
      AND stored.source_position IS NOT NULL AND message.role = 'system'
    ORDER BY stored.source_position, message.id LIMIT 1
  `).get(...params) as { content: string } | undefined;
  const latest = db.prepare(`
    SELECT message.content FROM messages AS message
    JOIN host_ingest_messages AS stored ON stored.message_id = message.id
    WHERE stored.source = ? AND stored.session_id = ? AND (? IS NULL OR message.id > ?)
      AND stored.source_position IS NOT NULL AND message.role = 'system'
    ORDER BY stored.source_position DESC, message.id DESC LIMIT 1
  `).get(...params) as { content: string } | undefined;
  return {
    total: count.total,
    firstFrame: first?.content,
    latestFrame: latest?.content,
  };
}

function replaceLoaMessageSources(
  db: Database,
  loaId: number,
  input: HostTranscript,
  preserveExisting: boolean,
  afterMessageId?: number
): void {
  if (!preserveExisting) {
    db.prepare('DELETE FROM loa_message_sources WHERE loa_id = ?').run(loaId);
  }
  const ordinalStart = preserveExisting
    ? ((db.prepare(`
        SELECT COALESCE(MAX(ordinal) + 1, 0) AS ordinal
        FROM loa_message_sources WHERE loa_id = ?
      `).get(loaId) as { ordinal: number }).ordinal)
    : 0;
  db.prepare(`
    INSERT INTO loa_message_sources (
      loa_id, ordinal, message_id, session_id, timestamp, role, content,
      project, importance, provenance
    )
    SELECT ?, ? + ROW_NUMBER() OVER (
        ORDER BY
          CASE WHEN stored.source = 'grok' THEN stored.source_position END,
          CASE WHEN stored.source <> 'grok' THEN message.timestamp END,
          message.id
      ) - 1,
      message.id, message.session_id, message.timestamp, message.role,
      message.content, message.project, message.importance, message.provenance
    FROM messages AS message
    JOIN host_ingest_messages AS stored ON stored.message_id = message.id
    WHERE stored.source = ? AND stored.session_id = ?
      AND (? IS NULL OR message.id > ?)
      AND (stored.source <> 'grok' OR stored.source_position IS NOT NULL)
    ORDER BY
      CASE WHEN stored.source = 'grok' THEN stored.source_position END,
      CASE WHEN stored.source <> 'grok' THEN message.timestamp END,
      message.id
  `).run(
    loaId,
    ordinalStart,
    input.source,
    input.sessionId,
    afterMessageId ?? null,
    afterMessageId ?? null
  );
  const sourceIds = db.prepare(`
    SELECT json_group_array(json_object('table', 'messages', 'id', message_id)) AS value
    FROM (
      SELECT message_id FROM loa_message_sources
      WHERE loa_id = ? ORDER BY ordinal
    )
  `).get(loaId) as { value: string };
  db.prepare('UPDATE loa_entries SET source_ids = ? WHERE id = ?')
    .run(sourceIds.value, loaId);
}

function finalizeSession(
  db: Database,
  input: HostTranscript,
  project: string | undefined,
  shouldFinalize: boolean,
  emptyReconciliation: boolean,
  deadline?: number
): { finalized: boolean; loaId?: number } {
  assertHostDeadline(deadline);
  if (!input.finalize || !shouldFinalize) return { finalized: false };

  const stats = lifecycleMessageStats(db, input);
  assertHostDeadline(deadline);
  if (stats.active === 0 && !emptyReconciliation) return { finalized: false };

  const title = `${input.source[0].toUpperCase()}${input.source.slice(1)} session ${input.sessionId}`;
  const description = `Automatic terminal extraction from ${input.source} lifecycle capture.`;
  const tags = `automatic-capture,${input.source}`;
  const existing = db
    .prepare(`
      SELECT id, fabric_extract, message_range_end AS previous_message_id
      FROM loa_entries
      WHERE session_id = ? AND description = ? AND tags = ?
      ORDER BY id DESC LIMIT 1
    `)
    .get(input.sessionId, description, tags) as
      { id: number; fabric_extract: string; previous_message_id: number | null } | undefined;
  const preserveExisting = Boolean(!emptyReconciliation && existing && stats.pruned > 0);
  let currentExtract = '';
  if (emptyReconciliation) {
    const sourceName = `${input.source[0].toUpperCase()}${input.source.slice(1)}`;
    currentExtract = `## ${sourceName} terminal capture\n\nNo transcript content was present.`;
  } else {
    const afterMessageId = preserveExisting
      ? (existing?.previous_message_id ?? undefined)
      : undefined;
    if (input.source === 'grok') {
      const summary = frameSummaryStats(db, input, afterMessageId);
      if (summary.total > 0) {
        currentExtract = generateFrameSummaryFromStats(summary, 'Grok export');
      }
    } else {
      const summary = basicSummaryStats(db, input, afterMessageId);
      if (summary.total > 0) currentExtract = generateBasicSummaryFromStats(summary);
    }
  }
  const fabricExtract = preserveExisting
    ? currentExtract
      ? `${existing!.fabric_extract}\n\n## RESUMED SESSION UPDATE\n\n${currentExtract}`
      : existing!.fabric_extract
    : currentExtract;
  assertHostDeadline(deadline);
  let loaId: number;
  if (existing) {
    db.prepare(`
      UPDATE loa_entries SET
        title = ?, fabric_extract = ?, message_range_start = ?, message_range_end = ?,
        project = ?, message_count = ?, source_ids = '[]', created_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      title,
      fabricExtract,
      stats.rangeStart,
      stats.rangeEnd,
      project ?? null,
      emptyReconciliation ? 0 : stats.total,
      existing.id
    );
    if (existing.fabric_extract !== fabricExtract) {
      invalidateRecordEmbedding(db, 'loa_entries', existing.id);
    }
    loaId = existing.id;
  } else {
    const result = db.prepare(`
      INSERT INTO loa_entries
        (title, description, fabric_extract, message_range_start, message_range_end,
         session_id, project, tags, message_count, importance, provenance, source_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 8, 'extracted', '[]')
    `).run(
      title,
      description,
      fabricExtract,
      stats.rangeStart,
      stats.rangeEnd,
      input.sessionId,
      project ?? null,
      tags,
      emptyReconciliation ? 0 : stats.total
    );
    loaId = Number(result.lastInsertRowid);
  }
  replaceLoaMessageSources(
    db,
    loaId,
    input,
    preserveExisting,
    preserveExisting ? (existing?.previous_message_id ?? undefined) : undefined
  );
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

function completeIngest(
  db: Database,
  input: HostTranscript,
  prepared: PreparedTranscript,
  previous: IngestStateRow | undefined,
  mutations: { inserted: number; reconciled: number },
  emptyReconciliation: boolean,
  skipped: number,
  deadline?: number
): HostIngestResult {
  const reconciliationComplete = input.source === 'grok' &&
    !input.incremental &&
    (input.reconcileComplete ?? true);
  const resumed = (
    mutations.inserted > 0 || mutations.reconciled > 0 || reconciliationComplete
  ) && Boolean(previous?.finalized_at);
  const checkpointReady = input.reconcileComplete !== false;
  if (resumed && !input.finalize && checkpointReady) {
    db.prepare('UPDATE sessions SET ended_at = NULL WHERE session_id = ?').run(input.sessionId);
  }
  const session = db
    .prepare('SELECT project FROM sessions WHERE session_id = ?')
    .get(input.sessionId) as { project: string | null };
  const terminal = finalizeSession(
    db,
    input,
    session.project ?? undefined,
    !previous?.finalized_at || resumed,
    emptyReconciliation,
    deadline
  );
  if (checkpointReady) {
    persistIngestState(db, input, prepared, previous, terminal.finalized, resumed);
  }
  assertHostDeadline(deadline);
  return {
    sessionId: input.sessionId,
    inserted: mutations.inserted,
    reconciled: mutations.reconciled,
    skipped,
    finalized: terminal.finalized,
    loaId: terminal.loaId,
    redactions: [...prepared.redactions],
    digest: prepared.digest,
  };
}

/**
 * Immediately ingest a host-supplied transcript into recall.db.
 *
 * This is the single host-neutral write seam for lifecycle adapters. It scrubs
 * before hashing or writing, preserves native session IDs, records source and
 * project attribution, and makes repeated overlapping hooks idempotent.
 */
function ingestHostTranscriptInTransaction(
  db: Database,
  input: HostTranscript,
  prepared: PreparedTranscript,
  deadline?: number
): HostIngestResult {
  assertHostDeadline(deadline);
  assertSessionOwnership(db, input);
  const previous = getIngestState(db, input);
  upsertSession(db, input, prepared);
  const mutations = insertNewMessages(db, input, prepared, deadline);
  const reconciliationComplete = input.source === 'grok' &&
    !input.incremental &&
    (input.reconcileComplete ?? true);
  const emptyReconciliation = reconciliationComplete &&
    (input.batch?.seenMessageKeys.size ?? prepared.messages.length) === 0;
  return completeIngest(
    db,
    input,
    prepared,
    previous,
    mutations,
    emptyReconciliation,
    prepared.messages.length - mutations.inserted,
    deadline
  );
}

function ingestBatchGenerationInTransaction(
  db: Database,
  generation: PreparedBatchGeneration,
  expectation?: HostIngestCheckpointExpectation,
  deadline?: number
): HostIngestResult {
  assertHostDeadline(deadline);
  const { input, prepared } = generation;
  if (expectation) assertExpectedCheckpoint(db, expectation);
  assertSessionOwnership(db, input);
  const previous = getIngestState(db, input);
  upsertGeneratedSession(db, generation);
  const mutations = publishGenerationMessages(db, generation, deadline);
  const reconciliationComplete = input.source === 'grok' &&
    !input.incremental &&
    (input.reconcileComplete ?? true);
  const activeGenerationMessages = (db.prepare(`
    SELECT COUNT(*) AS count FROM host_ingest_stage.generation_messages
  `).get() as { count: number }).count;
  const emptyReconciliation = reconciliationComplete && activeGenerationMessages === 0;
  return completeIngest(
    db,
    input,
    prepared,
    previous,
    mutations,
    emptyReconciliation,
    generation.messageCount - mutations.inserted,
    deadline
  );
}

export function ingestHostTranscript(input: HostTranscript): HostIngestResult {
  assertSessionId(input.sessionId);
  const prepared = prepareTranscript(input);
  const db = getDb();
  return db
    .transaction(() => ingestHostTranscriptInTransaction(db, input, prepared))
    .immediate();
}

export function ingestHostTranscriptBatch(
  inputs: Iterable<HostTranscript>,
  expectation?: HostIngestCheckpointExpectation,
  deadline?: number
): HostIngestResult {
  const stage = stagePreparedInputs(inputs, expectation, deadline);
  const db = getDb();
  let stageOpen = true;
  let attached = false;
  try {
    const generation = prepareBatchGeneration(stage, db, deadline);
    stage.db.close();
    stageOpen = false;
    db.prepare('ATTACH DATABASE ? AS host_ingest_stage').run(stage.path);
    attached = true;
    return db
      .transaction(() => {
        return ingestBatchGenerationInTransaction(db, generation, expectation, deadline);
      })
      .immediate();
  } finally {
    try {
      if (attached) db.exec('DETACH DATABASE host_ingest_stage');
    } finally {
      if (stageOpen) stage.db.close();
      rmSync(stage.directory, { recursive: true, force: true });
    }
  }
}
