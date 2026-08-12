import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { handleGrokHostHook, handleHostHook } from '../../src/commands/host-hook';
import { closeDb, getDb, initDb } from '../../src/db/connection';
import { parseCodexRollout } from '../../src/hosts/codex-lifecycle';
import { parseGrokExport } from '../../src/hosts/grok-lifecycle';
import {
  createHostIngestBatch,
  getHostIngestCheckpoint,
  HostIngestCheckpointConflictError,
  ingestHostTranscriptBatch,
  ingestHostTranscript,
  mergeHostIngestResults,
  type HostTranscript,
} from '../../src/lib/host-ingest';
import { SQLITE_SAFE_CHUNK_SIZE } from '../../src/lib/chunk';
import { getLoaMessages, getMessagesSinceLastLoa, search } from '../../src/lib/memory';

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, '..', 'fixtures', 'host-lifecycle', name), 'utf-8');

let tempDir = '';
let previousDbPath: string | undefined;
let previousSkip: string | undefined;
let previousIncludeSubagents: string | undefined;

function expectLifecycleSources(raw: string, messageIds: number[]): void {
  const source = JSON.parse(raw) as {
    table: string;
    loa_id?: number;
    generation_id?: string;
  };
  const stored = source.table === 'host_ingest_generation_messages'
    ? getDb().prepare(`
        SELECT message_id FROM host_ingest_generation_messages
        WHERE generation_id = ? AND content IS NOT NULL
          AND (source <> 'grok' OR source_position IS NOT NULL)
        ORDER BY CASE WHEN source = 'grok' THEN source_position END,
          CASE WHEN source <> 'grok' THEN timestamp END, message_id
      `).all(source.generation_id) as Array<{ message_id: number }>
    : getDb().prepare(`
        SELECT message_id FROM loa_message_sources
        WHERE loa_id = ? ORDER BY ordinal
      `).all(source.loa_id) as Array<{ message_id: number }>;
  expect(stored.map(row => row.message_id)).toEqual(messageIds);
}

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
    const markdown = fixture('grok-export.md');
    const parsed = parseGrokExport(markdown);
    expect(parsed.messages.length).toBeGreaterThan(1);
    expect(parsed.messages.every(message => message.role === 'system')).toBe(true);
    expect(parsed.messages.map(message => message.content).join('')).toBe(markdown);
  });

  test('Grok preserves role-looking Markdown inside exported messages', () => {
    const markdown = `# Grok Session

Session: grok-native-markdown

## Message 1 - User

Keep these ordinary Markdown lines in my message:
## Assistant
**Grok:**
## Message 2 - Assistant

## Message 3 - Grok

They remain verbatim user content.`;
    const parsed = parseGrokExport(markdown);

    expect(parsed.messages.every(message => message.role === 'system')).toBe(true);
    expect(parsed.messages.map(message => message.content).join('')).toBe(markdown);
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
        transcriptSize: () => Buffer.byteLength(fixture('codex-rollout.jsonl')),
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

  test('rejects a transcript session mismatch when subagents are included', () => {
    process.env.RECALL_INCLUDE_SUBAGENTS = '1';
    const result = handleHostHook(
      'codex',
      {
        hook_event_name: 'Stop',
        session_id: 'payload-session',
        transcript_path: '/supplied/rollout.jsonl',
      },
      {
        transcriptSize: () => Buffer.byteLength(fixture('codex-rollout.jsonl')),
        readTranscript: () => fixture('codex-rollout.jsonl'),
      }
    );
    expect(result.skipped).toBe('session-id-mismatch');
  });

  test('uses byte watermarks for unchanged, append-only, and reset reads', () => {
    const sessionId = 'codex-watermark-session';
    const meta = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: sessionId, cwd: '/work/Recall' },
    })}\n`;
    const filler = `${JSON.stringify({ type: 'event_msg', payload: { text: 'x'.repeat(5000) } })}\n`;
    const repeatedContent = 'repeat watermark message';
    const firstMessage = `${JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: repeatedContent }],
      },
    })}\n`;
    let transcript = Buffer.from(meta + filler + firstMessage);
    const starts: number[] = [];
    const dependencies = {
      transcriptSize: () => transcript.length,
      readTranscript: (_path: string, start = 0, length = transcript.length - start) => {
        starts.push(start);
        return transcript.subarray(start, start + length);
      },
    };
    const payload = {
      hook_event_name: 'Stop',
      session_id: sessionId,
      transcript_path: '/supplied/watermark.jsonl',
    };

    expect(handleHostHook('codex', payload, dependencies).ingest?.inserted).toBe(1);
    starts.length = 0;
    expect(handleHostHook('codex', payload, dependencies).skipped).toBe('unchanged-transcript');
    expect(starts).toEqual([]);

    const previousSize = transcript.length;
    transcript = Buffer.concat([
      transcript,
      Buffer.from(
        `${JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: repeatedContent }],
          },
        })}\n`
      ),
    ]);
    starts.length = 0;
    expect(handleHostHook('codex', payload, dependencies).ingest?.inserted).toBe(1);
    expect(starts).toContain(previousSize);
    expect(starts).not.toContain(0);
    expect(
      (
        getDb()
          .prepare('SELECT COUNT(*) AS count FROM published_messages WHERE session_id = ? AND content = ?')
          .get(sessionId, repeatedContent) as { count: number }
      ).count
    ).toBe(2);

    transcript = Buffer.from(meta + filler + firstMessage);
    starts.length = 0;
    expect(handleHostHook('codex', payload, dependencies).ingest?.inserted).toBe(0);
    expect(starts).toContain(0);

    const rewriteIndex = transcript.indexOf('xxx', meta.length);
    expect(rewriteIndex).toBeGreaterThanOrEqual(0);
    expect(rewriteIndex).toBeLessThan(transcript.length - 4096);
    transcript[rewriteIndex] = transcript[rewriteIndex] === 120 ? 121 : 120;
    starts.length = 0;
    expect(handleHostHook('codex', payload, dependencies).skipped).toBe('unchanged-transcript');
    expect(starts).toEqual([]);
    const rewritten = handleHostHook(
      'codex',
      { ...payload, hook_event_name: 'PreCompact' },
      dependencies
    );
    expect(rewritten.skipped).toBeUndefined();
    expect(rewritten.ingest).toBeDefined();
    expect(starts).toContain(0);
  });

  test('Grok exports by native session ID and does not claim SessionStart injection', async () => {
    let exported = '';
    let received: HostTranscript | undefined;
    const start = await handleGrokHostHook({
      hookEventName: 'session_start',
      sessionId: 'grok-native-456',
    });
    expect(start.skipped).toBe('unsupported-event');
    expect(start.stdout).toBeUndefined();
    const stagingBefore = new Set(
      readdirSync(tmpdir()).filter(name => name.startsWith('recall-grok-export-'))
    );

    const result = await handleGrokHostHook(
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
          const stagingDirectories = readdirSync(tmpdir()).filter(
            name => name.startsWith('recall-grok-export-') && !stagingBefore.has(name)
          );
          expect(stagingDirectories).toHaveLength(1);
          expect(readdirSync(join(tmpdir(), stagingDirectories[0]))).toEqual([]);
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
    expect(result.ingest?.inserted).toBe(received?.messages.length);
  });

  test('captures oversized Codex and streamed Grok transcripts in bounded chunks', async () => {
    const maxChunk = 25 * 1024 * 1024;
    const paddingLine = `${JSON.stringify({
      type: 'event_msg',
      payload: { text: 'x'.repeat(64 * 1024) },
    })}\n`;
    const padding = paddingLine.repeat(Math.ceil((maxChunk + 1024) / paddingLine.length));
    const codexSessionId = 'codex-oversized-session';
    const transcript = Buffer.from(
      `${JSON.stringify({ type: 'session_meta', payload: { id: codexSessionId } })}\n` +
      `${JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'first oversized message' }],
        },
      })}\n` +
      padding +
      `${JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'last oversized message' }],
        },
      })}\n`
    );
    const codexLengths: number[] = [];
    const codexFinalization: boolean[] = [];
    const codexIncremental: boolean[] = [];
    const codexBatches: Array<HostTranscript['batch']> = [];
    const codex = handleHostHook(
      'codex',
      {
        hook_event_name: 'SessionEnd',
        session_id: codexSessionId,
        transcript_path: '/supplied/oversized.jsonl',
      },
      {
        transcriptSize: () => transcript.length,
        readTranscript: (_path, start = 0, length = transcript.length - start) => {
          codexLengths.push(length);
          return transcript.subarray(start, start + length);
        },
        ingest: input => {
          codexFinalization.push(Boolean(input.finalize));
          codexIncremental.push(Boolean(input.incremental));
          codexBatches.push(input.batch);
          return {
            sessionId: input.sessionId,
            inserted: input.messages.length,
            skipped: 0,
            finalized: Boolean(input.finalize),
            redactions: [],
            digest: `${input.messages.length}`,
          };
        },
      }
    );
    expect(codex.ingest).toMatchObject({ inserted: 2, finalized: true });
    expect(codexFinalization).toEqual([false, true]);
    expect(codexIncremental).toEqual([false, false]);
    expect(codexBatches[0]).toBeDefined();
    expect(codexBatches[1]).toBe(codexBatches[0]);
    expect(Math.max(...codexLengths)).toBeLessThanOrEqual(maxChunk);

    const grokFinalization: boolean[] = [];
    const grokIncremental: boolean[] = [];
    const grokReconciliation: Array<boolean | undefined> = [];
    let grokBatchCalls = 0;
    const grokBatches: Array<HostTranscript['batch']> = [];
    const grokChunkSizes: number[] = [];
    const grokSourcePositions: number[] = [];
    const grokBlock = Buffer.from('grok export padding\n'.repeat(4096));
    const grok = await handleGrokHostHook(
      { hook_event_name: 'SessionEnd', session_id: 'grok-oversized-session' },
      {
        exportGrokStream: async function* () {
          let emitted = 0;
          while (emitted + grokBlock.length < maxChunk - 1024) {
            yield grokBlock;
            emitted += grokBlock.length;
          }
          yield Buffer.from(`${'second Grok frame '.repeat(8192)}\n`);
        },
        ingestBatch: inputs => {
          grokBatchCalls++;
          let aggregate: ReturnType<typeof ingestHostTranscript> | undefined;
          for (const input of inputs) {
            grokFinalization.push(Boolean(input.finalize));
            grokIncremental.push(Boolean(input.incremental));
            grokReconciliation.push(input.reconcileComplete);
            grokBatches.push(input.batch);
            for (const message of input.messages) {
              grokChunkSizes.push(Buffer.byteLength(message.content));
              grokSourcePositions.push(message.sourcePosition ?? -1);
            }
            aggregate = mergeHostIngestResults(aggregate, {
              sessionId: input.sessionId,
              inserted: input.messages.length,
              skipped: 0,
              finalized: Boolean(input.finalize),
              redactions: [],
              digest: `${input.messages.length}`,
            });
          }
          if (!aggregate) throw new Error('Expected Grok batch inputs');
          return aggregate;
        },
      }
    );
    expect(grok.ingest).toMatchObject({ inserted: 2, finalized: true });
    expect(grokBatchCalls).toBe(1);
    expect(grokFinalization).toEqual([false, true]);
    expect(grokIncremental).toEqual([false, false]);
    expect(grokReconciliation).toEqual([false, true]);
    expect(grokBatches[0]).toBeDefined();
    expect(grokBatches[1]).toBe(grokBatches[0]);
    expect(Math.max(...grokChunkSizes)).toBeLessThanOrEqual(maxChunk);
    expect(grokSourcePositions[0]).toBe(0);
    expect(grokSourcePositions[1]).toBeGreaterThan(grokSourcePositions[0]);
  });

  test('keeps oversized Grok boundaries stable after a prefix insertion', async () => {
    const maxChunk = 25 * 1024 * 1024;
    const raw = Buffer.allocUnsafe(maxChunk + 1024 * 1024);
    let state = 0x12345678;
    for (let index = 0; index < raw.length; index++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      raw[index] = 33 + ((state >>> 24) % 94);
    }
    const body = raw.toString('ascii');
    let markdown = body;

    const capture = async () => {
      const frames: Array<{ digest: string; position: number }> = [];
      await handleGrokHostHook(
        { hook_event_name: 'SessionEnd', session_id: 'grok-content-boundary' },
        {
          exportGrok: () => markdown,
          checkpoint: () => undefined,
          ingest: input => {
            for (const message of input.messages) {
              frames.push({
                digest: createHash('sha256').update(message.content).digest('hex'),
                position: message.sourcePosition ?? -1,
              });
            }
            return {
              sessionId: input.sessionId,
              inserted: input.messages.length,
              skipped: 0,
              finalized: Boolean(input.finalize),
              redactions: [],
              digest: `${input.messages.length}`,
            };
          },
        }
      );
      return frames;
    };

    const first = await capture();
    markdown = `prefix${body}`;
    const second = await capture();
    const stable = second.find(frame => first.some(previous => previous.digest === frame.digest));

    expect(first.length).toBeGreaterThan(1);
    expect(second.length).toBeGreaterThan(1);
    expect(stable).toBeDefined();
    const previous = first.find(frame => frame.digest === stable!.digest)!;
    expect(stable!.position - previous.position).toBe(6);
  }, 15_000);

  test('does not ingest a partial Grok export when the exporter fails', async () => {
    let ingests = 0;
    await expect(handleGrokHostHook(
      { hook_event_name: 'SessionEnd', session_id: 'grok-failed-export' },
      {
        exportGrokStream: async function* () {
          yield Buffer.from('partial export\n');
          throw new Error('export failed');
        },
        ingest: input => {
          ingests += 1;
          return {
            sessionId: input.sessionId,
            inserted: input.messages.length,
            skipped: 0,
            finalized: Boolean(input.finalize),
            redactions: [],
            digest: 'digest',
          };
        },
      }
    )).rejects.toThrow('export failed');
    expect(ingests).toBe(0);
  });

  test('reconciles inserted Grok frames without overlapping snapshots', async () => {
    let markdown = 'Frame A\n\nFrame B';
    const payload = { hook_event_name: 'SessionEnd', session_id: 'grok-frame-rewrite' };
    const dependencies = { exportGrok: () => markdown };

    expect((await handleGrokHostHook(payload, dependencies)).ingest).toMatchObject({ inserted: 2 });
    markdown = 'New frame\n\nFrame A\n\nFrame B';
    expect((await handleGrokHostHook(payload, dependencies)).ingest).toMatchObject({
      inserted: 1,
      skipped: 2,
    });

    const rows = getDb()
      .prepare(`
        SELECT m.id, m.content, h.source_position FROM published_messages m
        JOIN active_host_ingest_messages h ON h.message_id = m.id
        WHERE m.session_id = ? AND h.source_position IS NOT NULL
        ORDER BY h.source_position
      `)
      .all(payload.session_id) as Array<{ id: number; content: string }>;
    expect(rows).toHaveLength(3);
    expect(rows.map(row => row.content).join('')).toBe(markdown);
    expect(rows.some(row => row.content.includes('New frame\n\nFrame A'))).toBe(false);
    const loa = getDb()
      .prepare('SELECT source_ids FROM loa_entries WHERE session_id = ?')
      .get(payload.session_id) as { source_ids: string };
    expectLifecycleSources(loa.source_ids, rows.map(row => row.id));
  });

  test('refreshes finalized Grok lineage after reorder and removal reconciliation', async () => {
    let markdown = 'Frame A\n\nFrame B\n\nFrame C';
    const payload = { hook_event_name: 'SessionEnd', session_id: 'grok-frame-reorder' };
    const dependencies = { exportGrok: () => markdown };

    const initial = await handleGrokHostHook(payload, dependencies);
    markdown = 'Frame C\n\nFrame A\n\nFrame B';
    const reordered = await handleGrokHostHook(payload, dependencies);

    expect(initial.ingest).toMatchObject({ inserted: 3, finalized: true });
    expect(reordered.ingest).toMatchObject({ inserted: 0, finalized: true });
    expect(reordered.ingest?.reconciled).toBeGreaterThan(0);

    const db = getDb();
    const reorderedIds = db.prepare(`
      SELECT m.id FROM published_messages m
      JOIN active_host_ingest_messages h ON h.message_id = m.id
      WHERE m.session_id = ? AND h.source_position IS NOT NULL
      ORDER BY h.source_position
    `).all(payload.session_id) as Array<{ id: number }>;
    const reorderedLoa = db.prepare(`
      SELECT source_ids FROM loa_entries WHERE session_id = ?
    `).get(payload.session_id) as { source_ids: string };
    expectLifecycleSources(reorderedLoa.source_ids, reorderedIds.map(row => row.id));

    markdown = 'Frame C\n\nFrame A';
    const removed = await handleGrokHostHook(payload, dependencies);
    expect(removed.ingest).toMatchObject({ inserted: 0, finalized: true });
    expect(removed.ingest?.reconciled).toBeGreaterThan(0);

    const rows = db.prepare(`
      SELECT m.id, m.content FROM published_messages m
      JOIN active_host_ingest_messages h ON h.message_id = m.id
      WHERE m.session_id = ? AND h.source_position IS NOT NULL
      ORDER BY h.source_position
    `).all(payload.session_id) as Array<{ id: number; content: string }>;
    const loa = db.prepare(`
      SELECT fabric_extract, source_ids FROM loa_entries WHERE session_id = ?
    `).get(payload.session_id) as { fabric_extract: string; source_ids: string };

    expect(rows.map(row => row.content).join('')).toBe(markdown);
    expectLifecycleSources(loa.source_ids, rows.map(row => row.id));
    expect(loa.fabric_extract).toContain('Frame C');
    expect(loa.fabric_extract).toContain('Frame A');
    expect(loa.fabric_extract).not.toContain('Frame B');
  });

  test('replaces finalized Grok lineage for empty terminal exports', async () => {
    for (const [suffix, replacement] of [['empty', ''], ['whitespace', ' \n\t']]) {
      let markdown = 'Frame A\n\nFrame B';
      const sessionId = `grok-${suffix}-terminal-export`;
      const payload = { hook_event_name: 'SessionEnd', session_id: sessionId };
      const dependencies = { exportGrok: () => markdown };

      expect((await handleGrokHostHook(payload, dependencies)).ingest).toMatchObject({
        inserted: 2,
        finalized: true,
      });
      markdown = replacement;
      const reset = await handleGrokHostHook(payload, dependencies);

      expect(reset.ingest).toMatchObject({ inserted: 0, finalized: true });
      expect(reset.ingest?.reconciled).toBeGreaterThan(0);

      const db = getDb();
      const active = db.prepare(`
        SELECT COUNT(*) AS count FROM active_host_ingest_messages
        WHERE source = 'grok' AND session_id = ? AND source_position IS NOT NULL
      `).get(sessionId) as { count: number };
      const loa = db.prepare(`
        SELECT fabric_extract, message_range_start, message_range_end, message_count, source_ids
        FROM loa_entries WHERE session_id = ?
      `).get(sessionId) as {
        fabric_extract: string;
        message_range_start: number | null;
        message_range_end: number | null;
        message_count: number;
        source_ids: string;
      };

      expect(active.count).toBe(0);
      expect(loa.fabric_extract).toContain('No transcript content was present.');
      expect(loa.fabric_extract).not.toContain('Frame A');
      expect(loa.message_range_start).toBeNull();
      expect(loa.message_range_end).toBeNull();
      expect(loa.message_count).toBe(0);
      expectLifecycleSources(loa.source_ids, []);
      expect(getHostIngestCheckpoint('grok', sessionId)).toMatchObject({
        finalized: true,
      });
    }
  });

  test('keeps Grok frame identity stable across incremental delimiters and reset', async () => {
    let markdown = 'Frame A\n';
    const payload = { hook_event_name: 'Stop', session_id: 'grok-delimiter-boundary' };
    const dependencies = { exportGrok: () => markdown };

    expect((await handleGrokHostHook(payload, dependencies)).ingest).toMatchObject({ inserted: 1 });
    markdown = 'Frame A\n\nFrame B';
    expect((await handleGrokHostHook(payload, dependencies)).ingest).toMatchObject({ inserted: 1 });
    expect((await handleGrokHostHook(payload, dependencies)).skipped).toBe('unchanged-transcript');
    getDb().prepare(`
      UPDATE host_ingest_state SET watermark = ? WHERE source = 'grok' AND session_id = ?
    `).run(
      `bytes:${Buffer.byteLength(markdown)}:rolling:0000000000000000`,
      payload.session_id
    );
    expect((await handleGrokHostHook(
      { ...payload, hook_event_name: 'PreCompact' },
      dependencies
    )).ingest).toMatchObject({ inserted: 0, skipped: 2 });

    const rows = getDb()
      .prepare(`
        SELECT m.content FROM published_messages m
        JOIN active_host_ingest_messages h ON h.message_id = m.id
        WHERE m.session_id = ? AND h.source_position IS NOT NULL
        ORDER BY h.source_position
      `)
      .all(payload.session_id) as Array<{ content: string }>;
    expect(rows.map(row => row.content).join('')).toBe(markdown);
    expect(rows.map(row => row.content)).toEqual(['Frame A', '\n\nFrame B']);
  });

  test('persists terminal state for an unchanged Grok export', async () => {
    const sessionId = 'grok-unchanged-terminal';
    const dependencies = { exportGrok: () => 'Frame A\n\nFrame B' };

    expect((await handleGrokHostHook(
      { hook_event_name: 'Stop', session_id: sessionId },
      dependencies
    )).ingest).toMatchObject({ inserted: 2, finalized: false });
    expect(getHostIngestCheckpoint('grok', sessionId)).toMatchObject({ finalized: false });

    expect((await handleGrokHostHook(
      { hook_event_name: 'SessionEnd', session_id: sessionId },
      dependencies
    )).ingest).toMatchObject({ inserted: 0, finalized: true });
    expect(getHostIngestCheckpoint('grok', sessionId)).toMatchObject({ finalized: true });
  });

  test('validates a terminal Grok Stop before finalizing', async () => {
    let markdown = 'Frame A';
    const payload = { hook_event_name: 'Stop', session_id: 'grok-terminal-stop' };
    const dependencies = { exportGrok: () => markdown };

    expect((await handleGrokHostHook(payload, dependencies)).ingest).toMatchObject({
      inserted: 1,
      finalized: false,
    });
    markdown = 'Frame B';
    expect((await handleGrokHostHook(
      { ...payload, reason: 'channel_closed' },
      dependencies
    )).ingest).toMatchObject({ inserted: 1, finalized: true });

    const loa = getDb()
      .prepare('SELECT fabric_extract FROM loa_entries WHERE session_id = ?')
      .get(payload.session_id) as { fabric_extract: string };
    expect(loa.fabric_extract).toContain('Frame B');
    expect(loa.fabric_extract).not.toContain('Frame A');
  });

  test('recomputes Grok capture after a checkpoint conflict', async () => {
    const markdown = 'Frame A\n\nFrame B';
    await handleGrokHostHook(
      { hook_event_name: 'SessionEnd', session_id: 'grok-checkpoint-source' },
      { exportGrok: () => markdown }
    );
    const advanced = getHostIngestCheckpoint('grok', 'grok-checkpoint-source');
    let checkpointReads = 0;
    let batchCalls = 0;
    let exports = 0;
    const exportTimeouts: number[] = [];

    const result = await handleGrokHostHook(
      { hook_event_name: 'Stop', session_id: 'grok-checkpoint-retry' },
      {
        exportGrok: (_sessionId, timeoutMs) => {
          exports++;
          exportTimeouts.push(timeoutMs ?? 0);
          return markdown;
        },
        checkpoint: () => checkpointReads++ === 0 ? undefined : advanced,
        ingestBatch: () => {
          batchCalls++;
          throw new HostIngestCheckpointConflictError('grok', 'grok-checkpoint-retry');
        },
      }
    );

    expect(result).toEqual({ skipped: 'unchanged-transcript' });
    expect(exports).toBe(2);
    expect(exportTimeouts.every(timeout => timeout > 0 && timeout <= 30_000)).toBe(true);
    expect(checkpointReads).toBe(2);
    expect(batchCalls).toBe(1);
  });
});

describe('host-neutral immediate SQLite ingest', () => {
  test('prepares scrubbed host batches before acquiring the write lock', () => {
    const db = getDb();
    let contentReads = 0;
    const message = {
      role: 'system' as const,
      get content() {
        contentReads++;
        expect(db.inTransaction).toBe(false);
        return 'password=abcdefghijk';
      },
    };

    const result = ingestHostTranscriptBatch([{
      source: 'grok',
      sessionId: 'grok-prepared-before-lock',
      messages: [message],
      batch: createHostIngestBatch(),
    }]);

    expect(contentReads).toBeGreaterThan(0);
    expect(result.redactions).toContain('generic-assignment');
  });

  test('rejects an expired ingest generation before publication', () => {
    const sessionId = 'grok-expired-generation';
    expect(() => ingestHostTranscriptBatch([{
      source: 'grok',
      sessionId,
      messages: [{ role: 'system', content: 'Frame A', sourcePosition: 0 }],
      batch: createHostIngestBatch(),
    }], undefined, Date.now() - 1)).toThrow('Host lifecycle ingest deadline exhausted');

    expect(getDb().prepare('SELECT 1 FROM sessions WHERE session_id = ?').get(sessionId))
      .toBeNull();
  });

  test('lets SQLite allocate staged message IDs after retired rows', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO sessions (session_id, started_at, source) VALUES (?, ?, 'grok')
    `).run('retired-message-session', '2026-08-12T10:00:00.000Z');
    const retired = db.prepare(`
      INSERT INTO messages (session_id, timestamp, role, content, provenance)
      VALUES (?, ?, 'system', 'retired', 'verbatim')
    `).run('retired-message-session', '2026-08-12T10:00:00.000Z');
    db.prepare('DELETE FROM messages WHERE id = ?').run(retired.lastInsertRowid);

    ingestHostTranscriptBatch([{
      source: 'grok',
      sessionId: 'sqlite-allocated-message',
      messages: [{ role: 'system', content: 'current', sourcePosition: 0 }],
      batch: createHostIngestBatch(),
    }]);

    const current = db.prepare(`
      SELECT message.id FROM published_messages AS message
      JOIN active_host_ingest_messages AS stored ON stored.message_id = message.id
      WHERE stored.session_id = ?
    `).get('sqlite-allocated-message') as { id: number };
    expect(current.id).toBeGreaterThan(Number(retired.lastInsertRowid));
  });

  test('materializes staged mappings outside live messages and FTS', () => {
    const sessionId = 'set-wise-generation';
    const messages = Array.from({ length: SQLITE_SAFE_CHUNK_SIZE + 1 }, (_, index) => ({
      role: 'system' as const,
      content: `Frame ${index}`,
      nativeId: `frame-${index}`,
      sourcePosition: index,
    }));

    expect(ingestHostTranscriptBatch([{
      source: 'grok',
      sessionId,
      messages,
      batch: createHostIngestBatch(),
    }])).toMatchObject({ inserted: messages.length });

    const stored = getDb().prepare(`
      SELECT COUNT(*) AS count, COUNT(DISTINCT stored.message_id) AS distinct_ids,
        COUNT(DISTINCT stored.generation_id) AS generations
      FROM host_ingest_generation_messages AS stored
      JOIN host_ingest_state AS state ON state.active_generation = stored.generation_id
      WHERE stored.session_id = ?
    `).get(sessionId) as { count: number; distinct_ids: number; generations: number };
    expect(stored).toEqual({
      count: messages.length,
      distinct_ids: messages.length,
      generations: 1,
    });
    expect(getDb().prepare(`
      SELECT COUNT(*) AS count FROM messages WHERE session_id = ?
    `).get(sessionId)).toEqual({ count: 0 });
    expect(getDb().prepare(`
      SELECT COUNT(*) AS count FROM messages_fts_docsize WHERE id IN (
        SELECT message_id FROM host_ingest_generation_messages WHERE session_id = ?
      )
    `).get(sessionId)).toEqual({ count: 0 });
    expect(search('Frame 500', { table: 'messages' }).map(result => result.content))
      .toContain('Frame 500');
  });

  test('hides shadow rows until their lifecycle keys are published', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO host_ingest_generations
        (generation_id, source, session_id, created_at, status)
      VALUES ('pending:1', 'grok', 'shadow-visibility', ?, 'pending')
    `).run(new Date().toISOString());
    db.prepare(`
      INSERT INTO host_ingest_generation_messages (
        generation_id, ordinal, source, session_id, message_key, message_id,
        timestamp, role, content, provenance, source_position
      ) VALUES ('pending:1', 1, 'grok', 'shadow-visibility', 'native:pending',
        9000001, '2026-08-12T10:00:00.000Z', 'system', 'pending frame', 'verbatim', 0)
    `).run();

    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM published_messages WHERE session_id = ?
    `).get('shadow-visibility')).toEqual({ count: 0 });

    db.prepare(`
      INSERT INTO sessions (session_id, started_at, source)
      VALUES ('shadow-visibility', '2026-08-12T10:00:00.000Z', 'grok')
    `).run();
    db.prepare(`
      INSERT INTO host_ingest_state (
        source, session_id, transcript_digest, active_generation, updated_at
      ) VALUES ('grok', 'shadow-visibility', 'digest', 'pending:1', ?)
    `).run(new Date().toISOString());
    db.prepare(`
      UPDATE host_ingest_generations SET status = 'active'
      WHERE generation_id = 'pending:1'
    `).run();
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM published_messages WHERE session_id = ?
    `).get('shadow-visibility')).toEqual({ count: 1 });
  });

  test('sweeps stale unpublished generations across sessions', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO host_ingest_generations
        (generation_id, source, session_id, created_at, status)
      VALUES ('stale:other', 'grok', 'abandoned-session', '2000-01-01T00:00:00.000Z', 'pending')
    `).run();
    db.prepare(`
      INSERT INTO host_ingest_generation_messages (
        generation_id, ordinal, source, session_id, message_key, message_id,
        timestamp, role, content, provenance, source_position
      ) VALUES ('stale:other', 1, 'grok', 'abandoned-session', 'native:stale',
        9000002, '2000-01-01T00:00:00.000Z', 'system', 'stale frame', 'verbatim', 0)
    `).run();

    ingestHostTranscript({
      source: 'codex',
      sessionId: 'stale-generation-sweeper',
      messages: [{ role: 'user', content: 'sweep now' }],
    });

    expect(db.prepare(`
      SELECT 1 FROM host_ingest_generations WHERE generation_id = 'stale:other'
    `).get()).toBeNull();
    expect(db.prepare(`
      SELECT 1 FROM host_ingest_generation_messages WHERE generation_id = 'stale:other'
    `).get()).toBeNull();
  });

  test('discards a shadow generation when checkpoint activation loses', () => {
    const sessionId = 'shadow-checkpoint-conflict';
    expect(() => ingestHostTranscriptBatch([{
      source: 'grok',
      sessionId,
      messages: [{ role: 'system', content: 'pending', sourcePosition: 0 }],
      batch: createHostIngestBatch(),
    }], {
      source: 'grok',
      sessionId,
      checkpoint: { watermark: 'stale', finalized: false },
    })).toThrow(HostIngestCheckpointConflictError);

    expect(getDb().prepare('SELECT 1 FROM messages WHERE session_id = ?').get(sessionId))
      .toBeNull();
    expect(getDb().prepare(`
      SELECT 1 FROM host_ingest_generations WHERE session_id = ?
    `).get(sessionId)).toBeNull();
    expect(getDb().prepare('SELECT 1 FROM sessions WHERE session_id = ?').get(sessionId))
      .toBeNull();
  });

  test('records the global high-water cursor for an empty terminal capture', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO sessions (session_id, started_at, source)
      VALUES ('prior-session', '2026-08-12T09:00:00.000Z', 'mcp')
    `).run();
    const prior = db.prepare(`
      INSERT INTO messages (session_id, timestamp, role, content, provenance)
      VALUES ('prior-session', '2026-08-12T09:00:00.000Z', 'user', 'prior', 'verbatim')
    `).run();
    db.prepare(`
      INSERT INTO host_ingest_generations
        (generation_id, source, session_id, created_at, status)
      VALUES ('pending:high-water', 'grok', 'pending-session', ?, 'pending')
    `).run(new Date().toISOString());
    db.prepare(`
      INSERT INTO host_ingest_generation_messages (
        generation_id, ordinal, source, session_id, message_key, message_id,
        timestamp, role, content, provenance, source_position
      ) VALUES ('pending:high-water', 1, 'grok', 'pending-session', 'native:pending',
        ?, '2026-08-12T09:30:00.000Z', 'system', 'pending', 'verbatim', 0)
    `).run(Number(prior.lastInsertRowid) + 1000);

    const result = ingestHostTranscriptBatch([{
      source: 'grok',
      sessionId: 'empty-terminal-cursor',
      messages: [],
      incremental: false,
      reconcileComplete: true,
      finalize: true,
      batch: createHostIngestBatch(),
    }]);
    expect(db.prepare(`
      SELECT snapshot_max_message_id FROM loa_entries WHERE id = ?
    `).get(result.loaId!)).toEqual({ snapshot_max_message_id: Number(prior.lastInsertRowid) });
    expect(getMessagesSinceLastLoa().messages).toEqual([]);

    const next = db.prepare(`
      INSERT INTO messages (session_id, timestamp, role, content, provenance)
      VALUES ('prior-session', '2026-08-12T11:00:00.000Z', 'assistant', 'next', 'verbatim')
    `).run();
    expect(getMessagesSinceLastLoa().messages.map(message => message.id))
      .toEqual([Number(next.lastInsertRowid)]);
  });

  test('pins finalized LoA evidence across non-terminal reconciliation', () => {
    const sessionId = 'grok-pinned-loa-evidence';
    const initial = ingestHostTranscript({
      source: 'grok',
      sessionId,
      messages: [
        { role: 'system', content: 'Frame A', sourcePosition: 0 },
        { role: 'system', content: 'Frame B', sourcePosition: 7 },
      ],
      incremental: false,
      reconcileComplete: true,
      finalize: true,
    });

    expect(getLoaMessages(initial.loaId!).map(message => message.content)).toEqual([
      'Frame A',
      'Frame B',
    ]);

    const reconciled = ingestHostTranscript({
      source: 'grok',
      sessionId,
      messages: [
        {
          role: 'system',
          content: 'Frame B updated',
          identityContent: 'Frame B',
          sourcePosition: 0,
        },
        { role: 'system', content: 'Frame A', sourcePosition: 16 },
      ],
      incremental: false,
      reconcileComplete: true,
      finalize: false,
    });

    expect(reconciled.reconciled).toBeGreaterThan(0);
    const active = getDb().prepare(`
      SELECT message.content FROM published_messages AS message
      JOIN active_host_ingest_messages AS stored ON stored.message_id = message.id
      WHERE stored.source = 'grok' AND stored.session_id = ?
        AND stored.source_position IS NOT NULL
      ORDER BY stored.source_position
    `).all(sessionId) as Array<{ content: string }>;
    expect(active.map(message => message.content)).toEqual(['Frame B updated', 'Frame A']);
    expect(getLoaMessages(initial.loaId!).map(message => message.content)).toEqual([
      'Frame A',
      'Frame B',
    ]);
  });

  test('rolls back every Grok reset mutation when its batch is interrupted', () => {
    const sessionId = 'grok-interrupted-reset';
    const transcriptRef = 'grok export';
    const initialBatch = createHostIngestBatch();
    const initial = ingestHostTranscript({
      source: 'grok',
      sessionId,
      transcriptRef,
      watermark: 'bytes:16:rolling:1111111122222222',
      messages: [
        { role: 'system', content: 'Frame A\n\n', sourcePosition: 0 },
        { role: 'system', content: 'Frame B', sourcePosition: 9 },
      ],
      incremental: false,
      reconcileComplete: true,
      finalize: true,
      batch: initialBatch,
    });
    expect(initial).toMatchObject({ inserted: 2, finalized: true });

    const interruptedBatch = createHostIngestBatch();
    const interruptedReset: HostTranscript[] = [
      {
        source: 'grok',
        sessionId,
        transcriptRef,
        watermark: 'bytes:14:rolling:3333333344444444',
        messages: [
          {
            role: 'system',
            content: 'Frame B updated',
            identityContent: 'Frame B',
            sourcePosition: 0,
          },
          { role: 'system', content: 'Frame C', sourcePosition: 7 },
        ],
        incremental: false,
        reconcileComplete: false,
        batch: interruptedBatch,
      },
      {
        source: 'codex',
        sessionId,
        transcriptRef,
        watermark: 'bytes:14:rolling:3333333344444444',
        messages: [],
      },
    ];
    expect(() => ingestHostTranscriptBatch(interruptedReset)).toThrow('already owned by grok');

    const db = getDb();
    const originalRows = db.prepare(`
      SELECT m.id, m.content, h.source_position FROM published_messages m
      JOIN active_host_ingest_messages h ON h.message_id = m.id
      WHERE h.source = 'grok' AND h.session_id = ? AND h.source_position IS NOT NULL
      ORDER BY h.source_position
    `).all(sessionId) as Array<{ id: number; content: string; source_position: number }>;
    const originalLoa = db.prepare('SELECT source_ids FROM loa_entries WHERE session_id = ?')
      .get(sessionId) as { source_ids: string };

    expect(originalRows.map(row => [row.content, row.source_position])).toEqual([
      ['Frame A\n\n', 0],
      ['Frame B', 9],
    ]);
    expectLifecycleSources(originalLoa.source_ids, originalRows.map(row => row.id));
    expect(getHostIngestCheckpoint('grok', sessionId)).toMatchObject({
      watermark: 'bytes:16:rolling:1111111122222222',
      finalized: true,
    });

    const retryBatch = createHostIngestBatch();
    const retry = ingestHostTranscriptBatch([{
      source: 'grok',
      sessionId,
      transcriptRef,
      watermark: 'bytes:7:rolling:5555555566666666',
      messages: [{ role: 'system', content: 'Frame B', sourcePosition: 0 }],
      incremental: false,
      reconcileComplete: true,
      finalize: true,
      batch: retryBatch,
    }]);
    expect(retry).toMatchObject({ inserted: 0, finalized: true });

    const rows = db.prepare(`
      SELECT m.id, m.content FROM published_messages m
      JOIN active_host_ingest_messages h ON h.message_id = m.id
      WHERE h.source = 'grok' AND h.session_id = ? AND h.source_position IS NOT NULL
      ORDER BY h.source_position
    `).all(sessionId) as Array<{ id: number; content: string }>;
    const loa = db.prepare('SELECT source_ids FROM loa_entries WHERE session_id = ?')
      .get(sessionId) as { source_ids: string };

    expect(rows.map(row => row.content)).toEqual(['Frame B']);
    expectLifecycleSources(loa.source_ids, rows.map(row => row.id));
    expect(getHostIngestCheckpoint('grok', sessionId)).toMatchObject({
      watermark: 'bytes:7:rolling:5555555566666666',
      finalized: true,
    });
  });

  test('rejects a stale Grok checkpoint before publishing duplicate suffixes', () => {
    const sessionId = 'grok-stale-checkpoint';
    const transcriptRef = 'grok export';
    ingestHostTranscript({
      source: 'grok',
      sessionId,
      transcriptRef,
      watermark: 'bytes:7:rolling:1111111122222222',
      messages: [{ role: 'system', content: 'Frame A', sourcePosition: 0 }],
      incremental: false,
      reconcileComplete: true,
      batch: createHostIngestBatch(),
    });
    const stale = getHostIngestCheckpoint('grok', sessionId);
    const suffix = (): HostTranscript => ({
      source: 'grok',
      sessionId,
      transcriptRef,
      watermark: 'bytes:16:rolling:3333333344444444',
      messages: [{ role: 'system', content: '\n\nFrame B', sourcePosition: 7 }],
      incremental: true,
      batch: createHostIngestBatch(),
    });

    expect(ingestHostTranscriptBatch([suffix()], {
      source: 'grok',
      sessionId,
      checkpoint: stale,
    })).toMatchObject({ inserted: 1 });
    expect(() => ingestHostTranscriptBatch([suffix()], {
      source: 'grok',
      sessionId,
      checkpoint: stale,
    })).toThrow(HostIngestCheckpointConflictError);

    const rows = getDb()
      .prepare('SELECT content FROM published_messages WHERE session_id = ? ORDER BY id')
      .all(sessionId) as Array<{ content: string }>;
    expect(rows.map(row => row.content)).toEqual(['Frame A', '\n\nFrame B']);
  });

  test('shares fallback occurrences across reset batch chunks', () => {
    const batch = createHostIngestBatch();
    const input: HostTranscript = {
      source: 'codex',
      sessionId: 'codex-reset-batch-occurrences',
      messages: [{ role: 'user', content: 'Continue.' }],
      capturedAt: '2026-07-01T10:00:00.000Z',
      incremental: false,
      batch,
    };

    expect(ingestHostTranscript(input)).toMatchObject({ inserted: 1 });
    expect(ingestHostTranscript(input)).toMatchObject({ inserted: 1 });

    const rows = getDb()
      .prepare('SELECT timestamp FROM published_messages WHERE session_id = ? ORDER BY id')
      .all(input.sessionId) as Array<{ timestamp: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[1].timestamp > rows[0].timestamp).toBe(true);
  });

  test('reconciles fallback keys across append-only and reset captures', () => {
    const sessionId = 'codex-fallback-reconciliation';
    const first = { role: 'user' as const, content: 'First retained turn.' };
    const second = { role: 'assistant' as const, content: 'Second retained turn.' };

    expect(ingestHostTranscript({
      source: 'codex',
      sessionId,
      messages: [first, second],
    })).toMatchObject({ inserted: 2 });
    expect(ingestHostTranscript({
      source: 'codex',
      sessionId,
      messages: [second],
    })).toMatchObject({ inserted: 0, skipped: 1 });
    expect(ingestHostTranscript({
      source: 'codex',
      sessionId,
      messages: [second],
      incremental: true,
    })).toMatchObject({ inserted: 1 });
    expect(ingestHostTranscript({
      source: 'codex',
      sessionId,
      messages: [second, second],
    })).toMatchObject({ inserted: 0, skipped: 2 });

    const rows = getDb()
      .prepare('SELECT content FROM published_messages WHERE session_id = ? ORDER BY id')
      .all(sessionId) as Array<{ content: string }>;
    expect(rows.map(row => row.content)).toEqual([
      first.content,
      second.content,
      second.content,
    ]);
  });

  test('Grok export capture writes automatic rows immediately and deduplicates replay', async () => {
    const payload = {
      hookEventName: 'SessionEnd',
      sessionId: 'grok-native-456',
      workspaceRoot: '/work/Recall',
    };
    const dependencies = { exportGrok: () => fixture('grok-export.md') };

    const first = await handleGrokHostHook(payload, dependencies);
    const replay = await handleGrokHostHook(payload, dependencies);

    expect(first.ingest?.redactions).toContain('generic-assignment');

    const db = getDb();
    const rows = db
      .prepare('SELECT content, provenance FROM published_messages WHERE session_id = ? ORDER BY id')
      .all('grok-native-456') as Array<{ content: string; provenance: string }>;
    expect(first.ingest).toMatchObject({ inserted: rows.length, finalized: true });
    expect(replay.skipped).toBe('unchanged-transcript');
    expect(replay.ingest).toBeUndefined();

    expect(rows).toHaveLength(
      parseGrokExport(fixture('grok-export.md')).messages.filter(
        message => message.content.trim()
      ).length
    );
    expect(rows.some(row => row.content.includes('[REDACTED:generic-assignment]'))).toBe(true);
    expect(rows.every(row => row.provenance === 'verbatim')).toBe(true);
    const summary = db
      .prepare('SELECT fabric_extract FROM loa_entries WHERE session_id = ?')
      .get('grok-native-456') as { fabric_extract: string };
    expect(summary.fabric_extract).toContain('Recall will redact the credential before writing.');
    expect(summary.fabric_extract).not.toContain('No user messages');
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
      .prepare('SELECT content, provenance FROM published_messages WHERE session_id = ? ORDER BY id')
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
          .prepare('SELECT COUNT(*) AS count FROM active_host_ingest_messages WHERE session_id = ?')
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
      messages: [
        { role: 'user', content: 'retained before pruning' },
        { role: 'assistant', content: 'remove this lifecycle body during pruning' },
        { role: 'user', content: 'retained after pruning' },
      ],
    };
    const finalized = ingestHostTranscript({ ...input, finalize: true });
    expect(finalized.inserted).toBe(3);

    const db = getDb();
    const pruned = db.prepare(`
      SELECT id FROM published_messages WHERE session_id = ? AND content = ?
    `).get(input.sessionId, input.messages[1].content) as { id: number };
    db.prepare(`
      UPDATE host_ingest_generation_messages SET content = NULL WHERE message_id = ?
    `).run(pruned.id);
    const key = db
      .prepare(`
        SELECT message_id, content FROM host_ingest_generation_messages
        WHERE session_id = ? AND message_id = ? ORDER BY generation_id DESC LIMIT 1
      `)
      .get(input.sessionId, pruned.id) as { message_id: number; content: string | null };
    expect(key).toEqual({ message_id: pruned.id, content: null });
    const audit = db.prepare(`
      SELECT message_id, content FROM host_ingest_generation_messages
      WHERE generation_id = json_extract(
        (SELECT source_ids FROM loa_entries WHERE id = ?), '$.generation_id'
      ) AND message_id = ?
    `).get(finalized.loaId!, pruned.id) as { message_id: number; content: string | null };
    expect(audit.message_id).toBe(pruned.id);
    expect(audit.content).toBeNull();
    expect(getLoaMessages(finalized.loaId!).map(message => message.content)).toEqual([
      input.messages[0].content,
      input.messages[2].content,
    ]);
    expect(ingestHostTranscript(input)).toMatchObject({ inserted: 0, skipped: 3 });
  });

  test('preserves pruned terminal summaries and invalidates stale embeddings on resume', () => {
    const sessionId = 'codex-pruned-resume';
    const first = { role: 'user' as const, content: 'Initial retained request.' };
    const pruned = { role: 'assistant' as const, content: 'Pruned answer preserved by summary.' };
    const boundary = { role: 'system' as const, content: 'Initial terminal boundary.' };
    const resumed = { role: 'assistant' as const, content: 'Resumed terminal answer.' };
    const initial = ingestHostTranscript({
      source: 'codex',
      sessionId,
      messages: [first, pruned, boundary],
      finalize: true,
    });
    const db = getDb();
    const rows = db.prepare('SELECT id, content FROM published_messages WHERE session_id = ? ORDER BY id')
      .all(sessionId) as Array<{ id: number; content: string }>;
    db.prepare(`
      UPDATE host_ingest_generation_messages SET content = NULL WHERE message_id = ?
    `).run(rows[1].id);
    db.prepare(`
      INSERT INTO embeddings (source_table, source_id, model, dimensions, embedding)
      VALUES ('loa_entries', ?, 'test', 1, ?)
    `).run(initial.loaId!, Buffer.alloc(4));

    const refreshed = ingestHostTranscript({
      source: 'codex',
      sessionId,
      messages: [first, pruned, boundary, resumed],
      finalize: true,
    });

    expect(refreshed).toMatchObject({ inserted: 1, finalized: true, loaId: initial.loaId });
    const loa = db.prepare(`
      SELECT fabric_extract, message_count FROM loa_entries WHERE id = ?
    `).get(initial.loaId!) as { fabric_extract: string; message_count: number };
    expect(loa.message_count).toBe(4);
    expect(loa.fabric_extract).toContain(pruned.content);
    expect(loa.fabric_extract).toContain(resumed.content);
    expect(
      (
        db.prepare(`
          SELECT COUNT(*) AS count FROM embeddings
          WHERE source_table = 'loa_entries' AND source_id = ?
        `).get(initial.loaId!) as { count: number }
      ).count
    ).toBe(0);
    expect(
      db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('vec_index_dirty')
    ).toEqual({ value: '1' });

    db.prepare('DELETE FROM schema_meta WHERE key = ?').run('vec_index_dirty');
    const secondResume = {
      role: 'assistant' as const,
      content: 'Second resumed terminal answer.',
    };
    const secondRefresh = ingestHostTranscript({
      source: 'codex',
      sessionId,
      messages: [first, pruned, boundary, resumed, secondResume],
      finalize: true,
    });
    expect(secondRefresh).toMatchObject({ inserted: 1, finalized: true, loaId: initial.loaId });
    const finalExtract = (
      db.prepare('SELECT fabric_extract FROM loa_entries WHERE id = ?').get(initial.loaId!) as {
        fabric_extract: string;
      }
    ).fabric_extract;
    expect(finalExtract.split(first.content)).toHaveLength(2);
    expect(finalExtract.split(resumed.content)).toHaveLength(2);
    expect(finalExtract).toContain(secondResume.content);
    expect(finalExtract.match(/## RESUMED SESSION UPDATE/g) ?? []).toHaveLength(2);
    expect(
      db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('vec_index_dirty')
    ).toBeNull();
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
