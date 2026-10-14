import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { coreDump, parseDumpSessionJson } from '../../src/commands/dump';
import { dumpOmpSession } from '../../hosts/omp/recall';
import { withEnv } from '../helpers/env';
import { getDb } from '../../src/db/connection';
import { createLoaEntry, getLoaMessages, search } from '../../src/lib/memory';
import { ingestHostTranscript } from '../../src/lib/host-ingest';
import { ExtractorConfigError } from '../../src/lib/extraction';
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

  test('scrubs dump messages before storage, summaries, extraction, and snapshot matching', async () => {
    const sessionId = 'omp-scrubbed-dump';
    const secret = 'abcdefgh' + '12345678';
    ingestHostTranscript({
      source: 'omp',
      sessionId,
      project: 'recall-test',
      messages: [{ role: 'user', content: 'Automatic capture stays separate.', sourcePosition: 0 }],
    });
    const session = parseDumpSessionJson(JSON.stringify({
      contract: 1,
      harness: 'omp',
      session_id: sessionId,
      project: 'recall-test',
      messages: [
        { role: 'user', content: `api_key=${secret}` },
        { role: 'assistant', content: ' \u200b\u202e ' },
        { role: 'assistant', content: 'Safe answer.' },
      ],
    }));
    const options = { session, skipFabric: true, skipEmbed: true };
    const first = await coreDump('Scrubbed omp dump', options);
    expect(first).toMatchObject({ success: true, source: 'omp', messageCount: 2 });
    const db = getDb();
    expect(db.prepare('SELECT content FROM published_messages WHERE session_id = ? ORDER BY id').all(sessionId))
      .toEqual([
        { content: 'Automatic capture stays separate.' },
        { content: 'api_key=[REDACTED:generic-assignment]' },
        { content: 'Safe answer.' },
      ]);
    expect(search(secret, { table: 'messages' })).toEqual([]);
    const loa = db.prepare('SELECT fabric_extract, message_count FROM loa_entries WHERE id = ?')
      .get(first.loaId!) as { fabric_extract: string; message_count: number };
    expect(loa.message_count).toBe(2);
    expect(loa.fabric_extract).toContain('api_key=[REDACTED:generic-assignment]');
    expect(loa.fabric_extract).toContain('Safe answer.');
    expect(loa.fabric_extract).not.toContain(secret);
    let extractionInput = '';
    const second = await coreDump('Scrubbed omp dump', {
      ...options,
      skipFabric: false,
      extract: content => {
        extractionInput = content;
        return 'Curated safe extraction.';
      },
    });
    expect(second).toMatchObject({ success: true, messageCount: 0, loaId: first.loaId });
    expect(extractionInput).toContain('api_key=[REDACTED:generic-assignment]');
    expect(extractionInput).toContain('Safe answer.');
    expect(extractionInput).not.toContain(secret);
    expect(extractionInput).not.toContain('\u200b');
    expect(session.messages[0].content).toBe(`api_key=${secret}`);
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
      .prepare('SELECT message_id FROM active_host_ingest_messages WHERE source = ? AND session_id = ?')
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
      .prepare('SELECT id, content FROM published_messages WHERE session_id = ? ORDER BY id')
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
    expect(JSON.parse(automaticLoa[0].source_ids ?? 'null')).toMatchObject({
      table: 'host_ingest_generation_messages',
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
        getDb().prepare('SELECT COUNT(*) AS count FROM published_messages WHERE session_id = ?')
          .get(sessionId) as { count: number }
      ).count
    ).toBe(1);
  });

  test('rolls back explicit LoA updates when embedding invalidation fails', async () => {
    const sessionId = 'codex-explicit-atomic-update';
    ingestHostTranscript({
      source: 'codex',
      sessionId,
      messages: [{ role: 'user', content: 'Keep this explicit snapshot atomic.' }],
    });
    const options = {
      skipFabric: true,
      skipEmbed: true,
      session: {
        source: 'codex' as const,
        sessionId,
        project: 'recall-test',
        filePath: `mcp://codex/${sessionId}`,
        messages: [{
          session_id: sessionId,
          timestamp: '2026-08-12T12:00:00.000Z',
          role: 'assistant' as const,
          content: 'Explicit content whose LoA is embedded.',
          project: 'recall-test',
        }],
      },
    };
    const first = await coreDump('Original explicit title', options);
    const db = getDb();
    db.prepare(`
      INSERT INTO embeddings (source_table, source_id, model, dimensions, embedding)
      VALUES ('loa_entries', ?, 'test', 1, ?)
    `).run(first.loaId!, Buffer.alloc(4));
    db.exec(`
      CREATE TRIGGER reject_explicit_loa_embedding_delete
      BEFORE DELETE ON embeddings
      WHEN old.source_table = 'loa_entries' AND old.source_id = ${first.loaId!}
      BEGIN
        SELECT RAISE(ABORT, 'embedding invalidation rejected');
      END;
    `);

    try {
      await expect(coreDump('Replacement explicit title', options)).rejects.toThrow(
        'embedding invalidation rejected'
      );
    } finally {
      db.exec('DROP TRIGGER reject_explicit_loa_embedding_delete');
    }

    expect(db.prepare('SELECT title FROM loa_entries WHERE id = ?').get(first.loaId!))
      .toEqual({ title: 'Original explicit title' });
    expect(db.prepare(`
      SELECT 1 AS present FROM embeddings
      WHERE source_table = 'loa_entries' AND source_id = ?
    `).get(first.loaId!)).toEqual({ present: 1 });
  });

  test('does not write a basic-summary LoA when curated Extractor config fails', async () => {
    const sessionId = 'extractor-config-fail-dump';
    const result = await coreDump('Config fail', {
      skipFabric: false,
      skipEmbed: true,
      extract: () => {
        throw new ExtractorConfigError('curated Extractor id "ollama" is not allowed', 'curated');
      },
      session: {
        source: 'mcp',
        sessionId,
        project: 'recall-test',
        filePath: `mcp://${sessionId}`,
        messages: [
          {
            session_id: sessionId,
            timestamp: '2026-08-30T00:00:00.000Z',
            role: 'user',
            content: 'hello',
            project: 'recall-test',
          },
        ],
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('ollama');
    expect(result.loaId).toBeUndefined();
    expect(result.messageCount).toBe(1);

    const db = getDb();
    const loa = db.prepare(
      `SELECT fabric_extract FROM loa_entries WHERE session_id = ?`,
    ).all(sessionId) as Array<{ fabric_extract: string }>;
    expect(loa).toEqual([]);
  });

  test('omp recall_dump payload stores the live branch under omp, not a discovered transcript', async () => {
    let stdin = '';
    let args: readonly string[] = [];
    const reply = await dumpOmpSession({ title: 'omp live branch', skip_fabric: true }, {
      cwd: '/work/Recall',
      hasUI: true,
      ui: { notify: () => {}, confirm: async () => true },
      sessionManager: {
        getSessionId: () => 'omp-live-session',
        getBranch: () => [
          { type: 'message', id: 'u1', timestamp: '2026-10-14T12:00:00.000Z', message: { role: 'user', content: 'dump this omp question' } },
          { type: 'message', id: 't1', message: { role: 'toolResult', content: [{ type: 'text', text: 'tool noise' }] } },
          { type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'omp answer' }] } },
        ],
      },
    }, undefined, async (_file, childArgs, childStdin, _signal, onOutput) => {
      args = childArgs;
      stdin = childStdin;
      onOutput?.('✓ LoA #7 captured');
      return 0;
    });
    expect(args.slice(1)).toEqual(['dump', 'omp live branch', '--stdin', '--skip-fabric']);
    expect(reply.content[0].text).toBe('✓ LoA #7 captured');

    const result = await coreDump('omp live branch', { skipFabric: true, skipEmbed: true, session: parseDumpSessionJson(stdin) });
    expect(result).toMatchObject({ success: true, source: 'omp', sessionId: 'omp-live-session', messageCount: 2 });
    const rows = getDb().prepare('SELECT role, content, project FROM messages WHERE session_id = ? ORDER BY id')
      .all('omp-live-session');
    expect(rows).toEqual([
      { role: 'user', content: 'dump this omp question', project: 'Recall' },
      { role: 'assistant', content: 'omp answer', project: 'Recall' },
    ]);
  });

  test('inside omp, dump without a supplied session refuses and points at recall_dump', async () => {
    const result = await withEnv('OMPCODE', '1', () => coreDump('no omp input', { skipFabric: true, skipEmbed: true }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('recall_dump');
  });

  test('dump --stdin rejects malformed sessions whole', () => {
    const base = { contract: 1, harness: 'omp', session_id: 's' };
    expect(() => parseDumpSessionJson('not json')).toThrow('contract 1');
    expect(() => parseDumpSessionJson(JSON.stringify({ ...base, contract: 2, messages: [] }))).toThrow('contract 1');
    expect(() => parseDumpSessionJson(JSON.stringify({ ...base, harness: 'Bad Id', messages: [] }))).toThrow('harness');
    expect(() => parseDumpSessionJson(JSON.stringify({ ...base, messages: [{ role: 'system', content: 'x' }] }))).toThrow('user/assistant');
  });
});
