import { describe, expect, test } from 'bun:test';
import recallOmpExtension, {
  captureOmpSessionStop,
  CHILD_TIMEOUT_MS,
  injectOmpSessionStart,
  MAX_OMP_STDIN_BYTES,
  OMP_SESSION_START_CUSTOM_TYPE,
  runBoundedChild,
  START_CHILD_TIMEOUT_MS,
  type OmpExtensionAPI,
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

  test('session_stop sends ordered branch text through recall capture', async () => {
    let args: readonly string[] = [];
    let stdin = '';
    await captureOmpSessionStop({}, uiCtx(() => {}, {
      sessionManager: {
        getSessionId: () => 'sess-order',
        getBranch: () => [
          { type: 'message', id: 'u1', message: { role: 'user', content: 'first leaf' } },
          { type: 'tool', id: 't1' },
          {
            type: 'message',
            id: 'a1',
            message: { role: 'assistant', content: [{ type: 'text', text: 'second leaf' }] },
          },
        ],
      },
    }), undefined, async (_file, childArgs, childStdin) => {
      args = childArgs;
      stdin = childStdin;
      return 0;
    });
    expect(args[0]?.endsWith('/dist/index.js')).toBe(true);
    expect(args[0]).not.toContain('/hosts/dist/');
    expect(args[1]).toBe('capture');
    expect(args).not.toContain('host-hook');
    const payload = JSON.parse(stdin);
    expect(payload).toMatchObject({
      contract: 1,
      harness: 'omp',
      event: 'turn_end',
      session_id: 'sess-order',
      cwd: '/work/Recall',
    });
    expect(payload.text.indexOf('first leaf')).toBeLessThan(payload.text.indexOf('second leaf'));
    expect(payload.text).not.toContain('t1');
  });

  test('malformed branch does not spawn', async () => {
    const messages: string[] = [];
    let spawned = false;
    await captureOmpSessionStop({}, uiCtx(message => messages.push(message), {
      sessionManager: {
        getSessionId: () => 'sess-bad',
        getBranch: () => [null],
      },
    }), undefined, async () => {
      spawned = true;
      return 0;
    });
    expect(spawned).toBe(false);
    expect(messages).toEqual(['Recall omp capture failed']);
  });

  test('headless failure writes stderr and logger, not notify', async () => {
    const logs: string[] = [];
    const ctx: OmpExtensionContext = {
      cwd: '/work',
      hasUI: false,
      sessionManager: {
        getSessionId: () => 'sess-1',
        getBranch: () => [{ type: 'message', id: 'a', message: { role: 'user', content: 'hi' } }],
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

  test('session_start runs recall start and sendMessage with the markdown', async () => {
    const sent: Array<{ content: string; customType?: string; display?: boolean }> = [];
    const spawned: Array<{ file: string; args: readonly string[]; stdin: string; cwd?: string }> = [];
    await injectOmpSessionStart(
      {},
      uiCtx(() => {}),
      {
        on() {},
        sendMessage(message) {
          sent.push(message);
        },
      },
      async (file, args, stdin, _signal, cwd) => {
        spawned.push({ file, args, stdin, cwd });
        return { code: 0, stdout: '## Recall — Session Memory (tiered)\n**Project:** Recall\n' };
      },
    );
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.file).toBe('bun');
    expect(spawned[0]?.args[0]).toMatch(/dist\/index\.js$/);
    expect(spawned[0]?.args[0]).not.toContain('/hosts/dist/');
    expect(spawned[0]?.args[1]).toBe('start');
    expect(spawned[0]?.args).not.toContain('host-hook');
    expect(spawned[0]?.stdin).toBe('');
    expect(spawned[0]?.cwd).toBe('/work/Recall');
    expect(sent).toEqual([{
      customType: OMP_SESSION_START_CUSTOM_TYPE,
      content: '## Recall — Session Memory (tiered)\n**Project:** Recall',
      display: false,
    }]);
  });

  test('session_start skips sendMessage when the custom type is already on the branch', async () => {
    let spawned = false;
    const sent: unknown[] = [];
    await injectOmpSessionStart(
      {},
      uiCtx(() => {}, {
        sessionManager: {
          getSessionId: () => 'sess-1',
          getBranch: () => [{ type: 'custom_message', customType: OMP_SESSION_START_CUSTOM_TYPE }],
        },
      }),
      {
        on() {},
        sendMessage(message) {
          sent.push(message);
        },
      },
      async () => {
        spawned = true;
        return { code: 0, stdout: 'should not send' };
      },
    );
    expect(spawned).toBe(false);
    expect(sent).toEqual([]);
  });

  test('session_start nonzero child warns and does not sendMessage', async () => {
    const messages: string[] = [];
    const sent: unknown[] = [];
    await injectOmpSessionStart(
      {},
      uiCtx(message => messages.push(message)),
      {
        on() {},
        sendMessage(message) {
          sent.push(message);
        },
      },
      async () => ({ code: 1, stdout: '## Recall — should not leak' }),
    );
    expect(messages).toEqual(['Recall omp inject failed']);
    expect(sent).toEqual([]);
  });

  test('session_start child bound is shorter than capture', () => {
    expect(START_CHILD_TIMEOUT_MS).toBe(3_000);
    expect(CHILD_TIMEOUT_MS).toBe(30_000);
    expect(START_CHILD_TIMEOUT_MS).toBeLessThan(CHILD_TIMEOUT_MS);
  });

  test('hanging recall start times out, warns, and does not sendMessage', async () => {
    const messages: string[] = [];
    const sent: unknown[] = [];
    await injectOmpSessionStart(
      {},
      uiCtx(message => messages.push(message)),
      {
        on() {},
        sendMessage(message) {
          sent.push(message);
        },
      },
      (_file, _args, _stdin, signal) => {
        const { promise, resolve } = Promise.withResolvers<{ code: number | null; stdout: string }>();
        signal.addEventListener('abort', () => resolve({ code: null, stdout: '' }), { once: true });
        return promise;
      },
      20,
    );
    expect(messages).toEqual(['Recall omp inject cancelled']);
    expect(sent).toEqual([]);
  });

  test('the extension factory registers session_start and session_stop', () => {
    const events: string[] = [];
    const pi: OmpExtensionAPI = {
      on(event) {
        events.push(event);
      },
    };
    recallOmpExtension(pi);
    expect(events).toEqual(['session_start', 'session_stop']);
  });
});
