import { Database } from 'bun:sqlite';
import { createHash } from 'crypto';
import { closeSync, mkdtempSync, openSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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
  db: Database;
  count: number;
  batches: HostIngestBatch[];
}

interface StagedInputRow {
  ordinal: number;
  source: LifecycleHost;
  session_id: string;
  incremental: number | null;
  reconcile_complete: number | null;
  finalize: number | null;
  batch_index: number | null;
  captured_at: string;
  cwd: string | null;
  project: string | null;
  transcript_ref: string | null;
  watermark: string;
  digest: string;
}

interface StagedMessageRow {
  role: HostMessageRole;
  content: string;
  timestamp: string;
  message_key: string;
  identity_base: string | null;
  source_position: number | null;
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

function sourceMessageIds(raw: string | null | undefined): Set<number> {
  if (!raw) return new Set();
  try {
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries)) return new Set();
    return new Set(
      entries.flatMap(entry => {
        if (!entry || typeof entry !== 'object') return [];
        const item = entry as { table?: unknown; id?: unknown };
        return item.table === 'messages' &&
          typeof item.id === 'number' &&
          Number.isSafeInteger(item.id)
          ? [item.id]
          : [];
      })
    );
  } catch {
    return new Set();
  }
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

function assertIngestDeadline(deadline?: number): void {
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
    assertIngestDeadline(deadline);
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

  assertIngestDeadline(deadline);

  return prepared;
}

function prepareTranscript(input: HostTranscript, deadline?: number): PreparedTranscript {
  assertIngestDeadline(deadline);
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
  assertIngestDeadline(deadline);

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
  const batches: HostIngestBatch[] = [];
  const batchIndexes = new Map<HostIngestBatch, number>();
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
        batch_index INTEGER,
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
    `);
    rmSync(path);
    const insertInput = stageDb.prepare(`
      INSERT INTO inputs (
        ordinal, source, session_id, incremental, reconcile_complete, finalize,
        batch_index, captured_at, cwd, project, transcript_ref, watermark, digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      assertIngestDeadline(deadline);
      assertSessionId(input.sessionId);
      if (expectation && (
        input.source !== expectation.source || input.sessionId !== expectation.sessionId
      )) {
        throw new Error('Expected checkpoint must own every host transcript batch input');
      }
      let batchIndex: number | null = null;
      if (input.batch) {
        const existingIndex = batchIndexes.get(input.batch);
        batchIndex = existingIndex ?? batches.length;
        if (existingIndex === undefined) {
          batchIndexes.set(input.batch, batchIndex);
          batches.push(input.batch);
        }
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
          batchIndex,
          prepared.capturedAt,
          prepared.cwd ?? null,
          prepared.project ?? null,
          prepared.transcriptRef ?? null,
          prepared.watermark,
          prepared.digest
        );
        for (const [ordinal, message] of prepared.messages.entries()) {
          assertIngestDeadline(deadline);
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
    assertIngestDeadline(deadline);
    return { directory, db: stageDb, count, batches };
  } catch (error) {
    stageDb.close();
    rmSync(path, { force: true });
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function* readPreparedInputs(
  stage: PreparedInputStage,
  deadline?: number
): Generator<{ input: HostTranscript; prepared: PreparedTranscript }> {
  const inputRows = stage.db
    .prepare('SELECT * FROM inputs ORDER BY ordinal')
    .iterate() as IterableIterator<StagedInputRow>;
  const selectMessages = stage.db.prepare(`
    SELECT role, content, timestamp, message_key, identity_base, source_position
    FROM messages WHERE input_ordinal = ? ORDER BY ordinal
  `);
  const selectRedactions = stage.db.prepare(`
    SELECT kind FROM redactions WHERE input_ordinal = ? ORDER BY kind
  `);
  for (const row of inputRows) {
    assertIngestDeadline(deadline);
    const messages = (selectMessages.all(row.ordinal) as StagedMessageRow[]).map(message => ({
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
      messageKey: message.message_key,
      identityBase: message.identity_base ?? undefined,
      sourcePosition: message.source_position ?? undefined,
    }));
    const redactions = new Set(
      (selectRedactions.all(row.ordinal) as Array<{ kind: string }>).map(entry => entry.kind)
    );
    const batch = row.batch_index === null ? undefined : stage.batches[row.batch_index];
    yield {
      input: {
        source: row.source,
        sessionId: row.session_id,
        messages: [],
        incremental: restoredFlag(row.incremental),
        reconcileComplete: restoredFlag(row.reconcile_complete),
        finalize: restoredFlag(row.finalize),
        batch,
      },
      prepared: {
        capturedAt: row.captured_at,
        messages,
        cwd: row.cwd ?? undefined,
        project: row.project ?? undefined,
        transcriptRef: row.transcript_ref ?? undefined,
        watermark: row.watermark,
        digest: row.digest,
        redactions,
      },
    };
  }
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
  prepared: PreparedTranscript,
  deadline?: number
): { inserted: number; reconciled: number } {
  assertIngestDeadline(deadline);
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
    assertIngestDeadline(deadline);
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
    assertIngestDeadline(deadline);
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
    assertIngestDeadline(deadline);
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
      assertIngestDeadline(deadline);
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

function finalizeSession(
  db: Database,
  input: HostTranscript,
  project: string | undefined,
  shouldFinalize: boolean,
  emptyReconciliation: boolean,
  deadline?: number
): { finalized: boolean; loaId?: number } {
  assertIngestDeadline(deadline);
  if (!input.finalize || !shouldFinalize) return { finalized: false };

  const messages = input.source === 'grok'
    ? db.prepare(`
        SELECT m.id, m.role, m.content, m.timestamp FROM messages m
        JOIN host_ingest_messages h ON h.message_id = m.id
        WHERE m.session_id = ? AND h.source = ? AND h.session_id = ?
          AND h.source_position IS NOT NULL
        ORDER BY h.source_position, m.id
      `).all(input.sessionId, input.source, input.sessionId) as StoredMessage[]
    : db.prepare(`
        SELECT m.id, m.role, m.content, m.timestamp FROM messages m
        WHERE m.session_id = ? AND EXISTS (
          SELECT 1 FROM host_ingest_messages h
          WHERE h.source = ? AND h.session_id = ? AND h.message_id = m.id
        )
        ORDER BY m.timestamp, m.id
      `).all(input.sessionId, input.source, input.sessionId) as StoredMessage[];
  assertIngestDeadline(deadline);
  if (messages.length === 0 && !emptyReconciliation) return { finalized: false };

  const title = `${input.source[0].toUpperCase()}${input.source.slice(1)} session ${input.sessionId}`;
  const description = `Automatic terminal extraction from ${input.source} lifecycle capture.`;
  const tags = `automatic-capture,${input.source}`;
  const sourceIds = JSON.stringify(messages.map(message => ({ table: 'messages', id: message.id })));
  const messageRangeStart = messages.length > 0
    ? Math.min(...messages.map(message => message.id))
    : null;
  const messageRangeEnd = messages.length > 0
    ? Math.max(...messages.map(message => message.id))
    : null;
  const existing = db
    .prepare(`
      SELECT id, fabric_extract, source_ids FROM loa_entries
      WHERE session_id = ? AND description = ? AND tags = ?
      ORDER BY id DESC LIMIT 1
    `)
    .get(input.sessionId, description, tags) as
      { id: number; fabric_extract: string; source_ids: string | null } | undefined;
  const lifecycleCounts = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN message_id IS NULL THEN 1 ELSE 0 END) AS pruned
    FROM host_ingest_messages WHERE source = ? AND session_id = ?
      AND (? <> 'grok' OR source_position IS NOT NULL)
  `).get(input.source, input.sessionId, input.source) as { total: number; pruned: number | null };
  const previousMessageIds = sourceMessageIds(existing?.source_ids);
  const terminalMessages = existing
    ? messages.filter(message => !previousMessageIds.has(message.id))
    : messages;
  const preserveExisting = Boolean(
    !emptyReconciliation && existing && (lifecycleCounts.pruned ?? 0) > 0
  );
  const summaryMessages = preserveExisting ? terminalMessages : messages;
  let currentExtract = '';
  if (emptyReconciliation) {
    const sourceName = `${input.source[0].toUpperCase()}${input.source.slice(1)}`;
    currentExtract = `## ${sourceName} terminal capture\n\nNo transcript content was present.`;
  } else if (summaryMessages.length > 0) {
    currentExtract = input.source === 'grok'
      ? generateFrameSummary(summaryMessages, 'Grok export')
      : generateBasicSummary(summaryMessages);
  }
  const fabricExtract = preserveExisting
    ? currentExtract
      ? `${existing!.fabric_extract}\n\n## RESUMED SESSION UPDATE\n\n${currentExtract}`
      : existing!.fabric_extract
    : currentExtract;
  assertIngestDeadline(deadline);
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
      messageRangeStart,
      messageRangeEnd,
      project ?? null,
      emptyReconciliation ? 0 : lifecycleCounts.total,
      sourceIds,
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
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 8, 'extracted', ?)
    `).run(
      title,
      description,
      fabricExtract,
      messageRangeStart,
      messageRangeEnd,
      input.sessionId,
      project ?? null,
      tags,
      emptyReconciliation ? 0 : lifecycleCounts.total,
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
function ingestHostTranscriptInTransaction(
  db: Database,
  input: HostTranscript,
  prepared: PreparedTranscript,
  deadline?: number
): HostIngestResult {
  assertIngestDeadline(deadline);
  assertSessionOwnership(db, input);
  const previous = getIngestState(db, input);
  upsertSession(db, input, prepared);
  const mutations = insertNewMessages(db, input, prepared, deadline);
  const reconciliationComplete = input.source === 'grok' &&
    !input.incremental &&
    (input.reconcileComplete ?? true);
  const emptyReconciliation = reconciliationComplete &&
    (input.batch?.seenMessageKeys.size ?? prepared.messages.length) === 0;
  const resumed = (
    mutations.inserted > 0 || mutations.reconciled > 0 || reconciliationComplete
  ) &&
    Boolean(previous?.finalized_at);
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
  assertIngestDeadline(deadline);

  return {
    sessionId: input.sessionId,
    inserted: mutations.inserted,
    reconciled: mutations.reconciled,
    skipped: prepared.messages.length - mutations.inserted,
    finalized: terminal.finalized,
    loaId: terminal.loaId,
    redactions: [...prepared.redactions],
    digest: prepared.digest,
  };
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
  try {
    const db = getDb();
    return db
      .transaction(() => {
        assertIngestDeadline(deadline);
        if (expectation) assertExpectedCheckpoint(db, expectation);
        let aggregate: HostIngestResult | undefined;
        for (const { input, prepared } of readPreparedInputs(stage, deadline)) {
          aggregate = mergeHostIngestResults(
            aggregate,
            ingestHostTranscriptInTransaction(db, input, prepared, deadline)
          );
        }
        assertIngestDeadline(deadline);
        return aggregate!;
      })
      .immediate();
  } finally {
    stage.db.close();
    rmSync(stage.directory, { recursive: true, force: true });
  }
}
