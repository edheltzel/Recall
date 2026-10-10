import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { JEV_KEY_URL, runJev } from '../../src/commands/jev';

const decision: JevDecision = {
  choice: 'keep',
  probabilities: { keep: 1, demote: 0, drop: 0 },
  confidence: 1,
};

beforeEach(() => {
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
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
    expect(process.exitCode).toBe(0);
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

describe('recall jev ~/.env fallback', () => {
  function homeWith(body: string): string {
    const home = mkdtempSync(join(tmpdir(), 'recall-jev-cli-'));
    writeFileSync(join(home, '.env'), body);
    return home;
  }

  test('a non-blank environment value wins over the file', async () => {
    const home = homeWith("JEV_RECALL_KEY='from-file'\n");
    try {
      let scoredWith = '';
      const err: string[] = [];
      await runJev({ text: 'Use bun:sqlite' }, {
        env: { HOME: home, JEV_RECALL_KEY: 'from-env' },
        isTTY: false,
        writeErr: line => err.push(line),
        writeOut: () => {},
        score: async (_candidate, options) => {
          scoredWith = options?.apiKey ?? '';
          return decision;
        },
      });
      expect(scoredWith).toBe('from-env');
      expect(err.join('\n')).not.toContain('from-file');
      expect(err.join('\n')).not.toContain('from-env');
      expect(process.exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a blank environment value falls back to the file and does not print it', async () => {
    const secret = 'cli-file-secret';
    const home = homeWith(`export JEV_RECALL_KEY="${secret}" # comment\r\n`);
    try {
      let scoredWith = '';
      const err: string[] = [];
      const out: string[] = [];
      await runJev({ text: 'Use bun:sqlite' }, {
        env: { HOME: home, JEV_RECALL_KEY: '   ' },
        isTTY: false,
        writeErr: line => err.push(line),
        writeOut: line => out.push(line),
        score: async (_candidate, options) => {
          scoredWith = options?.apiKey ?? '';
          return decision;
        },
      });
      expect(scoredWith).toBe(secret);
      expect(`${err.join('\n')}\n${out.join('\n')}`).not.toContain(secret);
      expect(process.exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a missing file still refuses, and a thrown score does not print the file key', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'recall-jev-cli-'));
    const secret = 'cli-thrown-secret';
    const home = homeWith(`JEV_RECALL_KEY=${secret}\n`);
    try {
      const missing: string[] = [];
      let scored = false;
      await runJev({ text: 'Use bun:sqlite' }, {
        env: { HOME: empty },
        isTTY: false,
        writeErr: line => missing.push(line),
        score: async () => {
          scored = true;
          return decision;
        },
      });
      expect(scored).toBe(false);
      expect(missing.join('\n')).toContain(JEV_KEY_URL);
      expect(missing.join('\n')).toContain('~/.env');
      expect(missing.join('\n')).not.toContain('does not read');
      expect(process.exitCode).toBe(1);

      process.exitCode = 0;
      const err: string[] = [];
      await runJev({ text: 'Use bun:sqlite' }, {
        env: { HOME: home },
        isTTY: false,
        writeErr: line => err.push(line),
        score: async () => {
          throw new Error(`upstream said ${secret}`);
        },
      });
      expect(err.join('\n')).toBe('Jev request failed');
      expect(err.join('\n')).not.toContain(secret);
    } finally {
      rmSync(empty, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
