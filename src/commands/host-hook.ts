import { spawnSync } from 'child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  writeSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { parseCodexRollout } from '../hosts/codex-lifecycle.js';
import { parseGrokExport, streamGrokSessionExport } from '../hosts/grok-lifecycle.js';
import {
  createHostIngestBatch,
  HostIngestCheckpointConflictError,
  assertHostDeadline,
  ingestHostTranscriptBatch,
  ingestHostTranscript,
  getHostIngestCheckpoint,
  mergeHostIngestResults,
  type HostIngestCheckpoint,
  type HostIngestResult,
  type HostTranscript,
  type LifecycleHost,
} from '../lib/host-ingest.js';

const MAX_HOOK_INPUT_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 25 * 1024 * 1024;
const HASH_READ_BYTES = 1024 * 1024;
const GROK_CAPTURE_BUDGET_MS = 75_000;
const GROK_FINALIZATION_MARGIN_MS = 15_000;
const GROK_EXPORT_ATTEMPT_MAX_MS = 30_000;
const GROK_CHECKPOINT_ATTEMPTS = 2;
const ROLLING_SEEDS = [0x811c9dc5, 0x9e3779b9] as const;
const ROLLING_FACTORS = [0x01000193, 0x27d4eb2d] as const;

interface HookPayload {
  hook_event_name?: unknown;
  hookEventName?: unknown;
  session_id?: unknown;
  sessionId?: unknown;
  transcript_path?: unknown;
  transcriptPath?: unknown;
  cwd?: unknown;
  workspaceRoot?: unknown;
  timestamp?: unknown;
  agent_id?: unknown;
  agentId?: unknown;
  is_subagent?: unknown;
  isSubagent?: unknown;
  reason?: unknown;
}

export interface HostHookDependencies {
  readTranscript?: (path: string, start?: number, length?: number) => string | Buffer;
  transcriptSize?: (path: string) => number;
  exportGrok?: (sessionId: string, timeoutMs?: number) => string;
  exportGrokStream?: (
    sessionId: string,
    timeoutMs?: number
  ) => AsyncIterable<string | Buffer>;
  renderContext?: () => string;
  ingest?: typeof ingestHostTranscript;
  ingestBatch?: typeof ingestHostTranscriptBatch;
  checkpoint?: (source: LifecycleHost, sessionId: string) => HostIngestCheckpoint | undefined;
}

export interface HostHookResult {
  stdout?: string;
  ingest?: HostIngestResult;
  skipped?: string;
}

class HostHookSkip extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function resolveIngestBatch(
  dependencies: HostHookDependencies
): typeof ingestHostTranscriptBatch {
  if (dependencies.ingestBatch) return dependencies.ingestBatch;
  if (!dependencies.ingest) return ingestHostTranscriptBatch;
  return (inputs: Iterable<HostTranscript>, _expectation, deadline) => {
    let aggregate: HostIngestResult | undefined;
    for (const input of inputs) {
      assertHostDeadline(deadline);
      aggregate = mergeHostIngestResults(aggregate, dependencies.ingest!(input));
    }
    if (!aggregate) throw new Error('Host transcript batch must not be empty');
    return aggregate;
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function eventName(payload: HookPayload): string {
  return (stringValue(payload.hook_event_name) ?? stringValue(payload.hookEventName) ?? '')
    .replace(/[_-]/g, '')
    .toLowerCase();
}

function includeSubagents(): boolean {
  return process.env.RECALL_INCLUDE_SUBAGENTS === '1';
}

function payloadIsSubagent(payload: HookPayload): boolean {
  return Boolean(
    payload.is_subagent ||
      payload.isSubagent ||
      stringValue(payload.agent_id) ||
      stringValue(payload.agentId)
  );
}

function suppliedTranscriptSize(path: string): number {
  if (!existsSync(path)) throw new Error(`Supplied transcript does not exist: ${path}`);
  return statSync(path).size;
}

function readSuppliedTranscript(path: string, start = 0, length?: number): Buffer {
  const size = suppliedTranscriptSize(path);
  const bytes = Math.max(0, Math.min(length ?? size - start, size - start));
  const buffer = Buffer.alloc(bytes);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buffer, 0, bytes, start);
  } finally {
    closeSync(fd);
  }
  return buffer;
}

function asBuffer(value: string | Buffer): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf-8');
}

function byteCheckpoint(
  checkpoint: HostIngestCheckpoint | undefined,
  transcriptRef: string
): { size: number; digest: [number, number] } | undefined {
  const match = checkpoint?.watermark?.match(
    /^bytes:(\d+):rolling:([0-9a-f]{8})([0-9a-f]{8})$/
  );
  if (checkpoint?.transcriptRef !== transcriptRef || !match) return undefined;
  const size = Number(match[1]);
  return Number.isSafeInteger(size) && size >= 0
    ? { size, digest: [Number.parseInt(match[2], 16), Number.parseInt(match[3], 16)] }
    : undefined;
}

function updateByteDigest(digest: [number, number], raw: Buffer): void {
  for (const byte of raw) {
    digest[0] = Math.imul(digest[0] ^ byte, ROLLING_FACTORS[0]) >>> 0;
    digest[1] = Math.imul(digest[1] ^ byte, ROLLING_FACTORS[1]) >>> 0;
  }
}

function digestPrefix(
  end: number,
  read: (start: number, length: number) => Buffer,
  deadline?: number
): [number, number] {
  const digest: [number, number] = [ROLLING_SEEDS[0], ROLLING_SEEDS[1]];
  let cursor = 0;
  while (cursor < end) {
    assertHostDeadline(deadline);
    const length = Math.min(HASH_READ_BYTES, end - cursor);
    const raw = read(cursor, length);
    if (raw.length !== length) throw new Error('Transcript read returned incomplete data');
    updateByteDigest(digest, raw);
    cursor += raw.length;
  }
  return digest;
}

function byteWatermark(end: number, digest: [number, number]): string {
  const encoded = digest.map(value => value.toString(16).padStart(8, '0')).join('');
  return `bytes:${end}:rolling:${encoded}`;
}

function byteCapture(
  checkpoint: HostIngestCheckpoint | undefined,
  transcriptRef: string,
  size: number,
  read: (start: number, length: number) => Buffer,
  validatePrefix: boolean,
  deadline?: number
): { start: number; digest: [number, number]; reset: boolean } {
  const previous = byteCheckpoint(checkpoint, transcriptRef);
  if (previous && previous.size <= size) {
    if (!validatePrefix) {
      return {
        start: previous.size,
        digest: [previous.digest[0], previous.digest[1]],
        reset: false,
      };
    }
    const digest = digestPrefix(previous.size, read, deadline);
    if (digest[0] === previous.digest[0] && digest[1] === previous.digest[1]) {
      return { start: previous.size, digest, reset: false };
    }
  }
  return {
    start: 0,
    digest: [ROLLING_SEEDS[0], ROLLING_SEEDS[1]],
    reset: true,
  };
}

function* boundedTranscriptChunks(
  start: number,
  size: number,
  read: (start: number, length: number) => Buffer,
  digest: [number, number],
  boundary: (raw: Buffer) => number = raw => raw.lastIndexOf(0x0a) + 1,
  deadline?: number
): Generator<{ start: number; end: number; raw: Buffer; watermark: string }> {
  let cursor = start;
  while (cursor < size) {
    assertHostDeadline(deadline);
    const length = Math.min(MAX_TRANSCRIPT_BYTES, size - cursor);
    let raw = read(cursor, length);
    if (raw.length !== length) throw new Error('Transcript read returned incomplete data');
    let end = cursor + raw.length;
    if (end < size) {
      const boundaryEnd = boundary(raw);
      if (boundaryEnd <= 0) {
        throw new Error(`Transcript record exceeds ${MAX_TRANSCRIPT_BYTES} bytes`);
      }
      raw = raw.subarray(0, boundaryEnd);
      end = cursor + raw.length;
    }
    updateByteDigest(digest, raw);
    yield {
      start: cursor,
      end,
      raw,
      watermark: byteWatermark(end, digest),
    };
    cursor = end;
  }
}

function grokFrameBoundary(raw: Buffer): number {
  for (let end = raw.length; end > 0; end--) {
    if (raw[end - 1] !== 0x0a) continue;
    let cursor = end - 2;
    if (raw[cursor] === 0x0d) cursor--;
    while (raw[cursor] === 0x20 || raw[cursor] === 0x09) cursor--;
    if (raw[cursor] === 0x0a) return end;
  }
  const windowSize = Math.min(64, raw.length);
  const base = 257;
  let power = 1;
  for (let index = 1; index < windowSize; index++) power = Math.imul(power, base) >>> 0;
  let hash = 0;
  for (let index = 0; index < windowSize; index++) {
    hash = (Math.imul(hash, base) + raw[index]) >>> 0;
  }
  let boundary = 0;
  let fallback = windowSize;
  let minimum = 0xffffffff;
  const minimumBoundary = Math.min(1024 * 1024, raw.length);
  const maximumBoundary = Math.max(minimumBoundary, raw.length - 64 * 1024);
  for (let end = windowSize; end <= maximumBoundary; end++) {
    if (end >= minimumBoundary && (end === raw.length || (raw[end] & 0xc0) !== 0x80)) {
      if ((hash & 0xfffff) === 0) boundary = end;
      if (hash < minimum) {
        minimum = hash;
        fallback = end;
      }
    }
    if (end === maximumBoundary) break;
    const outgoing = Math.imul(raw[end - windowSize], power) >>> 0;
    hash = (Math.imul((hash - outgoing) >>> 0, base) + raw[end]) >>> 0;
  }
  return boundary || fallback;
}

interface GrokHookRequest {
  sessionId: string;
  cwd?: string;
  capturedAt?: string;
  finalize: boolean;
  validatePrefix: boolean;
}

function grokHookRequest(payload: HookPayload): GrokHookRequest | { skipped: string } {
  const event = eventName(payload);
  if (!['stop', 'precompact', 'postcompact', 'sessionend'].includes(event)) {
    return { skipped: 'unsupported-event' };
  }
  const sessionId = stringValue(payload.session_id) ?? stringValue(payload.sessionId);
  if (!sessionId) return { skipped: 'missing-session-id' };
  const reason = stringValue(payload.reason)?.toLowerCase();
  return {
    sessionId,
    cwd: stringValue(payload.cwd) ?? stringValue(payload.workspaceRoot),
    capturedAt: stringValue(payload.timestamp),
    finalize: event === 'sessionend' ||
      (event === 'stop' && ['channel_closed', 'shutdown'].includes(reason ?? '')),
    validatePrefix: event !== 'stop' || ['channel_closed', 'shutdown'].includes(reason ?? ''),
  };
}

function grokExportStream(
  sessionId: string,
  dependencies: HostHookDependencies,
  timeoutMs: number
): AsyncIterable<string | Buffer> {
  if (dependencies.exportGrokStream) {
    return dependencies.exportGrokStream(sessionId, timeoutMs);
  }
  if (dependencies.exportGrok) {
    return (async function* () {
      yield dependencies.exportGrok!(sessionId, timeoutMs);
    })();
  }
  return streamGrokSessionExport(sessionId, timeoutMs);
}

function grokExportAttemptTimeout(deadline: number, attemptsRemaining: number): number {
  assertHostDeadline(deadline - GROK_FINALIZATION_MARGIN_MS);
  const available = deadline - Date.now() - GROK_FINALIZATION_MARGIN_MS;
  return Math.min(GROK_EXPORT_ATTEMPT_MAX_MS, Math.max(1, Math.floor(
    available / attemptsRemaining
  )));
}

async function stageGrokExport(
  source: AsyncIterable<string | Buffer>,
  deadline: number
): Promise<{ directory: string; fd: number; size: number }> {
  const directory = mkdtempSync(join(tmpdir(), 'recall-grok-export-'));
  const path = join(directory, 'export.md');
  const fd = openSync(path, 'wx+', 0o600);
  let size = 0;
  try {
    rmSync(path);
    for await (const value of source) {
      assertHostDeadline(deadline);
      const raw = asBuffer(value);
      if (!Number.isSafeInteger(size + raw.length)) {
        throw new Error('Grok export is too large to capture safely');
      }
      let written = 0;
      while (written < raw.length) {
        written += writeSync(fd, raw, written, raw.length - written);
      }
      size += raw.length;
    }
    assertHostDeadline(deadline);
    return { directory, fd, size };
  } catch (error) {
    closeSync(fd);
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function ingestStagedGrokExport(
  request: GrokHookRequest,
  dependencies: HostHookDependencies,
  staged: { fd: number; size: number },
  deadline: number
): HostHookResult {
  assertHostDeadline(deadline);
  const transcriptRef = 'grok export';
  const ingestBatch = resolveIngestBatch(dependencies);
  const checkpoint = dependencies.checkpoint ?? getHostIngestCheckpoint;
  const previous = checkpoint('grok', request.sessionId);
  assertHostDeadline(deadline);
  const size = staged.size;
  const read = (start: number, length: number) => {
    const bytes = Math.max(0, Math.min(length, size - start));
    const buffer = Buffer.alloc(bytes);
    const read = readSync(staged.fd, buffer, 0, bytes, start);
    return read === bytes ? buffer : buffer.subarray(0, read);
  };
  const capture = byteCapture(
    previous,
    transcriptRef,
    size,
    read,
    request.validatePrefix,
    deadline
  );
  const start = capture.start;
  const incremental = start > 0;
  const batch = createHostIngestBatch();
  if (!capture.reset && start === size && (!request.finalize || previous?.finalized)) {
    return { skipped: 'unchanged-transcript' };
  }
  if (start === size) {
    const input: HostTranscript = {
      source: 'grok',
      sessionId: request.sessionId,
      messages: [],
      cwd: request.cwd,
      transcriptRef,
      watermark: capture.reset
        ? byteWatermark(size, capture.digest)
        : previous?.watermark ?? byteWatermark(size, capture.digest),
      capturedAt: request.capturedAt,
      incremental,
      reconcileComplete: true,
      finalize: request.finalize,
      batch,
    };
    return {
      ingest: ingestBatch([input], {
        source: 'grok',
        sessionId: request.sessionId,
        checkpoint: previous,
      }, deadline),
    };
  }

  const inputs = function* (): Generator<HostTranscript> {
    for (const chunk of boundedTranscriptChunks(
      start,
      size,
      read,
      capture.digest,
      grokFrameBoundary,
      deadline
    )) {
      assertHostDeadline(deadline);
      const parsed = parseGrokExport(chunk.raw.toString('utf-8'), {
        sourceOffset: chunk.start,
      });
      yield {
        source: 'grok',
        sessionId: request.sessionId,
        messages: parsed.messages,
        cwd: request.cwd,
        transcriptRef,
        watermark: chunk.watermark,
        capturedAt: request.capturedAt,
        incremental,
        reconcileComplete: chunk.end === size,
        finalize: request.finalize && chunk.end === size,
        batch,
      };
    }
  };
  assertHostDeadline(deadline);
  return {
    ingest: ingestBatch(inputs(), {
      source: 'grok',
      sessionId: request.sessionId,
      checkpoint: previous,
    }, deadline),
  };
}

export async function handleGrokHostHook(
  payload: HookPayload,
  dependencies: HostHookDependencies = {}
): Promise<HostHookResult> {
  if (payloadIsSubagent(payload) && !includeSubagents()) return { skipped: 'subagent' };
  const request = grokHookRequest(payload);
  if ('skipped' in request) return request;
  const deadline = Date.now() + GROK_CAPTURE_BUDGET_MS;
  for (let attempt = 0; attempt < GROK_CHECKPOINT_ATTEMPTS; attempt++) {
    const timeoutMs = grokExportAttemptTimeout(
      deadline,
      GROK_CHECKPOINT_ATTEMPTS - attempt
    );
    const staged = await stageGrokExport(
      grokExportStream(request.sessionId, dependencies, timeoutMs),
      deadline
    );
    try {
      return ingestStagedGrokExport(request, dependencies, staged, deadline);
    } catch (error) {
      if (!(error instanceof HostIngestCheckpointConflictError) ||
        attempt === GROK_CHECKPOINT_ATTEMPTS - 1) {
        throw error;
      }
    } finally {
      closeSync(staged.fd);
      rmSync(staged.directory, { recursive: true, force: true });
    }
  }
  throw new Error('Grok checkpoint retry exhausted');
}

function renderRecallContext(): string {
  const candidates = [
    fileURLToPath(new URL('../hooks/RecallStart.ts', import.meta.url)),
    fileURLToPath(new URL('../../hooks/RecallStart.ts', import.meta.url)),
  ];
  const hookPath = candidates.find(existsSync);
  if (!hookPath) throw new Error('RecallStart hook is not installed beside Recall');
  const result = spawnSync(process.execPath, [hookPath], {
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`RecallStart failed (${result.status})`);
  return result.stdout.trim();
}

function parsePayload(raw: string): HookPayload {
  if (Buffer.byteLength(raw, 'utf-8') > MAX_HOOK_INPUT_BYTES) {
    throw new Error(`Hook payload exceeds ${MAX_HOOK_INPUT_BYTES} bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw || '{}');
  } catch {
    throw new Error('Hook payload must be valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Hook payload must be a JSON object');
  }
  return value as HookPayload;
}

export function handleHostHook(
  host: Exclude<LifecycleHost, 'grok'>,
  payload: HookPayload,
  dependencies: HostHookDependencies = {}
): HostHookResult {
  const event = eventName(payload);
  const sessionId = stringValue(payload.session_id) ?? stringValue(payload.sessionId);
  const cwd = stringValue(payload.cwd) ?? stringValue(payload.workspaceRoot);
  const capturedAt = stringValue(payload.timestamp);
  const ingestBatch = resolveIngestBatch(dependencies);
  const checkpoint = dependencies.checkpoint ?? getHostIngestCheckpoint;

  if (payloadIsSubagent(payload) && !includeSubagents()) {
    return { skipped: 'subagent' };
  }

  if (host === 'codex') {
    if (event === 'sessionstart') {
      const context = (dependencies.renderContext ?? renderRecallContext)();
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: context,
          },
        }),
      };
    }

    if (!['stop', 'precompact', 'postcompact', 'sessionend'].includes(event)) {
      return { skipped: 'unsupported-event' };
    }
    if (!sessionId) return { skipped: 'missing-session-id' };
    const transcriptPath =
      stringValue(payload.transcript_path) ?? stringValue(payload.transcriptPath);
    if (!transcriptPath) return { skipped: 'missing-supplied-transcript' };
    const size = (dependencies.transcriptSize ?? suppliedTranscriptSize)(transcriptPath);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid transcript size');
    const read = (start: number, length: number) =>
      asBuffer(
        (dependencies.readTranscript ?? readSuppliedTranscript)(transcriptPath, start, length)
      ).subarray(0, length);
    const previous = checkpoint('codex', sessionId);
    const validatePrefix = ['precompact', 'postcompact', 'sessionend'].includes(event);
    const capture = byteCapture(previous, transcriptPath, size, read, validatePrefix);
    const start = capture.start;
    const incremental = start > 0;
    const batch = createHostIngestBatch();
    const finalize = event === 'sessionend';
    if (!capture.reset && start === size && (!finalize || previous?.finalized)) {
      return { skipped: 'unchanged-transcript' };
    }
    if (start === size) {
      return {
        ingest: ingestBatch([{
          source: 'codex',
          sessionId,
          messages: [],
          cwd,
          transcriptRef: transcriptPath,
          watermark: capture.reset
            ? byteWatermark(size, capture.digest)
            : previous?.watermark ?? byteWatermark(size, capture.digest),
          capturedAt,
          incremental,
          finalize,
          batch,
        }]),
      };
    }
    const inputs = function* (): Generator<HostTranscript> {
      for (const chunk of boundedTranscriptChunks(start, size, read, capture.digest)) {
        const parsed = parseCodexRollout(chunk.raw.toString('utf-8'));
        if (parsed.sessionId && parsed.sessionId !== sessionId) {
          throw new HostHookSkip('session-id-mismatch');
        }
        if (parsed.isSubagent && !includeSubagents()) throw new HostHookSkip('subagent');
        yield {
          source: 'codex',
          sessionId,
          messages: parsed.messages,
          cwd: cwd ?? parsed.cwd,
          transcriptRef: transcriptPath,
          watermark: chunk.watermark,
          capturedAt,
          incremental,
          finalize: finalize && chunk.end === size,
          batch,
        };
      }
    };
    try {
      return { ingest: ingestBatch(inputs()) };
    } catch (error) {
      if (error instanceof HostHookSkip) return { skipped: error.reason };
      throw error;
    }
  }

  return { skipped: 'jcode-probe-did-not-prove-safe-capture' };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_HOOK_INPUT_BYTES)
      throw new Error(`Hook payload exceeds ${MAX_HOOK_INPUT_BYTES} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export async function runHostHook(hostValue: string): Promise<void> {
  if (!['codex', 'grok', 'jcode'].includes(hostValue)) {
    throw new Error(`Unsupported lifecycle host: ${hostValue}`);
  }
  try {
    const payload = parsePayload(await readStdin());
    const result = hostValue === 'grok'
      ? await handleGrokHostHook(payload)
      : handleHostHook(hostValue as Exclude<LifecycleHost, 'grok'>, payload);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.ingest?.redactions.length) {
      process.stderr.write(`Recall redacted: ${result.ingest.redactions.join(', ')}\n`);
    }
  } catch (error) {
    process.stderr.write(
      `Recall ${hostValue} lifecycle capture skipped: ${error instanceof Error ? error.message : String(error)}\n`
    );
  }
}
