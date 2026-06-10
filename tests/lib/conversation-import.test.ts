import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupTestDb, teardownTestDb } from '../helpers/setup';
import {
  conversationSourceAdapters,
  detectConversationFormat,
  importConversations,
  parseSlackConversations,
} from '../../src/lib/conversation-import';

const EXTRACT_FIXTURE = `## ONE SENTENCE SUMMARY
Imported conversations can become structured memory.

## MAIN IDEAS
- Multi-format imports should pass through extraction
- Raw messages remain searchable at lower priority

## DECISIONS MADE
- Use adapter normalization before persistence (confidence: HIGH)

## ERRORS FIXED
- Missing source attribution: store sessions.source from the adapter
`;

let dbPath: string;
let tempDir: string;

beforeEach(() => {
  dbPath = setupTestDb();
  tempDir = mkdtempSync(join(tmpdir(), 'recall-conv-import-'));
});

afterEach(() => {
  teardownTestDb();
  rmSync(tempDir, { recursive: true, force: true });
});

function readDb(): Database {
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  return db;
}

describe('detectConversationFormat', () => {
  test('detects ChatGPT, Claude.ai, and Slack JSON shapes', () => {
    expect(detectConversationFormat([{ mapping: {}, current_node: 'x' }])).toBe('chatgpt');
    expect(detectConversationFormat([{ uuid: 'c1', chat_messages: [{ sender: 'human', text: 'hi' }] }])).toBe('claude-ai');
    expect(detectConversationFormat([{ ts: '1710000000.000100', user: 'U1', text: 'hello' }])).toBe('slack');
  });
});

describe('importConversations', () => {
  test('imports ChatGPT conversations as raw messages with source metadata when extraction is disabled', async () => {
    const file = join(tempDir, 'conversations.json');
    writeFileSync(file, JSON.stringify([
      {
        id: 'chat-1',
        title: 'Recall import',
        current_node: 'm2',
        mapping: {
          root: { id: 'root', parent: null, children: ['m1'], message: null },
          m1: {
            id: 'm1', parent: 'root', children: ['m2'],
            message: {
              author: { role: 'user' },
              create_time: 1710000000,
              content: { content_type: 'text', parts: ['Can Recall import this?'] },
            },
          },
          m2: {
            id: 'm2', parent: 'm1', children: [],
            message: {
              author: { role: 'assistant' },
              create_time: 1710000002,
              content: { content_type: 'text', parts: ['Yes, via normalized adapters.'] },
            },
          },
        },
      },
    ]));

    const result = await importConversations(file, { format: 'auto', noExtract: true });

    expect(result.sessionsFound).toBe(1);
    expect(result.sessionsImported).toBe(1);
    expect(result.messagesImported).toBe(2);
    expect(result.extractedSessions).toBe(0);

    const db = readDb();
    const session = db.prepare('SELECT source, project, summary FROM sessions').get() as any;
    const messages = db.prepare('SELECT role, content, project FROM messages ORDER BY timestamp').all() as any[];
    db.close();

    expect(session.source).toBe('chatgpt');
    expect(session.project).toBe('chatgpt');
    expect(session.summary).toContain('Imported chatgpt');
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(messages[0].content).toContain('Can Recall import this?');
  });

  test('maps Slack humans to user and bot messages to assistant while preserving sender attribution', () => {
    const file = join(tempDir, '2026-05-31.json');
    const slack = [
      { ts: '1710000000.000100', user: 'U1', user_profile: { real_name: 'Ada Lovelace' }, text: 'ship it' },
      { ts: '1710000001.000200', bot_id: 'B1', username: 'Recall Bot', subtype: 'bot_message', text: 'import finished' },
    ];

    const sessions = parseSlackConversations(slack, file, undefined, tempDir);

    expect(sessions.length).toBe(1);
    expect(sessions[0].messages.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(sessions[0].messages[0].content).toContain('[Ada Lovelace] ship it');
    expect(sessions[0].messages[1].content).toContain('[Recall Bot] import finished');
  });

  test('runs extraction by default and writes LoA, decisions, learnings, breadcrumbs, and extraction session metadata', async () => {
    const file = join(tempDir, 'claude.json');
    writeFileSync(file, JSON.stringify([
      {
        uuid: 'claude-1',
        name: 'Claude export',
        chat_messages: [
          { sender: 'human', created_at: '2026-05-31T10:00:00Z', text: 'Please import this conversation.' },
          { sender: 'assistant', created_at: '2026-05-31T10:00:01Z', text: 'I can normalize it first.' },
        ],
      },
    ]));

    const result = await importConversations(
      file,
      { format: 'claude-ai' },
      { extractor: async () => EXTRACT_FIXTURE }
    );

    expect(result.sessionsImported).toBe(1);
    expect(result.messagesImported).toBe(2);
    expect(result.extractedSessions).toBe(1);
    expect(result.structuredWrites.loa).toBe(1);
    expect(result.structuredWrites.decisions).toBe(1);
    expect(result.structuredWrites.learnings).toBe(1);
    expect(result.structuredWrites.breadcrumbs).toBe(2);

    const db = readDb();
    const counts = {
      loa: (db.prepare('SELECT COUNT(*) c FROM loa_entries').get() as any).c,
      decisions: (db.prepare('SELECT COUNT(*) c FROM decisions').get() as any).c,
      learnings: (db.prepare('SELECT COUNT(*) c FROM learnings').get() as any).c,
      breadcrumbs: (db.prepare('SELECT COUNT(*) c FROM breadcrumbs').get() as any).c,
      extractionSessions: (db.prepare('SELECT COUNT(*) c FROM extraction_sessions').get() as any).c,
    };
    const loa = db.prepare('SELECT message_range_start, message_range_end, message_count FROM loa_entries').get() as any;
    db.close();

    expect(counts).toEqual({ loa: 1, decisions: 1, learnings: 1, breadcrumbs: 2, extractionSessions: 1 });
    expect(loa.message_range_start).toBeGreaterThan(0);
    expect(loa.message_range_end).toBeGreaterThanOrEqual(loa.message_range_start);
    expect(loa.message_count).toBe(2);
  });

  test('returns zero sessions for unrecognized JSON under auto without throwing', async () => {
    const file = join(tempDir, 'mystery.json');
    writeFileSync(file, JSON.stringify({ foo: 'bar' }));

    const result = await importConversations(file, { format: 'auto', noExtract: true });

    expect(result.sessionsFound).toBe(0);
    expect(result.sessionsImported).toBe(0);
  });

  test('returns zero sessions when an explicit format does not match the data', async () => {
    const file = join(tempDir, 'chatgpt-as-slack.json');
    writeFileSync(file, JSON.stringify([
      {
        id: 'chat-explicit-1',
        title: 'Wrong format',
        current_node: 'm1',
        mapping: {
          m1: {
            id: 'm1', parent: null, children: [],
            message: {
              author: { role: 'user' },
              create_time: 1710000000,
              content: { content_type: 'text', parts: ['hi'] },
            },
          },
        },
      },
    ]));

    const result = await importConversations(file, { format: 'slack', noExtract: true });

    expect(result.sessionsFound).toBe(0);
    expect(result.sessionsImported).toBe(0);
  });
});

describe('conversationSourceAdapters', () => {
  test('registers exactly chatgpt, claude-ai, and slack in detection order', () => {
    expect(conversationSourceAdapters.map(adapter => adapter.source)).toEqual([
      'chatgpt',
      'claude-ai',
      'slack',
    ]);
  });

  // Payload matches BOTH the chatgpt detector (object-valued `mapping`) and the
  // claude-ai detector (`chat_messages` with a `sender`); chatgpt wins by registry order.
  test('resolves a chatgpt/claude-ai dual-match payload as chatgpt', () => {
    expect(detectConversationFormat([{ mapping: {}, chat_messages: [{ sender: 'human', text: 'hi' }] }])).toBe('chatgpt');
  });

  // Payload matches BOTH the claude-ai detector (`messages` with a `sender`) and the
  // slack detector (`ts` + `text`); claude-ai wins by registry order.
  test('resolves a claude-ai/slack dual-match payload as claude-ai', () => {
    expect(detectConversationFormat({ messages: [{ sender: 'human', ts: '1710000000.000100', text: 'hi' }] })).toBe('claude-ai');
  });

  test('returns null for data no adapter recognizes', () => {
    expect(detectConversationFormat({ foo: 'bar' })).toBeNull();
  });

  test('stamps every parsed session with its own adapter source', () => {
    const minimalPayloadFor = (source: string): unknown => {
      switch (source) {
        case 'chatgpt':
          return [{
            id: 'c', title: 't', current_node: 'm1',
            mapping: {
              m1: {
                id: 'm1', parent: null, children: [],
                message: {
                  author: { role: 'user' },
                  create_time: 1710000000,
                  content: { content_type: 'text', parts: ['hi'] },
                },
              },
            },
          }];
        case 'claude-ai':
          return [{
            uuid: 'c1', name: 'n',
            chat_messages: [{ sender: 'human', created_at: '2026-05-31T10:00:00Z', text: 'hi' }],
          }];
        case 'slack':
          return [{ ts: '1710000000.000100', user: 'U1', text: 'hi' }];
        default:
          throw new Error(`Unhandled adapter source: ${source}`);
      }
    };

    for (const adapter of conversationSourceAdapters) {
      const filePath = join(tempDir, `${adapter.source}.json`);
      const sessions = adapter.parse(minimalPayloadFor(adapter.source), { filePath, rootPath: tempDir });

      expect(sessions.length).toBeGreaterThan(0);
      for (const session of sessions) {
        expect(session.source).toBe(adapter.source);
      }
    }
  });
});
