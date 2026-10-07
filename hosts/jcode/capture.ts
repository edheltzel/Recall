// First-party Jcode capture helper. Speaks `recall capture` when the caller
// already has raw text. Does not read session files, install hooks, or watch
// transcripts. Self-contained: no src/ imports.
//
// Verified on jcode v0.91.0 (439a243bb): scalar [hooks] commands, turn_end
// assistant text truncated to 4000 chars, session_end has no body, no public
// watermark. `jcode session` has no history export.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export const JCODE_HARNESS = 'jcode';
export const JCODE_CAPTURE_CONTRACT = 1;
export const JCODE_CLI_PATH = join(PACKAGE_ROOT, 'dist', 'index.js');

const CHILD_TIMEOUT_MS = 30_000;

export type JcodeCaptureEvent = 'turn_end' | 'session_end';
export type JcodeCaptureSource = 'supplied' | 'host-history' | 'hook';
export type JcodeSkipReason =
  | 'missing-text'
  | 'unsafe-history'
  | 'no-public-watermark'
  | 'invalid-event';

export interface JcodeCaptureRequest {
  event?: string;
  text?: string;
  sessionId?: string;
  cwd?: string;
  project?: string;
  /** supplied: caller already has the text. host-history and hook are not safe without a watermark. */
  source?: JcodeCaptureSource;
  /** Present only when a public history cursor was proven. v1 hooks do not set this. */
  watermark?: string;
  /** Private session path. Never opened. */
  sessionFile?: string;
}

export interface JcodeInvoke {
  action: 'invoke';
  args: string[];
  stdin: string;
}

export interface JcodeSkip {
  action: 'skip';
  reason: JcodeSkipReason;
}

export type JcodeDecision = JcodeInvoke | JcodeSkip;

export type RunCapture = (
  file: string,
  args: readonly string[],
  stdin: string,
) => Promise<number | null>;

const CAPTURE_EVENTS: Record<string, true> = { turn_end: true, session_end: true };

export function jcodeSkipMessage(reason: JcodeSkipReason): string {
  switch (reason) {
    case 'missing-text':
      return 'Recall jcode capture skipped: no text supplied';
    case 'unsafe-history':
      return 'Recall jcode capture skipped: private session files are not read';
    case 'no-public-watermark':
      return 'Recall jcode capture skipped: Jcode has no public history watermark';
    case 'invalid-event':
      return 'Recall jcode capture skipped: event must be turn_end or session_end';
  }
}

export function decideJcodeCapture(input: JcodeCaptureRequest): JcodeDecision {
  if (input.sessionFile) return { action: 'skip', reason: 'unsafe-history' };

  const source = input.source ?? 'supplied';
  // ponytail: ignore hook payload and LAST_ASSISTANT_TEXT. Capture those only
  // after Jcode publishes a watermark field the hook actually sets.
  if ((source === 'hook' || source === 'host-history') && !input.watermark) {
    return { action: 'skip', reason: 'no-public-watermark' };
  }

  if (!input.event || !CAPTURE_EVENTS[input.event]) {
    return { action: 'skip', reason: 'invalid-event' };
  }
  if (!input.text || !input.text.trim()) {
    return { action: 'skip', reason: 'missing-text' };
  }

  const args = [
    'capture',
    '--contract',
    String(JCODE_CAPTURE_CONTRACT),
    '--harness',
    JCODE_HARNESS,
    '--event',
    input.event,
  ];
  if (input.sessionId) args.push('--session-id', input.sessionId);
  if (input.cwd) args.push('--cwd', input.cwd);
  if (input.project) args.push('--project', input.project);

  return { action: 'invoke', args, stdin: input.text };
}

/** Hook env only. Does not copy truncated assistant text or parse the payload. */
export function requestFromJcodeHook(
  env: Record<string, string | undefined>,
): JcodeCaptureRequest {
  return {
    source: 'hook',
    event: env.JCODE_HOOK_EVENT,
    sessionId: env.JCODE_HOOK_SESSION_ID,
    cwd: env.JCODE_HOOK_CWD,
  };
}

export function runCaptureChild(
  file: string,
  args: readonly string[],
  stdin: string,
): Promise<number | null> {
  const { promise, resolve, reject } = Promise.withResolvers<number | null>();
  const child = spawn(file, [...args], { stdio: ['pipe', 'ignore', 'inherit'] });
  const timer = setTimeout(() => {
    child.kill('SIGTERM');
  }, CHILD_TIMEOUT_MS);
  timer.unref();
  child.once('error', (err) => {
    clearTimeout(timer);
    reject(err);
  });
  child.once('close', (code) => {
    clearTimeout(timer);
    resolve(code);
  });
  child.stdin?.on('error', () => {
    // EPIPE after kill. Do not reject.
  });
  child.stdin?.end(stdin, 'utf8');
  return promise;
}

export async function captureJcode(
  input: JcodeCaptureRequest,
  run: RunCapture = runCaptureChild,
): Promise<JcodeDecision> {
  const decision = decideJcodeCapture(input);
  if (decision.action === 'skip') {
    process.stderr.write(`${jcodeSkipMessage(decision.reason)}\n`);
    return decision;
  }
  const code = await run('bun', [JCODE_CLI_PATH, ...decision.args], decision.stdin);
  if (code !== 0) process.stderr.write('Recall jcode capture failed\n');
  return decision;
}
