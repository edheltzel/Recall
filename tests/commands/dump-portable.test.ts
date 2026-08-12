import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { coreDump } from '../../src/commands/dump';
import { getDb } from '../../src/db/connection';
import { ingestHostTranscript } from '../../src/lib/host-ingest';
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

  test('re-import keeps lifecycle deduplication state for the same session', async () => {
    const sessionId = 'codex-lifecycle-reimport';
    const content = 'Preserve this lifecycle message across explicit re-imports.';
    const timestamp = '2026-08-12T12:00:00.000Z';
    const lifecycle = {
      source: 'codex' as const,
      sessionId,
      watermark: 'bytes:42',
      messages: [{ role: 'user' as const, content, timestamp }],
    };
    ingestHostTranscript(lifecycle);

    const options = {
      skipFabric: true,
      skipEmbed: true,
      session: {
        source: 'codex' as const,
        sessionId,
        project: 'recall-test',
        filePath: `mcp://codex/${sessionId}`,
        messages: [
          {
            session_id: sessionId,
            timestamp,
            role: 'user' as const,
            content,
            project: 'recall-test',
          },
        ],
      },
    };

    expect((await coreDump('First replacement', options)).success).toBe(true);
    expect((await coreDump('Second replacement', options)).success).toBe(true);

    const db = getDb();
    const state = db
      .prepare('SELECT watermark FROM host_ingest_state WHERE source = ? AND session_id = ?')
      .get('codex', sessionId) as { watermark: string };
    const key = db
      .prepare('SELECT message_id FROM host_ingest_messages WHERE source = ? AND session_id = ?')
      .get('codex', sessionId) as { message_id: number | null };
    expect(state.watermark).toBe('bytes:42');
    expect(key.message_id).toBeNull();
    expect(ingestHostTranscript(lifecycle)).toMatchObject({ inserted: 0, skipped: 1 });
    expect(
      (
        db
          .prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?')
          .get(sessionId) as { count: number }
      ).count
    ).toBe(1);
  });
});
