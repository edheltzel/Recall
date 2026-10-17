import { describe, expect, test } from 'bun:test';
import {
  captureOmpSessionStop,
  dumpOmpSession,
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

  test('large tool output does not block capture of small conversation text', async () => {
    let stdin = '';
    await captureOmpSessionStop({}, uiCtx(() => {}, {
      sessionManager: {
        getSessionId: () => 'sess-tools',
        getBranch: () => [
          { type: 'message', id: 'u1', message: { role: 'user', content: 'keep this question' } },
          {
            type: 'message',
            id: 'r1',
            message: { role: 'toolResult', content: [{ type: 'text', text: 'x'.repeat(MAX_OMP_STDIN_BYTES) }] },
          },
        ],
      },
    }), undefined, async (_file, _args, childStdin) => {
      stdin = childStdin;
      return 0;
    });
    expect(JSON.parse(stdin).text).toBe('keep this question');
  });

  test('oversize conversation text is trimmed and still captured', async () => {
    const messages: string[] = [];
    let spawned = false;
    let stdin = '';
    const head = 'HEAD_KEEP_omp_capture';
    const tail = 'TAIL_KEEP_omp_capture';
    await captureOmpSessionStop(
      {},
      uiCtx((message) => messages.push(message), {
        sessionManager: {
          getSessionId: () => 'sess-big',
          getBranch: () => [
            {
              type: 'message',
              id: 'u1',
              message: { role: 'user', content: `${head}${'x'.repeat(MAX_OMP_STDIN_BYTES)}${tail}` },
            },
          ],
        },
      }),
      undefined,
      async (_file, _args, childStdin) => {
        spawned = true;
        stdin = childStdin;
        return 0;
      },
    );
    expect(spawned).toBe(true);
    expect(Buffer.byteLength(stdin, 'utf8')).toBeLessThanOrEqual(MAX_OMP_STDIN_BYTES);
    const payload = JSON.parse(stdin);
    expect(payload.text.startsWith(head)).toBe(true);
    expect(payload.text.endsWith(tail)).toBe(true);
    expect(payload.text).toContain('[Recall omp capture truncated]');
    expect(messages[0]).toMatch(/^Recall omp capture truncated: \d+ bytes dropped$/);
    expect(Number(messages[0].match(/(\d+)/)?.[1])).toBeGreaterThan(0);
  });

  test('escaped oversize text keeps head and tail, not only the marker', async () => {
    let stdin = '';
    const head = 'HEAD_ESC_omp';
    const tail = 'TAIL_ESC_omp';
    // Quote and backslash expand 2x in JSON. A plain char every third keeps a correct fit above half the limit.
    const unit = '"\\a';
    const content = `${head}${unit.repeat(Math.ceil(MAX_OMP_STDIN_BYTES * 0.7 / unit.length))}${tail}`;
    await captureOmpSessionStop(
      {},
      uiCtx(() => {}, {
        sessionManager: {
          getSessionId: () => 'sess-esc',
          getBranch: () => [
            { type: 'message', id: 'u1', message: { role: 'user', content } },
          ],
        },
      }),
      undefined,
      async (_file, _args, childStdin) => {
        stdin = childStdin;
        return 0;
      },
    );
    expect(Buffer.byteLength(stdin, 'utf8')).toBeLessThanOrEqual(MAX_OMP_STDIN_BYTES);
    const payload = JSON.parse(stdin);
    expect(payload.text.startsWith(head)).toBe(true);
    expect(payload.text.endsWith(tail)).toBe(true);
    expect(payload.text).toContain('[Recall omp capture truncated]');
    expect(payload.text.length).toBeGreaterThan(MAX_OMP_STDIN_BYTES / 2);
  });

  test('trim does not keep a secret fragment split off its password= key', async () => {
    let stdin = '';
    const secret = `k9Qx7mP2vL8nR4wT6yU0zA1bC3dE5fH7${'m'.repeat(180)}`;
    const cut = Math.floor(MAX_OMP_STDIN_BYTES * 0.6);
    const content = `${'x'.repeat(cut - 200)} password=${secret} ${'y'.repeat(MAX_OMP_STDIN_BYTES)}`;
    await captureOmpSessionStop(
      {},
      uiCtx(() => {}, {
        sessionManager: {
          getSessionId: () => 'sess-secret',
          getBranch: () => [{
            type: 'message',
            id: 'u1',
            message: { role: 'user', content },
          }],
        },
      }),
      undefined,
      async (_file, _args, childStdin) => {
        stdin = childStdin;
        return 0;
      },
    );
    expect(Buffer.byteLength(stdin, 'utf8')).toBeLessThanOrEqual(MAX_OMP_STDIN_BYTES);
    const text = JSON.parse(stdin).text as string;
    expect(text).toContain('[Recall omp capture truncated]');
    expect(text).toContain('[REDACTED:generic-assignment]');
    for (let index = 0; index + 12 <= secret.length; index++) {
      expect(text).not.toContain(secret.slice(index, index + 12));
    }
  }, 60_000);

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

  test('recall_dump writes nothing unless the user confirms in the UI', async () => {
    let spawned = 0;
    const child = async () => { spawned++; return 0; };
    const declined = await dumpOmpSession({ title: 't' }, uiCtx(() => {}, {
      ui: { notify: () => {}, confirm: async () => false },
    }), undefined, child);
    const headless = await dumpOmpSession({ title: 't' }, uiCtx(() => {}, { hasUI: false }), undefined, child);
    expect(spawned).toBe(0);
    expect(declined.content[0].text).toContain('declined');
    expect(headless.content[0].text).toContain('nothing was saved');
  });

  test('already cancelled dump skips confirmation and child dispatch', async () => {
    let confirmed = false;
    let spawned = false;
    const result = await dumpOmpSession({ title: 't' }, uiCtx(() => {}, {
      ui: { notify: () => {}, confirm: async () => { confirmed = true; return true; } },
    }), AbortSignal.abort(), async () => { spawned = true; return 0; });
    expect(confirmed).toBe(false);
    expect(spawned).toBe(false);
    expect(result.content[0].text).toBe('Recall dump cancelled');
  });

  test('abort dismisses pending confirmation and finishes the dump without spawning', async () => {
    const ac = new AbortController();
    const confirmation = Promise.withResolvers<boolean>();
    let dialogOpen = false;
    let spawned = false;
    const pending = dumpOmpSession({ title: 't' }, uiCtx(() => {}, {
      ui: {
        notify: () => {},
        confirm: (_title, _message, options) => {
          dialogOpen = true;
          options?.signal?.addEventListener('abort', () => {
            dialogOpen = false;
            confirmation.resolve(false);
          }, { once: true });
          return confirmation.promise;
        },
      },
    }), ac.signal, async () => { spawned = true; return 0; });
    try {
      expect(dialogOpen).toBe(true);
      ac.abort();
      expect(dialogOpen).toBe(false);
      const result = await pending;
      expect(spawned).toBe(false);
      expect(result.content[0].text).toBe('Recall dump cancelled');
    } finally {
      ac.abort();
      confirmation.resolve(false);
      await pending;
    }
  });

  test.each(['approve', 'reject'] as const)('cancellation takes precedence when confirmation settles with %s', async outcome => {
    const ac = new AbortController();
    let spawned = false;
    const result = await dumpOmpSession({ title: 't' }, uiCtx(() => {}, {
      ui: {
        notify: () => {},
        confirm: async () => {
          ac.abort();
          if (outcome === 'reject') throw ac.signal.reason;
          return true;
        },
      },
    }), ac.signal, async () => { spawned = true; return 0; });
    expect(spawned).toBe(false);
    expect(result.content[0].text).toBe('Recall dump cancelled');
  });

  test.each(['capture', 'dump'] as const)('%s skips child dispatch when branch reading aborts the signal', async action => {
    const ac = new AbortController();
    const messages: string[] = [];
    let spawned = false;
    const ctx = uiCtx(message => messages.push(message), {
      ui: { notify: message => messages.push(message), confirm: async () => true },
      sessionManager: {
        getSessionId: () => 'sess-cancelled',
        getBranch: () => {
          ac.abort();
          return [{ type: 'message', id: 'u1', message: { role: 'user', content: 'hi' } }];
        },
      },
    });
    const child = async () => { spawned = true; return 0; };
    if (action === 'capture') {
      await captureOmpSessionStop({ signal: ac.signal }, ctx, undefined, child);
      expect(messages).toEqual(['Recall omp capture cancelled']);
    } else {
      const result = await dumpOmpSession({ title: 't' }, ctx, ac.signal, child);
      expect(result.content[0].text).toBe('Recall dump cancelled');
    }
    expect(spawned).toBe(false);
  });

  test('already cancelled bounded child never attempts to execute a missing command', async () => {
    await expect(runBoundedChild(
      `${import.meta.dir}/missing-omp-child`,
      [],
      '',
      AbortSignal.abort(),
    )).resolves.toBeNull();
  });
});
