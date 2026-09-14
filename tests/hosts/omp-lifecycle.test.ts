import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { handleHostHook, parsePayload } from '../../src/commands/host-hook';
import { closeDb, getDb, initDb } from '../../src/db/connection';
import { MIGRATIONS } from '../../src/db/migrations';
import { parseOmpSession } from '../../src/hosts/omp-lifecycle';
import { getLoaMessages, search } from '../../src/lib/memory';

let tempDir = '';
let previousDbPath: string | undefined;
let previousSkip: string | undefined;

function messageEntry(
  id: string,
  role: string,
  content: unknown,
  extras: Record<string, unknown> = {},
) {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-09-14T12:00:00.000Z',
    message: { role, content, ...extras },
  };
}

function ompPayload(sessionId: string, entries: unknown[], cwd = tempDir) {
  return {
    hook_event_name: 'session_stop',
    session_id: sessionId,
    cwd,
    entries,
  };
}

function published(sessionId: string): Array<{ content: string }> {
  return getDb().prepare(`
    SELECT m.content FROM published_messages m
    JOIN active_host_ingest_messages h ON h.message_id = m.id
    WHERE h.source = 'omp' AND h.session_id = ? AND h.source_position IS NOT NULL
    ORDER BY h.source_position
  `).all(sessionId) as Array<{ content: string }>;
}

beforeEach(() => {
  previousDbPath = process.env.RECALL_DB_PATH;
  previousSkip = process.env.RECALL_SKIP_LEGACY_DATA_MIGRATIONS;
  tempDir = mkdtempSync(join(tmpdir(), 'recall-omp-lifecycle-'));
  process.env.RECALL_DB_PATH = join(tempDir, 'recall.db');
  process.env.RECALL_SKIP_LEGACY_DATA_MIGRATIONS = '1';
  initDb();
});

afterEach(() => {
  closeDb();
  if (previousDbPath === undefined) delete process.env.RECALL_DB_PATH;
  else process.env.RECALL_DB_PATH = previousDbPath;
  if (previousSkip === undefined) delete process.env.RECALL_SKIP_LEGACY_DATA_MIGRATIONS;
  else process.env.RECALL_SKIP_LEGACY_DATA_MIGRATIONS = previousSkip;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('omp branch parser', () => {
  test('keeps user/assistant text at original entry indexes and drops the rest', () => {
    const parsed = parseOmpSession([
      messageEntry('u1', 'user', 'hello'),
      {
        type: 'message',
        id: 'tool1',
        parentId: 'u1',
        timestamp: '2026-09-14T12:00:01.000Z',
        message: { role: 'toolResult', content: 'should skip' },
      },
      messageEntry('a1', 'assistant', [
        { type: 'thinking', text: 'secret thought' },
        { type: 'toolCall', id: 'c1', name: 'bash', arguments: {} },
        { type: 'text', text: 'done' },
      ]),
      messageEntry('dev1', 'developer', 'injected'),
      { type: 'custom_message', id: 'cstm', parentId: 'a1', content: 'injected custom' },
      { type: 'compaction', id: 'sum1', parentId: 'a1', summary: 'branch summary' },
      { type: 'branch_summary', id: 'sum2', parentId: 'a1', summary: 'abandoned path' },
      messageEntry('a-tool', 'assistant', [{ type: 'toolCall', id: 'c2', name: 'bash', arguments: {} }]),
      messageEntry('a-img', 'assistant', [{ type: 'image', url: 'https://example.com/x.png' }]),
    ]);

    expect(parsed.messages).toEqual([
      {
        role: 'user',
        content: 'hello',
        timestamp: '2026-09-14T12:00:00.000Z',
        nativeId: 'u1',
        sourcePosition: 0,
      },
      {
        role: 'assistant',
        content: 'done',
        timestamp: '2026-09-14T12:00:00.000Z',
        nativeId: 'a1',
        sourcePosition: 2,
      },
    ]);
  });

  test('rejects a non-array entries payload before ingest', () => {
    expect(() => parseOmpSession({ id: 'nope' })).toThrow('entries array');
  });

  test('rejects null entries, bad content, missing ids, and duplicate native ids', () => {
    expect(() => parseOmpSession([null])).toThrow('malformed session entry');
    expect(() => parseOmpSession([messageEntry('u1', 'user', 123)])).toThrow('malformed session entry');
    expect(() => parseOmpSession([{
      type: 'message',
      message: { role: 'user', content: 'no id' },
    }])).toThrow('malformed session entry');
    expect(() => parseOmpSession([
      messageEntry('u1', 'user', 'a'),
      messageEntry('u1', 'user', 'b'),
    ])).toThrow('duplicate native ids');
  });
});

describe('omp session_stop ingest', () => {
  test('repeated capture of the same native ids is idempotent', () => {
    const entries = [
      messageEntry('u1', 'user', 'same turn'),
      messageEntry('a1', 'assistant', [{ type: 'text', text: 'same reply' }]),
    ];
    const first = handleHostHook('omp', ompPayload('omp-idem', entries));
    const second = handleHostHook('omp', ompPayload('omp-idem', entries));
    expect(first.ingest).toMatchObject({ inserted: 2, finalized: true });
    expect(second.ingest).toMatchObject({ inserted: 0, finalized: true });
    expect(published('omp-idem').map(row => row.content)).toEqual(['same turn', 'same reply']);
  });

  test('repeated identical human text with distinct native ids stays two rows', () => {
    const entries = [
      messageEntry('u1', 'user', 'hello again'),
      messageEntry('u2', 'user', 'hello again'),
    ];
    handleHostHook('omp', ompPayload('omp-dup-ids', entries));
    handleHostHook('omp', ompPayload('omp-dup-ids', entries));
    expect(published('omp-dup-ids').map(row => row.content)).toEqual([
      'hello again',
      'hello again',
    ]);
  });

  test('active-branch replacement hides abandoned text, redacts secrets, and stays searchable', () => {
    const first = handleHostHook('omp', ompPayload('omp-branch', [
      messageEntry('u1', 'user', 'keepmeleaf password=abcdefghijk'),
      messageEntry('a1', 'assistant', [{ type: 'text', text: 'abandonedleafxyz' }]),
    ]));
    expect(first.ingest?.redactions).toContain('generic-assignment');
    expect(first.ingest?.loaId).toBeNumber();
    expect(search('abandonedleafxyz', { table: 'messages' }).map(row => row.content))
      .toEqual(['abandonedleafxyz']);

    const second = handleHostHook('omp', ompPayload('omp-branch', [
      messageEntry('u1', 'user', 'keepmeleaf password=abcdefghijk'),
      messageEntry('a2', 'assistant', [{ type: 'text', text: 'activeleafxyz' }]),
    ]));
    expect(second.ingest?.reconciled).toBeGreaterThan(0);
    expect(published('omp-branch').map(row => row.content)).toEqual([
      'keepmeleaf password=[REDACTED:generic-assignment]',
      'activeleafxyz',
    ]);
    expect(search('abandonedleafxyz', { table: 'messages' })).toEqual([]);
    expect(search('activeleafxyz', { table: 'messages' }).map(row => row.content))
      .toEqual(['activeleafxyz']);
    expect(getLoaMessages(second.ingest!.loaId!).map(row => row.content)).toEqual([
      'keepmeleaf password=[REDACTED:generic-assignment]',
      'activeleafxyz',
    ]);
  });

  test('malformed recapture fails closed and keeps the published branch', () => {
    handleHostHook('omp', ompPayload('omp-malformed', [
      messageEntry('u1', 'user', 'durableleafxyz'),
    ]));
    expect(published('omp-malformed').map(row => row.content)).toEqual(['durableleafxyz']);

    expect(() => handleHostHook('omp', {
      hook_event_name: 'session_stop',
      session_id: 'omp-malformed',
      cwd: tempDir,
      entries: { not: 'an array' },
    })).toThrow('entries array');
    expect(() => handleHostHook('omp', {
      hook_event_name: 'session_stop',
      cwd: tempDir,
      entries: [],
    })).toThrow('session_id');
    expect(() => handleHostHook('omp', ompPayload('omp-malformed', [null]))).toThrow('malformed');
    expect(() => handleHostHook('omp', ompPayload('omp-malformed', [
      messageEntry('u1', 'user', 123),
    ]))).toThrow('malformed');
    expect(published('omp-malformed').map(row => row.content)).toEqual(['durableleafxyz']);
    expect(search('durableleafxyz', { table: 'messages' }).map(row => row.content))
      .toEqual(['durableleafxyz']);
  });

  test('a later fork session does not replace the parent session rows', () => {
    handleHostHook('omp', ompPayload('omp-parent', [
      messageEntry('p1', 'user', 'parentleafxyz'),
    ]));
    handleHostHook('omp', ompPayload('omp-fork', [
      messageEntry('f1', 'user', 'forkleafxyz'),
    ]));
    expect(published('omp-parent').map(row => row.content)).toEqual(['parentleafxyz']);
    expect(published('omp-fork').map(row => row.content)).toEqual(['forkleafxyz']);
  });

  test('omp stdin bound is 25MiB while other hosts stay at 1MiB', () => {
    const raw = JSON.stringify({
      hook_event_name: 'session_stop',
      session_id: 'omp-size',
      cwd: '/tmp',
      entries: [],
      pad: 'x'.repeat(2 * 1024 * 1024),
    });
    expect(() => parsePayload(raw)).toThrow(/exceeds/);
    expect(parsePayload(raw, 25 * 1024 * 1024).session_id).toBe('omp-size');
  });

  test('migrating a grok-only FTS install hides pruned omp branch rows', () => {
    const db = getDb();
    const now = '2026-09-14T12:00:00.000Z';
    db.prepare(`
      INSERT INTO sessions (session_id, started_at, source)
      VALUES ('omp-upgrade', ?, 'omp')
    `).run(now);
    db.prepare(`
      INSERT INTO host_ingest_generations
        (generation_id, source, session_id, created_at, status, ready, fts_ready, message_count)
      VALUES ('gen:omp-upgrade', 'omp', 'omp-upgrade', ?, 'active', 1, 1, 2)
    `).run(now);
    db.prepare(`
      INSERT INTO host_ingest_state (
        source, session_id, transcript_digest, active_generation, updated_at
      ) VALUES ('omp', 'omp-upgrade', 'digest', 'gen:omp-upgrade', ?)
    `).run(now);
    db.prepare(`
      INSERT INTO host_ingest_generation_messages (
        generation_id, ordinal, source, session_id, message_key, message_id,
        timestamp, role, content, provenance, source_position, fts_pending
      ) VALUES
        ('gen:omp-upgrade', 1, 'omp', 'omp-upgrade', 'native:kept', 92001,
         ?, 'user', 'upgradekeptxyz', 'verbatim', 0, 0),
        ('gen:omp-upgrade', 2, 'omp', 'omp-upgrade', 'native:hidden', 92002,
         ?, 'assistant', 'upgradehiddenxyz', 'verbatim', NULL, 0)
    `).run(now, now);
    db.exec(`
      INSERT INTO host_ingest_generation_messages_fts(rowid, content, project, generation_id)
      VALUES
        (92001, 'upgradekeptxyz', NULL, 'gen:omp-upgrade'),
        (92002, 'upgradehiddenxyz', NULL, 'gen:omp-upgrade')
    `);
    expect(db.prepare(`
      SELECT content FROM host_ingest_generation_messages_fts
      WHERE host_ingest_generation_messages_fts MATCH 'upgradehiddenxyz'
    `).all()).toEqual([{ content: 'upgradehiddenxyz' }]);

    closeDb();
    const raw = new Database(process.env.RECALL_DB_PATH!);
    raw.exec(`
      DROP TRIGGER IF EXISTS host_ingest_generation_messages_fts_ad;
      DROP TRIGGER IF EXISTS host_ingest_generation_messages_fts_au;
      DROP VIEW IF EXISTS published_messages;
      CREATE VIEW published_messages AS
      SELECT generated.message_id AS id, generated.session_id, generated.timestamp,
        generated.role, generated.content, generated.project, generated.importance,
        generated.provenance, 0 AS access_count, NULL AS last_accessed,
        generated.generation_id AS host_ingest_token
      FROM host_ingest_generation_messages AS generated
      JOIN host_ingest_state AS state
        ON state.active_generation = generated.generation_id
       AND state.source = generated.source
       AND state.session_id = generated.session_id
      WHERE generated.message_id IS NOT NULL
        AND generated.content IS NOT NULL
        AND (generated.source <> 'grok' OR generated.source_position IS NOT NULL);
      PRAGMA user_version = ${MIGRATIONS.length - 1};
    `);
    raw.close();

    initDb();
    expect(getDb().prepare(`
      SELECT content FROM host_ingest_generation_messages_fts
      WHERE host_ingest_generation_messages_fts MATCH 'upgradehiddenxyz'
    `).all()).toEqual([]);
    expect(getDb().prepare(`
      SELECT content FROM host_ingest_generation_messages_fts
      WHERE host_ingest_generation_messages_fts MATCH 'upgradekeptxyz'
    `).all()).toEqual([{ content: 'upgradekeptxyz' }]);
    expect(search('upgradehiddenxyz', { table: 'messages' })).toEqual([]);
    expect(search('upgradekeptxyz', { table: 'messages' }).map(row => row.content))
      .toEqual(['upgradekeptxyz']);
  });
});
