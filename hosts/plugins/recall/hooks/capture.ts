#!/usr/bin/env bun
// Codex ambient adapter. Reads the supplied rollout only, then calls `recall capture`.
// SessionStart injection stays on `recall host-hook codex`. No src/ imports.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';

export const CODEX_CAPTURE_COMMAND =
  'bun "${PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/hooks/capture.ts"';
export const CODEX_SESSION_START_COMMAND = 'recall host-hook codex';

const MAX_BYTES = 25 * 1024 * 1024;
const INJECTED_USER_PREFIXES = [
  '# AGENTS.md instructions for ',
  '<environment_context>',
  '<user_instructions>',
];

export interface CodexCaptureCall {
  event: 'turn_end' | 'session_end';
  text: string;
  sessionId: string;
  cwd?: string;
}

type Skip = { skipped: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function captureEvent(payload: Record<string, unknown>): CodexCaptureCall['event'] | undefined {
  const name = (stringValue(payload.hook_event_name) ?? stringValue(payload.hookEventName) ?? '')
    .replace(/[_-]/g, '')
    .toLowerCase();
  if (name === 'sessionend') return 'session_end';
  if (name === 'stop' || name === 'precompact' || name === 'postcompact') return 'turn_end';
  return undefined;
}

function containsSubagentMarker(value: unknown, depth = 0): boolean {
  if (depth > 5 || !isObject(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'subagent' || key === 'parent_thread_id' || key === 'parentThreadId') return true;
    if (containsSubagentMarker(child, depth + 1)) return true;
  }
  return false;
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isObject)
    .filter(part => ['input_text', 'output_text', 'text'].includes(String(part.type ?? '')))
    .map(part => stringValue(part.text) ?? '')
    .filter(Boolean)
    .join('\n');
}

/** Supplied rollout only. Drops injected instruction turns and duplicate event rows. */
export function codexCaptureFromHook(
  payload: Record<string, unknown>,
  readTranscript: (path: string) => string,
  env: NodeJS.ProcessEnv = process.env,
): CodexCaptureCall | Skip {
  const event = captureEvent(payload);
  if (!event) return { skipped: 'unsupported-event' };
  const subagent = Boolean(
    payload.is_subagent ||
      payload.isSubagent ||
      stringValue(payload.agent_id) ||
      stringValue(payload.agentId),
  );
  if (subagent && env.RECALL_INCLUDE_SUBAGENTS !== '1') return { skipped: 'subagent' };

  const sessionId = stringValue(payload.session_id) ?? stringValue(payload.sessionId);
  if (!sessionId) return { skipped: 'missing-session-id' };
  const transcriptPath =
    stringValue(payload.transcript_path) ?? stringValue(payload.transcriptPath);
  if (!transcriptPath) return { skipped: 'missing-supplied-transcript' };

  let raw: string;
  try {
    raw = readTranscript(transcriptPath);
  } catch (error) {
    return { skipped: error instanceof Error ? error.message : 'transcript-unreadable' };
  }

  const lines: string[] = [];
  let transcriptSessionId: string | undefined;
  let cwd = stringValue(payload.cwd) ?? stringValue(payload.workspaceRoot);
  let isSubagent = false;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isObject(parsed)) continue;
      row = parsed;
    } catch {
      continue;
    }
    const body = isObject(row.payload) ? row.payload : undefined;
    if (row.type === 'session_meta' && body) {
      transcriptSessionId =
        stringValue(body.id) ?? stringValue(body.session_id) ?? transcriptSessionId;
      cwd = cwd ?? stringValue(body.cwd);
      isSubagent ||= containsSubagentMarker(body.source) || containsSubagentMarker(body);
      continue;
    }
    if (row.type !== 'response_item' || !body || body.type !== 'message') continue;
    const role = body.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = messageText(body.content);
    if (!content.trim()) continue;
    if (role === 'user' && INJECTED_USER_PREFIXES.some(prefix => content.startsWith(prefix))) {
      continue;
    }
    lines.push(`${role}: ${content}`);
  }

  if (transcriptSessionId && transcriptSessionId !== sessionId) {
    return { skipped: 'session-id-mismatch' };
  }
  if (isSubagent && env.RECALL_INCLUDE_SUBAGENTS !== '1') return { skipped: 'subagent' };
  const text = lines.join('\n\n');
  if (!text.trim()) return { skipped: 'empty-text' };
  return { event, text, sessionId, cwd };
}

function readSuppliedTranscript(path: string): string {
  if (!existsSync(path)) throw new Error(`supplied transcript does not exist: ${path}`);
  const size = statSync(path).size;
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES) {
    throw new Error(`supplied transcript exceeds ${MAX_BYTES} bytes`);
  }
  return readFileSync(path, 'utf-8');
}

if (import.meta.main) {
  try {
    const raw = readFileSync(0, 'utf-8');
    const log = process.env.RECALL_E2E_HOOK_LOG;
    if (log && raw.trim()) {
      try {
        appendFileSync(log, raw.endsWith('\n') ? raw : `${raw}\n`);
      } catch {
        // e2e log is best-effort
      }
    }
    const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
    if (!isObject(parsed)) throw new Error('hook payload must be a JSON object');
    const call = codexCaptureFromHook(parsed, readSuppliedTranscript);
    if ('skipped' in call) process.exit(0);
    const child = spawnSync('recall', ['capture'], {
      input: JSON.stringify({
        contract: 1,
        harness: 'codex',
        event: call.event,
        text: call.text,
        session_id: call.sessionId,
        cwd: call.cwd,
      }),
      encoding: 'utf-8',
    });
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    if (child.status !== 0) process.stderr.write('Recall codex capture skipped\n');
  } catch (error) {
    process.stderr.write(
      `Recall codex capture skipped: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  process.exit(0);
}
