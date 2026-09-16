import { describe, expect, test } from 'bun:test';
import { runExtractionCascade } from '../../hooks/lib/extract-model';
import type { ExtractionProvider } from '../../hooks/lib/extraction-provider';

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
        })),
      ).toBeNull();
    } finally {
      console.error = originalError;
    }
    expect(logged.some(line => line.includes('automatic Extractor id "fabric" is not allowed'))).toBe(true);
  });
});
