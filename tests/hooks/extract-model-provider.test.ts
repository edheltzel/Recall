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
});
