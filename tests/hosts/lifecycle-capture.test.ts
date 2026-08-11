import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { handleHostHook } from '../../src/commands/host-hook';
import { closeDb, getDb, initDb } from '../../src/db/connection';
import { parseCodexRollout } from '../../src/hosts/codex-lifecycle';
import { parseGrokExport } from '../../src/hosts/grok-lifecycle';
import { ingestHostTranscript, type HostTranscript } from '../../src/lib/host-ingest';

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, '..', 'fixtures', 'host-lifecycle', name), 'utf-8');

let tempDir = '';
let previousDbPath: string | undefined;
let previousSkip: string | undefined;
let previousIncludeSubagents: string | undefined;

beforeEach(() => {
  previousDbPath = process.env.RECALL_DB_PATH;
  previousSkip = process.env.RECALL_SKIP_LEGACY_DATA_MIGRATIONS;
  previousIncludeSubagents = process.env.RECALL_INCLUDE_SUBAGENTS;
  delete process.env.RECALL_INCLUDE_SUBAGENTS;
  tempDir = mkdtempSync(join(tmpdir(), 'recall-host-lifecycle-'));
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
  if (previousIncludeSubagents === undefined) delete process.env.RECALL_INCLUDE_SUBAGENTS;
  else process.env.RECALL_INCLUDE_SUBAGENTS = previousIncludeSubagents;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('supported lifecycle transcript parsers', () => {
  test('Codex uses rollout response messages and ignores duplicate event rows', () => {
    const parsed = parseCodexRollout(fixture('codex-rollout.jsonl'));
    expect(parsed.sessionId).toBe('codex-native-123');
    expect(parsed.cwd).toBe('/work/Recall');
    expect(parsed.isSubagent).toBe(false);
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages.map(message => message.role)).toEqual(['user', 'assistant']);
  });

  test('Codex recognizes a subagent rollout marker', () => {
    const parsed = parseCodexRollout(
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'child',
          source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } },
        },
      })
    );
    expect(parsed.isSubagent).toBe(true);
  });

  test('Grok parses the public Markdown export surface', () => {
    const parsed = parseGrokExport(fixture('grok-export.md'));
    expect(parsed.messages.map(message => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(parsed.messages[1].content).toContain('supported export surface');
  });
});

describe('host hook payload routing', () => {
  test('Codex SessionStart emits supported additional context JSON only', () => {
    const result = handleHostHook(
      'codex',
      {
        hook_event_name: 'SessionStart',
        session_id: 'codex-native-123',
      },
      {
        renderContext: () => '## Recall context',
      }
    );
    expect(JSON.parse(result.stdout ?? '{}')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: '## Recall context',
      },
    });
    expect(result.ingest).toBeUndefined();
  });

  test('Codex reads only the supplied transcript path and routes compaction capture', () => {
    let received: HostTranscript | undefined;
    const result = handleHostHook(
      'codex',
      {
        hook_event_name: 'PreCompact',
        session_id: 'codex-native-123',
        transcript_path: '/supplied/rollout.jsonl',
        cwd: '/work/Recall',
      },
      {
        readTranscript: path => {
          expect(path).toBe('/supplied/rollout.jsonl');
          return fixture('codex-rollout.jsonl');
        },
        ingest: input => {
          received = input;
          return {
            sessionId: input.sessionId,
            inserted: input.messages.length,
            skipped: 0,
            finalized: false,
            redactions: [],
            digest: 'digest',
          };
        },
      }
    );
    expect(result.ingest?.inserted).toBe(2);
    expect(received?.source).toBe('codex');
    expect(received?.transcriptRef).toBe('/supplied/rollout.jsonl');
    expect(received?.finalize).toBe(false);
  });

  test('skips subagent lifecycle payloads by default', () => {
    const result = handleHostHook(
      'codex',
      {
        hook_event_name: 'Stop',
        session_id: 'codex-child',
        agent_id: 'child-agent',
        transcript_path: '/supplied/child.jsonl',
      },
      {
        readTranscript: () => {
          throw new Error('subagent transcript should not be read');
        },
      }
    );
    expect(result.skipped).toBe('subagent');
  });

  test('Grok exports by native session ID and does not claim SessionStart injection', () => {
    let exported = '';
    let received: HostTranscript | undefined;
    const start = handleHostHook('grok', {
      hookEventName: 'session_start',
      sessionId: 'grok-native-456',
    });
    expect(start.skipped).toBe('unsupported-event');
    expect(start.stdout).toBeUndefined();

    const result = handleHostHook(
      'grok',
      {
        hookEventName: 'session_end',
        sessionId: 'grok-native-456',
        workspaceRoot: '/work/Recall',
      },
      {
        exportGrok: sessionId => {
          exported = sessionId;
          return fixture('grok-export.md');
        },
        ingest: input => {
          received = input;
          return {
            sessionId: input.sessionId,
            inserted: input.messages.length,
            skipped: 0,
            finalized: true,
            redactions: [],
            digest: 'digest',
          };
        },
      }
    );
    expect(exported).toBe('grok-native-456');
    expect(received?.source).toBe('grok');
    expect(received?.finalize).toBe(true);
    expect(result.ingest?.inserted).toBe(4);
  });
});

describe('host-neutral immediate SQLite ingest', () => {
  test('Grok export capture writes automatic rows immediately and deduplicates replay', () => {
    const payload = {
      hookEventName: 'SessionEnd',
      sessionId: 'grok-native-456',
      workspaceRoot: '/work/Recall',
    };
    const dependencies = { exportGrok: () => fixture('grok-export.md') };

    const first = handleHostHook('grok', payload, dependencies);
    const replay = handleHostHook('grok', payload, dependencies);

    expect(first.ingest).toMatchObject({ inserted: 4, finalized: true });
    expect(first.ingest?.redactions).toContain('generic-assignment');
    expect(replay.ingest).toMatchObject({ inserted: 0, skipped: 4, finalized: false });

    const db = getDb();
    const rows = db
      .prepare('SELECT content, provenance FROM messages WHERE session_id = ? ORDER BY id')
      .all('grok-native-456') as Array<{ content: string; provenance: string }>;
    expect(rows).toHaveLength(4);
    expect(rows[2].content).toContain('[REDACTED:generic-assignment]');
    expect(rows.every(row => row.provenance === 'verbatim')).toBe(true);
  });

  test('scrubs, attributes, deduplicates, watermarks, and finalizes once', () => {
    const input: HostTranscript = {
      source: 'codex',
      sessionId: 'codex-native-123',
      cwd: '/work/Recall',
      transcriptRef: '/supplied/rollout.jsonl',
      watermark: 'bytes:706',
      capturedAt: '2026-07-01T10:00:03.000Z',
      messages: parseCodexRollout(fixture('codex-rollout.jsonl')).messages,
    };

    const first = ingestHostTranscript(input);
    const duplicate = ingestHostTranscript(input);
    const final = ingestHostTranscript({ ...input, finalize: true });
    const repeatedFinal = ingestHostTranscript({ ...input, finalize: true });

    expect(first.inserted).toBe(2);
    expect(first.redactions).toContain('generic-assignment');
    expect(duplicate).toMatchObject({ inserted: 0, skipped: 2, finalized: false });
    expect(final.finalized).toBe(true);
    expect(final.loaId).toBeNumber();
    expect(repeatedFinal).toMatchObject({ inserted: 0, finalized: false });

    const db = getDb();
    const session = db
      .prepare(
        'SELECT session_id, source, project, cwd, ended_at FROM sessions WHERE session_id = ?'
      )
      .get(input.sessionId) as Record<string, string | null>;
    expect(session).toMatchObject({
      session_id: 'codex-native-123',
      source: 'codex',
      project: 'Recall',
      cwd: '/work/Recall',
    });
    expect(session.ended_at).not.toBeNull();

    const messages = db
      .prepare('SELECT content, provenance FROM messages WHERE session_id = ? ORDER BY id')
      .all(input.sessionId) as Array<{ content: string; provenance: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain('[REDACTED:generic-assignment]');
    expect(messages[0].content).not.toContain('abcdefghijk');
    expect(messages.every(message => message.provenance === 'verbatim')).toBe(true);

    const state = db
      .prepare(`
      SELECT source, transcript_ref, watermark, finalized_at
      FROM host_ingest_state WHERE source = ? AND session_id = ?
    `)
      .get('codex', input.sessionId) as Record<string, string | null>;
    expect(state).toMatchObject({
      source: 'codex',
      transcript_ref: '/supplied/rollout.jsonl',
      watermark: 'bytes:706',
    });
    expect(state.finalized_at).not.toBeNull();
    expect(
      (
        db
          .prepare('SELECT COUNT(*) AS count FROM host_ingest_messages WHERE session_id = ?')
          .get(input.sessionId) as { count: number }
      ).count
    ).toBe(2);
    expect(
      (
        db
          .prepare('SELECT COUNT(*) AS count FROM loa_entries WHERE session_id = ?')
          .get(input.sessionId) as { count: number }
      ).count
    ).toBe(1);
  });

  test('retains message keys when an aged message row is deleted', () => {
    const input: HostTranscript = {
      source: 'codex',
      sessionId: 'codex-pruned-session',
      messages: [{ role: 'user', content: 'retain this lifecycle watermark after pruning' }],
    };
    expect(ingestHostTranscript(input).inserted).toBe(1);

    const db = getDb();
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(input.sessionId);
    const key = db
      .prepare('SELECT message_id FROM host_ingest_messages WHERE session_id = ?')
      .get(input.sessionId) as { message_id: number | null };
    expect(key.message_id).toBeNull();
    expect(ingestHostTranscript(input)).toMatchObject({ inserted: 0, skipped: 1 });
  });

  test('rejects a native session ID already owned by another host', () => {
    ingestHostTranscript({
      source: 'codex',
      sessionId: 'shared-native-id',
      messages: [{ role: 'user', content: 'first host' }],
    });
    expect(() =>
      ingestHostTranscript({
        source: 'grok',
        sessionId: 'shared-native-id',
        messages: [{ role: 'user', content: 'second host' }],
      })
    ).toThrow('already owned by codex');
  });
});
