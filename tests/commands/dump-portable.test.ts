import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { coreDump } from '../../src/commands/dump';
import { getDb } from '../../src/db/connection';
import { setupTestDb, teardownTestDb } from '../helpers/setup';

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());

describe('portable explicit session dump', () => {
  test('stores caller-supplied Codex messages without transcript discovery', async () => {
    const sessionId = 'codex-explicit-session';
    const result = await coreDump('Codex native plugin', {
      skipFabric: true,
      skipEmbed: true,
      session: {
        source: 'codex',
        sessionId,
        project: 'recall-test',
        filePath: `mcp://codex/${sessionId}`,
        messages: [
          {
            session_id: sessionId,
            timestamp: '2026-07-22T12:00:00.000Z',
            role: 'user',
            content: 'Package Recall on the native Codex plugin primitive.',
            project: 'recall-test',
          },
          {
            session_id: sessionId,
            timestamp: '2026-07-22T12:00:01.000Z',
            role: 'assistant',
            content: 'Use MCP for portable memory operations and keep lifecycle capture separate.',
            project: 'recall-test',
          },
        ],
      },
    });

    expect(result.success).toBe(true);
    expect(result.source).toBe('codex');
    expect(result.messageCount).toBe(2);
    const session = getDb().prepare('SELECT source, project FROM sessions WHERE session_id = ?').get(sessionId) as {
      source: string;
      project: string;
    };
    expect(session).toEqual({ source: 'codex', project: 'recall-test' });
  });
});
