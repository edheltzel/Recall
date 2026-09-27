import { describe, expect, test } from 'bun:test';
import {
  captureOmpSessionStop,
  MAX_OMP_STDIN_BYTES,
  runBoundedChild,
  type OmpExtensionContext,
} from '../hosts/omp/recall';

function uiCtx(
  notify: (message: string, type?: string) => void,
  extras: Partial<OmpExtensionContext> = {},
): OmpExtensionContext {
  return {
    cwd: '/work/Recall',
    hasUI: true,
    ui: { notify },
    sessionManager: {
      getSessionId: () => 'sess-1',
      getBranch: () => [{ type: 'message', id: 'a', message: { role: 'user', content: 'hi' } }],
    },
    ...extras,
  };
}

describe('omp native extension', () => {
  test('nonzero child warns via ui.notify without transcript', async () => {
    const messages: string[] = [];
    await captureOmpSessionStop({}, uiCtx((message) => messages.push(message)), undefined, async () => 1);
    expect(messages).toEqual(['Recall omp capture failed']);
    expect(messages.join('')).not.toContain('hi');
  });

  test('oversize payload warns and does not spawn', async () => {
    const messages: string[] = [];
    let spawned = false;
    await captureOmpSessionStop(
      {},
      uiCtx((message) => messages.push(message), {
        sessionManager: {
          getSessionId: () => 'sess-big',
          getBranch: () => [{ pad: 'x'.repeat(MAX_OMP_STDIN_BYTES) }],
        },
      }),
      undefined,
      async () => {
        spawned = true;
        return 0;
      },
    );
    expect(spawned).toBe(false);
    expect(messages).toEqual(['Recall omp capture skipped: payload exceeds 25MiB']);
  });

  test('headless failure writes stderr and logger, not notify', async () => {
    const logs: string[] = [];
    const ctx: OmpExtensionContext = {
      cwd: '/work',
      hasUI: false,
      sessionManager: {
        getSessionId: () => 'sess-1',
        getBranch: () => [],
      },
    };
    const stderrWrite = process.stderr.write.bind(process.stderr);
    let stderr = '';
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stderr.write;
    try {
      await captureOmpSessionStop(
        {},
        ctx,
        { on() {}, logger: { warn: message => logs.push(message) } },
        async () => 1,
      );
    } finally {
      process.stderr.write = stderrWrite;
    }
    expect(logs).toEqual(['Recall omp capture failed']);
    expect(stderr).toContain('Recall omp capture failed');
  });

  test('aborted signal skips spawn and warns cancelled', async () => {
    const messages: string[] = [];
    let spawned = false;
    const ac = new AbortController();
    ac.abort();
    await captureOmpSessionStop(
      { signal: ac.signal },
      uiCtx((message) => messages.push(message)),
      undefined,
      async () => {
        spawned = true;
        return 0;
      },
    );
    expect(spawned).toBe(false);
    expect(messages).toEqual(['Recall omp capture cancelled']);
  });

  test('hung child is killed by abort and does not hang', async () => {
    // Real subprocess SIGTERM: fake timers cannot kill a bun child.
    const ac = new AbortController();
    const pending = runBoundedChild(
      process.execPath,
      ['-e', 'await Bun.sleep(60_000)'],
      '',
      ac.signal,
    );
    ac.abort();
    const code = await pending;
    expect(code).not.toBe(0);
  });

  test('in-flight abort cancels a hung runChild', async () => {
    const messages: string[] = [];
    const ac = new AbortController();
    await captureOmpSessionStop(
      { signal: ac.signal },
      uiCtx(message => messages.push(message)),
      undefined,
      (_file, _args, _stdin, signal) => {
        const { promise, resolve } = Promise.withResolvers<number | null>();
        signal.addEventListener('abort', () => resolve(null), { once: true });
        ac.abort();
        return promise;
      },
    );
    expect(messages).toEqual(['Recall omp capture cancelled']);
  });
});
