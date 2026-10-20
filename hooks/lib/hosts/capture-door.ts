// Shared hook-side half of the `recall capture` door (contract 1). Host
// adapters build payloads here and shell out; none import src/ or write recall.db.

import { spawnSync } from 'child_process';
import { basename } from 'path';

export const CAPTURE_MAX_BYTES = 25 * 1024 * 1024;

export type CaptureEvent = 'turn_end' | 'session_end';

export interface CapturePayload<H extends string = string> {
  contract: 1;
  harness: H;
  event: CaptureEvent;
  text: string;
  session_id?: string;
  cwd?: string;
  project?: string;
}

export interface CaptureHints {
  sessionId?: string;
  cwd?: string;
  hookEvent?: string;
}

export function cleanId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  if (value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

export function isSessionEndHook(hookEvent: string | undefined): boolean {
  return (hookEvent ?? '').replace(/[_-]/g, '').toLowerCase() === 'sessionend';
}

export function capturePayload<H extends string>(
  harness: H,
  event: CaptureEvent,
  text: string,
  sessionId: string | undefined,
  cwd: string | undefined,
): CapturePayload<H> | null {
  if (!text.trim() || Buffer.byteLength(text, 'utf-8') > CAPTURE_MAX_BYTES) return null;
  const body: CapturePayload<H> = { contract: 1, harness, event, text };
  if (sessionId) body.session_id = sessionId;
  if (cwd) body.cwd = cwd;
  const project = cwd ? basename(cwd) : '';
  if (project && project !== '/' && project !== '.') body.project = project;
  return body;
}

/** Bytes `recall capture` reads on stdin for this payload; the door's cap applies to this. */
export function payloadBytes(body: CapturePayload): number {
  return Buffer.byteLength(JSON.stringify(body), 'utf-8');
}

/** Fail-soft. A missing `recall` or a rejected payload must not fail the hook. */
export function runRecallCapture(body: CapturePayload): boolean {
  try {
    if (payloadBytes(body) > CAPTURE_MAX_BYTES) return false;
    const input = JSON.stringify(body);
    const result = spawnSync('recall', ['capture'], {
      input,
      encoding: 'utf-8',
      timeout: 15_000,
      // bun ignores a PATH change unless env is passed through.
      env: process.env,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}
