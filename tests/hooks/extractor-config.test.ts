import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { defaultExtractorConfigPath, resolveExtractorConfig, resolveHarnessConfig } from '../../hooks/lib/extractor-config';

describe('resolveExtractorConfig', () => {
  test('missing file uses split defaults', () => {
    const resolved = resolveExtractorConfig({ fileText: null, env: {} });
    expect(resolved.automatic).toEqual({
      ok: true,
      value: {
        primary: { id: 'claude-cli', model: 'haiku' },
        fallback: [{ id: 'ollama', model: 'qwen2.5:3b' }],
      },
    });
    expect(resolved.curated).toEqual({
      ok: true,
      value: { primary: { id: 'fabric', model: 'claude-haiku-4-5' } },
    });
  });

  test('unparseable JSON fails both paths', () => {
    const resolved = resolveExtractorConfig({ fileText: '{', env: {} });
    expect(resolved.automatic.ok).toBe(false);
    expect(resolved.curated.ok).toBe(false);
  });

  test('fabric on automatic fails automatic only', () => {
    const resolved = resolveExtractorConfig({
      fileText: JSON.stringify({
        extractor: { automatic: { id: 'fabric', model: 'claude-haiku-4-5' } },
      }),
      env: {},
    });
    expect(resolved.automatic.ok).toBe(false);
    if (resolved.automatic.ok) throw new Error('expected automatic failure');
    expect(resolved.automatic.error).toContain('fabric');
    expect(resolved.curated.ok).toBe(true);
  });

  test('claude-cli on curated fails curated only', () => {
    const resolved = resolveExtractorConfig({
      fileText: JSON.stringify({
        extractor: { curated: { id: 'claude-cli', model: 'haiku' } },
      }),
      env: {},
    });
    expect(resolved.curated.ok).toBe(false);
    expect(resolved.automatic.ok).toBe(true);
  });

  test('illegal fallback id fails automatic', () => {
    const resolved = resolveExtractorConfig({
      fileText: JSON.stringify({
        extractor: {
          automatic: {
            id: 'claude-cli',
            fallback: [{ id: 'fabric', model: 'claude-haiku-4-5' }],
          },
        },
      }),
      env: {},
    });
    expect(resolved.automatic.ok).toBe(false);
    expect(resolved.curated.ok).toBe(true);
  });

  test('RECALL_FABRIC_MODEL overrides curated model', () => {
    const resolved = resolveExtractorConfig({
      fileText: JSON.stringify({
        extractor: { curated: { id: 'fabric', model: 'file-model' } },
      }),
      env: { RECALL_FABRIC_MODEL: 'env-fabric' },
    });
    expect(resolved.curated).toEqual({
      ok: true,
      value: { primary: { id: 'fabric', model: 'env-fabric' } },
    });
  });

  test('Recall_OLLAMA_MODEL overrides ollama steps only', () => {
    const resolved = resolveExtractorConfig({
      fileText: JSON.stringify({
        extractor: {
          automatic: {
            id: 'claude-cli',
            model: 'haiku',
            fallback: [{ id: 'ollama', model: 'file-ollama' }],
          },
        },
      }),
      env: { Recall_OLLAMA_MODEL: 'env-ollama' },
    });
    expect(resolved.automatic).toEqual({
      ok: true,
      value: {
        primary: { id: 'claude-cli', model: 'haiku' },
        fallback: [{ id: 'ollama', model: 'env-ollama' }],
      },
    });
  });

  test('env cannot select Extractor ids', () => {
    const resolved = resolveExtractorConfig({
      fileText: null,
      env: { RECALL_EXTRACTOR: 'ollama', RECALL_FABRIC_MODEL: 'env-fabric' },
    });
    expect(resolved.automatic.ok && resolved.automatic.value.primary.id).toBe('claude-cli');
    expect(resolved.curated.ok && resolved.curated.value.primary.id).toBe('fabric');
    expect(resolved.curated.ok && resolved.curated.value.primary.model).toBe('env-fabric');
  });

  test('loads configPath from disk', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'recall-extractor-config-'));
    try {
      const configPath = join(configDir, 'config.json');
      writeFileSync(
        configPath,
        JSON.stringify({ extractor: { automatic: { id: 'claude-cli', model: 'from-config-path' } } }),
      );
      const resolved = resolveExtractorConfig({ configPath, env: {} });
      expect(resolved.automatic).toEqual({
        ok: true,
        value: { primary: { id: 'claude-cli', model: 'from-config-path' }, fallback: [] },
      });
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test('defaultExtractorConfigPath uses HOME and ignores RECALL_HOME', () => {
    expect(
      defaultExtractorConfigPath({
        HOME: '/real-home',
        RECALL_HOME: '/decoy-recall-home',
      }),
    ).toBe(join('/real-home', '.agents', 'Recall', 'config.json'));
  });
});

describe('resolveHarnessConfig', () => {
  test('missing file leaves query and cluster absent and keeps extractor defaults', () => {
    const harness = resolveHarnessConfig({ fileText: null, env: {} });
    const extractor = resolveExtractorConfig({ fileText: null, env: {} });
    expect(harness.query).toEqual({ ok: true, absent: true });
    expect(harness.cluster).toEqual({ ok: true, absent: true });
    expect(extractor.automatic.ok && extractor.automatic.value.primary).toEqual({
      id: 'claude-cli',
      model: 'haiku',
    });
    expect(extractor.automatic.ok && extractor.automatic.value.fallback).toEqual([
      { id: 'ollama', model: 'qwen2.5:3b' },
    ]);
  });

  test('an extractor-only file leaves every harness key absent', () => {
    const fileText = JSON.stringify({
      extractor: { automatic: { id: 'claude-cli', model: 'haiku' } },
    });
    const harness = resolveHarnessConfig({ fileText, env: {} });
    expect(harness.query).toEqual({ ok: true, absent: true });
    expect(harness.automatic).toEqual({ ok: true, absent: true });
    expect(harness.curated).toEqual({ ok: true, absent: true });
    expect(harness.cluster).toEqual({ ok: true, absent: true });
  });
  test('query Pi and automatic Claude are different selections', () => {
    const harness = resolveHarnessConfig({
      fileText: JSON.stringify({
        query: { primary: { id: 'pi' } },
        extraction: { automatic: { primary: { id: 'claude' } } },
      }),
      env: {},
    });
    expect(harness.query).toEqual({
      ok: true,
      absent: false,
      value: { primary: { kind: 'named', id: 'pi', model: '' }, fallback: [] },
    });
    expect(harness.automatic).toEqual({
      ok: true,
      absent: false,
      value: { primary: { kind: 'named', id: 'claude', model: '' }, fallback: [] },
    });
  });

  test('cluster Grok and automatic Claude are different selections', () => {
    const harness = resolveHarnessConfig({
      fileText: JSON.stringify({
        cluster: { primary: { id: 'grok' } },
        extraction: { automatic: { primary: { id: 'claude' } } },
      }),
      env: {},
    });
    expect(harness.cluster.ok && !harness.cluster.absent && harness.cluster.value.primary).toEqual({
      kind: 'named',
      id: 'grok',
      model: '',
    });
    expect(harness.automatic.ok && !harness.automatic.absent && harness.automatic.value.primary).toEqual({
      kind: 'named',
      id: 'claude',
      model: '',
    });
  });

  test('a Pi label with argv stays a command', () => {
    const harness = resolveHarnessConfig({
      fileText: JSON.stringify({
        query: { primary: { id: 'pi', argv: ['pi', '--print'] } },
      }),
      env: {},
    });
    expect(harness.query).toEqual({
      ok: true,
      absent: false,
      value: {
        primary: { kind: 'command', label: 'pi', argv: ['pi', '--print'], model: '' },
        fallback: [],
      },
    });
  });

  test('empty argv fails that path closed', () => {
    const harness = resolveHarnessConfig({
      fileText: JSON.stringify({ query: { primary: { argv: [] } } }),
      env: {},
    });
    expect(harness.query.ok).toBe(false);
  });

  test('unparseable JSON fails query closed', () => {
    const harness = resolveHarnessConfig({ fileText: '{', env: {} });
    expect(harness.query).toEqual({ ok: false, error: 'config.json is not valid JSON' });
  });

  test('a bad query object leaves the extractor path intact', () => {
    const fileText = JSON.stringify({
      query: { primary: { id: 'not-a-harness' } },
      extractor: { automatic: { id: 'claude-cli', model: 'haiku' } },
    });
    const harness = resolveHarnessConfig({ fileText, env: {} });
    const extractor = resolveExtractorConfig({ fileText, env: {} });
    expect(harness.query.ok).toBe(false);
    expect(extractor.automatic).toEqual({
      ok: true,
      value: {
        primary: { id: 'claude-cli', model: 'haiku' },
        fallback: [],
      },
    });
  });

  test('argv that matches scrub fails closed', () => {
    const harness = resolveHarnessConfig({
      fileText: JSON.stringify({
        query: { primary: { argv: ['pi', 'sk-ant-abcdefghijklmnopqrst'] } },
      }),
      env: {},
    });
    expect(harness.query.ok).toBe(false);
  });
});
