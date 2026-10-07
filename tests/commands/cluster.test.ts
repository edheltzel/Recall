import { describe, expect, test } from 'bun:test';
import { claudeCliTextGenerationProvider } from '../../src/providers/claude-cli';
import { clusterProvider, reportClusterMiss, scrubProcedure } from '../../src/commands/cluster';

describe('cluster harness', () => {
  test('no cluster list keeps the dated Claude provider', () => {
    expect(clusterProvider({ fileText: null })).toBe(claudeCliTextGenerationProvider);
  });

  test('a present list that fails does not call Claude', () => {
    const provider = clusterProvider({
      fileText: JSON.stringify({
        cluster: { primary: { id: 'pi', model: 'luna' } },
        extraction: { automatic: { primary: { id: 'claude' } } },
      }),
      spawn: () => ({ ok: false, code: 'exit', message: 'failed' }),
      proven: { pi: () => ({ executable: 'pi', argv: ['--print'] }) },
    });
    expect(provider?.id).toBe('cluster-harness');
    expect(provider?.generate('TITLE: prompt')).toBeNull();
    const logged: string[] = [];
    const original = console.error;
    const previous = process.exitCode;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      reportClusterMiss(provider);
      expect(process.exitCode).toBe(1);
      expect(logged.join('\n')).toContain('failed');
      expect(logged.join('\n')).not.toContain('Synthesis failed');
    } finally {
      console.error = original;
      process.exitCode = previous ?? 0;
    }
  });

  test('a present cluster step sends the synthesis prompt', () => {
    let stdin = '';
    const provider = clusterProvider({
      fileText: JSON.stringify({ cluster: { primary: { id: 'grok', model: 'luna' } } }),
      spawn: (request) => {
        stdin = request.stdin;
        return { ok: true, stdout: 'TITLE: Keep the prompt\nTRIGGER: when\nSTEPS:\n1. do it' };
      },
      proven: { grok: () => ({ executable: 'grok', argv: ['--print'] }) },
    });
    expect(provider?.generate('synthesis prompt')).toContain('TITLE:');
    expect(stdin).toBe('synthesis prompt');
  });

  test('a title containing an sk-ant- key is stored as a redaction marker', () => {
    const clean = scrubProcedure({
      title: 'Use sk-ant-abcdefghijklmnopqrst carefully',
      trigger: 'when',
      steps: '1. do it',
    });
    expect(clean.title).not.toContain('sk-ant-abcdefghijklmnopqrst');
    expect(clean.title).toContain('[REDACTED:');
  });
});
