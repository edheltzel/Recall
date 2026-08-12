import { createHash } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { closeSync, existsSync, openSync, readSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { parseCodexRollout } from '../hosts/codex-lifecycle.js';
import { parseGrokExport } from '../hosts/grok-lifecycle.js';
import {
  ingestHostTranscript,
  getHostIngestCheckpoint,
  type HostIngestCheckpoint,
  type HostIngestResult,
  type LifecycleHost,
} from '../lib/host-ingest.js';

const MAX_HOOK_INPUT_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 25 * 1024 * 1024;
const WATERMARK_TAIL_BYTES = 4096;

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
  exportGrok?: (sessionId: string) => string;
  exportGrokStream?: (sessionId: string) => AsyncIterable<string | Buffer>;
  renderContext?: () => string;
  ingest?: typeof ingestHostTranscript;
  checkpoint?: (source: LifecycleHost, sessionId: string) => HostIngestCheckpoint | undefined;
}

export interface HostHookResult {
  stdout?: string;
  ingest?: HostIngestResult;
  skipped?: string;
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

function tailHash(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function byteCheckpoint(
  checkpoint: HostIngestCheckpoint | undefined,
  transcriptRef: string
): { size: number; tail: string } | undefined {
  const match = checkpoint?.watermark?.match(/^bytes:(\d+):tail:([0-9a-f]{64})$/);
  if (checkpoint?.transcriptRef !== transcriptRef || !match) return undefined;
  const size = Number(match[1]);
  return Number.isSafeInteger(size) && size >= 0 ? { size, tail: match[2] } : undefined;
}

function byteCaptureStart(
  checkpoint: HostIngestCheckpoint | undefined,
  transcriptRef: string,
  size: number,
  read: (start: number, length: number) => Buffer
): number {
  let start = 0;
  const previous = byteCheckpoint(checkpoint, transcriptRef);
  if (previous && previous.size <= size) {
    const tailStart = Math.max(0, previous.size - WATERMARK_TAIL_BYTES);
    const previousTail = read(tailStart, previous.size - tailStart);
    if (tailHash(previousTail) === previous.tail) start = previous.size;
  }
  return start;
}

function byteWatermark(end: number, read: (start: number, length: number) => Buffer): string {
  const tailStart = Math.max(0, end - WATERMARK_TAIL_BYTES);
  return `bytes:${end}:tail:${tailHash(read(tailStart, end - tailStart))}`;
}

function* boundedTranscriptChunks(
  start: number,
  size: number,
  read: (start: number, length: number) => Buffer
): Generator<{ start: number; end: number; raw: Buffer; watermark: string }> {
  let cursor = start;
  while (cursor < size) {
    const length = Math.min(MAX_TRANSCRIPT_BYTES, size - cursor);
    let raw = read(cursor, length);
    if (raw.length !== length) throw new Error('Transcript read returned incomplete data');
    let end = cursor + raw.length;
    if (end < size) {
      const newline = raw.lastIndexOf(0x0a);
      if (newline < 0) {
        throw new Error(`Transcript record exceeds ${MAX_TRANSCRIPT_BYTES} bytes`);
      }
      raw = raw.subarray(0, newline + 1);
      end = cursor + raw.length;
    }
    yield { start: cursor, end, raw, watermark: byteWatermark(end, read) };
    cursor = end;
  }
}

function mergeIngestResults(
  current: HostIngestResult | undefined,
  next: HostIngestResult
): HostIngestResult {
  if (!current) return next;
  return {
    sessionId: next.sessionId,
    inserted: current.inserted + next.inserted,
    skipped: current.skipped + next.skipped,
    finalized: current.finalized || next.finalized,
    loaId: next.loaId ?? current.loaId,
    redactions: [...new Set([...current.redactions, ...next.redactions])],
    digest: next.digest,
  };
}

interface GrokHookRequest {
  sessionId: string;
  cwd?: string;
  capturedAt?: string;
  finalize: boolean;
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
  };
}

function appendTail(current: Buffer, next: Buffer): Buffer {
  if (next.length >= WATERMARK_TAIL_BYTES) return next.subarray(-WATERMARK_TAIL_BYTES);
  const combined = Buffer.concat([current, next]);
  return combined.length > WATERMARK_TAIL_BYTES
    ? combined.subarray(-WATERMARK_TAIL_BYTES)
    : combined;
}

async function* runGrokExportStream(sessionId: string): AsyncGenerator<Buffer> {
  const command = process.env.GROK_BIN || 'grok';
  const child = spawn(command, ['export', sessionId], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let closed = false;
  let timedOut = false;
  child.stderr.on('data', chunk => {
    stderr = `${stderr}${asBuffer(chunk).toString('utf-8')}`.slice(-MAX_HOOK_INPUT_BYTES);
  });
  const completion = new Promise<{ code: number | null; signal: string | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        closed = true;
        resolve({ code, signal });
      });
    }
  );
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 60_000);
  try {
    for await (const chunk of child.stdout) yield asBuffer(chunk);
    const result = await completion;
    if (timedOut) throw new Error('grok export timed out');
    if (result.code !== 0) {
      throw new Error(
        `grok export failed (${result.code ?? result.signal ?? 'unknown'}): ${stderr.trim()}`
      );
    }
  } finally {
    clearTimeout(timeout);
    if (!closed) {
      child.kill('SIGKILL');
      await completion.catch(() => undefined);
    }
  }
}

async function ingestGrokStreamPass(
  request: GrokHookRequest,
  dependencies: HostHookDependencies,
  previous: HostIngestCheckpoint | undefined,
  useCheckpoint: boolean
): Promise<{ reset: boolean; result?: HostHookResult }> {
  const transcriptRef = 'grok export';
  const checkpoint = useCheckpoint ? byteCheckpoint(previous, transcriptRef) : undefined;
  const ingest = dependencies.ingest ?? ingestHostTranscript;
  const source = (dependencies.exportGrokStream ?? runGrokExportStream)(request.sessionId);
  let validated = !checkpoint;
  let bytesRead = 0;
  let captureCursor = checkpoint?.size ?? 0;
  let prefixTail = Buffer.alloc(0);
  let currentTail = Buffer.alloc(0);
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let aggregate: HostIngestResult | undefined;

  if (checkpoint?.size === 0) {
    if (tailHash(prefixTail) !== checkpoint.tail) return { reset: true };
    validated = true;
  }

  const ingestChunk = (raw: Buffer) => {
    const start = captureCursor;
    captureCursor += raw.length;
    currentTail = appendTail(currentTail, raw);
    const parsed = parseGrokExport(raw.toString('utf-8'));
    aggregate = mergeIngestResults(aggregate, ingest({
      source: 'grok',
      sessionId: request.sessionId,
      messages: parsed.messages,
      cwd: request.cwd,
      transcriptRef,
      watermark: `bytes:${captureCursor}:tail:${tailHash(currentTail)}`,
      capturedAt: request.capturedAt,
      incremental: start > 0,
      finalize: false,
    }));
  };

  const flushBounded = () => {
    while (pendingBytes > MAX_TRANSCRIPT_BYTES) {
      const combined = Buffer.concat(pending, pendingBytes);
      const newline = combined.subarray(0, MAX_TRANSCRIPT_BYTES).lastIndexOf(0x0a);
      if (newline < 0) {
        throw new Error(`Transcript record exceeds ${MAX_TRANSCRIPT_BYTES} bytes`);
      }
      ingestChunk(combined.subarray(0, newline + 1));
      const remainder = combined.subarray(newline + 1);
      pending = remainder.length ? [remainder] : [];
      pendingBytes = remainder.length;
    }
  };

  const queue = (raw: Buffer) => {
    let offset = 0;
    while (offset < raw.length) {
      const take = Math.min(
        MAX_TRANSCRIPT_BYTES + 1 - pendingBytes,
        raw.length - offset
      );
      pending.push(raw.subarray(offset, offset + take));
      pendingBytes += take;
      offset += take;
      flushBounded();
    }
  };

  for await (const value of source) {
    const raw = asBuffer(value);
    let offset = 0;
    if (!validated && checkpoint) {
      const take = Math.min(checkpoint.size - bytesRead, raw.length);
      prefixTail = appendTail(prefixTail, raw.subarray(0, take));
      bytesRead += take;
      offset = take;
      if (bytesRead === checkpoint.size) {
        if (tailHash(prefixTail) !== checkpoint.tail) return { reset: true };
        validated = true;
        currentTail = prefixTail;
      }
    }
    if (validated && offset < raw.length) {
      const suffix = raw.subarray(offset);
      bytesRead += suffix.length;
      queue(suffix);
    }
  }

  if (!validated) return { reset: true };
  if (pendingBytes > 0) ingestChunk(Buffer.concat(pending, pendingBytes));

  if (!aggregate && (!request.finalize || previous?.finalized)) {
    return { reset: false, result: { skipped: 'unchanged-transcript' } };
  }
  if (request.finalize) {
    aggregate = mergeIngestResults(aggregate, ingest({
      source: 'grok',
      sessionId: request.sessionId,
      messages: [],
      cwd: request.cwd,
      transcriptRef,
      watermark: `bytes:${bytesRead}:tail:${tailHash(currentTail)}`,
      capturedAt: request.capturedAt,
      incremental: bytesRead > 0,
      finalize: true,
    }));
  }
  return { reset: false, result: { ingest: aggregate } };
}

export async function handleGrokHostHook(
  payload: HookPayload,
  dependencies: HostHookDependencies = {}
): Promise<HostHookResult> {
  if (payloadIsSubagent(payload) && !includeSubagents()) return { skipped: 'subagent' };
  const request = grokHookRequest(payload);
  if ('skipped' in request) return request;
  const checkpoint = (dependencies.checkpoint ?? getHostIngestCheckpoint)(
    'grok',
    request.sessionId
  );
  const first = await ingestGrokStreamPass(request, dependencies, checkpoint, true);
  if (!first.reset) return first.result ?? { skipped: 'empty-export' };
  const reset = await ingestGrokStreamPass(request, dependencies, checkpoint, false);
  return reset.result ?? { skipped: 'empty-export' };
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
  host: LifecycleHost,
  payload: HookPayload,
  dependencies: HostHookDependencies = {}
): HostHookResult {
  const event = eventName(payload);
  const sessionId = stringValue(payload.session_id) ?? stringValue(payload.sessionId);
  const cwd = stringValue(payload.cwd) ?? stringValue(payload.workspaceRoot);
  const capturedAt = stringValue(payload.timestamp);
  const ingest = dependencies.ingest ?? ingestHostTranscript;
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
    const start = byteCaptureStart(previous, transcriptPath, size, read);
    const finalize = event === 'sessionend';
    if (start === size && (!finalize || previous?.finalized)) {
      return { skipped: 'unchanged-transcript' };
    }
    if (start === size) {
      return {
        ingest: ingest({
          source: 'codex',
          sessionId,
          messages: [],
          cwd,
          transcriptRef: transcriptPath,
          watermark: previous?.watermark ?? byteWatermark(size, read),
          capturedAt,
          incremental: start > 0,
          finalize: true,
        }),
      };
    }
    let aggregate: HostIngestResult | undefined;
    for (const chunk of boundedTranscriptChunks(start, size, read)) {
      const parsed = parseCodexRollout(chunk.raw.toString('utf-8'));
      if (parsed.sessionId && parsed.sessionId !== sessionId) {
        return { skipped: 'session-id-mismatch' };
      }
      if (parsed.isSubagent && !includeSubagents()) return { skipped: 'subagent' };
      aggregate = mergeIngestResults(aggregate, ingest({
        source: 'codex',
        sessionId,
        messages: parsed.messages,
        cwd: cwd ?? parsed.cwd,
        transcriptRef: transcriptPath,
        watermark: chunk.watermark,
        capturedAt,
        incremental: chunk.start > 0,
        finalize: finalize && chunk.end === size,
      }));
    }
    return { ingest: aggregate };
  }

  if (host === 'grok') {
    const request = grokHookRequest(payload);
    if ('skipped' in request) return request;
    if (!dependencies.exportGrok) {
      throw new Error('Synchronous Grok routing requires an injected export');
    }
    const markdown = dependencies.exportGrok(request.sessionId);
    const transcriptRef = 'grok export';
    const raw = Buffer.from(markdown, 'utf-8');
    const previous = checkpoint('grok', request.sessionId);
    const read = (start: number, length: number) => raw.subarray(start, start + length);
    const start = byteCaptureStart(
      previous,
      transcriptRef,
      raw.length,
      read
    );
    if (start === raw.length && (!request.finalize || previous?.finalized)) {
      return { skipped: 'unchanged-transcript' };
    }
    if (start === raw.length) {
      return {
        ingest: ingest({
          source: 'grok',
          sessionId: request.sessionId,
          messages: [],
          cwd: request.cwd,
          transcriptRef,
          watermark: previous?.watermark ?? byteWatermark(raw.length, read),
          capturedAt: request.capturedAt,
          incremental: start > 0,
          finalize: true,
        }),
      };
    }
    let aggregate: HostIngestResult | undefined;
    for (const chunk of boundedTranscriptChunks(start, raw.length, read)) {
      const parsed = parseGrokExport(chunk.raw.toString('utf-8'));
      aggregate = mergeIngestResults(aggregate, ingest({
        source: 'grok',
        sessionId: request.sessionId,
        messages: parsed.messages,
        cwd: request.cwd,
        transcriptRef,
        watermark: chunk.watermark,
        capturedAt: request.capturedAt,
        incremental: chunk.start > 0,
        finalize: request.finalize && chunk.end === raw.length,
      }));
    }
    return { ingest: aggregate };
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
      : handleHostHook(hostValue as LifecycleHost, payload);
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
