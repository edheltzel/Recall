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

  test('re-import preserves automatic lifecycle capture for the same session', async () => {
    const sessionId = 'codex-lifecycle-reimport';
    const lifecycleContent = 'Preserve this lifecycle message across explicit re-imports.';
    const explicitContent = 'Add this explicit snapshot without replacing automatic capture.';
    const timestamp = '2026-08-12T12:00:00.000Z';
    const lifecycle = {
      source: 'codex' as const,
      sessionId,
      watermark: 'bytes:42',
      messages: [{ role: 'user' as const, content: lifecycleContent, timestamp }],
      finalize: true,
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
            timestamp: '2026-08-12T12:00:01.000Z',
            role: 'assistant' as const,
            content: explicitContent,
            project: 'recall-test',
          },
        ],
      },
    };

    const first = await coreDump('First replacement', options);
    expect(first).toMatchObject({ success: true, messageCount: 1 });
    options.session.messages[0].timestamp = '2026-08-12T12:00:02.000Z';
    expect(await coreDump('Second replacement', options)).toMatchObject({
      success: true,
      messageCount: 0,
    });

    const db = getDb();
    const state = db
      .prepare('SELECT watermark FROM host_ingest_state WHERE source = ? AND session_id = ?')
      .get('codex', sessionId) as { watermark: string };
    const key = db
      .prepare('SELECT message_id FROM host_ingest_messages WHERE source = ? AND session_id = ?')
      .get('codex', sessionId) as { message_id: number | null };
    expect(state.watermark).toBe('bytes:42');
    expect(key.message_id).toBeNumber();
    expect(ingestHostTranscript(lifecycle)).toMatchObject({ inserted: 0, skipped: 1 });
    const messages = db
      .prepare('SELECT id, content FROM messages WHERE session_id = ? ORDER BY id')
      .all(sessionId) as Array<{ id: number; content: string }>;
    expect(messages.map(message => message.content)).toEqual([lifecycleContent, explicitContent]);
    const loa = db
      .prepare(`
        SELECT description, tags, message_range_start, message_range_end, message_count
        FROM loa_entries
        WHERE session_id = ? ORDER BY id
      `)
      .all(sessionId) as Array<{
        description: string | null;
        tags: string | null;
        message_range_start: number;
        message_range_end: number;
        message_count: number;
      }>;
    expect(loa).toHaveLength(2);
    expect(loa.filter(entry => entry.tags?.includes('automatic-capture'))).toHaveLength(1);
    const explicitLoa = loa.filter(entry => entry.description === 'Explicit memory dump.');
    expect(explicitLoa).toHaveLength(1);
    expect(explicitLoa[0]).toMatchObject({
      message_range_start: messages[1].id,
      message_range_end: messages[1].id,
      message_count: 1,
    });
  });
});
