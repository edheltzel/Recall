import { Database } from 'bun:sqlite';
import { createHash } from 'crypto';
import { closeSync, mkdtempSync, openSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getDb } from '../db/connection.js';
import { SQLITE_SAFE_CHUNK_SIZE } from './chunk.js';
import { detectProject } from './project.js';
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
  batchOccurrence?: number;
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
  transcript_digest: string;
  active_generation: string | null;
  finalized_at: string | null;
}

interface PreparedBatchTerminal {
  existing?: {
    id: number;
    fabricExtract: string;
    previousMessageId: number | null;
  };
  title: string;
  description: string;
  tags: string;
  fabricExtract: string;
  messageCount: number;
  snapshotMaxMessageId: number;
  empty: boolean;
}

interface PreparedBatchGeneration {
  input: HostTranscript;
  prepared: PreparedTranscript;
  startedAt: string;
  endedAt: string | null;
  messageCount: number;
  generationRowCount: number;
  newMessageCount: number;
  publishToken: string;
  previous?: IngestStateRow;
  reconciled: number;
  terminal?: PreparedBatchTerminal;
}

const STALE_GENERATION_MS = 5 * 60 * 1000;

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
  if (input.batch) {
    input.batch.nextOrdinal += input.messages.length;
    for (const message of messages) {
      if (!message.identityBase) continue;
      const occurrence = (input.batch.fallbackOccurrences.get(message.identityBase) ?? 0) + 1;
      input.batch.fallbackOccurrences.set(message.identityBase, occurrence);
      message.batchOccurrence = occurrence;
    }
  }
  const cwdResult = input.cwd ? scrub(input.cwd) : undefined;
  const detectedProject = input.project ?? (input.cwd ? detectProject(input.cwd) : undefined);
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
        batch_occurrence INTEGER,
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
        timestamp TEXT,
        role TEXT,
        content TEXT,
        project TEXT,
        importance INTEGER,
        provenance TEXT,
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
        identity_base, batch_occurrence, source_position
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            message.batchOccurrence ?? null,
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
    SELECT message_key FROM active_host_ingest_messages
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
      SELECT input_ordinal, ordinal, identity_base, batch_occurrence,
        ROW_NUMBER() OVER (
          PARTITION BY identity_base ORDER BY input_ordinal, ordinal
        ) AS occurrence
      FROM messages WHERE identity_base IS NOT NULL
    )
    UPDATE messages SET message_key = 'content:' || identity_base || ':' || printf('%016d',
      (SELECT base FROM occurrence_bases WHERE occurrence_bases.identity_base = messages.identity_base) +
      (SELECT COALESCE(batch_occurrence, occurrence) FROM ranked
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
  const sessionMetadata = db.prepare(`
    SELECT cwd, project FROM sessions WHERE session_id = ?
  `).get(first.session_id) as { cwd: string | null; project: string | null } | null;
  const redactions = new Set(
    (stage.db.prepare('SELECT DISTINCT kind FROM redactions ORDER BY kind').all() as
      Array<{ kind: string }>).map(row => row.kind)
  );
  const previous = getIngestState(db, {
    source: first.source,
    sessionId: first.session_id,
    messages: [],
  });
  const existingPage = db.prepare(`
    SELECT stored.message_key, stored.message_id, stored.source_position,
      CASE WHEN generated.message_key IS NOT NULL THEN generated.timestamp
        ELSE message.timestamp END AS timestamp,
      CASE WHEN generated.message_key IS NOT NULL THEN generated.role
        ELSE message.role END AS role,
      CASE WHEN generated.message_key IS NOT NULL THEN generated.content
        ELSE message.content END AS content,
      CASE WHEN generated.message_key IS NOT NULL THEN generated.project
        ELSE message.project END AS project,
      CASE WHEN generated.message_key IS NOT NULL THEN generated.importance
        ELSE message.importance END AS importance,
      CASE WHEN generated.message_key IS NOT NULL THEN generated.provenance
        ELSE message.provenance END AS provenance
    FROM active_host_ingest_messages AS stored
    LEFT JOIN host_ingest_state AS state
      ON state.source = stored.source AND state.session_id = stored.session_id
    LEFT JOIN host_ingest_generation_messages AS generated
      ON generated.generation_id = state.active_generation
     AND generated.source = stored.source
     AND generated.session_id = stored.session_id
     AND generated.message_key = stored.message_key
    LEFT JOIN messages AS message ON message.id = stored.message_id
    WHERE stored.source = ? AND stored.session_id = ? AND stored.message_key > ?
    ORDER BY stored.message_key LIMIT ?
  `);
  const stagedCurrent = stage.db.prepare(`
    SELECT ordinal, content, source_position FROM generation_messages WHERE message_key = ?
  `);
  const markExisting = stage.db.prepare(`
    UPDATE generation_messages SET existing_key = 1, message_id = ?,
      content = CASE WHEN ? IS NULL THEN NULL ELSE content END
    WHERE message_key = ?
  `);
  const insertExisting = stage.db.prepare(`
    INSERT INTO generation_messages (
      source, session_id, message_key, message_id, timestamp, role, content,
      project, source_position, existing_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  let reconciled = 0;
  let keyCursor = '';
  for (;;) {
    assertHostDeadline(deadline);
    const page = existingPage.all(
      first.source,
      first.session_id,
      keyCursor,
      SQLITE_SAFE_CHUNK_SIZE
    ) as Array<{
      message_key: string;
      message_id: number | null;
      source_position: number | null;
      timestamp: string | null;
      role: HostMessageRole | null;
      content: string | null;
      project: string | null;
      importance: number | null;
      provenance: string | null;
    }>;
    if (page.length === 0) break;
    stage.db.transaction(() => {
      for (const row of page) {
        const current = stagedCurrent.get(row.message_key) as {
          ordinal: number;
          content: string | null;
          source_position: number | null;
        } | undefined;
        if (current) {
          markExisting.run(row.message_id, row.content, row.message_key);
          if ((row.content !== null && current.content !== row.content) ||
              current.source_position !== row.source_position) {
            reconciled++;
          }
          continue;
        }
        const sourcePosition = first.source === 'grok' && !Boolean(last.incremental) &&
          (last.reconcile_complete === null || Boolean(last.reconcile_complete))
          ? null
          : row.source_position;
        if (sourcePosition !== row.source_position) reconciled++;
        insertExisting.run(
          first.source,
          first.session_id,
          row.message_key,
          row.message_id,
          row.timestamp,
          row.role,
          row.content,
          row.project,
          sourcePosition
        );
      }
    })();
    keyCursor = page.at(-1)!.message_key;
  }
  stage.db.exec(`
    UPDATE generation_messages SET ordinal = -ordinal;
    WITH ranked AS (
      SELECT ordinal AS previous_ordinal,
        ROW_NUMBER() OVER (
          ORDER BY
            CASE WHEN source = 'grok' THEN source_position IS NULL END,
            CASE WHEN source = 'grok' THEN source_position END,
            CASE WHEN source <> 'grok' THEN timestamp END,
            message_id,
            message_key
        ) AS next_ordinal
      FROM generation_messages
    )
    UPDATE generation_messages SET ordinal = (
      SELECT next_ordinal FROM ranked
      WHERE ranked.previous_ordinal = generation_messages.ordinal
    );
  `);
  const newMessageCount = (stage.db.prepare(`
    SELECT COUNT(*) AS count FROM generation_messages WHERE existing_key = 0
  `).get() as { count: number }).count;
  const generationRowCount = (stage.db.prepare(`
    SELECT COUNT(*) AS count FROM generation_messages
  `).get() as { count: number }).count;
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
      cwd: metadata.cwd ?? sessionMetadata?.cwd ?? undefined,
      project: metadata.project ?? sessionMetadata?.project ?? undefined,
      transcriptRef: last.transcript_ref ?? undefined,
      watermark: last.watermark,
      digest: last.digest,
      redactions,
    },
    startedAt: timeRange.first_timestamp ?? first.captured_at,
    endedAt: input.finalize ? (timeRange.last_timestamp ?? last.captured_at) : null,
    messageCount: timeRange.count,
    generationRowCount,
    newMessageCount,
    publishToken: `${Date.now().toString(16).padStart(12, '0')}${hash(
      `${stage.path}\u0000${first.source}\u0000${first.session_id}`
    )}`,
    previous,
    reconciled,
  };
}

function reserveGenerationMessageIds(
  db: Database,
  stage: PreparedInputStage,
  generation: PreparedBatchGeneration,
  deadline?: number
): void {
  if (generation.newMessageCount === 0) return;
  assertHostDeadline(deadline);
  const firstId = db.transaction(() => {
    const sequence = db.prepare(`
      SELECT seq FROM sqlite_sequence WHERE name = 'messages'
    `).get() as { seq: number } | undefined;
    const generated = db.prepare(`
      SELECT COALESCE(MAX(message_id), 0) AS id FROM host_ingest_generation_messages
    `).get() as { id: number };
    const stored = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages')
      .get() as { id: number };
    const first = Math.max(sequence?.seq ?? 0, generated.id, stored.id) + 1;
    if (sequence) {
      db.prepare(`UPDATE sqlite_sequence SET seq = ? WHERE name = 'messages'`)
        .run(first + generation.newMessageCount - 1);
    } else {
      db.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES ('messages', ?)`)
        .run(first + generation.newMessageCount - 1);
    }
    return first;
  }).immediate();
  stage.db.prepare(`
    WITH pending AS (
      SELECT ordinal, ROW_NUMBER() OVER (ORDER BY ordinal) - 1 AS offset
      FROM generation_messages WHERE existing_key = 0
    )
    UPDATE generation_messages SET message_id = ? + (
      SELECT offset FROM pending WHERE pending.ordinal = generation_messages.ordinal
    )
    WHERE existing_key = 0
  `).run(firstId);
  assertHostDeadline(deadline);
}

function currentMessageHighWater(db: Database): number {
  const stored = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages')
    .get() as { id: number };
  const generated = db.prepare(`
    SELECT COALESCE(MAX(max_message_id), 0) AS id
    FROM host_ingest_generations WHERE status = 'active'
  `).get() as { id: number };
  return Math.max(stored.id, generated.id);
}

function prepareBatchTerminal(
  db: Database,
  stage: PreparedInputStage,
  generation: PreparedBatchGeneration,
  deadline?: number
): PreparedBatchTerminal | undefined {
  const { input, previous } = generation;
  const reconciliationComplete = input.source === 'grok' && !input.incremental &&
    (input.reconcileComplete ?? true);
  const resumed = (
    generation.newMessageCount > 0 || generation.reconciled > 0 || reconciliationComplete
  ) && Boolean(previous?.finalized_at);
  if (!input.finalize || (previous?.finalized_at && !resumed)) return undefined;

  const activeWhere = `content IS NOT NULL AND message_id IS NOT NULL
    AND (source <> 'grok' OR source_position IS NOT NULL)`;
  const stats = stage.db.prepare(`
    SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN content IS NOT NULL THEN 1 ELSE 0 END), 0) AS active,
      COALESCE(SUM(CASE WHEN content IS NULL THEN 1 ELSE 0 END), 0) AS pruned,
      MIN(CASE WHEN content IS NOT NULL THEN message_id END) AS range_start,
      MAX(CASE WHEN content IS NOT NULL THEN message_id END) AS range_end
    FROM generation_messages
    WHERE source <> 'grok' OR source_position IS NOT NULL
  `).get() as {
    total: number;
    active: number;
    pruned: number;
    range_start: number | null;
    range_end: number | null;
  };
  const empty = reconciliationComplete && stats.active === 0;
  if (stats.active === 0 && !empty) return undefined;

  const title = `${input.source[0].toUpperCase()}${input.source.slice(1)} session ${input.sessionId}`;
  const description = `Automatic terminal extraction from ${input.source} lifecycle capture.`;
  const tags = `automatic-capture,${input.source}`;
  const existingRow = db.prepare(`
    SELECT id, fabric_extract, snapshot_max_message_id
    FROM loa_entries WHERE session_id = ? AND description = ? AND tags = ?
    ORDER BY id DESC LIMIT 1
  `).get(input.sessionId, description, tags) as {
    id: number;
    fabric_extract: string;
    snapshot_max_message_id: number | null;
  } | undefined;
  const existing = existingRow ? {
    id: existingRow.id,
    fabricExtract: existingRow.fabric_extract,
    previousMessageId: existingRow.snapshot_max_message_id,
  } : undefined;
  const preserveExisting = Boolean(!empty && existing && stats.pruned > 0);
  const afterMessageId = preserveExisting ? existing?.previousMessageId : null;
  const params = [afterMessageId, afterMessageId] as const;
  let currentExtract = '';
  if (empty) {
    const sourceName = `${input.source[0].toUpperCase()}${input.source.slice(1)}`;
    currentExtract = `## ${sourceName} terminal capture\n\nNo transcript content was present.`;
  } else if (input.source === 'grok') {
    const count = stage.db.prepare(`
      SELECT COUNT(*) AS total FROM generation_messages
      WHERE ${activeWhere} AND role = 'system' AND (? IS NULL OR message_id > ?)
    `).get(...params) as { total: number };
    const first = stage.db.prepare(`
      SELECT content FROM generation_messages
      WHERE ${activeWhere} AND role = 'system' AND (? IS NULL OR message_id > ?)
      ORDER BY source_position, message_id LIMIT 1
    `).get(...params) as { content: string } | undefined;
    const latest = stage.db.prepare(`
      SELECT content FROM generation_messages
      WHERE ${activeWhere} AND role = 'system' AND (? IS NULL OR message_id > ?)
      ORDER BY source_position DESC, message_id DESC LIMIT 1
    `).get(...params) as { content: string } | undefined;
    if (count.total > 0) {
      currentExtract = generateFrameSummaryFromStats({
        total: count.total,
        firstFrame: first?.content,
        latestFrame: latest?.content,
      }, 'Grok export');
    }
  } else {
    const summary = stage.db.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(role = 'user'), 0) AS user,
        COALESCE(SUM(role = 'assistant'), 0) AS assistant
      FROM generation_messages
      WHERE ${activeWhere} AND (? IS NULL OR message_id > ?)
    `).get(...params) as { total: number; user: number; assistant: number };
    const firstUser = stage.db.prepare(`
      SELECT content FROM generation_messages
      WHERE ${activeWhere} AND role = 'user' AND (? IS NULL OR message_id > ?)
      ORDER BY timestamp, message_id LIMIT 1
    `).get(...params) as { content: string } | undefined;
    const lastAssistant = stage.db.prepare(`
      SELECT content FROM generation_messages
      WHERE ${activeWhere} AND role = 'assistant' AND (? IS NULL OR message_id > ?)
      ORDER BY timestamp DESC, message_id DESC LIMIT 1
    `).get(...params) as { content: string } | undefined;
    if (summary.total > 0) {
      currentExtract = generateBasicSummaryFromStats({
        ...summary,
        firstUser: firstUser?.content,
        lastAssistant: lastAssistant?.content,
      });
    }
  }
  const fabricExtract = preserveExisting
    ? currentExtract
      ? `${existing!.fabricExtract}\n\n## RESUMED SESSION UPDATE\n\n${currentExtract}`
      : existing!.fabricExtract
    : currentExtract;
  assertHostDeadline(deadline);
  return {
    existing,
    title,
    description,
    tags,
    fabricExtract,
    messageCount: empty ? 0 : stats.total,
    snapshotMaxMessageId: Math.max(
      existing?.previousMessageId ?? 0,
      stats.range_end ?? 0,
      empty ? currentMessageHighWater(db) : 0
    ),
    empty,
  };
}

function persistPreparedGeneration(
  db: Database,
  stage: PreparedInputStage,
  generation: PreparedBatchGeneration,
  deadline?: number
): void {
  const maxMessageId = (stage.db.prepare(`
    SELECT COALESCE(MAX(message_id), 0) AS id FROM generation_messages
  `).get() as { id: number }).id;
  db.transaction(() => {
    db.prepare(`
      INSERT INTO host_ingest_generations
        (generation_id, source, session_id, created_at, message_count,
         max_message_id, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      generation.publishToken,
      generation.input.source,
      generation.input.sessionId,
      new Date().toISOString(),
      generation.generationRowCount,
      maxMessageId
    );
  }).immediate();
  const page = stage.db.prepare(`
    SELECT * FROM generation_messages WHERE ordinal > ? ORDER BY ordinal LIMIT ?
  `);
  const insert = db.prepare(`
    INSERT INTO host_ingest_generation_messages (
      generation_id, ordinal, source, session_id, message_key, message_id,
      timestamp, role, content, project, importance, provenance, source_position
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let cursor = -1;
  for (;;) {
    assertHostDeadline(deadline);
    const rows = page.all(cursor, SQLITE_SAFE_CHUNK_SIZE) as Array<{
      ordinal: number;
      source: string;
      session_id: string;
      message_key: string;
      message_id: number | null;
      timestamp: string | null;
      role: string | null;
      content: string | null;
      project: string | null;
      importance: number | null;
      provenance: string | null;
      source_position: number | null;
    }>;
    if (rows.length === 0) break;
    db.transaction(() => {
      for (const row of rows) {
        insert.run(
          generation.publishToken,
          row.ordinal,
          row.source,
          row.session_id,
          row.message_key,
          row.message_id,
          row.timestamp,
          row.role,
          row.content,
          row.project,
          row.importance ?? 5,
          row.provenance ?? 'verbatim',
          row.source_position
        );
      }
    }).immediate();
    cursor = rows.at(-1)!.ordinal;
  }
  db.transaction(() => {
    db.prepare(`
      UPDATE host_ingest_generations SET ready = 1
      WHERE generation_id = ? AND status = 'pending'
    `).run(generation.publishToken);
  }).immediate();
}

function deleteGeneration(
  db: Database,
  generationId: string,
  status: 'pending' | 'superseded',
  deadline?: number
): void {
  for (;;) {
    assertHostDeadline(deadline);
    const rows = db.prepare(`
      SELECT rowid FROM host_ingest_generation_messages
      WHERE generation_id = ? ORDER BY rowid LIMIT ?
    `).all(generationId, SQLITE_SAFE_CHUNK_SIZE) as Array<{ rowid: number }>;
    if (rows.length === 0) break;
    const ids = rows.map(row => row.rowid);
    db.transaction(() => {
      db.prepare(`
        DELETE FROM host_ingest_generation_messages
        WHERE rowid IN (${ids.map(() => '?').join(',')})
      `).run(...ids);
    }).immediate();
  }
  db.transaction(() => {
    db.prepare(`
      DELETE FROM host_ingest_generations
      WHERE generation_id = ? AND status = ?
    `).run(generationId, status);
  }).immediate();
}

function discardStaleGenerations(db: Database, deadline?: number): void {
  assertHostDeadline(deadline);
  const cutoff = new Date(Date.now() - STALE_GENERATION_MS).toISOString();
  const stale = db.prepare(`
    SELECT generation.generation_id FROM host_ingest_generations AS generation
    WHERE generation.status = 'pending' AND generation.created_at < ?
      AND NOT EXISTS (
        SELECT 1 FROM host_ingest_state AS state
        WHERE state.active_generation = generation.generation_id
      )
    ORDER BY generation.created_at LIMIT ?
  `).all(cutoff, SQLITE_SAFE_CHUNK_SIZE) as Array<{ generation_id: string }>;
  for (const row of stale) deleteGeneration(db, row.generation_id, 'pending', deadline);
}

function discardSupersededGenerations(db: Database, deadline?: number): void {
  assertHostDeadline(deadline);
  const stale = db.prepare(`
    SELECT generation.generation_id FROM host_ingest_generations AS generation
    WHERE generation.status = 'superseded'
      AND NOT EXISTS (
        SELECT 1 FROM host_ingest_state AS state
        WHERE state.active_generation = generation.generation_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM loa_entries AS loa
        WHERE json_extract(
          CASE WHEN json_valid(loa.source_ids) THEN loa.source_ids END,
          '$.table'
        ) = 'host_ingest_generation_messages'
          AND json_extract(
          CASE WHEN json_valid(loa.source_ids) THEN loa.source_ids END,
          '$.generation_id'
        ) = generation.generation_id
      )
    ORDER BY generation.created_at LIMIT ?
  `).all(SQLITE_SAFE_CHUNK_SIZE) as Array<{ generation_id: string }>;
  for (const row of stale) deleteGeneration(db, row.generation_id, 'superseded', deadline);
}

function assertSessionOwnership(db: Database, input: HostTranscript): void {
  const existing = db
    .prepare('SELECT source FROM sessions WHERE session_id = ?')
    .get(input.sessionId) as { source: string | null } | undefined;
  if (existing?.source && existing.source !== 'unknown' && existing.source !== input.source) {
    throw new Error(`Native session ID ${input.sessionId} is already owned by ${existing.source}`);
  }
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

function getIngestState(db: Database, input: HostTranscript): IngestStateRow | undefined {
  const row = db
    .prepare(`
      SELECT transcript_ref, watermark, transcript_digest, active_generation, finalized_at
      FROM host_ingest_state
      WHERE source = ? AND session_id = ?
    `)
    .get(input.source, input.sessionId) as IngestStateRow | null;
  return row ?? undefined;
}

function assertExpectedCheckpoint(
  db: Database,
  expectation: HostIngestCheckpointExpectation
): void {
  const current = db
    .prepare(`
      SELECT transcript_ref, watermark, transcript_digest, active_generation, finalized_at
      FROM host_ingest_state
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
      SELECT transcript_ref, watermark, transcript_digest, active_generation, finalized_at
      FROM host_ingest_state
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

function sameIngestState(
  left: IngestStateRow | undefined,
  right: IngestStateRow | undefined
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined &&
      left.transcript_ref === right.transcript_ref &&
      left.watermark === right.watermark &&
      left.transcript_digest === right.transcript_digest &&
      left.active_generation === right.active_generation &&
      left.finalized_at === right.finalized_at;
}

function activatePreparedGeneration(
  db: Database,
  generation: PreparedBatchGeneration,
  expectation?: HostIngestCheckpointExpectation,
  deadline?: number
): HostIngestResult {
  assertHostDeadline(deadline);
  if (expectation) assertExpectedCheckpoint(db, expectation);
  const current = getIngestState(db, generation.input);
  if (!sameIngestState(current, generation.previous)) {
    throw new HostIngestCheckpointConflictError(
      generation.input.source,
      generation.input.sessionId
    );
  }
  assertSessionOwnership(db, generation.input);
  const pending = db.prepare(`
    SELECT message_count FROM host_ingest_generations
    WHERE generation_id = ? AND status = 'pending' AND ready = 1
  `).get(generation.publishToken) as { message_count: number } | undefined;
  if (!pending) throw new Error('Lifecycle generation is not pending publication');
  if (pending.message_count !== generation.generationRowCount) {
    throw new Error('Lifecycle generation was not fully materialized');
  }

  const { input, prepared, previous } = generation;
  upsertGeneratedSession(db, generation);
  const reconciliationComplete = input.source === 'grok' && !input.incremental &&
    (input.reconcileComplete ?? true);
  const resumed = (
    generation.newMessageCount > 0 || generation.reconciled > 0 || reconciliationComplete
  ) && Boolean(previous?.finalized_at);
  if (resumed && !input.finalize && input.reconcileComplete !== false) {
    db.prepare('UPDATE sessions SET ended_at = NULL WHERE session_id = ?').run(input.sessionId);
  }

  let loaId: number | undefined;
  const terminal = generation.terminal;
  if (terminal) {
    const snapshotMaxMessageId = Math.max(
      terminal.snapshotMaxMessageId,
      terminal.empty ? currentMessageHighWater(db) : 0
    );
    const sourceIds = JSON.stringify({
      table: 'host_ingest_generation_messages',
      generation_id: generation.publishToken,
    });
    if (terminal.existing) {
      db.prepare(`
        UPDATE loa_entries SET title = ?, fabric_extract = ?,
          message_range_start = NULL, message_range_end = NULL,
          snapshot_max_message_id = ?, project = ?, message_count = ?,
          source_ids = ?, created_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        terminal.title,
        terminal.fabricExtract,
        snapshotMaxMessageId,
        prepared.project ?? null,
        terminal.messageCount,
        sourceIds,
        terminal.existing.id
      );
      if (terminal.existing.fabricExtract !== terminal.fabricExtract) {
        invalidateRecordEmbedding(db, 'loa_entries', terminal.existing.id);
      }
      loaId = terminal.existing.id;
    } else {
      const result = db.prepare(`
        INSERT INTO loa_entries (
          title, description, fabric_extract, snapshot_max_message_id,
          session_id, project, tags, message_count, importance, provenance, source_ids
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 8, 'extracted', ?)
      `).run(
        terminal.title,
        terminal.description,
        terminal.fabricExtract,
        snapshotMaxMessageId,
        input.sessionId,
        prepared.project ?? null,
        terminal.tags,
        terminal.messageCount,
        sourceIds
      );
      loaId = Number(result.lastInsertRowid);
    }
    db.prepare('UPDATE sessions SET summary = ? WHERE session_id = ?')
      .run(terminal.title, input.sessionId);
  }

  if (previous?.active_generation) {
    db.prepare(`
      UPDATE host_ingest_generations SET status = 'superseded'
      WHERE generation_id = ? AND status = 'active'
    `).run(previous.active_generation);
  }
  db.prepare(`
    UPDATE host_ingest_generations SET status = 'active'
    WHERE generation_id = ? AND status = 'pending'
  `).run(generation.publishToken);
  const finalizedAt = terminal
    ? prepared.capturedAt
    : resumed
      ? null
      : (previous?.finalized_at ?? null);
  db.prepare(`
    INSERT INTO host_ingest_state (
      source, session_id, transcript_ref, watermark, transcript_digest,
      active_generation, finalized_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, session_id) DO UPDATE SET
      transcript_ref = excluded.transcript_ref,
      watermark = excluded.watermark,
      transcript_digest = excluded.transcript_digest,
      active_generation = excluded.active_generation,
      finalized_at = excluded.finalized_at,
      updated_at = excluded.updated_at
  `).run(
    input.source,
    input.sessionId,
    prepared.transcriptRef ?? null,
    prepared.watermark,
    prepared.digest,
    generation.publishToken,
    finalizedAt,
    prepared.capturedAt
  );
  assertHostDeadline(deadline);
  return {
    sessionId: input.sessionId,
    inserted: generation.newMessageCount,
    reconciled: generation.reconciled,
    skipped: generation.messageCount - generation.newMessageCount,
    finalized: Boolean(terminal),
    loaId,
    redactions: [...prepared.redactions],
    digest: prepared.digest,
  };
}

export function ingestHostTranscript(input: HostTranscript): HostIngestResult {
  return ingestHostTranscriptBatch([input]);
}

export function ingestHostTranscriptBatch(
  inputs: Iterable<HostTranscript>,
  expectation?: HostIngestCheckpointExpectation,
  deadline?: number
): HostIngestResult {
  const stage = stagePreparedInputs(inputs, expectation, deadline);
  const db = getDb();
  let activated = false;
  let generation: PreparedBatchGeneration | undefined;
  try {
    discardStaleGenerations(db, deadline);
    discardSupersededGenerations(db, deadline);
    const preparedGeneration = prepareBatchGeneration(stage, db, deadline);
    generation = preparedGeneration;
    reserveGenerationMessageIds(db, stage, preparedGeneration, deadline);
    preparedGeneration.terminal = prepareBatchTerminal(db, stage, preparedGeneration, deadline);
    persistPreparedGeneration(db, stage, preparedGeneration, deadline);
    stage.db.close();
    const result = db
      .transaction(() => {
        return activatePreparedGeneration(db, preparedGeneration, expectation, deadline);
      })
      .immediate();
    activated = true;
    discardSupersededGenerations(db, deadline);
    return result;
  } finally {
    try {
      if (!activated && generation) {
        deleteGeneration(db, generation.publishToken, 'pending');
      }
    } finally {
      try {
        stage.db.close();
      } catch {
      }
      rmSync(stage.directory, { recursive: true, force: true });
    }
  }
}
