import { describe, expect, test } from 'bun:test';
import { ExtractorConfigError, runFabricExtract } from '../../src/lib/extraction';

describe('curated Extractor wiring', () => {
  test('runFabricExtract uses the resolved fabric model', () => {
    const calls: string[] = [];
    const text = runFabricExtract('transcript', {
      resolve: () => ({
        automatic: { ok: true, value: { primary: { id: 'claude-cli', model: 'haiku' }, fallback: [] } },
        curated: { ok: true, value: { primary: { id: 'fabric', model: 'env-fabric' } } },
      }),
      extract: (content, model) => {
        calls.push(`${model}:${content}`);
        return `wisdom:${model}`;
      },
    });
    expect(text).toBe('wisdom:env-fabric');
    expect(calls).toEqual(['env-fabric:transcript']);
  });

  test('runFabricExtract fails closed on illegal curated id', () => {
    expect(() =>
      runFabricExtract('transcript', {
        resolve: () => ({
          automatic: { ok: true, value: { primary: { id: 'claude-cli', model: 'haiku' }, fallback: [] } },
          curated: { ok: false, error: 'curated Extractor id "ollama" is not allowed' },
        }),
        extract: () => 'should-not-run',
      }),
    ).toThrow(ExtractorConfigError);
  });
});
