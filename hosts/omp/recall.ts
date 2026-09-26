// Native omp extension: session_stop → package-local `bun dist/index.js host-hook omp`.
// Self-contained — no src/ imports, no @oh-my-pi runtime import.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI_PATH = join(PACKAGE_ROOT, 'dist', 'index.js');
const CHILD_TIMEOUT_MS = 30_000;

export const MAX_OMP_STDIN_BYTES = 25 * 1024 * 1024;

export interface OmpSessionStopEvent {
  signal?: AbortSignal;
}

export interface OmpExtensionContext {
  cwd: string;
  hasUI?: boolean;
  ui?: { notify: (message: string, type?: 'info' | 'warning' | 'error') => void };
  sessionManager: {
    getSessionId: () => string;
    getBranch: (fromId?: string) => unknown[];
  };
}

export interface OmpExtensionAPI {
  on(
    event: 'session_stop',
    handler: (event: OmpSessionStopEvent, ctx: OmpExtensionContext) => unknown,
  ): void;
  logger?: { warn: (message: string) => void };
}

export type RunBoundedChild = (
  file: string,
  args: readonly string[],
  stdin: string,
  signal: AbortSignal,
) => Promise<number | null>;

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

/** Spawn a child, write stdin, honor abort (SIGTERM then SIGKILL). */
export function runBoundedChild(
  file: string,
  args: readonly string[],
  stdin: string,
  signal: AbortSignal,
): Promise<number | null> {
  const { promise, resolve, reject } = Promise.withResolvers<number | null>();
  let settled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const child = spawn(file, [...args], {
    stdio: ['pipe', 'ignore', 'ignore'],
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
    if (err) reject(err);
    else resolve(code);
  };

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

    const payload = JSON.stringify({
      hook_event_name: 'session_stop',
      session_id: sessionId,
      cwd: ctx.cwd,
      entries,
    });

    if (Buffer.byteLength(payload, 'utf8') > MAX_OMP_STDIN_BYTES) {
      warn(ctx, pi, 'Recall omp capture skipped: payload exceeds 25MiB');
      return;
    }

    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), CHILD_TIMEOUT_MS);
    timer.unref();
    const signal = event.signal
      ? AbortSignal.any([event.signal, timeout.signal])
      : timeout.signal;

    try {
      const code = await runChild('bun', [CLI_PATH, 'host-hook', 'omp'], payload, signal);
      if (code === 0) return;
      warn(
        ctx,
        pi,
        signal.aborted ? 'Recall omp capture cancelled' : 'Recall omp capture failed',
      );
    } finally {
      clearTimeout(timer);
      timeout.abort();
    }
  } catch {
    warn(ctx, pi, 'Recall omp capture failed');
  }
}

export default function recallOmpExtension(pi: OmpExtensionAPI): void {
  pi.on('session_stop', (event, ctx) => captureOmpSessionStop(event, ctx, pi));
}
