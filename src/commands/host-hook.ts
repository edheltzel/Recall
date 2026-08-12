import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
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
  const size = statSync(path).size;
  if (size > MAX_TRANSCRIPT_BYTES) {
    throw new Error(`Supplied transcript exceeds ${MAX_TRANSCRIPT_BYTES} bytes`);
  }
  return size;
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

function byteCaptureRange(
  checkpoint: HostIngestCheckpoint | undefined,
  transcriptRef: string,
  size: number,
  read: (start: number, length: number) => Buffer
): { start: number; watermark: string } {
  let start = 0;
  const match = checkpoint?.watermark?.match(/^bytes:(\d+):tail:([0-9a-f]{64})$/);
  if (checkpoint?.transcriptRef === transcriptRef && match) {
    const previousSize = Number(match[1]);
    if (Number.isSafeInteger(previousSize) && previousSize <= size) {
      const tailStart = Math.max(0, previousSize - WATERMARK_TAIL_BYTES);
      const previousTail = read(tailStart, previousSize - tailStart);
      if (tailHash(previousTail) === match[2]) start = previousSize;
    }
  }

  const tailStart = Math.max(0, size - WATERMARK_TAIL_BYTES);
  const currentTail = read(tailStart, size - tailStart);
  return { start, watermark: `bytes:${size}:tail:${tailHash(currentTail)}` };
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

function runGrokExport(sessionId: string): string {
  const command = process.env.GROK_BIN || 'grok';
  const result = spawnSync(command, ['export', sessionId], {
    encoding: 'utf-8',
    maxBuffer: MAX_TRANSCRIPT_BYTES,
    timeout: 60_000,
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`grok export failed (${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout;
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
    if (size > MAX_TRANSCRIPT_BYTES) {
      throw new Error(`Supplied transcript exceeds ${MAX_TRANSCRIPT_BYTES} bytes`);
    }
    const read = (start: number, length: number) =>
      asBuffer((dependencies.readTranscript ?? readSuppliedTranscript)(transcriptPath, start, length));
    const previous = checkpoint('codex', sessionId);
    const range = byteCaptureRange(previous, transcriptPath, size, read);
    const finalize = event === 'sessionend';
    if (range.start === size && (!finalize || previous?.finalized)) {
      return { skipped: 'unchanged-transcript' };
    }
    const raw = read(range.start, size - range.start).toString('utf-8');
    const parsed = parseCodexRollout(raw);
    if (parsed.sessionId && parsed.sessionId !== sessionId) {
      return { skipped: 'session-id-mismatch' };
    }
    if (parsed.isSubagent && !includeSubagents()) return { skipped: 'subagent' };
    return {
      ingest: ingest({
        source: 'codex',
        sessionId,
        messages: parsed.messages,
        cwd: cwd ?? parsed.cwd,
        transcriptRef: transcriptPath,
        watermark: range.watermark,
        capturedAt,
        incremental: range.start > 0,
        finalize,
      }),
    };
  }

  if (host === 'grok') {
    if (!['stop', 'precompact', 'postcompact', 'sessionend'].includes(event)) {
      return { skipped: 'unsupported-event' };
    }
    if (!sessionId) return { skipped: 'missing-session-id' };
    const markdown = (dependencies.exportGrok ?? runGrokExport)(sessionId);
    if (Buffer.byteLength(markdown, 'utf-8') > MAX_TRANSCRIPT_BYTES) {
      throw new Error(`Grok export exceeds ${MAX_TRANSCRIPT_BYTES} bytes`);
    }
    const reason = stringValue(payload.reason)?.toLowerCase();
    const terminalStop = event === 'stop' && ['channel_closed', 'shutdown'].includes(reason ?? '');
    const finalize = event === 'sessionend' || terminalStop;
    const transcriptRef = 'grok export';
    const raw = Buffer.from(markdown, 'utf-8');
    const previous = checkpoint('grok', sessionId);
    const range = byteCaptureRange(
      previous,
      transcriptRef,
      raw.length,
      (start, length) => raw.subarray(start, start + length)
    );
    if (range.start === raw.length && (!finalize || previous?.finalized)) {
      return { skipped: 'unchanged-transcript' };
    }
    const parsed = parseGrokExport(raw.subarray(range.start).toString('utf-8'));
    return {
      ingest: ingest({
        source: 'grok',
        sessionId,
        messages: parsed.messages,
        cwd,
        transcriptRef,
        watermark: range.watermark,
        capturedAt,
        incremental: range.start > 0,
        finalize,
      }),
    };
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
    const result = handleHostHook(hostValue as LifecycleHost, payload);
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
