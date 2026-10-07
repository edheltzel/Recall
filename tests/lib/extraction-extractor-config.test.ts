import { describe, expect, test } from 'bun:test';
import { ExtractorConfigError, runFabricExtract } from '../../src/lib/extraction';

const absentHarness = () => ({
  query: { ok: true as const, absent: true as const },
  automatic: { ok: true as const, absent: true as const },
  curated: { ok: true as const, absent: true as const },
  cluster: { ok: true as const, absent: true as const },
});

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
      resolveHarness: absentHarness,
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
        resolveHarness: absentHarness,
      }),
    ).toThrow(ExtractorConfigError);
  });

  test('a present named curated failure does not call Fabric', () => {
    let extracted = false;
    expect(() => runFabricExtract('transcript', {
      resolveHarness: () => ({
        query: { ok: true, absent: true },
        automatic: { ok: true, absent: true },
        curated: {
          ok: true,
          absent: false,
          value: { primary: { kind: 'named', id: 'pi', model: 'luna' }, fallback: [] },
        },
        cluster: { ok: true, absent: true },
      }),
      extract: () => {
        extracted = true;
        return 'basic';
      },
      spawn: () => ({ ok: false, code: 'exit', message: 'failed' }),
    })).toThrow(ExtractorConfigError);
    expect(extracted).toBe(false);
  });
});
