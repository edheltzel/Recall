import { describe, expect, test } from 'bun:test';
import type { HarnessStep, NamedHarnessId } from '../../hooks/lib/extractor-config';
import { runHarnessStep, runHarnessStepAsync, type SpawnFn } from '../../hooks/lib/harness-runner';

const proven = {
  pi: (model: string) => ({ executable: 'pi', argv: ['--model', model] }),
};

function named(model = ''): HarnessStep {
  return { kind: 'named', id: 'pi', model };
}

describe('runHarnessStep', () => {
  test('a proven named id sends stdin and returns trimmed stdout', () => {
    const calls: Array<{ executable: string; argv: string[]; stdin: string }> = [];
    const spawn: SpawnFn = (request) => {
      calls.push(request);
      return { ok: true, stdout: '  answer  ' };
    };
    const result = runHarnessStep({
      step: named('luna'),
      stdin: 'question',
      timeoutMs: 30000,
      spawn,
      proven,
    });
    expect(result).toEqual({ ok: true, text: 'answer' });
    expect(calls).toEqual([{ executable: 'pi', argv: ['--model', 'luna'], stdin: 'question', timeoutMs: 30000 }]);
  });

  test('an unproven named id fails and does not spawn', () => {
    let spawned = false;
    const spawn: SpawnFn = () => {
      spawned = true;
      return { ok: true, stdout: 'nope' };
    };
    const result = runHarnessStep({
      step: { kind: 'named', id: 'jcode' as NamedHarnessId, model: 'x' },
      stdin: 'question',
      timeoutMs: 30000,
      spawn,
      proven,
    });
    expect(result.ok).toBe(false);
    expect(spawned).toBe(false);
  });

  test('a blank model is replaced with the Recall default', () => {
    let seen = '';
    const spawn: SpawnFn = (request) => {
      seen = request.argv[1];
      return { ok: true, stdout: 'ok' };
    };
    runHarnessStep({
      step: named(''),
      stdin: 'question',
      timeoutMs: 30000,
      spawn,
      proven,
      defaults: { pi: 'recall-pi' },
    });
    expect(seen).toBe('recall-pi');
  });

  test('a non-TTY missing binary fails and does not prompt', () => {
    let prompts = 0;
    const result = runHarnessStep({
      step: { kind: 'command', label: 'pi', argv: ['pi', '--print'], model: '' },
      stdin: 'question',
      timeoutMs: 30000,
      isTTY: false,
      readPath: () => {
        prompts += 1;
        return '/tmp/pi';
      },
      spawn: () => ({ ok: false, code: 'missing', message: 'not found' }),
    });
    expect(result.ok).toBe(false);
    expect(prompts).toBe(0);
  });
  test('a TTY path is the executable for one retry and is not echoed', () => {
    const secret = '/tmp/secret-pi-path';
    const calls: string[] = [];
    let attempt = 0;
    const result = runHarnessStep({
      step: { kind: 'command', label: '', argv: ['pi', '--print'], model: '' },
      stdin: 'question',
      timeoutMs: 30000,
      isTTY: true,
      readPath: () => secret,
      spawn: (request) => {
        calls.push(request.executable);
        attempt += 1;
        if (attempt === 1) return { ok: false, code: 'missing', message: 'not found' };
        return { ok: false, code: 'exit', message: `spawn ${secret} failed` };
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain(secret);
    expect(calls).toEqual(['pi', secret]);
  });

  test('a blank path fails the step', () => {
    const result = runHarnessStep({
      step: { kind: 'command', label: '', argv: ['pi'], model: '' },
      stdin: 'question',
      timeoutMs: 30000,
      isTTY: true,
      readPath: () => '  ',
      spawn: () => ({ ok: false, code: 'missing', message: 'not found' }),
    });
    expect(result.ok).toBe(false);
  });

  test('the path retry does not join argv into a shell string', () => {
    const calls: Array<{ executable: string; argv: string[] }> = [];
    let attempt = 0;
    runHarnessStep({
      step: { kind: 'command', label: '', argv: ['echo hi; rm -rf /', '--flag'], model: '' },
      stdin: 'question',
      timeoutMs: 30000,
      isTTY: true,
      readPath: () => '/usr/bin/echo',
      spawn: (request) => {
        calls.push({ executable: request.executable, argv: request.argv });
        attempt += 1;
        return attempt === 1
          ? { ok: false, code: 'missing', message: 'not found' }
          : { ok: true, stdout: 'ok' };
      },
    });
    expect(calls[1]).toEqual({ executable: '/usr/bin/echo', argv: ['--flag'] });
  });


  test('non-zero exit, timeout, and empty stdout fail', () => {
    for (const code of ['exit', 'timeout', 'empty'] as const) {
      const result = runHarnessStep({
        step: { kind: 'command', label: '', argv: ['pi'], model: '' },
        stdin: 'question',
        timeoutMs: 30000,
        spawn: () => ({ ok: false, code, message: code }),
      });
      expect(result.ok).toBe(false);
    }
  });

  test('a command argv is not passed through a shell', () => {
    let argv: string[] = [];
    runHarnessStep({
      step: { kind: 'command', label: 'x', argv: ['tool', 'a b', 'c;d'], model: '' },
      stdin: 'question',
      timeoutMs: 30000,
      spawn: (request) => {
        argv = request.argv;
        return { ok: true, stdout: 'ok' };
      },
    });
    expect(argv).toEqual(['a b', 'c;d']);
  });

  test('an async command step writes stdin to the child', async () => {
    const result = await runHarnessStepAsync({
      step: { kind: 'command', label: 'cat', argv: ['/bin/cat'], model: '' },
      stdin: 'question only\n',
      timeoutMs: 5000,
      isTTY: false,
    });
    expect(result).toEqual({ ok: true, text: 'question only' });
  });

  test('a named claude step uses the print contract without an injected caller', () => {
    let argv: string[] = [];
    let cleared = false;
    const result = runHarnessStep({
      step: { kind: 'named', id: 'claude', model: '' },
      stdin: 'question',
      timeoutMs: 30000,
      isTTY: false,
      spawn: (request) => {
        argv = request.argv;
        cleared = request.env?.CLAUDECODE === '';
        return { ok: true, stdout: 'answer' };
      },
    });
    expect(result).toEqual({ ok: true, text: 'answer' });
    expect(argv).toEqual(['-p', '--model', 'haiku', '--output-format', 'text', '--setting-sources', '']);
    expect(cleared).toBe(true);
  });

  test('a named codex step reads stdin through exec without an injected caller', () => {
    let argv: string[] = [];
    const result = runHarnessStep({
      step: { kind: 'named', id: 'codex', model: 'gpt-5' },
      stdin: 'question',
      timeoutMs: 30000,
      isTTY: false,
      spawn: (request) => {
        argv = request.argv;
        return { ok: true, stdout: 'answer' };
      },
    });
    expect(result).toEqual({ ok: true, text: 'answer' });
    expect(argv).toEqual(['exec', '-m', 'gpt-5', '-']);
  });

  test('a named pi step sends the question on stdin without an injected caller', () => {
    let stdin = '';
    let argv: string[] = [];
    const result = runHarnessStep({
      step: { kind: 'named', id: 'pi', model: 'sonnet' },
      stdin: 'what changed',
      timeoutMs: 30000,
      isTTY: false,
      spawn: (request) => {
        stdin = request.stdin;
        argv = request.argv;
        return { ok: true, stdout: 'pi answer' };
      },
    });
    expect(result).toEqual({ ok: true, text: 'pi answer' });
    expect(stdin).toBe('what changed');
    expect(argv).toEqual(['--print', '--model', 'sonnet']);
  });
});
