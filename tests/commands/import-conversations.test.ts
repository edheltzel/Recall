import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import { NO_EXTRACT_WARNING, runImportConversations } from '../../src/commands/import-conversations';

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

  test('rejects an unrecognized format before importing', async () => {
    const file = join(tempDir, 'empty.json');
    writeFileSync(file, JSON.stringify([]));

    await expect(
      runImportConversations(file, { format: 'invalid' as any })
    ).rejects.toThrow('Invalid format');
  });
});
