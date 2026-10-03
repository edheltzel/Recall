// Native omp extension: session_start → package-local `bun dist/index.js start`;
// session_stop → package-local `bun dist/index.js capture`.
// Self-contained — no src/ imports, no @oh-my-pi runtime import.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI_PATH = join(PACKAGE_ROOT, 'dist', 'index.js');
/** Capture child budget. Matches omp's generic extension-handler cap. */
export const CHILD_TIMEOUT_MS = 30_000;
/**
 * Inject child budget. omp awaits `session_start` before the session opens
 * (`ExtensionRunner.emit` + `initializeExtensions`), with a 30s host cap.
 * Stay well under that so a hung `recall start` cannot hold startup.
 */
export const START_CHILD_TIMEOUT_MS = 3_000;

export const MAX_OMP_STDIN_BYTES = 25 * 1024 * 1024;
export const OMP_SESSION_START_CUSTOM_TYPE = 'recall-memory.session-start';

export interface OmpSessionStopEvent {
  signal?: AbortSignal;
}

export type OmpSessionStartEvent = OmpSessionStopEvent;

export interface OmpExtensionContext {
  cwd: string;
  hasUI?: boolean;
  ui?: { notify: (message: string, type?: 'info' | 'warning' | 'error') => void };
  sessionManager: {
    getSessionId: () => string;
    getBranch: (fromId?: string) => unknown[];
  };
}

export interface OmpCustomMessage {
  customType?: string;
  content: string;
  display?: boolean;
}

export interface OmpExtensionAPI {
  on(
    event: 'session_start' | 'session_stop',
    handler: (event: OmpSessionStartEvent, ctx: OmpExtensionContext) => unknown,
  ): void;
  logger?: { warn: (message: string) => void };
  sendMessage?: (
    message: OmpCustomMessage,
    options?: { triggerTurn?: boolean },
  ) => void;
}

export type RunBoundedChild = (
  file: string,
  args: readonly string[],
  stdin: string,
  signal: AbortSignal,
) => Promise<number | null>;

export type RunBoundedChildCapture = (
  file: string,
  args: readonly string[],
  stdin: string,
  signal: AbortSignal,
  cwd?: string,
) => Promise<{ code: number | null; stdout: string }>;

function warn(ctx: OmpExtensionContext, pi: OmpExtensionAPI | undefined, message: string): void {
  try {
    if (ctx.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(message, 'warning');
      return;
    }
  } catch {
    // fall through to logger/stderr
  }
  try {
    pi?.logger?.warn(message);
  } catch {
    // ignore
  }
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    // ignore
  }
}

function spawnBounded(
  file: string,
  args: readonly string[],
  stdin: string,
  signal: AbortSignal,
  captureStdout: boolean,
  cwd?: string,
): Promise<{ code: number | null; stdout: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ code: number | null; stdout: string }>();
  let settled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const chunks: Buffer[] = [];

  const child = spawn(file, [...args], {
    stdio: ['pipe', captureStdout ? 'pipe' : 'ignore', 'ignore'],
    cwd,
  });

  const onAbort = () => {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 500);
  };

  const settle = (err: Error | null, code: number | null) => {
    if (settled) return;
    settled = true;
    signal.removeEventListener('abort', onAbort);
    clearTimeout(killTimer);
    const stdout = Buffer.concat(chunks).toString('utf8');
    if (err) reject(err);
    else resolve({ code, stdout });
  };

  child.stdout?.on('data', chunk => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  child.once('error', err => settle(err, null));
  child.once('close', code => settle(null, code));

  child.stdin?.on('error', () => {
    // EPIPE after kill / early exit — do not reject
  });
  child.stdin?.end(stdin, 'utf8');

  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });

  return promise;
}

/** Spawn a child, write stdin, honor abort (SIGTERM then SIGKILL). */
export function runBoundedChild(
  file: string,
  args: readonly string[],
  stdin: string,
  signal: AbortSignal,
): Promise<number | null> {
  return spawnBounded(file, args, stdin, signal, false).then(result => result.code);
}

export function runBoundedChildCapture(
  file: string,
  args: readonly string[],
  stdin: string,
  signal: AbortSignal,
  cwd?: string,
): Promise<{ code: number | null; stdout: string }> {
  return spawnBounded(file, args, stdin, signal, true, cwd);
}

function timedSignal(
  event: OmpSessionStartEvent,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  timer.unref();
  const signal = event.signal
    ? AbortSignal.any([event.signal, timeout.signal])
    : timeout.signal;
  return {
    signal,
    dispose: () => {
      clearTimeout(timer);
      timeout.abort();
    },
  };
}

const SKIP_ROLES: Record<string, true> = {
  developer: true, system: true, toolResult: true, bashExecution: true,
  pythonExecution: true, fileMention: true, hookMessage: true,
};

function ompMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    throw new Error('omp lifecycle capture received a malformed session entry');
  }
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      throw new Error('omp lifecycle capture received a malformed session entry');
    }
    const row = part as Record<string, unknown>;
    if (typeof row.type !== 'string' || !row.type) {
      throw new Error('omp lifecycle capture received a malformed session entry');
    }
    if (row.type !== 'text') continue;
    if (typeof row.text !== 'string') {
      throw new Error('omp lifecycle capture received a malformed session entry');
    }
    if (row.text) parts.push(row.text);
  }
  return parts.join('\n');
}

/** Ordered user/assistant text. Malformed branches throw so capture is not partial. */
function ompBranchText(entries: unknown): string {
  if (!Array.isArray(entries)) {
    throw new Error('omp lifecycle capture requires an entries array');
  }
  const parts: string[] = [];
  const seenIds = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('omp lifecycle capture received a malformed session entry');
    }
    const row = entry as Record<string, unknown>;
    if (typeof row.type !== 'string' || !row.type) {
      throw new Error('omp lifecycle capture received a malformed session entry');
    }
    const nativeId = typeof row.id === 'string' && row.id ? row.id : undefined;
    if (nativeId) {
      if (seenIds.has(nativeId)) {
        throw new Error('omp lifecycle capture received duplicate native ids');
      }
      seenIds.add(nativeId);
    }
    if (row.type !== 'message') continue;
    if (!nativeId || !row.message || typeof row.message !== 'object' || Array.isArray(row.message)) {
      throw new Error('omp lifecycle capture received a malformed session entry');
    }
    const message = row.message as Record<string, unknown>;
    if (typeof message.role !== 'string' || !message.role) {
      throw new Error('omp lifecycle capture received a malformed session entry');
    }
    if (Object.hasOwn(SKIP_ROLES, message.role)) continue;
    if (message.role !== 'user' && message.role !== 'assistant') {
      throw new Error('omp lifecycle capture received a malformed session entry');
    }
    const content = ompMessageText(message.content);
    if (!content.trim()) continue;
    parts.push(content);
  }
  return parts.join('\n\n');
}

function alreadyInjected(ctx: OmpExtensionContext): boolean {
  try {
    return ctx.sessionManager.getBranch().some(entry => (
      typeof entry === 'object'
      && entry !== null
      && 'type' in entry
      && entry.type === 'custom_message'
      && 'customType' in entry
      && entry.customType === OMP_SESSION_START_CUSTOM_TYPE
    ));
  } catch {
    return false;
  }
}

export async function injectOmpSessionStart(
  event: OmpSessionStartEvent,
  ctx: OmpExtensionContext,
  pi?: OmpExtensionAPI,
  runChild: RunBoundedChildCapture = runBoundedChildCapture,
  timeoutMs: number = START_CHILD_TIMEOUT_MS,
): Promise<void> {
  try {
    if (event.signal?.aborted) {
      warn(ctx, pi, 'Recall omp inject cancelled');
      return;
    }
    if (alreadyInjected(ctx)) return;
    if (!pi?.sendMessage) return;

    const timeout = timedSignal(event, timeoutMs);
    try {
      const result = await runChild('bun', [CLI_PATH, 'start'], '', timeout.signal, ctx.cwd);
      if (timeout.signal.aborted) {
        warn(ctx, pi, 'Recall omp inject cancelled');
        return;
      }
      if (result.code !== 0) {
        warn(ctx, pi, 'Recall omp inject failed');
        return;
      }
      const content = result.stdout.trimEnd();
      if (!content) return;
      pi.sendMessage(
        { customType: OMP_SESSION_START_CUSTOM_TYPE, content, display: false },
        { triggerTurn: false },
      );
    } finally {
      timeout.dispose();
    }
  } catch {
    warn(ctx, pi, 'Recall omp inject failed');
  }
}

export async function captureOmpSessionStop(
  event: OmpSessionStopEvent,
  ctx: OmpExtensionContext,
  pi?: OmpExtensionAPI,
  runChild: RunBoundedChild = runBoundedChild,
): Promise<void> {
  try {
    if (event.signal?.aborted) {
      warn(ctx, pi, 'Recall omp capture cancelled');
      return;
    }

    const sessionId = ctx.sessionManager.getSessionId();
    const entries = ctx.sessionManager.getBranch();
    if (!sessionId) {
      warn(ctx, pi, 'Recall omp capture failed');
      return;
    }

    const rawEntries = JSON.stringify(entries);
    if (Buffer.byteLength(rawEntries, 'utf8') > MAX_OMP_STDIN_BYTES) {
      warn(ctx, pi, 'Recall omp capture skipped: payload exceeds 25MiB');
      return;
    }

    const text = ompBranchText(entries);
    if (!text.trim()) return;

    const payload = JSON.stringify({
      contract: 1,
      harness: 'omp',
      event: 'turn_end',
      text,
      session_id: sessionId,
      cwd: ctx.cwd,
    });
    if (Buffer.byteLength(payload, 'utf8') > MAX_OMP_STDIN_BYTES) {
      warn(ctx, pi, 'Recall omp capture skipped: payload exceeds 25MiB');
      return;
    }

    const timeout = timedSignal(event, CHILD_TIMEOUT_MS);
    try {
      const code = await runChild('bun', [CLI_PATH, 'capture'], payload, timeout.signal);
      if (code === 0) return;
      warn(
        ctx,
        pi,
        timeout.signal.aborted ? 'Recall omp capture cancelled' : 'Recall omp capture failed',
      );
    } finally {
      timeout.dispose();
    }
  } catch {
    warn(ctx, pi, 'Recall omp capture failed');
  }
}

export default function recallOmpExtension(pi: OmpExtensionAPI): void {
  pi.on('session_start', (event, ctx) => injectOmpSessionStart(event, ctx, pi));
  pi.on('session_stop', (event, ctx) => captureOmpSessionStop(event, ctx, pi));
}
