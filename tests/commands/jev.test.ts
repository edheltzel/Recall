import { afterEach, describe, expect, test } from 'bun:test';
import { JEV_KEY_URL, runJev } from '../../src/commands/jev';
import type { JevDecision } from '../../src/providers/jev';

const decision: JevDecision = {
  choice: 'keep',
  probabilities: { keep: 1, demote: 0, drop: 0 },
  confidence: 1,
};

afterEach(() => {
  process.exitCode = undefined;
});

describe('recall jev missing key', () => {
  test('a terminal prompts, shows the key URL, and does not print the pasted key', async () => {
    const err: string[] = [];
    const out: string[] = [];
    let scoredWith = '';
    await runJev(
      { text: 'Use bun:sqlite' },
      {
        env: {},
        isTTY: true,
        readKey: async () => 'secret-key',
        writeErr: line => err.push(line),
        writeOut: line => out.push(line),
        score: async (_candidate, options) => {
          scoredWith = options?.apiKey ?? '';
          return decision;
        },
      },
    );
    expect(err.join('\n')).toContain(JEV_KEY_URL);
    expect(err.join('\n')).not.toContain('secret-key');
    expect(out.join('\n')).not.toContain('secret-key');
    expect(scoredWith).toBe('secret-key');
    expect(process.exitCode).toBeUndefined();
  });

  test('a non-interactive run prints the URL and does not score', async () => {
    const err: string[] = [];
    let scored = false;
    await runJev(
      { text: 'Use bun:sqlite' },
      {
        env: { JEV_RECALL_KEY: '   ' },
        isTTY: false,
        writeErr: line => err.push(line),
        score: async () => {
          scored = true;
          return decision;
        },
      },
    );
    expect(scored).toBe(false);
    expect(err.join('\n')).toContain('https://console.typesafe.ai/keys');
    expect(process.exitCode).toBe(1);
  });

  test('a blank prompt cancels without a request', async () => {
    let scored = false;
    await runJev(
      { text: 'Use bun:sqlite' },
      {
        env: {},
        isTTY: true,
        readKey: async () => '  ',
        writeErr: () => {},
        score: async () => {
          scored = true;
          return decision;
        },
      },
    );
    expect(scored).toBe(false);
    expect(process.exitCode).toBe(1);
  });
});
