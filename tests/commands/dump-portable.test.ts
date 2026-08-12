import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { coreDump } from '../../src/commands/dump';
import { getDb } from '../../src/db/connection';
import { createLoaEntry, getLoaMessages } from '../../src/lib/memory';
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
    const resumedContent = 'Refresh the automatic extraction after this session resumes.';
    const timestamp = '2026-08-12T12:00:00.000Z';
    const lifecycle = {
      source: 'codex' as const,
      sessionId,
      project: 'recall-test',
      watermark: 'bytes:42',
      messages: [{ role: 'user' as const, content: lifecycleContent, timestamp }],
      finalize: true,
    };
    const initialFinal = ingestHostTranscript(lifecycle);

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
    const childLoaId = createLoaEntry({
      title: 'Explicit dump continuation',
      fabric_extract: 'Knowledge that continues from the explicit dump.',
      parent_loa_id: first.loaId,
      provenance: 'extracted',
    });
    getDb().prepare(`
      INSERT INTO embeddings (source_table, source_id, model, dimensions, embedding)
      VALUES ('loa_entries', ?, 'test', 1, ?)
    `).run(first.loaId!, Buffer.alloc(4));
    options.session.messages[0].timestamp = '2026-08-12T12:00:02.000Z';
    const second = await coreDump('Second replacement', options);
    expect(second).toMatchObject({
      success: true,
      messageCount: 0,
      loaId: first.loaId,
    });
    expect(
      getDb().prepare('SELECT parent_loa_id FROM loa_entries WHERE id = ?').get(childLoaId)
    ).toEqual({ parent_loa_id: first.loaId });
    expect(
      (
        getDb().prepare(`
          SELECT COUNT(*) AS count FROM embeddings
          WHERE source_table = 'loa_entries' AND source_id = ?
        `).get(first.loaId!) as { count: number }
      ).count
    ).toBe(0);

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

    ingestHostTranscript({
      source: 'grok',
      sessionId: 'interleaved-lifecycle-session',
      messages: [{ role: 'system', content: 'Unrelated session content.' }],
    });
    const resumed = {
      source: 'codex' as const,
      sessionId,
      watermark: 'bytes:84',
      messages: [
        lifecycle.messages[0],
        {
          role: 'assistant' as const,
          content: resumedContent,
          timestamp: '2026-08-12T12:00:03.000Z',
        },
      ],
    };
    expect(ingestHostTranscript(resumed)).toMatchObject({ inserted: 1, finalized: false });
    const resumedState = db
      .prepare('SELECT finalized_at FROM host_ingest_state WHERE source = ? AND session_id = ?')
      .get('codex', sessionId) as { finalized_at: string | null };
    expect(resumedState.finalized_at).toBeNull();
    expect(
      (
        db.prepare('SELECT ended_at FROM sessions WHERE session_id = ?').get(sessionId) as {
          ended_at: string | null;
        }
      ).ended_at
    ).toBeNull();
    const refreshedFinal = ingestHostTranscript({ ...resumed, finalize: true });
    expect(refreshedFinal).toMatchObject({ inserted: 0, finalized: true, loaId: initialFinal.loaId });

    const messages = db
      .prepare('SELECT id, content FROM messages WHERE session_id = ? ORDER BY id')
      .all(sessionId) as Array<{ id: number; content: string }>;
    expect(messages.map(message => message.content)).toEqual([
      lifecycleContent,
      explicitContent,
      resumedContent,
    ]);
    const loa = db
      .prepare(`
        SELECT id, description, tags, message_range_start, message_range_end,
          message_count, project, source_ids
        FROM loa_entries
        WHERE session_id = ? ORDER BY id
      `)
      .all(sessionId) as Array<{
        id: number;
        description: string | null;
        tags: string | null;
        message_range_start: number;
        message_range_end: number;
        message_count: number;
        project: string | null;
        source_ids: string | null;
      }>;
    expect(loa).toHaveLength(2);
    const automaticLoa = loa.filter(entry => entry.tags?.includes('automatic-capture'));
    expect(automaticLoa).toHaveLength(1);
    expect(automaticLoa[0]).toMatchObject({ message_count: 2, project: 'recall-test' });
    expect(JSON.parse(automaticLoa[0].source_ids ?? 'null')).toEqual({
      table: 'loa_message_sources',
      loa_id: automaticLoa[0].id,
    });
    expect(getLoaMessages(automaticLoa[0].id).map(message => message.content)).toEqual([
      lifecycleContent,
      resumedContent,
    ]);
    const explicitLoa = loa.filter(entry => entry.description === 'Explicit memory dump.');
    expect(explicitLoa).toHaveLength(1);
    expect(explicitLoa[0]).toMatchObject({
      message_range_start: messages[1].id,
      message_range_end: messages[1].id,
      message_count: 1,
    });
  });

  test('rejects explicit dumps owned by another lifecycle source', async () => {
    const sessionId = 'codex-owned-session';
    ingestHostTranscript({
      source: 'codex',
      sessionId,
      messages: [{ role: 'user', content: 'Codex owns this native session.' }],
    });

    const result = await coreDump('Mismatched source', {
      skipFabric: true,
      skipEmbed: true,
      session: {
        source: 'mcp',
        sessionId,
        project: 'recall-test',
        filePath: `mcp://mcp/${sessionId}`,
        messages: [{
          session_id: sessionId,
          timestamp: '2026-08-12T12:00:00.000Z',
          role: 'assistant',
          content: 'This row must not be attributed to Codex.',
          project: 'recall-test',
        }],
      },
    });

    expect(result).toMatchObject({ success: false, messageCount: 0, source: 'mcp' });
    expect(result.error).toContain('owned by codex');
    expect(
      getDb().prepare('SELECT source FROM sessions WHERE session_id = ?').get(sessionId)
    ).toEqual({ source: 'codex' });
    expect(
      (
        getDb().prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?')
          .get(sessionId) as { count: number }
      ).count
    ).toBe(1);
  });
});
