import { spawnSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { parseCodexRollout } from '../hosts/codex-lifecycle.js';
import { parseGrokExport } from '../hosts/grok-lifecycle.js';
import {
  ingestHostTranscript,
  type HostIngestResult,
  type LifecycleHost,
} from '../lib/host-ingest.js';

const MAX_HOOK_INPUT_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 25 * 1024 * 1024;

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
  readTranscript?: (path: string) => string;
  exportGrok?: (sessionId: string) => string;
  renderContext?: () => string;
  ingest?: typeof ingestHostTranscript;
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

function readSuppliedTranscript(path: string): string {
  if (!existsSync(path)) throw new Error(`Supplied transcript does not exist: ${path}`);
  const size = statSync(path).size;
  if (size > MAX_TRANSCRIPT_BYTES) {
    throw new Error(`Supplied transcript exceeds ${MAX_TRANSCRIPT_BYTES} bytes`);
  }
  return readFileSync(path, 'utf-8');
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
    const raw = (dependencies.readTranscript ?? readSuppliedTranscript)(transcriptPath);
    const parsed = parseCodexRollout(raw);
    if (
      (parsed.isSubagent || (parsed.sessionId && parsed.sessionId !== sessionId)) &&
      !includeSubagents()
    ) {
      return { skipped: parsed.isSubagent ? 'subagent' : 'session-id-mismatch' };
    }
    const bytes = Buffer.byteLength(raw, 'utf-8');
    return {
      ingest: ingest({
        source: 'codex',
        sessionId,
        messages: parsed.messages,
        cwd: cwd ?? parsed.cwd,
        transcriptRef: transcriptPath,
        watermark: `bytes:${bytes}`,
        capturedAt,
        finalize: event === 'sessionend',
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
    const parsed = parseGrokExport(markdown);
    const reason = stringValue(payload.reason)?.toLowerCase();
    const terminalStop = event === 'stop' && ['channel_closed', 'shutdown'].includes(reason ?? '');
    return {
      ingest: ingest({
        source: 'grok',
        sessionId,
        messages: parsed.messages,
        cwd,
        transcriptRef: 'grok export',
        watermark: `bytes:${Buffer.byteLength(markdown, 'utf-8')}`,
        capturedAt,
        finalize: event === 'sessionend' || terminalStop,
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
