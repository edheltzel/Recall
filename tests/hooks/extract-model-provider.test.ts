import { describe, expect, test } from 'bun:test';
import { runExtractionCascade } from '../../hooks/lib/extract-model';
import { resolveQueryHarness } from '../../src/lib/query-harness';
import type { ExtractionProvider } from '../../hooks/lib/extraction-provider';

const absentHarness = () => ({
  query: { ok: true as const, absent: true as const },
  automatic: { ok: true as const, absent: true as const },
  curated: { ok: true as const, absent: true as const },
  cluster: { ok: true as const, absent: true as const },
});

describe('host-neutral extraction cascade', () => {
  test('tries injected providers in order without knowing their commands or auth', async () => {
    const calls: string[] = [];
    const providers: ExtractionProvider[] = [
      { id: 'first-host', extract: () => { calls.push('first-host'); return null; } },
      { id: 'second-host', extract: () => { calls.push('second-host'); return 'portable extraction'; } },
      { id: 'unused', extract: () => { calls.push('unused'); return 'wrong'; } },
    ];

    expect(await runExtractionCascade('session text', providers)).toBe('portable extraction');
    expect(calls).toEqual(['first-host', 'second-host']);
  });

  test('builds the automatic cascade from resolved config', async () => {
    const calls: string[] = [];
    const factories = {
      'claude-cli': (model: string) => ({
        id: 'claude-cli',
        extract: () => {
          calls.push(`claude-cli:${model}`);
          return null;
        },
      }),
      ollama: (model: string) => ({
        id: 'ollama',
        extract: () => {
          calls.push(`ollama:${model}`);
          return `ok:${model}`;
        },
      }),
    };
    expect(
      await runExtractionCascade(
        'session text',
        undefined,
        () => ({
          automatic: {
            ok: true,
            value: {
              primary: { id: 'claude-cli', model: 'haiku' },
              fallback: [{ id: 'ollama', model: 'qwen2.5:3b' }],
            },
          },
          curated: { ok: true, value: { primary: { id: 'fabric', model: 'claude-haiku-4-5' } } },
        }),
        factories,
        absentHarness,
      ),
    ).toBe('ok:qwen2.5:3b');
    expect(calls).toEqual(['claude-cli:haiku', 'ollama:qwen2.5:3b']);
  });

  test('fail-closed automatic config emits the path error and extracts nothing', async () => {
    const logged: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };
    try {
      expect(
        await runExtractionCascade('session text', undefined, () => ({
          automatic: { ok: false, error: 'automatic Extractor id "fabric" is not allowed' },
          curated: { ok: true, value: { primary: { id: 'fabric', model: 'claude-haiku-4-5' } } },
        }), undefined, absentHarness),
      ).toBeNull();
    } finally {
      console.error = originalError;
    }
    expect(logged.some(line => line.includes('automatic Extractor id "fabric" is not allowed'))).toBe(true);
  });

  test('a named automatic step sends the prepared prompt and a failure tries the next step', async () => {
    const inputs: string[] = [];
    const long = '## ONE SENTENCE SUMMARY\nA prepared extraction that is long enough to pass the provider length check.\n\n## MAIN IDEAS\n- kept the prompt';
    const result = await runExtractionCascade(
      'raw transcript',
      undefined,
      () => ({
        automatic: { ok: true, value: { primary: { id: 'claude-cli', model: 'haiku' }, fallback: [] } },
        curated: { ok: true, value: { primary: { id: 'fabric', model: 'claude-haiku-4-5' } } },
      }),
      undefined,
      () => ({
        query: { ok: true, absent: true },
        automatic: {
          ok: true,
          absent: false,
          value: {
            primary: { kind: 'named', id: 'pi', model: 'luna' },
            fallback: [{ kind: 'named', id: 'claude', model: 'haiku' }],
          },
        },
        curated: { ok: true, absent: true },
        cluster: { ok: true, absent: true },
      }),
      (request) => {
        inputs.push(request.stdin);
        if (inputs.length === 1) return { ok: false, code: 'exit', message: 'failed' };
        return { ok: true, stdout: long };
      },
      {
        pi: () => ({ executable: 'pi', argv: ['--print'] }),
        claude: () => ({ executable: 'claude', argv: ['-p'] }),
      },
    );
    expect(inputs[0]).toContain('ONE SENTENCE SUMMARY');
    expect(inputs[0]).toContain('raw transcript');
    expect(inputs[0]).not.toBe('raw transcript');
    expect(result).toBe(long);
  });

  test('a Pi query sends only the question while Claude extraction keeps its prompt', async () => {
    let queryStdin = '';
    let queryArgv: string[] = [];
    const answer = await resolveQueryHarness('what changed', {
      fileText: JSON.stringify({ query: { primary: { id: 'pi', model: 'sonnet' } } }),
      spawn: (request) => {
        queryStdin = request.stdin;
        queryArgv = request.argv;
        return { ok: true, stdout: 'pi answer' };
      },
    });
    const extracted: string[] = [];
    const long = '## ONE SENTENCE SUMMARY\nA prepared extraction that is long enough to pass the provider length check.\n\n## MAIN IDEAS\n- kept the prompt';
    const result = await runExtractionCascade(
      'raw transcript',
      undefined,
      () => ({
        automatic: { ok: true, value: { primary: { id: 'claude-cli', model: 'haiku' }, fallback: [] } },
        curated: { ok: true, value: { primary: { id: 'fabric', model: 'claude-haiku-4-5' } } },
      }),
      undefined,
      () => ({
        query: { ok: true, absent: true },
        automatic: {
          ok: true,
          absent: false,
          value: { primary: { kind: 'named', id: 'claude', model: 'haiku' }, fallback: [] },
        },
        curated: { ok: true, absent: true },
        cluster: { ok: true, absent: true },
      }),
      (request) => {
        extracted.push(request.stdin);
        return { ok: true, stdout: long };
      },
    );
    expect(answer).toEqual({ kind: 'text', text: 'pi answer' });
    expect(queryStdin).toBe('what changed');
    expect(queryArgv).toEqual(['--print', '--model', 'sonnet']);
    expect(extracted[0]).toContain('ONE SENTENCE SUMMARY');
    expect(extracted[0]).toContain('raw transcript');
    expect(extracted[0]).not.toBe('what changed');
    expect(result).toBe(long);
  });
});
