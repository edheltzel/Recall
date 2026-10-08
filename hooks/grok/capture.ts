#!/usr/bin/env bun
// Grok ambient adapter. `grok export <session-id>` text goes to `recall capture`.
// No SessionStart injection. No src/ imports.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Grok rewrites `$HOME` inside `${VAR:-default}` before `inspect`; `~` is not expanded there by sh.
export const GROK_CAPTURE_COMMAND =
  'bun "${RECALL_DIR:-$(printf %s ~)/.agents/Recall}/grok/hooks/capture.ts"';

const EXPORT_TIMEOUT_MS = 60_000;

export interface GrokCaptureCall {
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

function captureEvent(payload: Record<string, unknown>): GrokCaptureCall['event'] | undefined {
  const name = (stringValue(payload.hook_event_name) ?? stringValue(payload.hookEventName) ?? '')
    .replace(/[_-]/g, '')
    .toLowerCase();
  if (name === 'sessionend') return 'session_end';
  if (name === 'stop' || name === 'precompact' || name === 'postcompact') return 'turn_end';
  return undefined;
}

export function grokCaptureFromHook(
  payload: Record<string, unknown>,
  exportSession: (sessionId: string) => string,
  env: NodeJS.ProcessEnv = process.env,
): GrokCaptureCall | Skip {
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
  const text = exportSession(sessionId);
  if (!text.trim()) return { skipped: 'empty-export' };
  return {
    event,
    text,
    sessionId,
    cwd: stringValue(payload.cwd) ?? stringValue(payload.workspaceRoot),
  };
}

function exportGrokSession(sessionId: string): string {
  const command = process.env.GROK_BIN || 'grok';
  const child = spawnSync(command, ['export', sessionId], {
    encoding: 'utf-8',
    timeout: EXPORT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(
      `grok export failed (${child.status ?? 'unknown'}): ${(child.stderr ?? '').trim()}`,
    );
  }
  return child.stdout ?? '';
}

if (import.meta.main) {
  try {
    const raw = readFileSync(0, 'utf-8');
    const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
    if (!isObject(parsed)) throw new Error('hook payload must be a JSON object');
    const call = grokCaptureFromHook(parsed, exportGrokSession);
    if ('skipped' in call) process.exit(0);
    const child = spawnSync('recall', ['capture'], {
      input: JSON.stringify({
        contract: 1,
        harness: 'grok',
        event: call.event,
        text: call.text,
        session_id: call.sessionId,
        cwd: call.cwd,
      }),
      encoding: 'utf-8',
    });
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    if (child.status !== 0) process.stderr.write('Recall grok capture skipped\n');
  } catch (error) {
    process.stderr.write(
      `Recall grok capture skipped: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  process.exit(0);
}
