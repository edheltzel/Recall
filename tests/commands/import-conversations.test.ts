import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { NO_EXTRACT_WARNING, runImportConversations } from '../../src/commands/import-conversations';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const CLI_ENTRY = join(REPO_ROOT, 'src', 'index.ts');

let tempDir: string;

beforeEach(() => {
  setupTestDb();
  tempDir = mkdtempSync(join(tmpdir(), 'recall-import-command-'));
});

afterEach(() => {
  teardownTestDb();
  rmSync(tempDir, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('runImportConversations', () => {
  test('warns when --no-extract bypasses curated extraction', async () => {
    const file = join(tempDir, 'conversations.json');
    writeFileSync(file, JSON.stringify([
      {
        id: 'chat-command-1',
        title: 'Command warning',
        current_node: 'm1',
        mapping: {
          m1: {
            id: 'm1', parent: null, children: [],
            message: {
              author: { role: 'user' },
              create_time: 1710000000,
              content: { content_type: 'text', parts: ['raw only'] },
            },
          },
        },
      },
    ]));

    const logs: string[] = [];
    const warns: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    try {
      console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
      console.warn = (...args: unknown[]) => { warns.push(args.join(' ')); };
      await runImportConversations(file, { format: 'chatgpt', noExtract: true });
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }

    expect(warns.join('\n')).toContain(NO_EXTRACT_WARNING);
    expect(logs.join('\n')).toContain('Sessions imported: 1');
  });

  // Regression for #66: Commander maps `--no-extract` to `options.extract = false`,
  // not `options.noExtract`. The src/index.ts wiring must read `options.extract === false`,
  // otherwise the flag is dead and extraction runs anyway. This exercises the real CLI
  // (Commander parsing -> wiring) which the in-process tests above bypass.
  test('CLI --no-extract flag suppresses extraction (regression for #66)', () => {
    const file = join(tempDir, 'cli-no-extract.json');
    writeFileSync(file, JSON.stringify([
      {
        id: 'chat-cli-1',
        title: 'CLI no-extract',
        current_node: 'm1',
        mapping: {
          m1: {
            id: 'm1', parent: null, children: [],
            message: {
              author: { role: 'user' },
              create_time: 1710000000,
              content: { content_type: 'text', parts: ['raw only'] },
            },
          },
        },
      },
    ]));

    const { RECALL_DB_PATH: _drop, MEM_DB_PATH: _legacy, ...baseEnv } = process.env;
    const env = { ...baseEnv, RECALL_DB_PATH: join(tempDir, 'cli.db') };
    const init = Bun.spawnSync(['bun', CLI_ENTRY, 'init'], { cwd: REPO_ROOT, env });
    expect(init.exitCode).toBe(0);

    const proc = Bun.spawnSync(
      ['bun', CLI_ENTRY, 'import-conversations', file, '--format', 'chatgpt', '--no-extract'],
      { cwd: REPO_ROOT, env }
    );

    const stdout = proc.stdout.toString();
    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain('Sessions imported: 1');
    // The "Extracted sessions:" block is gated on extraction running. If the flag were
    // dead, noExtract would be undefined and this block would print.
    expect(stdout).not.toContain('Extracted sessions:');
    expect(proc.stderr.toString()).toContain(NO_EXTRACT_WARNING);
  });

  test('rejects an unrecognized format before importing', async () => {
    const file = join(tempDir, 'empty.json');
    writeFileSync(file, JSON.stringify([]));

    await expect(
      runImportConversations(file, { format: 'invalid' as any })
    ).rejects.toThrow('Invalid format');
  });
});
